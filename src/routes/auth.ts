import type { FastifyInstance } from "fastify"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { favorites, teams, users } from "../db/schema.js"
import { hashPassword, verifyPassword } from "../auth/password.js"
import { SESSION_COOKIE, createSession, revokeSession } from "../auth/session.js"
import { HttpError, clearSessionCookie, notFound, parse, requireUser, currentUser, setSessionCookie, type Deps } from "../http.js"

const email = z.string().trim().toLowerCase().email().max(254)
const password = z.string().min(8, "must be at least 8 characters").max(200)

// Precomputed so failed logins for unknown emails take as long as wrong passwords.
const DUMMY_HASH = await hashPassword("pitchlive-timing-equaliser")

export async function authRoutes(app: FastifyInstance, { db, config }: Deps) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }

  app.post("/api/auth/register", strict, async (req, reply) => {
    const body = parse(z.object({ email, password, displayName: z.string().trim().min(2).max(40) }), req.body)
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1)
    if (existing) throw new HttpError(409, "An account with that email already exists")
    const [user] = await db
      .insert(users)
      .values({ email: body.email, displayName: body.displayName, passwordHash: await hashPassword(body.password) })
      .returning({ id: users.id, email: users.email, displayName: users.displayName })
    const session = await createSession(db, user!.id, config.SESSION_TTL_DAYS)
    setSessionCookie(reply, config, session.token, session.expiresAt)
    return reply.code(201).send({ user })
  })

  app.post("/api/auth/login", strict, async (req, reply) => {
    const body = parse(z.object({ email, password: z.string().max(200) }), req.body)
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1)
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH)
    if (!user || !ok) throw new HttpError(401, "Incorrect email or password")
    const session = await createSession(db, user.id, config.SESSION_TTL_DAYS)
    setSessionCookie(reply, config, session.token, session.expiresAt)
    return { user: { id: user.id, email: user.email, displayName: user.displayName } }
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
