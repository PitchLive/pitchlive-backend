import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import { matches, standings, teams } from "../src/db/schema.js"
import { mapStatus, syncScoreboards, syncStandings } from "../src/jobs/espn.js"
import { setup } from "./helpers.js"

let ctx: Awaited<ReturnType<typeof setup>>
before(async () => (ctx = await setup()))
after(() => ctx.close())

const event = (id: string, state: "pre" | "in" | "post", name: string, clock: string, home: string, away: string, hs: string, as: string) => ({
  id,
  date: "2026-10-23T19:00Z",
  status: { displayClock: clock, type: { name, state } },
  competitions: [
    {
      venue: { fullName: "Portman Road" },
      competitors: [
        { homeAway: "home", score: hs, team: { id: home, displayName: `Team ${home}` } },
        { homeAway: "away", score: as, team: { id: away, displayName: `Team ${away}`, abbreviation: "NEW" } },
      ],
    },
  ],
})

describe("ESPN sync", () => {
  it("maps statuses", () => {
    assert.deepEqual(mapStatus({ displayClock: "67'", type: { name: "STATUS_IN_PROGRESS", state: "in" } }), { status: "LIVE", minute: 67 })
    assert.deepEqual(mapStatus({ displayClock: "45'", type: { name: "STATUS_HALFTIME", state: "in" } }), { status: "HT", minute: 45 })
    assert.deepEqual(mapStatus({ type: { name: "STATUS_FULL_TIME", state: "post" } }), { status: "FT", minute: null })
    assert.deepEqual(mapStatus({ type: { name: "STATUS_POSTPONED", state: "pre" } }), { status: "POSTPONED", minute: null })
  })

  it("upserts scoreboard matches, maps known clubs and creates unknown ones", async () => {
    const [ipswich] = await ctx.db.select().from(teams).where(eq(teams.id, "ips"))
    let live = false
    const fetcher = async (url: string) =>
      url.includes("/eng.1/") && url.endsWith("20261023")
        ? { events: [live ? event("9001", "in", "STATUS_IN_PROGRESS", "12'", ipswich!.espnId!, "999999", "1", "0") : event("9001", "pre", "STATUS_SCHEDULED", "0'", ipswich!.espnId!, "999999", "0", "0")] }
        : { events: [] }

    const now = new Date("2026-10-23T12:00:00Z")
    assert.deepEqual(await syncScoreboards(ctx.db, fetcher, now), ["espn-9001"])
    assert.deepEqual(await syncScoreboards(ctx.db, fetcher, now), [], "unchanged match is not reported")

    live = true
    assert.deepEqual(await syncScoreboards(ctx.db, fetcher, now), ["espn-9001"])
    const [m] = await ctx.db.select().from(matches).where(eq(matches.id, "espn-9001"))
    assert.equal(m!.homeId, "ips")
    assert.equal(m!.awayId, "t-999999")
    assert.equal(m!.status, "LIVE")
    assert.equal(m!.homeScore, 1)
    const [created] = await ctx.db.select().from(teams).where(eq(teams.id, "t-999999"))
    assert.equal(created!.short, "NEW")
  })

  it("replaces a league table, re-sorting unordered feeds and keeping form", async () => {
    const before = await ctx.db.select().from(standings).where(eq(standings.leagueId, "sco.1"))
    const [a, b] = before.sort((x, y) => x.position - y.position)
    const [ta] = await ctx.db.select().from(teams).where(eq(teams.id, a!.teamId))
    const [tb] = await ctx.db.select().from(teams).where(eq(teams.id, b!.teamId))
    const stats = (pts: number) => [
      { name: "gamesPlayed", value: 10 },
      { name: "wins", value: pts / 3 },
      { name: "ties", value: 0 },
      { name: "losses", value: 10 - pts / 3 },
      { name: "pointsFor", value: 10 },
      { name: "pointsAgainst", value: 5 },
      { name: "points", value: pts },
    ]
    const fetcher = async (url: string) => {
      if (!url.includes("/sco.1/")) throw new Error("skip")
      return {
        children: [
          {
            standings: {
              seasonDisplayName: "2026-27",
              entries: [
                { team: { id: ta!.espnId, displayName: ta!.name }, stats: stats(9) },
                { team: { id: tb!.espnId, displayName: tb!.name }, stats: stats(21) },
              ],
            },
          },
        ],
      }
    }
    assert.equal(await syncStandings(ctx.db, fetcher), 1)
    const after = await ctx.db.select().from(standings).where(eq(standings.leagueId, "sco.1"))
    assert.equal(after.length, 2)
    const top = after.find((r) => r.position === 1)!
    assert.equal(top.teamId, tb!.id, "re-sorted by points")
    assert.equal(top.form, b!.form, "form preserved")
  })
})
