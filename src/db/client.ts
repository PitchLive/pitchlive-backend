import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core"
import * as schema from "./schema.js"

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>
export type Database = { db: DB; close: () => Promise<void> }

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle")

/**
 * Connects to Postgres when a URL is given; otherwise opens an embedded PGlite
 * database (a directory on disk, or "memory://" for tests). Runs migrations.
 */
export async function openDatabase(opts: { url?: string; pgliteDir: string }): Promise<Database> {
  if (opts.url) {
    const { default: postgres } = await import("postgres")
    const { drizzle } = await import("drizzle-orm/postgres-js")
    const { migrate } = await import("drizzle-orm/postgres-js/migrator")
    const sql = postgres(opts.url, { max: 10 })
    const db = drizzle(sql, { schema })
    await migrate(db, { migrationsFolder: MIGRATIONS })
    return { db: db as unknown as DB, close: () => sql.end() }
  }

  const { PGlite } = await import("@electric-sql/pglite")
  const { drizzle } = await import("drizzle-orm/pglite")
  const { migrate } = await import("drizzle-orm/pglite/migrator")
  if (!opts.pgliteDir.startsWith("memory://")) fs.mkdirSync(opts.pgliteDir, { recursive: true })
  const client = new PGlite(opts.pgliteDir)
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder: MIGRATIONS })
  return { db: db as unknown as DB, close: () => client.close() }
}
