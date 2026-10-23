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
  demo: boolean
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

/**
 * Returns a playable URL for a match. Matches with no licensed stream configured
 * get the public demo stream (clearly flagged) so the player can be developed.
 */
export async function playbackFor(db: DB, config: Config, matchId: string): Promise<Playback> {
  const [stream] = await db.select().from(streams).where(eq(streams.matchId, matchId)).limit(1)
  if (!stream) return { url: config.DEMO_STREAM_URL, provider: "hls", quality: "HD", expiresAt: null, demo: true }

  if (stream.provider === "hls") {
    return { url: stream.source, provider: "hls", quality: stream.quality, expiresAt: null, demo: stream.source === config.DEMO_STREAM_URL }
  }

  const base = `https://stream.mux.com/${stream.source}.m3u8`
  if (!stream.signed) return { url: base, provider: "mux", quality: stream.quality, expiresAt: null, demo: false }

  if (!config.MUX_SIGNING_KEY_ID || !config.MUX_SIGNING_PRIVATE_KEY) throw new Error("Mux signing keys are not configured")
  const { token, expiresAt } = signMuxToken(stream.source, config.MUX_SIGNING_KEY_ID, config.MUX_SIGNING_PRIVATE_KEY, config.PLAYBACK_TOKEN_TTL_SECONDS)
  return { url: `${base}?token=${token}`, provider: "mux", quality: stream.quality, expiresAt: expiresAt.toISOString(), demo: false }
}
