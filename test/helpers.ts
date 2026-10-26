import { buildApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { openDatabase } from "../src/db/client.js"
import { seed } from "../src/db/seed.js"
import { LiveHub } from "../src/live/hub.js"
import type { DB } from "../src/db/client.js"
import { matches, streams } from "../src/db/schema.js"

export const ORIGIN = "http://localhost:8443"

export async function setup() {
  const config = loadConfig({ NODE_ENV: "test", ESPN_SYNC: "false", ADMIN_TOKEN: "test-admin-token-123456", CORS_ORIGIN: ORIGIN })
  const database = await openDatabase({ pgliteDir: "memory://" })
  await seed(database.db)
  const hub = new LiveHub()
  const app = await buildApp({ db: database.db, config, hub }, { logger: false })
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
