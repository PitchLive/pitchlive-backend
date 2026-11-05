import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import { leagues, matches, standings } from "../src/db/schema.js"
import { activeLeagueIds } from "../src/jobs/espn.js"
import { ensureLeague } from "../src/services/leagueCatalog.js"
import { setup } from "./helpers.js"

let ctx: Awaited<ReturnType<typeof setup>>
before(async () => (ctx = await setup()))
after(() => ctx.close())

const team = (id: string) => ({ id, displayName: `League One club ${id}`, abbreviation: `L${id}` })
const stats = (pts: number) => [
  { name: "gamesPlayed", value: 12 },
  { name: "wins", value: pts / 3 },
  { name: "ties", value: 0 },
  { name: "losses", value: 12 - pts / 3 },
  { name: "pointsFor", value: 20 },
  { name: "pointsAgainst", value: 10 },
  { name: "points", value: pts },
]

describe("countries and on-demand leagues", () => {
  it("lists countries and their competitions", async () => {
    const { countries } = (await ctx.app.inject("/api/countries")).json()
    const england = countries.find((c: { country: string }) => c.country === "England")
    assert.ok(england.leagues >= 5)
    assert.ok(countries.some((c: { country: string }) => c.country === "World"), "international competitions grouped under World")
    const { leagues: list } = (await ctx.app.inject("/api/countries/England/leagues")).json()
    assert.equal(list[0].slug, "eng.1", "top flight first")
    assert.ok(list.some((l: { slug: string; cup: boolean }) => l.slug === "eng.fa" && l.cup))
  })

  it("loads a league from the catalogue on first visit, once", async () => {
    let calls = 0
    const fetcher = async (url: string) => {
      calls++
      if (url.includes("/standings"))
        return { children: [{ standings: { entries: [{ team: team("801"), stats: stats(30) }, { team: team("802"), stats: stats(21) }] } }] }
      if (url.endsWith("/scoreboard")) return { leagues: [{ season: { startDate: "2026-07-01T00:00Z", endDate: "2027-06-30T00:00Z" } }] }
      if (url.includes("dates=2026"))
        return {
          events: [
            {
              id: "77001",
              date: "2026-10-18T14:00Z",
              status: { type: { name: "STATUS_FULL_TIME", state: "post" } },
              competitions: [{ competitors: [{ homeAway: "home", score: "2", team: team("801") }, { homeAway: "away", score: "1", team: team("802") }] }],
            },
          ],
        }
      return { events: [] }
    }

    assert.equal(await ensureLeague(ctx.db, "zzz.9", fetcher), false, "unknown competitions are rejected")
    assert.equal(await ensureLeague(ctx.db, "eng.3", fetcher), true)
    const [row] = await ctx.db.select().from(leagues).where(eq(leagues.id, "eng.3"))
    assert.equal(row!.featured, false)
    assert.equal(row!.country, "England")
    assert.ok(row!.lastViewedAt, "marked as viewed")
    assert.equal((await ctx.db.select().from(standings).where(eq(standings.leagueId, "eng.3"))).length, 2)
    assert.equal((await ctx.db.select().from(matches).where(eq(matches.leagueId, "eng.3"))).length, 1)

    const before = calls
    await ensureLeague(ctx.db, "eng.3", fetcher)
    assert.equal(calls, before, "a second visit within ten minutes doesn't refetch")
  })

  it("keeps recently viewed leagues in the background sync, and only those", async () => {
    assert.ok((await activeLeagueIds(ctx.db)).includes("eng.3"))
    await ctx.db.update(leagues).set({ lastViewedAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(leagues.id, "eng.3"))
    assert.ok(!(await activeLeagueIds(ctx.db)).includes("eng.3"), "dropped after a day without visits")
    assert.ok((await activeLeagueIds(ctx.db)).includes("eng.1"), "curated leagues always stay")
  })

  it("keeps the curated directory to the 18 featured leagues", async () => {
    const { leagues: list } = (await ctx.app.inject("/api/leagues")).json()
    assert.equal(list.length, 18)
  })

  it("names the league on every match", async () => {
    const { matches: list } = (await ctx.app.inject("/api/leagues/eng.3/matches?kind=results")).json()
    assert.equal(list[0].leagueName, "English League One")
  })
})
