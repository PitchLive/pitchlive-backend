import { createHash, randomBytes } from "node:crypto"
import { and, eq, gt, lt } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { sessions, users } from "../db/schema.js"

export const SESSION_COOKIE = "pl_session"

export type SessionUser = { id: string; email: string; displayName: string }

const digest = (token: string) => createHash("sha256").update(token).digest("hex")

export async function createSession(db: DB, userId: string, ttlDays: number) {
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000)
  await db.insert(sessions).values({ id: digest(token), userId, expiresAt })
  return { token, expiresAt }
}

export async function userForToken(db: DB, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  const [row] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, digest(token)), gt(sessions.expiresAt, new Date())))
    .limit(1)
  return row ?? null
}

export async function revokeSession(db: DB, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.id, digest(token)))
}

export async function purgeExpiredSessions(db: DB) {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
}
