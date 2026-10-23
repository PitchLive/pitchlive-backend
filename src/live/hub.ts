import type { WebSocket } from "ws"
import type { MatchView } from "../services/views.js"

export type ChatView = { id: number; matchId: string; user: { id: string; displayName: string }; body: string; createdAt: string }

export type ServerEvent =
  | { type: "hello"; user: { id: string; displayName: string } | null }
  | { type: "subscribed"; topic: string }
  | { type: "match"; match: MatchView }
  | { type: "chat"; message: ChatView }
  | { type: "error"; error: string }

/**
 * In-process topic fan-out. Topics: "scores" (every match update) and
 * "match:<id>" (one match's updates and chat). For more than one server
 * instance, back publish() with Redis pub/sub.
 */
export class LiveHub {
  private topics = new Map<string, Set<WebSocket>>()
  private bySocket = new Map<WebSocket, Set<string>>()

  subscribe(ws: WebSocket, topic: string) {
    if (!this.topics.has(topic)) this.topics.set(topic, new Set())
    this.topics.get(topic)!.add(ws)
    if (!this.bySocket.has(ws)) this.bySocket.set(ws, new Set())
    this.bySocket.get(ws)!.add(topic)
  }

  unsubscribe(ws: WebSocket, topic: string) {
    this.topics.get(topic)?.delete(ws)
    this.bySocket.get(ws)?.delete(topic)
  }

  drop(ws: WebSocket) {
    for (const t of this.bySocket.get(ws) ?? []) this.topics.get(t)?.delete(ws)
    this.bySocket.delete(ws)
  }

  publish(topic: string, event: ServerEvent) {
    const sockets = this.topics.get(topic)
    if (!sockets?.size) return
    const data = JSON.stringify(event)
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(data)
  }

  publishMatch(match: MatchView) {
    const event: ServerEvent = { type: "match", match }
    this.publish("scores", event)
    this.publish(`match:${match.id}`, event)
  }

  get connectionCount() {
    return this.bySocket.size
  }

  closeAll() {
    for (const ws of this.bySocket.keys()) ws.close(1001, "server shutting down")
    this.topics.clear()
    this.bySocket.clear()
  }
}

export const send = (ws: WebSocket, event: ServerEvent) => ws.send(JSON.stringify(event))
