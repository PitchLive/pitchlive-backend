import { buildApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { openDatabase } from "../src/db/client.js"
import { seed } from "../src/db/seed.js"
import { LiveHub } from "../src/live/hub.js"
import type { DB } from "../src/db/client.js"
import { matches, streams } from "../src/db/schema.js"
import type { VerifyIdToken } from "../src/auth/firebase.js"
import { HttpError } from "../src/http.js"

export const ORIGIN = "http://localhost:8443"

/**
 * Stands in for Firebase in tests. A test token is "test|uid|email|verified|name";
 * anything else is rejected the way an expired or forged token would be.
 */
const fakeVerifier: VerifyIdToken = async (token) => {
  const [tag, uid, email, verified, name] = token.split("|")
  if (tag !== "test" || !uid || !email) throw new HttpError(401, "Your sign-in has expired. Please try again.")
  return { uid, email: email.toLowerCase(), emailVerified: verified === "1", name: name || null }
}

export const testToken = (uid: string, email: string, opts: { verified?: boolean; name?: string } = {}) =>
  ["test", uid, email, opts.verified ? "1" : "0", opts.name ?? ""].join("|")

/** Signs in through the Firebase exchange and returns the session cookie. */
export async function signIn(app: Awaited<ReturnType<typeof setup>>["app"], uid: string, email: string, name = "Fan") {
  const res = await app.inject({ method: "POST", url: "/api/auth/firebase", payload: { idToken: testToken(uid, email, { verified: true, name }) } })
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`)
  return sessionCookie(res)
}

export async function setup() {
  const config = loadConfig({ NODE_ENV: "test", ESPN_SYNC: "false", ADMIN_TOKEN: "test-admin-token-123456", CORS_ORIGIN: ORIGIN, AUTH_RATE_LIMIT: "1000" })
  const database = await openDatabase({ pgliteDir: "memory://" })
  await seed(database.db)
  const hub = new LiveHub()
  const app = await buildApp({ db: database.db, config, hub, verifyIdToken: fakeVerifier }, { logger: false })
  return {
    app,
    db: database.db,
    config,
    hub,
    async close() {
      await app.close()
      await database.close()
    },
  }
}

/**
 * Test fixtures: three matches in play (one with a licensed stream) and one upcoming.
 * Only used by the test suite; production data comes from ESPN.
 */
export async function seedFixtures(db: DB) {
  const now = Date.now()
  const live = (id: string, leagueId: string, homeId: string, awayId: string, minute: number, hs: number, as: number, status: "LIVE" | "HT" = "LIVE") => ({
    id,
    leagueId,
    homeId,
    awayId,
    homeScore: hs,
    awayScore: as,
    status,
    minute,
    period: minute > 45 ? 2 : 1,
    clockSeconds: minute * 60,
    clockDisplay: `${minute}'`,
    kickoff: new Date(now - minute * 60_000),
  })
  await db.insert(matches).values([
    live("fx-1", "uefa.champions", "ars", "rma", 67, 2, 1),
    live("fx-2", "eng.1", "liv", "bou", 23, 0, 0),
    live("fx-3", "eng.1", "mci", "che", 45, 1, 1, "HT"),
    { id: "fx-4", leagueId: "esp.1", homeId: "bar", awayId: "sev", status: "UPCOMING" as const, kickoff: new Date(now + 3 * 3_600_000) },
  ])
  await db.insert(streams).values({ matchId: "fx-1", provider: "hls", source: "https://streams.example.com/fx-1.m3u8", quality: "HD" })
}

/** Pulls the session cookie out of a response so it can be replayed. */
export function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((c) => c.name === "pl_session")
  if (!c) throw new Error("no session cookie")
  return `pl_session=${c.value}`
}
