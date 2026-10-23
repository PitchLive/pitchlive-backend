import type { FastifyInstance } from "fastify"
import { asc, desc, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { chatMessages, matchStatuses, standings, teams, users } from "../db/schema.js"
import { notFound, parse, type Deps } from "../http.js"
import { getLeague, getMatch, getTeam, leagueTable, listLeagues, listMatches, searchTeams } from "../services/views.js"

const idParam = z.object({ id: z.string().min(1).max(64) })

export async function catalogRoutes(app: FastifyInstance, { db }: Deps) {
  app.get("/api/leagues", async () => {
    const [all, leaders] = await Promise.all([
      listLeagues(db),
      db
        .select({ leagueId: standings.leagueId, group: standings.groupName, points: standings.points, team: { id: teams.id, name: teams.name, short: teams.short, logo: teams.logo } })
        .from(standings)
        .innerJoin(teams, eq(teams.id, standings.teamId))
        .where(eq(standings.position, 1)),
    ])
    const counts = await db.select({ leagueId: standings.leagueId }).from(standings)
    const clubCount = new Map<string, number>()
    for (const c of counts) clubCount.set(c.leagueId, (clubCount.get(c.leagueId) ?? 0) + 1)
    return {
      leagues: all.map((l) => ({
        ...l,
        clubCount: clubCount.get(l.id) ?? 0,
        leaders: leaders.filter((x) => x.leagueId === l.id).map(({ leagueId: _, group, ...rest }) => ({ group: group || null, ...rest })),
      })),
    }
  })

  app.get("/api/leagues/:id", async (req) => {
    const { id } = parse(idParam, req.params)
    const league = await getLeague(db, id)
    if (!league) throw notFound("League")
    return { league, table: await leagueTable(db, id) }
  })

  app.get("/api/leagues/:id/teams", async (req) => {
    const { id } = parse(idParam, req.params)
    if (!(await getLeague(db, id))) throw notFound("League")
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
    return { matches: await listMatches(db, { teamId: id, limit: 50 }) }
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
