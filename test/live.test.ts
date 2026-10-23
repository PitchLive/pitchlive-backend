import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { WebSocket } from "ws"
import { seedDemoMatches } from "../src/jobs/demo.js"
import { getMatch } from "../src/services/views.js"
import { ORIGIN, sessionCookie, setup } from "./helpers.js"

let ctx: Awaited<ReturnType<typeof setup>>
let url: string
let cookie: string

before(async () => {
  ctx = await setup()
  await seedDemoMatches(ctx.db, ctx.config.DEMO_STREAM_URL)
  await ctx.app.listen({ port: 0, host: "127.0.0.1" })
  const addr = ctx.app.server.address() as { port: number }
  url = `ws://127.0.0.1:${addr.port}/api/live`
  const reg = await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: "chat@x.io", password: "longenough1", displayName: "Chatter" } })
  cookie = sessionCookie(reg)
})
after(() => ctx.close())

/** Opens a socket and returns a function that resolves with the next message matching a predicate. */
async function connect(headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers: { origin: ORIGIN, ...headers } })
  const inbox: any[] = []
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = []
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString())
    const i = waiters.findIndex((w) => w.pred(msg))
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg)
    else inbox.push(msg)
  })
  await new Promise((r) => ws.once("open", r))
  const next = (pred: (m: any) => boolean) =>
    new Promise<any>((resolve, reject) => {
      const i = inbox.findIndex(pred)
      if (i >= 0) return resolve(inbox.splice(i, 1)[0])
      waiters.push({ pred, resolve })
      setTimeout(() => reject(new Error("timed out waiting for message")), 3000)
    })
  return { ws, next, send: (m: unknown) => ws.send(JSON.stringify(m)) }
}

describe("live socket", () => {
  it("greets anonymous and signed-in users", async () => {
    const anon = await connect()
    assert.equal((await anon.next((m) => m.type === "hello")).user, null)
    const signed = await connect({ cookie })
    assert.equal((await signed.next((m) => m.type === "hello")).user.displayName, "Chatter")
    anon.ws.close()
    signed.ws.close()
  })

  it("pushes the current match on subscribe and later score updates", async () => {
    const c = await connect()
    c.send({ type: "subscribe", topic: "match:demo-1" })
    const first = await c.next((m) => m.type === "match")
    assert.equal(first.match.id, "demo-1")

    c.send({ type: "subscribe", topic: "scores" })
    await c.next((m) => m.type === "subscribed" && m.topic === "scores")
    ctx.hub.publishMatch((await getMatch(ctx.db, "demo-2"))!)
    assert.equal((await c.next((m) => m.type === "match")).match.id, "demo-2")
    c.ws.close()
  })

  it("broadcasts chat to match subscribers and rejects anonymous chat", async () => {
    const viewer = await connect()
    viewer.send({ type: "subscribe", topic: "match:demo-1" })
    await viewer.next((m) => m.type === "subscribed")

    const anon = await connect()
    anon.send({ type: "chat", matchId: "demo-1", body: "hi" })
    assert.equal((await anon.next((m) => m.type === "error")).error, "Sign in to chat")

    const author = await connect({ cookie })
    author.send({ type: "chat", matchId: "demo-1", body: "  What a goal!  " })
    const msg = await viewer.next((m) => m.type === "chat")
    assert.equal(msg.message.body, "What a goal!")
    assert.equal(msg.message.user.displayName, "Chatter")

    author.send({ type: "chat", matchId: "demo-1", body: "again" })
    assert.equal((await author.next((m) => m.type === "error")).error, "Slow down")

    const history = (await ctx.app.inject("/api/matches/demo-1")).json().chat
    assert.equal(history.at(-1).body, "What a goal!")
    for (const c of [viewer, anon, author]) c.ws.close()
  })

  it("rejects bad messages and foreign origins", async () => {
    const c = await connect()
    c.send({ type: "subscribe", topic: "anything" })
    assert.equal((await c.next((m) => m.type === "error")).error, "Invalid message")
    c.ws.close()

    const evil = new WebSocket(url, { headers: { origin: "https://evil.example" } })
    const code = await new Promise((r) => evil.on("close", (code) => r(code)))
    assert.equal(code, 1008)
  })
})
