import type { FastifyReply, FastifyRequest } from "fastify"
import type { z } from "zod"
import type { Config } from "./config.js"
import type { DB } from "./db/client.js"
import type { LiveHub } from "./live/hub.js"
import { SESSION_COOKIE, userForToken, type SessionUser } from "./auth/session.js"

export type Deps = { db: DB; config: Config; hub: LiveHub }

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new HttpError(400, issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request")
  }
  return result.data
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`)

export async function currentUser(db: DB, req: FastifyRequest): Promise<SessionUser | null> {
  return userForToken(db, req.cookies[SESSION_COOKIE])
}

export async function requireUser(db: DB, req: FastifyRequest): Promise<SessionUser> {
  const user = await currentUser(db, req)
  if (!user) throw new HttpError(401, "Sign in required")
  return user
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: config.cookieSecure })
}

export const allowedOrigins = (config: Config) => config.CORS_ORIGIN.split(",").map((o) => o.trim())
