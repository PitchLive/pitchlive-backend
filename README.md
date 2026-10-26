# PitchLive API

Fastify + TypeScript backend for [PitchLive](https://github.com/PitchLive/PitchLive): leagues, clubs, tables, live scores, accounts, favourites, live chat and stream playback.

## Run it

```bash
npm install
cp .env.example .env   # optional; defaults work locally
npm run dev            # http://localhost:8787
```

Then run the frontend (`npm run dev` in the PitchLive repo). Its Vite dev server proxies `/api` (HTTP and WebSocket) to the server, so the browser sees one origin and session cookies stay first-party.

No database install is needed: without `DATABASE_URL` the server uses **PGlite** (embedded Postgres) stored in `.data/`. For production set `DATABASE_URL` to a real Postgres; migrations run on startup either way. The first boot seeds leagues, clubs and tables from `data/snapshot.json`.

| Script | Does |
|---|---|
| `npm run dev` | Start with reload |
| `npm test` | REST, auth, WebSocket, ESPN sync and live-loop tests (in-memory DB, ESPN mocked) |
| `npm run build` / `npm start` | Compile to `dist/` and run it |
| `npm run db:generate` | New SQL migration after editing `src/db/schema.ts` |
| `npm run db:seed` | Re-load the snapshot into the database |

## Data

- **Live scores** (`src/jobs/scheduler.ts`): leagues with a match in play (or kicking off within the next couple of minutes) are re-read from ESPN every 10 seconds, and every change is pushed to WebSocket subscribers at once. Each match carries ESPN's clock (`clockSeconds`, `period`, `clockDisplay`) and `clockAgeMs`, so clients can tick the clock every second between updates.
- **Other jobs**: a full sweep of every league for yesterday to tomorrow every 2 minutes while anything is live (5 otherwise), tables every 5–15 minutes, form and stadiums daily.
- All match data is real ESPN data; there is no simulated or sample data outside the test suite.
- Team ids match the frontend (`ars`, `esp-96`, `t-1929`). The seed files come from the frontend repo: `npm run data:leagues` there regenerates `server/data/snapshot.json`. Copy it and `src/leagueCatalog.json` into this repo's `data/` folder to update them.

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

Only attach streams you hold the rights to. `/api/matches/:id/playback` returns 404 for matches without one. For Mux signed playback set `MUX_SIGNING_KEY_ID` and `MUX_SIGNING_PRIVATE_KEY`, then attach with `{ "provider": "mux", "source": "<playback id>", "signed": true }`.
