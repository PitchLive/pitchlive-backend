import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { chatMessages } from "../db/schema.js"
import { send } from "../live/hub.js"
import { allowedOrigins, currentUser, type Deps } from "../http.js"
import { getMatch } from "../services/views.js"

const clientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), topic: z.string().regex(/^(scores|match:[\w.-]{1,64})$/) }),
  z.object({ type: z.literal("unsubscribe"), topic: z.string().max(80) }),
  z.object({ type: z.literal("chat"), matchId: z.string().min(1).max(64), body: z.string().trim().min(1).max(280) }),
])

const CHAT_INTERVAL_MS = 1500

/**
 * One socket per client. Client → server:
 *   {type:"subscribe", topic:"scores" | "match:<id>"}, {type:"unsubscribe", topic}, {type:"chat", matchId, body}
 * Server → client: hello, subscribed, match, chat, error (see live/hub.ts).
 */
export async function liveRoutes(app: FastifyInstance, { db, config, hub }: Deps) {
  app.get("/api/live", { websocket: true }, async (socket, req) => {
    // Browsers always send Origin on WebSocket upgrades; reject other sites (cross-site WebSocket hijacking).
    const origin = req.headers.origin
    if (origin && !allowedOrigins(config).includes(origin)) {
      socket.close(1008, "origin not allowed")
      return
    }

    const user = await currentUser(db, req)
    let lastChat = 0
    let alive = true
    socket.on("pong", () => (alive = true))
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate()
      alive = false
      socket.ping()
    }, 30_000)

    socket.on("close", () => {
      clearInterval(heartbeat)
      hub.drop(socket)
    })

    socket.on("message", async (raw) => {
      let msg: z.infer<typeof clientMessage>
      try {
        msg = clientMessage.parse(JSON.parse(raw.toString()))
      } catch {
        return send(socket, { type: "error", error: "Invalid message" })
      }

      if (msg.type === "subscribe") {
        hub.subscribe(socket, msg.topic)
        send(socket, { type: "subscribed", topic: msg.topic })
        if (msg.topic.startsWith("match:")) {
          const match = await getMatch(db, msg.topic.slice(6))
          if (match) send(socket, { type: "match", match })
        }
        return
      }

      if (msg.type === "unsubscribe") return hub.unsubscribe(socket, msg.topic)

      if (!user) return send(socket, { type: "error", error: "Sign in to chat" })
      if (Date.now() - lastChat < CHAT_INTERVAL_MS) return send(socket, { type: "error", error: "Slow down" })
      if (!(await getMatch(db, msg.matchId))) return send(socket, { type: "error", error: "Match not found" })
      lastChat = Date.now()
      const [row] = await db.insert(chatMessages).values({ matchId: msg.matchId, userId: user.id, body: msg.body }).returning()
      hub.publish(`match:${msg.matchId}`, {
        type: "chat",
        message: { id: row!.id, matchId: msg.matchId, body: row!.body, createdAt: row!.createdAt.toISOString(), user: { id: user.id, displayName: user.displayName } },
      })
    })

    send(socket, { type: "hello", user: user && { id: user.id, displayName: user.displayName } })
  })
}
