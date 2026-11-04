import { and, asc, desc, eq, gte, inArray, lt, or, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { DB } from "../db/client.js"
import { leagues, matches, standings, streams, teams, type MatchStatus } from "../db/schema.js"

export type TeamSummary = { id: string; name: string; short: string; color: string; color2: string; logo: string | null }

const teamCols = { id: teams.id, name: teams.name, short: teams.short, color: teams.color, color2: teams.color2, logo: teams.logo }

/** The curated leagues shown in the directory (others are reached through countries). */
export async function listLeagues(db: DB) {
  return db.select().from(leagues).where(eq(leagues.featured, true)).orderBy(asc(leagues.sortOrder))
}

export async function getLeague(db: DB, id: string) {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, id)).limit(1)
  return league ?? null
}

export type FormEntry = {
  result: "W" | "D" | "L"
  matchId: string
  opponentId: string
  home: boolean
  scored: number
  conceded: number
  kickoff: string
}

/**
 * Each team's last five results in a competition, oldest first, from the matches we
 * hold. Up to date the moment a match ends, unlike ESPN's own form field.
 */
export async function recentForm(db: DB, leagueId: string): Promise<Map<string, FormEntry[]>> {
  const done = await db
    .select({ id: matches.id, homeId: matches.homeId, awayId: matches.awayId, homeScore: matches.homeScore, awayScore: matches.awayScore, kickoff: matches.kickoff })
    .from(matches)
    .where(and(eq(matches.leagueId, leagueId), eq(matches.status, "FT")))
    .orderBy(desc(matches.kickoff))
  const form = new Map<string, FormEntry[]>()
  const add = (team: string, entry: FormEntry) => {
    const list = form.get(team) ?? []
    if (list.length < 5) form.set(team, [...list, entry])
  }
  for (const m of done) {
    const kickoff = m.kickoff.toISOString()
    const r = (a: number, b: number) => (a > b ? "W" : a < b ? "L" : "D") as FormEntry["result"]
    add(m.homeId, { result: r(m.homeScore, m.awayScore), matchId: m.id, opponentId: m.awayId, home: true, scored: m.homeScore, conceded: m.awayScore, kickoff })
    add(m.awayId, { result: r(m.awayScore, m.homeScore), matchId: m.id, opponentId: m.homeId, home: false, scored: m.awayScore, conceded: m.homeScore, kickoff })
  }
  for (const [team, list] of form) form.set(team, list.reverse())
  return form
}

export async function leagueTable(db: DB, leagueId: string) {
  const rows = await db
    .select({ s: standings, team: teamCols })
    .from(standings)
    .innerJoin(teams, eq(teams.id, standings.teamId))
    .where(eq(standings.leagueId, leagueId))
    .orderBy(asc(standings.groupName), asc(standings.position))
  const form = await recentForm(db, leagueId)

  const groups = new Map<string, ReturnType<typeof standingView>[]>()
  for (const r of rows) {
    const key = r.s.groupName
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(standingView(r.s, r.team, form.get(r.s.teamId)))
  }
  return [...groups.entries()].map(([group, rows]) => ({ group: group || null, rows }))
}

function standingView(s: typeof standings.$inferSelect, team: TeamSummary, form?: FormEntry[]) {
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
    // Results we hold; ESPN's form string only until the season has been loaded.
    form: form?.length ? form.map((f) => f.result) : s.form.split(""),
    formDetail: form ?? [],
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
    competitions: await Promise.all(
      competitions.map(async (c) => ({
        league: c.league,
        group: c.s.groupName || null,
        standing: standingView(c.s, summary(team), (await recentForm(db, c.league.id)).get(id)),
      })),
    ),
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
    .select({ m: matches, home: homeCols, away: awayCols, stream: streams.matchId, leagueName: leagues.name })
    .from(matches)
    .leftJoin(leagues, eq(leagues.id, matches.leagueId))
    .innerJoin(home, eq(home.id, matches.homeId))
    .innerJoin(away, eq(away.id, matches.awayId))
    .leftJoin(streams, eq(streams.matchId, matches.id))
    .where(where)
    .orderBy(order === "asc" ? asc(matches.kickoff) : desc(matches.kickoff))
    .limit(limit)
  const now = Date.now()
  return rows.map((r) => ({
    id: r.m.id,
    leagueId: r.m.leagueId,
    leagueName: r.leagueName,
    status: r.m.status,
    minute: r.m.minute,
    period: r.m.period,
    clockSeconds: r.m.clockSeconds,
    clockDisplay: r.m.clockDisplay,
    // How old the clock reading is right now. Clients add their own elapsed time,
    // which avoids depending on the client's and server's clocks agreeing.
    clockAgeMs: Math.max(0, now - r.m.updatedAt.getTime()),
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
  opts: { leagueId?: string; teamId?: string; status?: MatchStatus[]; from?: Date; to?: Date; limit: number; order?: "asc" | "desc" },
) {
  const conds: (SQL | undefined)[] = [
    opts.leagueId ? eq(matches.leagueId, opts.leagueId) : undefined,
    opts.teamId ? or(eq(matches.homeId, opts.teamId), eq(matches.awayId, opts.teamId)) : undefined,
    opts.status?.length ? inArray(matches.status, opts.status) : undefined,
    opts.from ? gte(matches.kickoff, opts.from) : undefined,
    opts.to ? lt(matches.kickoff, opts.to) : undefined,
  ]
  return queryMatches(db, and(...conds), opts.limit, opts.order)
}

export async function getMatch(db: DB, id: string) {
  const [m] = await queryMatches(db, eq(matches.id, id), 1)
  return m ?? null
}
