import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { ORIGIN, seedFixtures, sessionCookie, setup, signIn, testToken } from "./helpers.js"

let ctx: Awaited<ReturnType<typeof setup>>

before(async () => {
  ctx = await setup()
  await seedFixtures(ctx.db)
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
    assert.deepEqual(
      epl.top.map((r: { position: number }) => r.position),
      [1, 2, 3],
    )
    assert.equal(epl.top[0].team.id, epl.leaders[0].team.id, "top three starts with the leader")
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
    const live = res.json().matches
    assert.deepEqual(live.map((m: { id: string }) => m.id).sort(), ["fx-1", "fx-2", "fx-3"])
    const fx1 = live.find((m: { id: string }) => m.id === "fx-1")
    assert.equal(fx1.clockSeconds, 67 * 60)
    assert.equal(fx1.period, 2)
    assert.equal(typeof fx1.clockAgeMs, "number")
    assert.equal((await ctx.app.inject("/api/matches?status=bogus")).statusCode, 400)
    assert.equal((await ctx.app.inject("/api/matches?date=23-10-2026")).statusCode, 400)
  })
})

describe("auth", () => {
  it("creates an account from a Firebase sign-in, reads the session, logs out", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-fan", "Fan@Example.com", { name: "Fan" }) } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().user.email, "fan@example.com")
    assert.equal(res.json().user.displayName, "Fan")
    const cookie = sessionCookie(res)
    assert.match(res.headers["set-cookie"] as string, /HttpOnly/)

    const me = await ctx.app.inject({ url: "/api/auth/me", headers: { cookie } })
    assert.equal(me.json().user.displayName, "Fan")

    const out = await ctx.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })
    assert.equal(out.statusCode, 204)
    const after = await ctx.app.inject({ url: "/api/auth/me", headers: { cookie } })
    assert.equal(after.json().user, null, "session revoked server-side")
  })

  it("signs the same Firebase user back into the same account", async () => {
    const first = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-fan", "fan@example.com") } })
    const again = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-fan", "fan@example.com"), displayName: "Someone Else" } })
    assert.equal(first.json().user.id, again.json().user.id)
    assert.equal(again.json().user.displayName, "Fan", "an existing name is kept")
  })

  it("uses the sign-up name when Firebase has none, else the email", async () => {
    const named = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-new", "new@x.io"), displayName: "New Fan" } })
    assert.equal(named.json().user.displayName, "New Fan")
    const bare = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-bare", "bare.name@x.io") } })
    assert.equal(bare.json().user.displayName, "bare.name")
  })

  it("links an existing email only when Firebase has verified it", async () => {
    const other = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-other", "fan@example.com") } })
    assert.equal(other.statusCode, 409, "an unverified email cannot take over an account")
    const google = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-google", "fan@example.com", { verified: true }) } })
    assert.equal(google.statusCode, 200)
    const original = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken("uid-google", "fan@example.com", { verified: true }) } })
    assert.equal(google.json().user.id, original.json().user.id)
  })

  it("rejects bad tokens and bad input", async () => {
    const forged = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: "not-a-real-firebase-token" } })
    assert.equal(forged.statusCode, 401)
    assert.equal(forged.cookies.length, 0, "no session for a bad token")
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", payload: {} })).statusCode, 400)
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "a@b.c", password: "longenough1", displayName: "Old" } })).statusCode, 404, "password sign-up is gone")
  })

  it("blocks cross-site writes", async () => {
    const payload = { idToken: testToken("uid-site", "site@x.io") }
    const res = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", headers: { origin: "https://evil.example" }, payload })
    assert.equal(res.statusCode, 403)
    const ok = await ctx.app.inject({ method: "POST", url: "/api/auth/firebase", headers: { origin: ORIGIN }, payload })
    assert.equal(ok.statusCode, 200)
  })

  it("keeps app settings on the account", async () => {
    assert.equal((await ctx.app.inject({ url: "/api/me/settings" })).statusCode, 401)
    const cookie = await signIn(ctx.app, "uid-set", "set@x.io")
    assert.equal((await ctx.app.inject({ url: "/api/me/settings", headers: { cookie } })).json().settings, null)
    const settings = { clock24: false, alerts: { goals: true, kickoff: false }, spoiler: { enabled: true, delaySec: 90 } }
    const put = await ctx.app.inject({ method: "PUT", url: "/api/me/settings", headers: { cookie }, payload: { settings } })
    assert.equal(put.statusCode, 200)
    assert.deepEqual((await ctx.app.inject({ url: "/api/me/settings", headers: { cookie } })).json().settings, settings)
    const huge = await ctx.app.inject({ method: "PUT", url: "/api/me/settings", headers: { cookie }, payload: { settings: { blob: "x".repeat(5000) } } })
    assert.equal(huge.statusCode, 400)
    const other = await signIn(ctx.app, "uid-set-2", "set2@x.io")
    assert.equal((await ctx.app.inject({ url: "/api/me/settings", headers: { cookie: other } })).json().settings, null, "per account")
  })

  it("manages favourites for the signed-in user only", async () => {
    const cookie = await signIn(ctx.app, "uid-fav", "fav@x.io")
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
  it("requires sign-in, returns licensed streams and 404s matches without one", async () => {
    assert.equal((await ctx.app.inject("/api/matches/fx-1/playback")).statusCode, 401)
    const cookie = await signIn(ctx.app, "uid-viewer", "viewer@x.io", "Viewer")
    const res = await ctx.app.inject({ url: "/api/matches/fx-1/playback", headers: { cookie } })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers["cache-control"], "private, no-store")
    assert.equal(res.json().playback.url, "https://streams.example.com/fx-1.m3u8")
    const none = await ctx.app.inject({ url: "/api/matches/fx-2/playback", headers: { cookie } })
    assert.equal(none.statusCode, 404)
    assert.equal(none.json().error, "Stream not found")
    assert.equal((await ctx.app.inject({ url: "/api/matches/nope/playback", headers: { cookie } })).statusCode, 404)
  })
})

describe("admin", () => {
  it("requires the admin token", async () => {
    assert.equal((await ctx.app.inject({ method: "POST", url: "/api/admin/sync", payload: { job: "seed" } })).statusCode, 401)
    const res = await ctx.app.inject({
      method: "PUT",
      url: "/api/admin/matches/fx-3/stream",
      headers: { authorization: "Bearer test-admin-token-123456" },
      payload: { provider: "hls", source: "https://example.com/live.m3u8", quality: "4K" },
    })
    assert.equal(res.statusCode, 204)
    const { match } = (await ctx.app.inject("/api/matches/fx-3")).json()
    assert.equal(match.hasStream, true)
  })
})
