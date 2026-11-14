import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { eq } from "drizzle-orm"
import { leagues, teams } from "../src/db/schema.js"
import { sportOfLeague, sportsInPlay, syncSports } from "../src/jobs/sports.js"
import { getMatchDetails } from "../src/services/matchDetails.js"
import { setup } from "./helpers.js"

let ctx: Awaited<ReturnType<typeof setup>>
before(async () => (ctx = await setup()))
after(() => ctx.close())

const now = new Date("2026-11-10T23:30:00Z")
const nbaTeam = (id: string, name: string, abbr: string) => ({ id, displayName: name, abbreviation: abbr, color: "1d428a", logo: `https://img.example/${abbr}.png` })

const nba = {
  leagues: [{ name: "National Basketball Association", abbreviation: "NBA", logos: [{ href: "https://img.example/nba.png" }] }],
  events: [
    {
      id: "401810001",
      date: "2026-11-10T23:00Z",
      status: { displayClock: "4:21", period: 3, type: { name: "STATUS_IN_PROGRESS", state: "in", shortDetail: "4:21 - 3rd" } },
      competitions: [
        {
          id: "401810001",
          date: "2026-11-10T23:00Z",
          venue: { fullName: "Madison Square Garden" },
          competitors: [
            { homeAway: "home", score: "78", team: nbaTeam("18", "New York Knicks", "NY"), linescores: [{ value: 26 }, { value: 32 }, { value: 20 }] },
            { homeAway: "away", score: "71", team: nbaTeam("2", "Boston Celtics", "BOS"), linescores: [{ value: 30 }, { value: 21 }, { value: 20 }] },
          ],
        },
      ],
    },
  ],
}

const player = (id: string, name: string, order: number, sets: [number, boolean, number?][]) => ({
  id,
  order,
  athlete: { displayName: name, flag: { href: `https://img.example/${id}.png`, alt: "Chile" } },
  linescores: sets.map(([value, winner, tiebreak]) => ({ value, winner, tiebreak })),
})
const atp = {
  events: [
    {
      id: "148-2026",
      name: "Stockholm Open",
      date: "2026-11-07T05:00Z",
      groupings: [
        {
          grouping: { slug: "mens-singles", displayName: "Men's Singles" },
          competitions: [
            {
              id: "186540",
              date: "2026-11-10T12:05Z",
              status: { period: 3, type: { name: "STATUS_FINAL", state: "post", shortDetail: "Final" } },
              round: { displayName: "Round 2" },
              venue: { court: "Center Court" },
              competitors: [player("2970", "Alejandro Tabilo", 2, [[7, true, 7], [6, false, 7], [7, true]]), player("3052", "Lorenzo Sonego", 1, [[6, false, 2], [7, true, 9], [5, false]])],
            },
            // A slot in the draw nobody has reached yet.
            { id: "186541", date: "2026-11-12T12:00Z", status: { type: { name: "STATUS_SCHEDULED", state: "pre" } }, competitors: [{ id: "9", order: 1 }] },
          ],
        },
      ],
    },
  ],
}

const fetcher = async (url: string) => {
  if (url.includes("/basketball/nba/scoreboard?dates=20261110")) return nba
  if (url.includes("/tennis/atp/scoreboard")) return atp
  if (url.includes("/basketball/nba/summary?event=401810001"))
    return {
      boxscore: {
        teams: [
          { team: { id: "2" }, statistics: [{ name: "rebounds", label: "Rebounds", displayValue: "31" }, { name: "assists", label: "Assists", displayValue: "17" }] },
          { team: { id: "18" }, statistics: [{ name: "rebounds", label: "Rebounds", displayValue: "38" }, { name: "assists", label: "Assists", displayValue: "22" }] },
        ],
      },
    }
  return { events: [] }
}

