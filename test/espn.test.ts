import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { eq, inArray } from "drizzle-orm"
import { matches, standings, teams } from "../src/db/schema.js"
import { mapStatus, syncScoreboards, syncStandings } from "../src/jobs/espn.js"
import { TableRechecks, leaguesInPlay } from "../src/jobs/scheduler.js"
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
  it("maps statuses and the match clock", () => {
    const noClock = { minute: null, period: null, clockSeconds: null, clockDisplay: null }
    assert.deepEqual(mapStatus({ clock: 4021.4, displayClock: "67'", period: 2, type: { name: "STATUS_SECOND_HALF", state: "in" } }), {
      status: "LIVE",
      minute: 67,
      period: 2,
      clockSeconds: 4021,
      clockDisplay: "67'",
    })
    assert.deepEqual(mapStatus({ clock: 2700, displayClock: "45'", period: 1, type: { name: "STATUS_HALFTIME", state: "in" } }), {
      status: "HT",
      minute: 45,
      period: 1,
      clockSeconds: 2700,
      clockDisplay: "45'",
    })
    // Finished matches drop the clock so clients don't keep ticking it.
    assert.deepEqual(mapStatus({ clock: 5400, displayClock: "90'+9'", period: 2, type: { name: "STATUS_FULL_TIME", state: "post" } }), { status: "FT", ...noClock })
    assert.deepEqual(mapStatus({ type: { name: "STATUS_POSTPONED", state: "pre" } }), { status: "POSTPONED", ...noClock })
  })

  it("picks only leagues with a match in play or kicking off for the fast loop", async () => {
    const now = new Date("2026-10-23T19:00:00Z")
    const base = { homeScore: 0, awayScore: 0 }
    await ctx.db.insert(matches).values([
      { id: "lp-1", leagueId: "ger.1", homeId: "bay", awayId: "bvb", status: "LIVE", kickoff: new Date("2026-10-23T18:30:00Z"), ...base },
      { id: "lp-2", leagueId: "ita.1", homeId: "juv", awayId: "nap", status: "UPCOMING", kickoff: new Date("2026-10-23T19:01:00Z"), ...base },
      { id: "lp-3", leagueId: "fra.1", homeId: "psg", awayId: "mon", status: "UPCOMING", kickoff: new Date("2026-10-23T21:00:00Z"), ...base },
      { id: "lp-4", leagueId: "esp.1", homeId: "bar", awayId: "sev", status: "FT", kickoff: new Date("2026-10-23T16:00:00Z"), ...base },
    ])
    assert.deepEqual((await leaguesInPlay(ctx.db, now)).sort(), ["ger.1", "ita.1"])
    await ctx.db.delete(matches).where(inArray(matches.id, ["lp-1", "lp-2", "lp-3", "lp-4"]))
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

  it("limits the fast pass to the given leagues and days", async () => {
    const urls: string[] = []
    const fetcher = async (url: string) => (urls.push(url), { events: [] })
    await syncScoreboards(ctx.db, fetcher, new Date("2026-10-23T12:00:00Z"), { leagues: ["eng.1", "esp.1"], days: [-1, 0] })
    assert.deepEqual(urls.map((u) => u.replace(/^.*soccer\//, "")).sort(), [
      "eng.1/scoreboard?dates=20261022",
      "eng.1/scoreboard?dates=20261023",
      "esp.1/scoreboard?dates=20261022",
      "esp.1/scoreboard?dates=20261023",
    ])
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
    assert.deepEqual(await syncStandings(ctx.db, fetcher), ["sco.1"], "reports the league whose table changed")
    const after = await ctx.db.select().from(standings).where(eq(standings.leagueId, "sco.1"))
    assert.equal(after.length, 2)
    const top = after.find((r) => r.position === 1)!
    assert.equal(top.teamId, tb!.id, "re-sorted by points")
    assert.equal(top.form, b!.form, "form preserved")
    assert.deepEqual(await syncStandings(ctx.db, fetcher, { leagues: ["sco.1"] }), [], "an unchanged table is not reported")
  })

  it("re-checks a league's table a few times after one of its matches ends", () => {
    const r = new TableRechecks()
    const t0 = 1_000_000
    r.schedule("eng.1", t0)
    assert.deepEqual(r.take(t0 + 1_000), [], "nothing due straight away")
    assert.deepEqual(r.take(t0 + 31_000), ["eng.1"], "first check after 30 s")
    assert.deepEqual(r.take(t0 + 32_000), [], "each due time fires once")
    assert.deepEqual(r.take(t0 + 3 * 60_000 + 1), ["eng.1"])
    assert.deepEqual(r.take(t0 + 8 * 60_000 + 1), ["eng.1"])
    assert.deepEqual(r.take(t0 + 60 * 60_000), [], "done after the last check")
  })
})
