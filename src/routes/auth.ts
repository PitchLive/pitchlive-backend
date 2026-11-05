import type { FastifyInstance } from "fastify"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { favorites, teams, users } from "../db/schema.js"
import type { DB } from "../db/client.js"
import type { FirebaseIdentity } from "../auth/firebase.js"
import { SESSION_COOKIE, createSession, revokeSession } from "../auth/session.js"
import { HttpError, clearSessionCookie, notFound, parse, requireUser, currentUser, setSessionCookie, type Deps } from "../http.js"

const publicUser = { id: users.id, email: users.email, displayName: users.displayName }

/** The PitchLive account for a Firebase user: found by uid, linked by verified email, or created. */
async function accountFor(db: DB, id: FirebaseIdentity, requestedName?: string) {
  const [byUid] = await db.select(publicUser).from(users).where(eq(users.firebaseUid, id.uid)).limit(1)
  if (byUid) return byUid

  const [byEmail] = await db.select({ ...publicUser, firebaseUid: users.firebaseUid }).from(users).where(eq(users.email, id.email)).limit(1)
  if (byEmail) {
    // Only a verified email may claim an existing account, or anyone could sign up as someone else.
    if (!id.emailVerified) throw new HttpError(409, "An account with this email already exists. Continue with Google, or verify your email first.")
    await db.update(users).set({ firebaseUid: id.uid }).where(eq(users.id, byEmail.id))
    return { id: byEmail.id, email: byEmail.email, displayName: byEmail.displayName }
  }

  const displayName = id.name ?? requestedName ?? id.email.split("@")[0]!.slice(0, 40)
  const [created] = await db.insert(users).values({ email: id.email, firebaseUid: id.uid, displayName }).returning(publicUser)
  return created!
}

export async function authRoutes(app: FastifyInstance, { db, config, verifyIdToken }: Deps) {
  const strict = { config: { rateLimit: { max: config.AUTH_RATE_LIMIT, timeWindow: "1 minute" } } }

  // The browser signs in with Firebase, then trades the Firebase ID token for our session cookie.
  app.post("/api/auth/firebase", strict, async (req, reply) => {
    const body = parse(z.object({ idToken: z.string().min(10).max(8192), displayName: z.string().trim().min(2).max(40).optional() }), req.body)
    const identity = await verifyIdToken(body.idToken)
    const user = await accountFor(db, identity, body.displayName)
    const session = await createSession(db, user.id, config.SESSION_TTL_DAYS)
    setSessionCookie(reply, config, session.token, session.expiresAt)
    return { user }
  })

  app.post("/api/auth/logout", async (req, reply) => {
    await revokeSession(db, req.cookies[SESSION_COOKIE])
    clearSessionCookie(reply, config)
    return reply.code(204).send()
  })

  app.get("/api/auth/me", async (req) => ({ user: await currentUser(db, req) }))

  /* Favourite clubs */

  app.get("/api/me/favorites", async (req) => {
    const user = await requireUser(db, req)
    const rows = await db
      .select({ id: teams.id, name: teams.name, short: teams.short, color: teams.color, color2: teams.color2, logo: teams.logo })
      .from(favorites)
      .innerJoin(teams, eq(teams.id, favorites.teamId))
      .where(eq(favorites.userId, user.id))
      .orderBy(asc(favorites.createdAt))
    return { teams: rows }
  })

  app.put("/api/me/favorites/:teamId", async (req, reply) => {
    const user = await requireUser(db, req)
    const { teamId } = parse(z.object({ teamId: z.string().min(1).max(64) }), req.params)
    const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).limit(1)
    if (!team) throw notFound("Team")
    await db.insert(favorites).values({ userId: user.id, teamId }).onConflictDoNothing()
    return reply.code(204).send()
  })

  app.delete("/api/me/favorites/:teamId", async (req, reply) => {
    const user = await requireUser(db, req)
    const { teamId } = parse(z.object({ teamId: z.string().min(1).max(64) }), req.params)
    await db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.teamId, teamId)))
    return reply.code(204).send()
  })
}