describe("other sports", () => {
  it("knows a league's sport from its id", () => {
    assert.equal(sportOfLeague("eng.1"), "soccer")
    assert.equal(sportOfLeague("basketball.nba"), "basketball")
    assert.equal(sportOfLeague("tennis.148-2026.mens-singles"), "tennis")
    assert.equal(sportOfLeague(null), "soccer")
  })

  it("syncs team sports with their status line and period scores, apart from football", async () => {
    // A football club with the same ESPN id as the Knicks must stay a different team.
    await ctx.db.insert(teams).values({ id: "t-18", espnId: "18", name: "Some Football Club", short: "SFC", color: "#000000", color2: "#ffffff" }).onConflictDoNothing()

    const changed = await syncSports(ctx.db, fetcher, now)
    assert.ok(changed.includes("espn-basketball-401810001"))
    assert.deepEqual(await syncSports(ctx.db, fetcher, now), [], "nothing changes on an identical second pass")

    const { matches: hoops } = (await ctx.app.inject("/api/matches?date=2026-11-10&sport=basketball")).json()
    assert.equal(hoops.length, 1)
    const m = hoops[0]
    assert.equal(m.sport, "basketball")
    assert.equal(m.leagueId, "basketball.nba")
    assert.equal(m.leagueName, "NBA")
    assert.equal(m.leagueLogo, "https://img.example/nba.png")
    assert.equal(m.status, "LIVE")
    assert.equal(m.statusText, "4:21 - 3rd")
    assert.deepEqual([m.homeScore, m.awayScore], [78, 71])
    assert.deepEqual(m.linescores, { home: [26, 32, 20], away: [30, 21, 20] })
    assert.equal(m.home.id, "basketball-18")
    assert.equal(m.home.name, "New York Knicks")

    const { matches: football } = (await ctx.app.inject("/api/matches?date=2026-11-10")).json()
    assert.ok(football.every((x: { sport: string }) => x.sport === "soccer"), "the default list stays football only")
    const { matches: all } = (await ctx.app.inject("/api/matches?date=2026-11-10&sport=all&limit=500")).json()
    assert.ok(all.some((x: { id: string }) => x.id === "espn-basketball-401810001"))

    const { teams: found } = (await ctx.app.inject("/api/teams?q=knicks&sport=basketball")).json()
    assert.deepEqual(found.map((t: { id: string }) => t.id), ["basketball-18"])
    assert.equal((await ctx.app.inject("/api/teams?q=knicks")).json().teams.length, 0, "club search stays football unless asked")
  })

  it("turns tennis draws into leagues and sets into the score", async () => {
    const { matches: list } = (await ctx.app.inject("/api/matches?date=2026-11-10&sport=tennis")).json()
    assert.equal(list.length, 1, "unfilled draw slots are skipped")
    const m = list[0]
    assert.equal(m.id, "espn-tennis-186540")
    assert.equal(m.leagueId, "tennis.148-2026.mens-singles")
    assert.equal(m.leagueName, "Stockholm Open, Men's Singles")
    assert.equal(m.leagueCountry, "ATP")
    assert.equal(m.home.name, "Lorenzo Sonego", "order 1 is listed first")
    assert.deepEqual([m.homeScore, m.awayScore], [1, 2], "sets won")
    assert.deepEqual(m.linescores, { home: [6, 7, 5], away: [7, 6, 7], homeTb: [2, 9, null], awayTb: [7, 7, null] })
    assert.equal(m.status, "FT")
    assert.equal(m.venue, "Round 2 · Center Court")
    assert.equal(m.away.logo, "https://img.example/2970.png")
  })

  it("lists a sport's competitions and follows the ones in play", async () => {
    assert.deepEqual((await ctx.app.inject("/api/sports")).json().sports, ["soccer", "basketball", "football", "hockey", "baseball", "tennis"])
    // "Around now" for the competitions list is the real clock, so check the rows directly.
    const [league] = await ctx.db.select().from(leagues).where(eq(leagues.id, "basketball.nba"))
    assert.equal(league?.sport, "basketball")
    assert.equal(league?.featured, false)
    assert.equal((await ctx.app.inject("/api/sports/cricket/leagues")).statusCode, 400)
    assert.deepEqual(await sportsInPlay(ctx.db, now), [{ sport: "basketball", slug: "nba" }])
    // Other sports' leagues open without loading a football table or season.
    const page = await ctx.app.inject("/api/leagues/basketball.nba")
    assert.equal(page.statusCode, 200)
    assert.equal((await ctx.app.inject("/api/leagues/basketball.nba/matches?kind=fixtures")).json().matches.length, 1)
  })

  it("serves box-score stats as match details", async () => {
    const res = await getMatchDetails(ctx.db, "espn-basketball-401810001", { fetcher, force: true })
    assert.deepEqual(res?.details.stats, [
      { key: "rebounds", label: "Rebounds", home: "38", away: "31" },
      { key: "assists", label: "Assists", home: "22", away: "17" },
    ])
    assert.equal(res?.details.lineups, null)
    const tennis = await getMatchDetails(ctx.db, "espn-tennis-186540", { fetcher, force: true })
    assert.deepEqual(tennis?.details.stats, [])
  })
})
