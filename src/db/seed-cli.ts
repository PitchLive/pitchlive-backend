import { loadConfig } from "../config.js"
import { openDatabase } from "./client.js"
import { seed } from "./seed.js"

const config = loadConfig()
const { db, close } = await openDatabase({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR })
console.log(await seed(db))
await close()
