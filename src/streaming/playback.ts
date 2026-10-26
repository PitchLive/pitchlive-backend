import { createSign } from "node:crypto"
import { eq } from "drizzle-orm"
import type { Config } from "../config.js"
import type { DB } from "../db/client.js"
import { streams } from "../db/schema.js"

export type Playback = {
  url: string
  provider: "mux" | "hls"
  quality: string
  expiresAt: string | null
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url")

/** RS256 JWT in the shape Mux expects for signed playback (sub = playback id, aud "v"). */
export function signMuxToken(playbackId: string, keyId: string, privateKeyB64: string, ttlSeconds: number, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSeconds
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }))
  const payload = b64url(JSON.stringify({ sub: playbackId, aud: "v", exp, kid: keyId }))
  const pem = Buffer.from(privateKeyB64, "base64").toString("utf8")
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(pem)
  return { token: `${header}.${payload}.${b64url(signature)}`, expiresAt: new Date(exp * 1000) }
}

/** Returns a playable URL for a match's licensed stream, or null when none is attached. */
export async function playbackFor(db: DB, config: Config, matchId: string): Promise<Playback | null> {
  const [stream] = await db.select().from(streams).where(eq(streams.matchId, matchId)).limit(1)
  if (!stream) return null

  if (stream.provider === "hls") return { url: stream.source, provider: "hls", quality: stream.quality, expiresAt: null }

  const base = `https://stream.mux.com/${stream.source}.m3u8`
  if (!stream.signed) return { url: base, provider: "mux", quality: stream.quality, expiresAt: null }

  if (!config.MUX_SIGNING_KEY_ID || !config.MUX_SIGNING_PRIVATE_KEY) throw new Error("Mux signing keys are not configured")
  const { token, expiresAt } = signMuxToken(stream.source, config.MUX_SIGNING_KEY_ID, config.MUX_SIGNING_PRIVATE_KEY, config.PLAYBACK_TOKEN_TTL_SECONDS)
  return { url: `${base}?token=${token}`, provider: "mux", quality: stream.quality, expiresAt: expiresAt.toISOString() }
}
