import { and, asc, desc, eq, gte, inArray, lt, or, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { DB } from "../db/client.js"
import { leagues, matches, standings, streams, teams, type MatchStatus } from "../db/schema.js"

export type TeamSummary = { id: string; name: string; short: string; color: string; color2: string; logo: string | null }

const teamCols = { id: teams.id, name: teams.name, short: teams.short, color: teams.color, color2: teams.color2, logo: teams.logo }

export async function listLeagues(db: DB) {
  return db.select().from(leagues).orderBy(asc(leagues.sortOrder))
}

export async function getLeague(db: DB, id: string) {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, id)).limit(1)
  return league ?? null
}

export async function leagueTable(db: DB, leagueId: string) {
  const rows = await db
    .select({ s: standings, team: teamCols })
    .from(standings)
    .innerJoin(teams, eq(teams.id, standings.teamId))
    .where(eq(standings.leagueId, leagueId))
    .orderBy(asc(standings.groupName), asc(standings.position))

  const groups = new Map<string, ReturnType<typeof standingView>[]>()
  for (const r of rows) {
    const key = r.s.groupName
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(standingView(r.s, r.team))
  }
  return [...groups.entries()].map(([group, rows]) => ({ group: group || null, rows }))
}

function standingView(s: typeof standings.$inferSelect, team: TeamSummary) {
  return {
    position: s.position,
    team,
    played: s.played,
    won: s.won,
    drawn: s.drawn,
    lost: s.lost,
    goalsFor: s.goalsFor,
    goalsAgainst: s.goalsAgainst,
    goalDifference: s.goalsFor - s.goalsAgainst,
    points: s.points,
    form: s.form.split(""),
    note: s.note,
    noteColor: s.noteColor,
  }
}

export async function searchTeams(db: DB, opts: { q?: string; leagueId?: string; limit: number }) {
  const all = await db
    .select()
    .from(teams)
    .where(opts.leagueId ? eq(teams.leagueId, opts.leagueId) : undefined)
    .orderBy(asc(teams.name))
  // Accent-insensitive match done in JS so it behaves the same on PGlite and Postgres.
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  const needle = opts.q ? fold(opts.q.trim()) : ""
  return all.filter((t) => !needle || fold(t.name).includes(needle) || fold(t.short) === needle).slice(0, opts.limit)
}

export async function getTeam(db: DB, id: string) {
  const [team] = await db.select().from(teams).where(eq(teams.id, id)).limit(1)
  if (!team) return null
  const competitions = await db
    .select({ league: { id: leagues.id, name: leagues.name, short: leagues.short }, s: standings })
    .from(standings)
    .innerJoin(leagues, eq(leagues.id, standings.leagueId))
    .where(eq(standings.teamId, id))
    .orderBy(asc(leagues.sortOrder))
  return {
    ...team,
    competitions: competitions.map((c) => ({ league: c.league, group: c.s.groupName || null, standing: standingView(c.s, summary(team)) })),
  }
}

const summary = (t: typeof teams.$inferSelect): TeamSummary => ({
  id: t.id,
  name: t.name,
  short: t.short,
  color: t.color,
  color2: t.color2,
  logo: t.logo,
})

const home = alias(teams, "home")
const away = alias(teams, "away")
const homeCols = { id: home.id, name: home.name, short: home.short, color: home.color, color2: home.color2, logo: home.logo }
const awayCols = { id: away.id, name: away.name, short: away.short, color: away.color, color2: away.color2, logo: away.logo }

export type MatchView = Awaited<ReturnType<typeof queryMatches>>[number]

async function queryMatches(db: DB, where: SQL | undefined, limit: number, order: "asc" | "desc" = "asc") {
  const rows = await db
    .select({ m: matches, home: homeCols, away: awayCols, stream: streams.matchId })
    .from(matches)
    .innerJoin(home, eq(home.id, matches.homeId))
    .innerJoin(away, eq(away.id, matches.awayId))
    .leftJoin(streams, eq(streams.matchId, matches.id))
    .where(where)
    .orderBy(order === "asc" ? asc(matches.kickoff) : desc(matches.kickoff))
    .limit(limit)
  return rows.map((r) => ({
    id: r.m.id,
    leagueId: r.m.leagueId,
    status: r.m.status,
    minute: r.m.minute,
    kickoff: r.m.kickoff.toISOString(),
    venue: r.m.venue,
    homeScore: r.m.homeScore,
    awayScore: r.m.awayScore,
    home: r.home,
    away: r.away,
    hasStream: r.stream !== null,
  }))
}

export async function listMatches(
  db: DB,
  opts: { leagueId?: string; teamId?: string; status?: MatchStatus[]; from?: Date; to?: Date; limit: number },
) {
  const conds: (SQL | undefined)[] = [
    opts.leagueId ? eq(matches.leagueId, opts.leagueId) : undefined,
    opts.teamId ? or(eq(matches.homeId, opts.teamId), eq(matches.awayId, opts.teamId)) : undefined,
    opts.status?.length ? inArray(matches.status, opts.status) : undefined,
    opts.from ? gte(matches.kickoff, opts.from) : undefined,
    opts.to ? lt(matches.kickoff, opts.to) : undefined,
  ]
  return queryMatches(db, and(...conds), opts.limit)
}

export async function getMatch(db: DB, id: string) {
  const [m] = await queryMatches(db, eq(matches.id, id), 1)
  return m ?? null
}
