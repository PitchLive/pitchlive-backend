import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { seedDemoMatches, tickDemoMatches } from "../src/jobs/demo.js"
import { ORIGIN, sessionCookie, setup } from "./helpers.js"

let ctx: Awaited<ReturnType<typeof setup>>

before(async () => {
  ctx = await setup()
  await seedDemoMatches(ctx.db, ctx.config.DEMO_STREAM_URL)
})
after(() => ctx.close())

describe("catalog", () => {
  it("lists all 18 leagues with leaders and club counts", async () => {
    const res = await ctx.app.inject("/api/leagues")
    assert.equal(res.statusCode, 200)
    const { leagues } = res.json()
    assert.equal(leagues.length, 18)
    const epl = leagues.find((l: { id: string }) => l.id === "eng.1")
    assert.equal(epl.name, "Premier League")
    assert.equal(epl.clubCount, 20)
    assert.equal(epl.leaders.length, 1)
    assert.equal(leagues.find((l: { id: string }) => l.id === "usa.1").leaders.length, 2, "MLS has two conference leaders")
  })

  it("returns a league table ordered by position", async () => {
    const res = await ctx.app.inject("/api/leagues/eng.1")
    const { league, table } = res.json()
    assert.equal(league.country, "England")
    assert.equal(table.length, 1)
    const pts = table[0].rows.map((r: { points: number }) => r.points)
    assert.deepEqual(pts, [...pts].sort((a, b) => b - a))
    assert.equal(table[0].rows[0].position, 1)
  })

  it("404s unknown leagues and teams", async () => {
    assert.equal((await ctx.app.inject("/api/leagues/nope")).statusCode, 404)
    assert.equal((await ctx.app.inject("/api/teams/nope")).statusCode, 404)
  })

  it("searches teams accent-insensitively", async () => {
    const res = await ctx.app.inject("/api/teams?q=atletico")
    const names = res.json().teams.map((t: { name: string }) => t.name)
    assert.ok(names.includes("Atlético Madrid"), names.join(", "))
  })

  it("returns a team with its competitions and stadium", async () => {
    const { team } = (await ctx.app.inject("/api/teams/ars")).json()
    assert.equal(team.name, "Arsenal")
    assert.equal(team.stadium, "Emirates Stadium")
    assert.ok(team.competitions.some((c: { league: { id: string } }) => c.league.id === "eng.1"))
  })

  it("filters matches by status and validates input", async () => {
    const res = await ctx.app.inject("/api/matches?status=live,ht")
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().matches.length, 4)
    assert.equal((await ctx.app.inject("/api/matches?status=bogus")).statusCode, 400)
    assert.equal((await ctx.app.inject("/api/matches?date=23-10-2026")).statusCode, 400)
  })
})

describe("auth", () => {
  const creds = { email: "Fan@Example.com", password: "correct horse battery", displayName: "Fan" }

  it("registers, reads session, logs out", async () => {
    const reg = await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: creds })
    assert.equal(reg.statusCode, 201)
    assert.equal(reg.json().user.email, "fan@example.com")
    const cookie = sessionCookie(reg)
    assert.match(reg.headers["set-cookie"] as string, /HttpOnly/)

    const me = await ctx.app.inject({ url: "/api/auth/me", headers: { cookie } })
    assert.equal(me.json().user.displayName, "Fan")

    const out = await ctx.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })
    assert.equal(out.statusCode, 204)
    const after = await ctx.app.inject({ url: "/api/auth/me", headers: { cookie } })
    assert.equal(after.json().user, null, "session revoked server-side")
  })

  it("rejects duplicates, weak passwords and wrong passwords", async () => {
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: creds })).statusCode, 409)
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: { ...creds, email: "x@y.z", password: "short" } })).statusCode, 400)
    const bad = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: creds.email, password: "nope nope nope" } })
    assert.equal(bad.statusCode, 401)
    const ghost = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ghost@x.io", password: "whatever123" } })
    assert.equal(ghost.statusCode, 401)
    assert.equal(ghost.json().error, bad.json().error, "same message for unknown email")
  })

  it("blocks cross-site writes", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "https://evil.example" }, payload: { email: creds.email, password: creds.password } })
    assert.equal(res.statusCode, 403)
    const ok = await ctx.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { email: creds.email, password: creds.password } })
    assert.equal(ok.statusCode, 200)
  })

  it("manages favourites for the signed-in user only", async () => {
    const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: creds.email, password: creds.password } })
    const cookie = sessionCookie(login)
    assert.equal((await ctx.app.inject({ url: "/api/me/favorites" })).statusCode, 401)
    assert.equal((await ctx.app.inject({ method: "PUT", url: "/api/me/favorites/ars", headers: { cookie } })).statusCode, 204)
    assert.equal((await ctx.app.inject({ method: "PUT", url: "/api/me/favorites/ars", headers: { cookie } })).statusCode, 204, "idempotent")
    assert.equal((await ctx.app.inject({ method: "PUT", url: "/api/me/favorites/nope", headers: { cookie } })).statusCode, 404)
    const list = await ctx.app.inject({ url: "/api/me/favorites", headers: { cookie } })
    assert.deepEqual(list.json().teams.map((t: { id: string }) => t.id), ["ars"])
    await ctx.app.inject({ method: "DELETE", url: "/api/me/favorites/ars", headers: { cookie } })
    assert.equal((await ctx.app.inject({ url: "/api/me/favorites", headers: { cookie } })).json().teams.length, 0)
  })
})

describe("streaming", () => {
  it("requires sign-in and returns the configured stream", async () => {
    assert.equal((await ctx.app.inject("/api/matches/demo-1/playback")).statusCode, 401)
    const reg = await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "viewer@x.io", password: "longenough1", displayName: "Viewer" } })
    const cookie = sessionCookie(reg)
    const res = await ctx.app.inject({ url: "/api/matches/demo-1/playback", headers: { cookie } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers["cache-control"], "private, no-store")
    assert.equal(res.json().playback.demo, true)
    assert.equal((await ctx.app.inject({ url: "/api/matches/nope/playback", headers: { cookie } })).statusCode, 404)
  })
})

describe("admin", () => {
  it("requires the admin token", async () => {
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/admin/sync", payload: { job: "seed" } })).statusCode, 401)
    const res = await ctx.app.inject({
      method: "PUT",
      url: "/api/admin/matches/demo-3/stream",
      headers: { authorization: "Bearer test-admin-token-123456" },
      payload: { provider: "hls", source: "https://example.com/live.m3u8", quality: "4K" },
    })
    assert.equal(res.statusCode, 204)
    const { match } = (await ctx.app.inject("/api/matches/demo-3")).json()
    assert.equal(match.hasStream, true)
  })
})

describe("demo simulator", () => {
  it("advances live matches", async () => {
    const before = (await ctx.app.inject("/api/matches/demo-2")).json().match.minute
    await tickDemoMatches(ctx.db, () => 0.5)
    assert.equal((await ctx.app.inject("/api/matches/demo-2")).json().match.minute, before + 1)
  })
})
