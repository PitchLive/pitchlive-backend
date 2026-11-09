import { asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { leagues, matches, standings, teams, type MatchStatus } from "../db/schema.js"

const SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
const STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer"
const CORE = "https://sports.core.api.espn.com/v2/sports/soccer/leagues"

type Fetcher = (url: string) => Promise<unknown>

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`)
  return res.json()
}

/** "2026-27 English Premier League" → "2026-27" */
export const seasonLabel = (s: string | undefined) => s?.match(/^\d{4}(-\d{2})?/)?.[0] ?? null

const hex = (c: unknown, fallback: string) => (typeof c === "string" && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : fallback)

type EspnTeam = { id: string; displayName: string; abbreviation?: string; location?: string; color?: string; alternateColor?: string; logo?: string; logos?: { href: string }[] }

/** Resolve ESPN team ids to app ids, creating clubs we haven't seen (cup opponents, promoted sides). */
async function resolveTeams(db: DB, espnTeams: EspnTeam[], leagueId: string | null) {
  const ids = [...new Set(espnTeams.map((t) => t.id))]
  if (!ids.length) return new Map<string, string>()
  const known = await db.select({ id: teams.id, espnId: teams.espnId }).from(teams).where(inArray(teams.espnId, ids))
  const map = new Map(known.map((k) => [k.espnId!, k.id]))
  for (const t of espnTeams) {
    if (map.has(t.id)) continue
    const id = `t-${t.id}`
    await db
      .insert(teams)
      .values({
        id,
        espnId: t.id,
        name: t.displayName,
        short: t.abbreviation ?? t.displayName.slice(0, 3).toUpperCase(),
        city: t.location ?? null,
        color: hex(t.color, "#334155"),
        color2: hex(t.alternateColor, "#ffffff"),
        logo: t.logo ?? t.logos?.[0]?.href ?? null,
        leagueId: leagueId?.startsWith("uefa") ? null : leagueId,
      })
      .onConflictDoNothing()
    map.set(t.id, id)
  }
  return map
}

/* ───────────── Live scores ───────────── */

export type EspnEvent = {
  id: string
  date: string
  status: { clock?: number; displayClock?: string; period?: number; type: { name: string; state: "pre" | "in" | "post" } }
  competitions: { venue?: { fullName?: string }; competitors: { homeAway: "home" | "away"; score?: string; team: EspnTeam }[] }[]
}

type Clock = { status: MatchStatus; minute: number | null; period: number | null; clockSeconds: number | null; clockDisplay: string | null }

export function mapStatus(s: EspnEvent["status"]): Clock {
  const name = s.type.name
  const none = { minute: null, period: null, clockSeconds: null, clockDisplay: null }
  if (/POSTPONED|CANCELED|ABANDONED|SUSPENDED|DELAYED/.test(name)) return { status: "POSTPONED", ...none }
  if (s.type.state === "pre") return { status: "UPCOMING", ...none }
  if (s.type.state === "post") return { status: "FT", ...none }
  const period = s.period ?? null
  const clockSeconds = typeof s.clock === "number" ? Math.floor(s.clock) : null
  const clockDisplay = s.displayClock ?? null
  if (name === "STATUS_HALFTIME") return { status: "HT", minute: 45, period, clockSeconds, clockDisplay }
  const minute = parseInt(s.displayClock ?? "", 10)
  return { status: "LIVE", minute: Number.isFinite(minute) ? minute : null, period, clockSeconds, clockDisplay }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "")

/**
 * Writes ESPN events for one league, returning ids of matches that are new or changed.
 * Team lookups and existing rows are loaded in bulk, so a whole season is cheap.
 */
export async function upsertEvents(db: DB, leagueId: string, events: EspnEvent[]) {
  const usable = events.flatMap((ev) => {
    const comp = ev.competitions[0]
    const h = comp?.competitors.find((c) => c.homeAway === "home")
    const a = comp?.competitors.find((c) => c.homeAway === "away")
    return comp && h && a ? [{ ev, comp, h, a }] : []
  })
  if (!usable.length) return []
  const ids = await resolveTeams(db, usable.flatMap((u) => [u.h.team, u.a.team]), leagueId)
  const existing = new Map<string, typeof matches.$inferSelect>()
  const matchIds = usable.map((u) => `espn-${u.ev.id}`)
  for (let i = 0; i < matchIds.length; i += 500)
    for (const m of await db.select().from(matches).where(inArray(matches.id, matchIds.slice(i, i + 500)))) existing.set(m.id, m)

  const changed: string[] = []
  for (const { ev, comp, h, a } of usable) {
    const row = {
      id: `espn-${ev.id}`,
      espnId: ev.id,
      leagueId,
      homeId: ids.get(h.team.id)!,
      awayId: ids.get(a.team.id)!,
      homeScore: Number(h.score ?? 0) || 0,
      awayScore: Number(a.score ?? 0) || 0,
      ...mapStatus(ev.status),
      kickoff: new Date(ev.date),
      venue: comp.venue?.fullName ?? null,
    }
    const prev = existing.get(row.id)
    const differs =
      !prev ||
      prev.status !== row.status ||
      prev.minute !== row.minute ||
      prev.period !== row.period ||
      prev.clockSeconds !== row.clockSeconds ||
      prev.homeScore !== row.homeScore ||
      prev.awayScore !== row.awayScore ||
      prev.kickoff.getTime() !== row.kickoff.getTime()
    if (!differs) continue
    await db
      .insert(matches)
      .values(row)
      .onConflictDoUpdate({ target: matches.id, set: { ...row, updatedAt: sql`now()` } })
    changed.push(row.id)
  }
  return changed
}

/** Leagues the background jobs keep fresh: curated ones, plus any opened in the last day. */
export const ACTIVE_WINDOW_MS = 24 * 60 * 60_000
export async function activeLeagueIds(db: DB, now = new Date()) {
  const rows = await db
    .select({ id: leagues.id })
    .from(leagues)
    .where(or(eq(leagues.featured, true), gt(leagues.lastViewedAt, new Date(now.getTime() - ACTIVE_WINDOW_MS))))
  return rows.map((r) => r.id)
}

async function leagueIds(db: DB, only?: string[]) {
  return only ?? (await activeLeagueIds(db))
}

/**
 * Upserts fixtures from ESPN scoreboards and returns the ids of matches that changed.
 * Defaults to every league for yesterday/today/tomorrow; the live loop narrows both.
 */
export async function syncScoreboards(
  db: DB,
  fetcher: Fetcher = defaultFetcher,
  now = new Date(),
  opts: { leagues?: string[]; days?: number[] } = {},
) {
  const days = (opts.days ?? [-1, 0, 1]).map((o) => ymd(new Date(now.getTime() + o * 86_400_000)))
  const changed: string[] = []
  for (const leagueId of await leagueIds(db, opts.leagues)) {
    for (const day of days) {
      try {
        const data = (await fetcher(`${SITE}/${leagueId}/scoreboard?dates=${day}`)) as { events?: EspnEvent[] }
        changed.push(...(await upsertEvents(db, leagueId, data.events ?? [])))
      } catch {
        continue
      }
    }
  }
  return changed
}

type EspnLeagueInfo = { leagues?: { season?: { startDate?: string; endDate?: string } }[] }

/**
 * Every result and fixture of each league's current season. ESPN reports the season
 * window (Aug–May in Europe, the calendar year in MLS/Brazil/Argentina) and accepts a
 * whole year per request, so a season takes two or three requests per league.
 */
export async function syncSeason(db: DB, fetcher: Fetcher = defaultFetcher, opts: { leagues?: string[] } = {}) {
  const changed: string[] = []
  for (const leagueId of await leagueIds(db, opts.leagues)) {
    try {
      const info = (await fetcher(`${SITE}/${leagueId}/scoreboard`)) as EspnLeagueInfo
      const season = info.leagues?.[0]?.season
      if (!season?.startDate || !season.endDate) continue
      const start = new Date(season.startDate)
      const end = new Date(season.endDate)
      const events: EspnEvent[] = []
      for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) {
        const data = (await fetcher(`${SITE}/${leagueId}/scoreboard?dates=${y}&limit=1000`)) as { events?: EspnEvent[] }
        for (const ev of data.events ?? []) {
          const t = new Date(ev.date)
          if (t >= start && t <= end) events.push(ev)
        }
      }
      changed.push(...(await upsertEvents(db, leagueId, events)))
    } catch {
      continue
    }
  }
  return changed
}

/* ───────────── Standings ───────────── */

type EspnStandingsGroup = {
  name?: string
  standings: {
    seasonDisplayName?: string
    entries: { team: EspnTeam; note?: { description?: string; color?: string }; stats: { name: string; value?: number }[] }[]
  }
}

const tableFingerprint = (rows: { groupName: string; teamId: string; played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number; points: number; note: string | null }[]) =>
  rows.map((r) => [r.groupName, r.teamId, r.played, r.won, r.drawn, r.lost, r.goalsFor, r.goalsAgainst, r.points, r.note ?? ""].join(":")).join("|")

/**
 * Replaces league tables from ESPN. Defaults to every league; `leagues` narrows it.
 * Returns the ids of leagues whose table actually changed, so clients can be told.
 */
export async function syncStandings(db: DB, fetcher: Fetcher = defaultFetcher, opts: { leagues?: string[] } = {}) {
  const changed: string[] = []
  for (const leagueId of await leagueIds(db, opts.leagues)) {
    let data: { children?: EspnStandingsGroup[] } & Partial<EspnStandingsGroup>
    try {
      data = (await fetcher(`${STANDINGS}/${leagueId}/standings`)) as typeof data
    } catch {
      continue
    }
    const groups: EspnStandingsGroup[] = data.children?.length ? data.children : data.standings ? [data as EspnStandingsGroup] : []
    if (!groups.length) continue
    const ids = await resolveTeams(db, groups.flatMap((g) => g.standings.entries.map((e) => e.team)), leagueId)
    // Form isn't in this feed; keep what the daily detail sync stored.
    const prevForm = new Map(
      (await db.select({ teamId: standings.teamId, form: standings.form }).from(standings).where(eq(standings.leagueId, leagueId))).map((r) => [
        r.teamId,
        r.form,
      ]),
    )

    const rows = groups.flatMap((g) => {
      const entries = g.standings.entries.map((e) => {
        const st = Object.fromEntries(e.stats.map((s) => [s.name, s.value ?? 0]))
        const teamId = ids.get(e.team.id)!
        return {
          leagueId,
          teamId,
          groupName: groups.length > 1 ? (g.name ?? "") : "",
          position: 0,
          played: st.gamesPlayed ?? 0,
          won: st.wins ?? 0,
          drawn: st.ties ?? 0,
          lost: st.losses ?? 0,
          goalsFor: st.pointsFor ?? 0,
          goalsAgainst: st.pointsAgainst ?? 0,
          points: st.points ?? 0,
          form: prevForm.get(teamId) ?? "",
          note: e.note?.description ?? null,
          noteColor: e.note?.color ?? null,
        }
      })
      // Some feeds (MLS) aren't ordered by points; keep ESPN order only when it already is.
      if (entries.some((r, i) => i > 0 && entries[i - 1]!.points < r.points))
        entries.sort((x, y) => y.points - x.points || y.goalsFor - y.goalsAgainst - (x.goalsFor - x.goalsAgainst) || y.goalsFor - x.goalsFor)
      return entries.map((r, i) => ({ ...r, position: i + 1 }))
    })

    const before = await db.select().from(standings).where(eq(standings.leagueId, leagueId)).orderBy(asc(standings.groupName), asc(standings.position))
    const sameTable = tableFingerprint(before) === tableFingerprint([...rows].sort((a, b) => a.groupName.localeCompare(b.groupName) || a.position - b.position))

    await db.transaction(async (tx) => {
      if (!sameTable) {
        await tx.delete(standings).where(eq(standings.leagueId, leagueId))
        if (rows.length) await tx.insert(standings).values(rows)
      }
      // updatedAt doubles as "table last checked", which the site shows next to each table.
      const season = seasonLabel(groups[0]?.standings.seasonDisplayName)
      await tx
        .update(leagues)
        .set({ ...(season ? { season } : {}), updatedAt: sql`now()` })
        .where(eq(leagues.id, leagueId))
    })
    if (!sameTable) changed.push(leagueId)
  }
  return changed
}

/* ───────────── Club details (form, venue) ───────────── */

type CoreTeam = { form?: string; venue?: { fullName?: string; address?: { city?: string; country?: string } } }

export async function syncTeamDetails(db: DB, fetcher: Fetcher = defaultFetcher, concurrency = 8) {
  const all = await db
    .select({ id: teams.id, espnId: teams.espnId, home: teams.leagueId, leagueId: standings.leagueId })
    .from(teams)
    .innerJoin(standings, eq(standings.teamId, teams.id))
    .where(isNotNull(teams.espnId))
  // One request per club, preferring its domestic league over UEFA competitions.
  const byTeam = new Map<string, (typeof all)[number]>()
  for (const r of all) if (!byTeam.has(r.id) || r.leagueId === r.home) byTeam.set(r.id, r)
  const rows = [...byTeam.values()]
  const year = new Date().getUTCFullYear()
  let i = 0
  let updated = 0

  const work = async () => {
    while (i < rows.length) {
      const r = rows[i++]!
      // Season ids differ by calendar (2026 = 2026-27 in Europe, calendar year in MLS/Brazil); try both.
      let d: CoreTeam | null = null
      for (const season of [year, year - 1]) {
        try {
          d = (await fetcher(`${CORE}/${r.leagueId}/seasons/${season}/teams/${r.espnId}?lang=en&region=us`)) as CoreTeam
          break
        } catch {}
      }
      if (!d) continue
      const form = (d.form ?? "").replace(/[^WDL]/g, "").slice(-5)
      await db.update(standings).set({ form }).where(eq(standings.teamId, r.id))
      await db
        .update(teams)
        .set({
          ...(d.venue?.fullName ? { stadium: d.venue.fullName } : {}),
          ...(d.venue?.address?.city ? { city: d.venue.address.city } : {}),
          ...(d.venue?.address?.country ? { country: d.venue.address.country } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(teams.id, r.id))
      updated++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, work))
  return updated
}
