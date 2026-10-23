import { eq, inArray, isNotNull, sql } from "drizzle-orm"
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
export const seasonLabel = (s: string | undefined) => s?.match(/^d{4}(-d{2})?/)?.[0] ?? null

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

type EspnEvent = {
  id: string
  date: string
  status: { displayClock?: string; type: { name: string; state: "pre" | "in" | "post" } }
  competitions: { venue?: { fullName?: string }; competitors: { homeAway: "home" | "away"; score?: string; team: EspnTeam }[] }[]
}

export function mapStatus(s: EspnEvent["status"]): { status: MatchStatus; minute: number | null } {
  const name = s.type.name
  if (/POSTPONED|CANCELED|ABANDONED|SUSPENDED|DELAYED/.test(name)) return { status: "POSTPONED", minute: null }
  if (s.type.state === "pre") return { status: "UPCOMING", minute: null }
  if (s.type.state === "post") return { status: "FT", minute: null }
  if (name === "STATUS_HALFTIME") return { status: "HT", minute: 45 }
  const minute = parseInt(s.displayClock ?? "", 10)
  return { status: "LIVE", minute: Number.isFinite(minute) ? minute : null }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "")

/** Upserts yesterday/today/tomorrow fixtures for every league. Returns ids of matches that changed. */
export async function syncScoreboards(db: DB, fetcher: Fetcher = defaultFetcher, now = new Date()) {
  const allLeagues = await db.select({ id: leagues.id }).from(leagues)
  const days = [-1, 0, 1].map((o) => ymd(new Date(now.getTime() + o * 86_400_000)))
  const changed: string[] = []

  for (const { id: leagueId } of allLeagues) {
    for (const day of days) {
      let data: { events?: EspnEvent[] }
      try {
        data = (await fetcher(`${SITE}/${leagueId}/scoreboard?dates=${day}`)) as { events?: EspnEvent[] }
      } catch {
        continue
      }
      for (const ev of data.events ?? []) {
        const comp = ev.competitions[0]
        const h = comp?.competitors.find((c) => c.homeAway === "home")
        const a = comp?.competitors.find((c) => c.homeAway === "away")
        if (!comp || !h || !a) continue
        const ids = await resolveTeams(db, [h.team, a.team], leagueId)
        const { status, minute } = mapStatus(ev.status)
        const row = {
          id: `espn-${ev.id}`,
          espnId: ev.id,
          leagueId,
          homeId: ids.get(h.team.id)!,
          awayId: ids.get(a.team.id)!,
          homeScore: Number(h.score ?? 0) || 0,
          awayScore: Number(a.score ?? 0) || 0,
          status,
          minute,
          kickoff: new Date(ev.date),
          venue: comp.venue?.fullName ?? null,
        }
        const [prev] = await db.select().from(matches).where(eq(matches.id, row.id)).limit(1)
        const differs =
          !prev ||
          prev.status !== row.status ||
          prev.minute !== row.minute ||
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

export async function syncStandings(db: DB, fetcher: Fetcher = defaultFetcher) {
  const allLeagues = await db.select({ id: leagues.id }).from(leagues)
  let updated = 0
  for (const { id: leagueId } of allLeagues) {
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

    await db.transaction(async (tx) => {
      await tx.delete(standings).where(eq(standings.leagueId, leagueId))
      if (rows.length) await tx.insert(standings).values(rows)
      const season = seasonLabel(groups[0]?.standings.seasonDisplayName)
      if (season) await tx.update(leagues).set({ season, updatedAt: sql`now()` }).where(eq(leagues.id, leagueId))
    })
    updated++
  }
  return updated
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
