import { buildApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { openDatabase } from "../src/db/client.js"
import { seed } from "../src/db/seed.js"
import { LiveHub } from "../src/live/hub.js"

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

/** Pulls the session cookie out of a response so it can be replayed. */
export function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  const c = res.cookies.find((c) => c.name === "pl_session")
  if (!c) throw new Error("no session cookie")
  return `pl_session=${c.value}`
}
