import { z } from "zod"

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(8787),
  // Real Postgres in production. When unset, an embedded PGlite database is used.
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default("./.data/pglite"),
  CORS_ORIGIN: z.string().default("http://localhost:8443"),
  COOKIE_SECURE: bool.optional(),
  SESSION_TTL_DAYS: z.coerce.number().positive().default(30),
  // Firebase Auth handles sign-up and sign-in; the server only verifies its ID tokens.
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  // Sign-in attempts allowed per IP per minute.
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  ADMIN_TOKEN: z.string().min(16).optional(),
  // Background sync with ESPN's public soccer endpoints.
  ESPN_SYNC: bool.default(true),
  // Mux signed playback. Private key is the base64-encoded PEM Mux gives you.
  MUX_SIGNING_KEY_ID: z.string().optional(),
  MUX_SIGNING_PRIVATE_KEY: z.string().optional(),
  PLAYBACK_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
})

export type Config = z.infer<typeof schema> & { cookieSecure: boolean }

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.parse(env)
  return { ...parsed, cookieSecure: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === "production" }
}
