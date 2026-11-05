import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import { matches } from "../src/db/schema.js"
import { syncSeason } from "../src/jobs/espn.js"
import { setup } from "./helpers.js"

let ctx: Awaited<ReturnType<typeof setup>>
before(async () => (ctx = await setup()))
after(() => ctx.close())

const ev = (id: string, date: string, state: "pre" | "post", home: string, away: string, hs: number, as: number) => ({
  id,
  date,
  status: { type: { name: state === "post" ? "STATUS_FULL_TIME" : "STATUS_SCHEDULED", state } },
  competitions: [
    {
      competitors: [
        { homeAway: "home", score: String(hs), team: { id: home, displayName: `Club ${home}` } },
        { homeAway: "away", score: String(as), team: { id: away, displayName: `Club ${away}` } },
      ],
    },
  ],
})

describe("season sync", () => {
  it("loads every in-season result and fixture across the years the season spans", async () => {
    const urls: string[] = []
    const fetcher = async (url: string) => {
      urls.push(url.replace(/^.*soccer\//, ""))
      if (url.endsWith("/scoreboard")) return { leagues: [{ season: { startDate: "2026-07-01T00:00Z", endDate: "2027-06-30T00:00Z" } }] }
      if (url.includes("dates=2026"))
        return {
          events: [
            ev("100", "2026-05-20T15:00Z", "post", "901", "902", 1, 1), // last season: ignored
            ev("101", "2026-08-22T15:00Z", "post", "901", "902", 2, 0),
            ev("102", "2026-10-25T15:00Z", "post", "902", "901", 1, 3),
          ],
        }
      if (url.includes("dates=2027")) return { events: [ev("103", "2027-03-14T15:00Z", "pre", "901", "902", 0, 0)] }
      return { events: [] }
    }

    const changed = await syncSeason(ctx.db, fetcher, { leagues: ["por.1"] })
    assert.deepEqual(changed.sort(), ["espn-101", "espn-102", "espn-103"])
    assert.deepEqual(urls, ["por.1/scoreboard", "por.1/scoreboard?dates=2026&limit=1000", "por.1/scoreboard?dates=2027&limit=1000"])
    const [m] = await ctx.db.select().from(matches).where(eq(matches.id, "espn-102"))
    assert.equal(m!.status, "FT")
    assert.equal(m!.awayScore, 3)

    assert.deepEqual(await syncSeason(ctx.db, fetcher, { leagues: ["por.1"] }), [], "a re-run with nothing new changes nothing")
  })

  it("serves results latest-first and fixtures soonest-first", async () => {
    const results = (await ctx.app.inject("/api/leagues/por.1/matches?kind=results")).json().matches
    assert.deepEqual(
      results.map((m: { id: string }) => m.id),
      ["espn-102", "espn-101"],
    )
    const fixtures = (await ctx.app.inject("/api/leagues/por.1/matches?kind=fixtures")).json().matches
    assert.deepEqual(
      fixtures.map((m: { id: string }) => m.id),
      ["espn-103"],
    )
    assert.equal((await ctx.app.inject("/api/leagues/nope/matches")).statusCode, 404)
  })

  it("builds the table's last-5 form from real results, oldest first", async () => {
    // Six results for Benfica (t-1929) in por.1; only the latest five count.
    const benfica = "t-1929"
    const opp = "ucl-437" // FC Porto
    const scores: [number, number][] = [
      [1, 0],
      [0, 0],
      [0, 2],
      [3, 1],
      [2, 2],
      [1, 0],
    ]
    await ctx.db.insert(matches).values(
      scores.map(([b, o], i) => ({
        id: `form-${i}`,
        leagueId: "por.1",
        homeId: i % 2 === 0 ? benfica : opp,
        awayId: i % 2 === 0 ? opp : benfica,
        homeScore: i % 2 === 0 ? b : o,
        awayScore: i % 2 === 0 ? o : b,
        status: "FT" as const,
        kickoff: new Date(Date.UTC(2026, 8, 1 + i * 7)),
      })),
    )
    const { table } = (await ctx.app.inject("/api/leagues/por.1")).json()
    const row = table.flatMap((g: { rows: unknown[] }) => g.rows).find((r: { team: { id: string } }) => r.team.id === benfica)
    assert.deepEqual(row.form, ["D", "L", "W", "D", "W"], "last five, oldest first (the first 1-0 win drops off)")
    assert.equal(row.formDetail.length, 5)
    assert.deepEqual(row.formDetail.at(-1), {
      result: "W",
      matchId: "form-5",
      opponentId: opp,
      home: false,
      scored: 1,
      conceded: 0,
      kickoff: new Date(Date.UTC(2026, 8, 36)).toISOString(),
    })
  })
})
