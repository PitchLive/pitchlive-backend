# PitchLive API

Fastify + TypeScript backend for PitchLive: leagues, clubs, tables, live scores, accounts, favourites, live chat and stream playback.

## Run it

```bash
cd server
npm install
cp .env.example .env   # optional; defaults work locally
npm run dev            # http://localhost:8787
```

Then run the frontend (`npm run dev` in the project root). Vite proxies `/api` (HTTP and WebSocket) to the server, so the browser sees one origin and session cookies stay first-party.

No database install is needed: without `DATABASE_URL` the server uses **PGlite** (embedded Postgres) stored in `server/.data/`. For production set `DATABASE_URL` to a real Postgres; migrations run on startup either way. The first boot seeds leagues, clubs and tables from `data/snapshot.json`.

| Script | Does |
|---|---|
| `npm run dev` | Start with reload |
| `npm test` | 20 tests: REST, auth, WebSocket, ESPN sync (in-memory DB, ESPN mocked) |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run db:generate` | New SQL migration after editing `src/db/schema.ts` |
| `npm run db:seed` | Re-load the snapshot into the database |

## Data

- **Background jobs** (`src/jobs/`): fixtures and scores from ESPN every minute while a match is live (otherwise every 5 minutes), tables every 15 minutes, form and stadiums daily. Score changes are pushed to WebSocket subscribers.
- **Demo matches** (`DEMO_MATCHES=true`): four simulated live games with the public Mux test stream, so the player and live updates can be built offline. These are not real.
- Team ids match the frontend (`ars`, `esp-96`, `t-1929`). `npm run data:leagues` in the project root refreshes both the frontend data and `data/snapshot.json`.

## API

All responses are JSON. Writes need `Content-Type: application/json`, and requests carrying an `Origin` must come from `CORS_ORIGIN`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | |
| GET | `/api/leagues` | With leaders and club counts |
| GET | `/api/leagues/:id` | `id` is the ESPN slug (`eng.1`); league + table groups |
| GET | `/api/leagues/:id/teams` | |
| GET | `/api/teams?q=&league=&limit=` | Accent-insensitive search |
| GET | `/api/teams/:id` | Club, stadium, every competition standing |
| GET | `/api/teams/:id/matches` | |
| GET | `/api/matches?status=LIVE,HT&league=&date=YYYY-MM-DD` | |
| GET | `/api/matches/:id` | Match + last 50 chat messages |
| GET | `/api/matches/:id/playback` | Signed in. Stream URL (Mux tokens signed server-side) |
| POST | `/api/auth/register` | `{email, password, displayName}`; sets `pl_session` cookie |
| POST | `/api/auth/login` · `/api/auth/logout` | Rate limited to 10/min |
| GET | `/api/auth/me` | `{user}` or `{user: null}` |
| GET · PUT · DELETE | `/api/me/favorites[/:teamId]` | Signed in |
| POST | `/api/admin/sync` | Bearer `ADMIN_TOKEN`; `{job: "scoreboards" \| "standings" \| "teams" \| "seed"}` |
| PUT | `/api/admin/matches/:id/stream` | Bearer `ADMIN_TOKEN`; attach a licensed stream |

### WebSocket `/api/live`

```jsonc
// client → server
{ "type": "subscribe", "topic": "scores" }          // every score change
{ "type": "subscribe", "topic": "match:espn-401879253" }
{ "type": "chat", "matchId": "espn-401879253", "body": "What a goal!" }  // signed in, max 280 chars

// server → client
{ "type": "hello", "user": { "id": "…", "displayName": "…" } | null }
{ "type": "match", "match": { …same shape as /api/matches… } }
{ "type": "chat", "message": { "id": 1, "body": "…", "user": { … }, "createdAt": "…" } }
{ "type": "error", "error": "Sign in to chat" }
```

## Security notes

- Passwords: scrypt with per-user salt. Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production); only its SHA-256 is stored.
- CSRF: cross-origin writes and WebSocket upgrades are rejected by `Origin`.
- Live chat is limited to one message per 1.5 s per connection.
- The live hub is in-process. Before running more than one instance, back `LiveHub.publish` with Redis pub/sub.

## Streaming

Only attach streams you hold the rights to. Matches without a configured stream return the public demo stream with `demo: true`. For Mux signed playback set `MUX_SIGNING_KEY_ID` and `MUX_SIGNING_PRIVATE_KEY`, then attach with `{ "provider": "mux", "source": "<playback id>", "signed": true }`.
