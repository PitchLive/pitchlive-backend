import type { FastifyInstance } from "fastify"
import { asc, desc, eq, inArray, lte } from "drizzle-orm"
import { z } from "zod"
import { chatMessages, matchStatuses, standings, teams, users } from "../db/schema.js"
import { notFound, parse, type Deps } from "../http.js"
import { getLeague, getMatch, getTeam, leagueTable, listLeagues, listMatches, searchTeams } from "../services/views.js"
import { getMatchDetails } from "../services/matchDetails.js"
import { catalogEntry, countries, ensureLeague, leaguesOf } from "../services/leagueCatalog.js"

const idParam = z.object({ id: z.string().min(1).max(64) })

export async function catalogRoutes(app: FastifyInstance, { db }: Deps) {
  // Stats, line-ups, key events and commentary. Live matches are refreshed by the
  // match-details job and pushed to subscribers; this serves the current copy.
  app.get("/api/matches/:id/details", async (req, reply) => {
    const { id } = parse(idParam, req.params)
    if (!(await getMatch(db, id))) throw notFound("Match")
    const result = await getMatchDetails(db, id)
    if (!result) throw notFound("Match details")
    reply.header("cache-control", "no-cache")
    return { details: result.details }
  })

  app.get("/api/leagues", async () => {
    const [all, topRows] = await Promise.all([
      listLeagues(db),
      db
        .select({
          leagueId: standings.leagueId,
          group: standings.groupName,
          position: standings.position,
          played: standings.played,
          points: standings.points,
          team: { id: teams.id, name: teams.name, short: teams.short, color: teams.color, color2: teams.color2, logo: teams.logo },
        })
        .from(standings)
        .innerJoin(teams, eq(teams.id, standings.teamId))
        .where(lte(standings.position, 3))
        .orderBy(asc(standings.groupName), asc(standings.position)),
    ])
    const counts = await db.select({ leagueId: standings.leagueId }).from(standings)
    const clubCount = new Map<string, number>()
    for (const c of counts) clubCount.set(c.leagueId, (clubCount.get(c.leagueId) ?? 0) + 1)
    return {
      leagues: all.map((l) => {
        const rows = topRows.filter((x) => x.leagueId === l.id)
        const firstGroup = rows[0]?.group
        return {
          ...l,
          clubCount: clubCount.get(l.id) ?? 0,
          // Each group's leader (MLS conferences etc.) and the first group's top three.
          leaders: rows.filter((x) => x.position === 1).map(({ group, points, team }) => ({ group: group || null, points, team })),
          top: rows.filter((x) => x.group === firstGroup).map(({ position, played, points, team }) => ({ position, played, points, team })),
        }
      }),
    }
  })

  // Countries with soccer coverage, and the competitions in each (any of them can be opened).
  app.get("/api/countries", async () => ({ countries: countries() }))

  app.get("/api/countries/:name/leagues", async (req) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(80) }), req.params)
    return { leagues: leaguesOf(name) }
  })

  app.get("/api/leagues/:id", async (req) => {
    const { id } = parse(idParam, req.params)
    if (!(await ensureLeague(db, id))) throw notFound("League")
    const league = await getLeague(db, id)
    if (!league) throw notFound("League")
    const entry = catalogEntry(id)
    return { league: { ...league, cup: entry?.cup ?? false, women: entry?.women ?? false }, table: await leagueTable(db, id) }
  })

  // A league's season: "results" (latest first) or "fixtures" (soonest first, including any in play).
  app.get("/api/leagues/:id/matches", async (req) => {
    const { id } = parse(idParam, req.params)
    const q = parse(
      z.object({
        kind: z.enum(["results", "fixtures"]).default("fixtures"),
        limit: z.coerce.number().int().min(1).max(500).default(500),
      }),
      req.query,
    )
    if (!(await ensureLeague(db, id))) throw notFound("League")
    const list =
      q.kind === "results"
        ? await listMatches(db, { leagueId: id, status: ["FT"], limit: q.limit, order: "desc" })
        : await listMatches(db, { leagueId: id, status: ["LIVE", "HT", "UPCOMING", "POSTPONED"], limit: q.limit, order: "asc" })
    return { matches: list }
  })

  app.get("/api/leagues/:id/teams", async (req) => {
    const { id } = parse(idParam, req.params)
    if (!(await ensureLeague(db, id))) throw notFound("League")
    const table = await leagueTable(db, id)
    const ids = table.flatMap((g) => g.rows.map((r) => r.team.id))
    return { teams: ids.length ? await db.select().from(teams).where(inArray(teams.id, ids)).orderBy(asc(teams.name)) : [] }
  })

  app.get("/api/teams", async (req) => {
    const q = parse(
      z.object({
        q: z.string().max(80).optional(),
        league: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      }),
      req.query,
    )
    return { teams: await searchTeams(db, { q: q.q, leagueId: q.league, limit: q.limit }) }
  })

  app.get("/api/teams/:id", async (req) => {
    const { id } = parse(idParam, req.params)
    const team = await getTeam(db, id)
    if (!team) throw notFound("Team")
    return { team }
  })

  app.get("/api/teams/:id/matches", async (req) => {
    const { id } = parse(idParam, req.params)
    return { matches: await listMatches(db, { teamId: id, limit: 200 }) }
  })

  app.get("/api/matches", async (req) => {
    const q = parse(
      z.object({
        status: z
          .string()
          .transform((s) => s.split(",").map((x) => x.trim().toUpperCase()))
          .pipe(z.array(z.enum(matchStatuses)))
          .optional(),
        league: z.string().max(64).optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    )
    const from = q.date ? new Date(`${q.date}T00:00:00Z`) : undefined
    const to = from ? new Date(from.getTime() + 86_400_000) : undefined
    return { matches: await listMatches(db, { status: q.status, leagueId: q.league, from, to, limit: q.limit }) }
  })

  app.get("/api/matches/:id", async (req) => {
    const { id } = parse(idParam, req.params)
    const match = await getMatch(db, id)
    if (!match) throw notFound("Match")
    const chat = await db
      .select({ id: chatMessages.id, body: chatMessages.body, createdAt: chatMessages.createdAt, user: { id: users.id, displayName: users.displayName } })
      .from(chatMessages)
      .innerJoin(users, eq(users.id, chatMessages.userId))
      .where(eq(chatMessages.matchId, id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(50)
    return { match, chat: chat.reverse().map((c) => ({ ...c, matchId: id, createdAt: c.createdAt.toISOString() })) }
  })
}
