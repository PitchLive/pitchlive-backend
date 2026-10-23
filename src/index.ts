import { buildApp } from "./app.js"
import { loadConfig } from "./config.js"
import { openDatabase } from "./db/client.js"
import { isSeeded, seed } from "./db/seed.js"
import { seedDemoMatches } from "./jobs/demo.js"
import { startJobs } from "./jobs/scheduler.js"
import { LiveHub } from "./live/hub.js"

const config = loadConfig()
const { db, close } = await openDatabase({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR })
const hub = new LiveHub()
const app = await buildApp({ db, config, hub }, { logger: { level: config.NODE_ENV === "test" ? "warn" : "info" } })

if (!(await isSeeded(db))) app.log.info(await seed(db), "database seeded from snapshot")
if (config.DEMO_MATCHES) await seedDemoMatches(db, config.DEMO_STREAM_URL)

const stopJobs = startJobs({ db, hub, log: app.log, espn: config.ESPN_SYNC, demo: config.DEMO_MATCHES })

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down")
    stopJobs()
    await app.close()
    await close()
    process.exit(0)
  })

await app.listen({ host: config.HOST, port: config.PORT })
