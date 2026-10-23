import Fastify, { type FastifyServerOptions } from "fastify"
import cookie from "@fastify/cookie"
import cors from "@fastify/cors"
import rateLimit from "@fastify/rate-limit"
import websocket from "@fastify/websocket"
import { sql } from "drizzle-orm"
import { HttpError, allowedOrigins, type Deps } from "./http.js"
import { catalogRoutes } from "./routes/catalog.js"
import { authRoutes } from "./routes/auth.js"
import { liveRoutes } from "./routes/live.js"
import { streamingRoutes } from "./routes/streaming.js"
import { adminRoutes } from "./routes/admin.js"

export async function buildApp(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify({ trustProxy: true, bodyLimit: 64 * 1024, ...opts })
  const origins = allowedOrigins(deps.config)

  await app.register(cookie)
  await app.register(cors, { origin: origins, credentials: true, methods: ["GET", "POST", "PUT", "DELETE"] })
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" })
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } })

  // Cookie-authenticated writes must come from our own frontend (CSRF defence on top of SameSite=Lax).
  app.addHook("onRequest", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return
    const origin = req.headers.origin
    if (origin && !origins.includes(origin)) throw new HttpError(403, "Origin not allowed")
  })

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode ?? 500
    if (status >= 500) req.log.error(err)
    reply.code(status).send({ error: status >= 500 ? "Internal server error" : err.message })
  })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }))

  app.get("/api/health", async () => {
    await deps.db.execute(sql`select 1`)
    return { ok: true, connections: deps.hub.connectionCount }
  })

  await app.register(catalogRoutes, deps)
  await app.register(authRoutes, deps)
  await app.register(streamingRoutes, deps)
  await app.register(liveRoutes, deps)
  await app.register(adminRoutes, deps)

  app.addHook("onClose", async () => deps.hub.closeAll())
  return app
}
