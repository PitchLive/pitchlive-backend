import { after, before, beforeEach, describe, it, mock } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { WebSocket } from "ws"
import { eq } from "drizzle-orm"
import { matches } from "../src/db/schema.js"
import { clearDetailsCache, normalizeSummary } from "../src/services/matchDetails.js"
import { refreshWatchedDetails } from "../src/jobs/scheduler.js"
import { ORIGIN, setup } from "./helpers.js"

// Trimmed real ESPN summary: Crystal Palace 0-2 Newcastle United, 25 Oct 2026.
const SUMMARY = JSON.parse(fs.readFileSync(new URL("./fixtures/espn-summary-401879254.json", import.meta.url), "utf8"))
const SIDES = new Map([
  ["384", "home" as const],
  ["361", "away" as const],
])

let ctx: Awaited<ReturnType<typeof setup>>
before(async () => {
  ctx = await setup()
  await ctx.db.insert(matches).values({
    id: "espn-401879254",
    espnId: "401879254",
    leagueId: "eng.1",
    homeId: "cry",
    awayId: "new",
    homeScore: 0,
    awayScore: 2,
    status: "LIVE",
    minute: 70,
    kickoff: new Date(Date.now() - 80 * 60_000),
  })
})
after(() => ctx.close())
beforeEach(() => clearDetailsCache())

describe("match details normalisation", () => {
  const d = normalizeSummary("m", SUMMARY, SIDES)

  it("counts every kind of goal ESPN reports (headers, volleys, free kicks, penalties, own goals)", () => {
    const ev = (id: string, type: string, scoringPlay: boolean, team: string) => ({ id, type: { type }, scoringPlay, clock: { displayValue: "10'" }, period: { number: 1 }, team: { id: team }, participants: [{ athlete: { displayName: `P${id}` } }] })
    const s = normalizeSummary(
      "m",
      {
        keyEvents: [
          ev("1", "goal", true, "384"),
          ev("2", "goal---header", true, "384"),
          ev("3", "goal---volley", true, "361"),
          ev("4", "goal---free-kick", true, "361"),
          ev("5", "penalty---scored", true, "384"),
          ev("6", "own-goal", true, "361"),
          ev("7", "penalty---missed", false, "384"),
          ev("8", "shot-on-target", false, "384"),
        ],
      },
      SIDES,
    )
    assert.deepEqual(
      s.events.map((e) => `${e.id}:${e.type}`),
      ["1:goal", "2:goal", "3:goal", "4:goal", "5:penalty-goal", "6:own-goal", "7:penalty---missed"],
    )
  })

  it("orders stats Flashscore-style and formats percentages", () => {
    assert.equal(d.stats[0]!.label, "Ball possession")
    assert.match(d.stats[0]!.home, /^\d+%$/)
    // ESPN sends pass accuracy as a fraction (0.8); it must read as a whole percentage.
    const pass = d.stats.find((s) => s.key === "passPct")!
    assert.ok(Number(pass.home.replace("%", "")) > 1, `pass accuracy ${pass.home}`)
    assert.ok(d.stats.some((s) => s.key === "shotsOnTarget"))
  })

  it("builds both line-ups with formation, 11 starters and bench", () => {
    assert.ok(d.lineups)
    assert.equal(d.lineups!.home.formation, "3-4-2-1")
    assert.equal(d.lineups!.home.starters.length, 11)
    assert.equal(d.lineups!.away.starters.length, 11)
    assert.equal(d.lineups!.home.starters[0]!.position, "G", "keeper first by formation place")
    const mateta = d.lineups!.home.starters.find((p) => p.name === "Jean-Philippe Mateta")
    assert.equal(mateta?.subbedOut, "62'")
    const nketiah = d.lineups!.home.bench.find((p) => p.name === "Eddie Nketiah")
    assert.equal(nketiah?.subbedIn, "62'")
  })

  it("keeps key events with the right side and drops noise", () => {
    const goal = d.events.find((e) => e.type === "goal")
    assert.equal(goal?.side, "away")
    assert.equal(goal?.minute, "47'")
    assert.deepEqual(goal?.players, ["William Osula", "Jacob Murphy"])
    assert.ok(!d.events.some((e) => e.type === "start-delay"), "delays are commentary-only")
    const scorer = d.lineups!.away.starters.concat(d.lineups!.away.bench).find((p) => p.name === "William Osula")
    assert.equal(scorer?.goals, 1)
  })

  it("returns commentary newest first", () => {
    assert.ok(d.commentary.length > 50)
    assert.ok(d.commentary[0]!.seq > d.commentary.at(-1)!.seq)
  })
})

describe("match details endpoint and live push", () => {
  it("serves details and caches them between calls", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(SUMMARY), { headers: { "content-type": "application/json" } }))
    try {
      const res = await ctx.app.inject("/api/matches/espn-401879254/details")
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().details.lineups.home.formation, "3-4-2-1")
      await ctx.app.inject("/api/matches/espn-401879254/details")
      assert.equal(fetchMock.mock.callCount(), 1, "second call served from cache")
      assert.equal((await ctx.app.inject("/api/matches/nope/details")).statusCode, 404)
    } finally {
      fetchMock.mock.restore()
    }
  })

  it("pushes details to watchers only when they change", async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" })
    const { port } = ctx.app.server.address() as { port: number }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { origin: ORIGIN } })
    const got: any[] = []
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === "details") got.push(m.details)
    })
    await new Promise((r) => ws.once("open", r))
    ws.send(JSON.stringify({ type: "subscribe", topic: "match:espn-401879254" }))
    await new Promise((r) => setTimeout(r, 200))

    let payload = SUMMARY
    const fetcher = async () => payload
    assert.equal(await refreshWatchedDetails(ctx.db, ctx.hub, fetcher), 1, "first read is pushed")
    assert.equal(await refreshWatchedDetails(ctx.db, ctx.hub, fetcher), 0, "unchanged content is not pushed")
    payload = { ...SUMMARY, commentary: [{ sequence: 999, time: { displayValue: "71'" }, text: "Corner, Newcastle United." }, ...SUMMARY.commentary] }
    assert.equal(await refreshWatchedDetails(ctx.db, ctx.hub, fetcher), 1, "new commentary is pushed")
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(got.length >= 2)
    assert.equal(got.at(-1).commentary[0].text, "Corner, Newcastle United.")

    // Finished long ago: no longer refreshed.
    await ctx.db.update(matches).set({ status: "FT", updatedAt: new Date(Date.now() - 3_600_000) }).where(eq(matches.id, "espn-401879254"))
    clearDetailsCache()
    assert.equal(await refreshWatchedDetails(ctx.db, ctx.hub, fetcher), 0)
    ws.close()
  })
})
