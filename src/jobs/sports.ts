import { and, between, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { leagues, matches, teams, type MatchStatus } from "../db/schema.js"
import { defaultFetcher } from "./espn.js"

/*
 * Sports besides football, from the same ESPN scoreboards. Team sports share one event shape
 * (home/away, score, period scores); tennis lists tournaments whose draws hold the matches.
 * Everything lands in the same leagues/teams/matches tables, tagged with its sport:
 *   league  "basketball.nba", "tennis.148-2026.mens-singles"
 *   team    "basketball-18" (espn id "basketball:18"), tennis players "tennis-2970"
 *   match   "espn-basketball-401810001"
 * so ESPN's per-sport id ranges can't collide with football's.
 */

export const SPORT_LEAGUES = {
  basketball: [
    { slug: "nba", name: "NBA", country: "USA" },
    { slug: "wnba", name: "WNBA", country: "USA" },
    { slug: "mens-college-basketball", name: "NCAA Men's Basketball", country: "USA" },
  ],
  football: [
    { slug: "nfl", name: "NFL", country: "USA" },
    { slug: "college-football", name: "NCAA Football", country: "USA" },
  ],
  hockey: [{ slug: "nhl", name: "NHL", country: "USA & Canada" }],
  baseball: [{ slug: "mlb", name: "MLB", country: "USA & Canada" }],
  tennis: [
    { slug: "atp", name: "ATP", country: "ATP" },
    { slug: "wta", name: "WTA", country: "WTA" },
  ],
} as const

export type OtherSport = keyof typeof SPORT_LEAGUES
export type Sport = "soccer" | OtherSport
export const SPORTS = ["soccer", ...(Object.keys(SPORT_LEAGUES) as OtherSport[])] as const

/** The sport a league id belongs to ("basketball.nba" → basketball; football slugs like "eng.1" → soccer). */
export function sportOfLeague(id: string | null | undefined): Sport {
  const head = id?.split(".")[0] ?? ""
  return head in SPORT_LEAGUES ? (head as OtherSport) : "soccer"
}

type Fetcher = (url: string) => Promise<unknown>
const SITE = "https://site.api.espn.com/apis/site/v2/sports"
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "")
const hex = (c: unknown, fallback: string) => (typeof c === "string" && /^[0-9a-f]{6}$/i.test(c) ? `#${c}` : fallback)

export type Linescores = { home: number[]; away: number[]; homeTb?: (number | null)[]; awayTb?: (number | null)[] }

type EspnStatus = { displayClock?: string; period?: number; type: { name: string; state: "pre" | "in" | "post"; shortDetail?: string; description?: string } }
type EspnLine = { value?: number; tiebreak?: number; winner?: boolean }
type EspnTeam = { id: string; displayName: string; abbreviation?: string; location?: string; color?: string; alternateColor?: string; logo?: string }
type EspnAthlete = { displayName?: string; shortName?: string; flag?: { href?: string; alt?: string } }
type EspnCompetitor = {
  id?: string
  homeAway?: "home" | "away"
  order?: number
  score?: string
  team?: EspnTeam
  athlete?: EspnAthlete
  roster?: { displayName?: string; shortDisplayName?: string; athletes?: EspnAthlete[] }
  linescores?: EspnLine[]
}
type EspnCompetition = { id: string; date: string; status?: EspnStatus; venue?: { fullName?: string; court?: string }; competitors?: EspnCompetitor[]; round?: { displayName?: string } }
type EspnSportEvent = {
  id: string
  name?: string
  date: string
  status?: EspnStatus
  venue?: { displayName?: string }
  competitions?: EspnCompetition[]
  groupings?: { grouping?: { slug?: string; displayName?: string }; competitions?: EspnCompetition[] }[]
}
type EspnScoreboard = { leagues?: { name?: string; abbreviation?: string; logos?: { href?: string }[] }[]; events?: EspnSportEvent[] }

function mapStatus(s: EspnStatus | undefined): { status: MatchStatus; period: number | null; clockDisplay: string | null; statusText: string | null } {
  const name = s?.type.name ?? ""
  const none = { period: null, clockDisplay: null }
  if (/POSTPONED|CANCELED|ABANDONED|SUSPENDED/.test(name)) return { status: "POSTPONED", ...none, statusText: s?.type.shortDetail ?? null }
  if (!s || s.type.state === "pre") return { status: "UPCOMING", ...none, statusText: null }
  if (s.type.state === "post") return { status: "FT", period: s.period ?? null, clockDisplay: null, statusText: s.type.shortDetail ?? s.type.description ?? "Final" }
  return { status: name === "STATUS_HALFTIME" ? "HT" : "LIVE", period: s.period ?? null, clockDisplay: s.displayClock ?? null, statusText: s.type.shortDetail ?? null }
}

type LeagueSeed = { id: string; sport: OtherSport; name: string; short: string; country: string; logo: string | null; sortOrder: number }

async function ensureLeague(db: DB, l: LeagueSeed) {
  const [row] = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.id, l.id)).limit(1)
  if (row) return
  const values = {
    id: l.id,
    sport: l.sport,
    name: l.name,
    short: l.short,
    country: l.country,
    code: l.short.slice(0, 3).toUpperCase(),
    region: "Other",
    founded: 0,
    recordHolder: "",
    accent: "#3d7bff",
    blurb: "",
    logo: l.logo,
    season: null,
    sortOrder: l.sortOrder,
    featured: false,
  }
  await db.insert(leagues).values(values).onConflictDoNothing()
  // League names are unique (e.g. the same tournament next year): keep apart by id.
  const [made] = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.id, l.id)).limit(1)
  if (!made) await db.insert(leagues).values({ ...values, name: `${l.name} (${l.id.split(".")[1] ?? l.id})` }).onConflictDoNothing()
}

type Party = { espnId: string; name: string; short: string; city: string | null; color: string; color2: string; logo: string | null }

/** App ids for the two sides of each match, creating teams/players we haven't seen. */
async function resolveParties(db: DB, sport: OtherSport, parties: Party[], leagueId: string) {
  const byEspn = new Map(parties.map((p) => [p.espnId, p]))
  const ids = [...byEspn.keys()]
  const map = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 500)
    for (const k of await db.select({ id: teams.id, espnId: teams.espnId }).from(teams).where(inArray(teams.espnId, ids.slice(i, i + 500)))) map.set(k.espnId!, k.id)
  for (const p of byEspn.values()) {
    if (map.has(p.espnId)) continue
    const id = p.espnId.replace(":", "-")
    await db
      .insert(teams)
      .values({ id, espnId: p.espnId, sport, name: p.name, short: p.short, city: p.city, color: p.color, color2: p.color2, logo: p.logo, leagueId: sport === "tennis" ? null : leagueId })
      .onConflictDoNothing()
    map.set(p.espnId, id)
  }
  return map
}

type Row = {
  id: string
  espnId: string
  sport: OtherSport
  leagueId: string
  home: Party
  away: Party
  homeScore: number
  awayScore: number
  status: MatchStatus
  period: number | null
  clockDisplay: string | null
  statusText: string | null
  linescores: Linescores | null
  kickoff: Date
  venue: string | null
}

/** Writes matches for one league, returning the ids of those that are new or changed. */
async function upsertRows(db: DB, sport: OtherSport, leagueId: string, rows: Row[]) {
  if (!rows.length) return []
  const ids = await resolveParties(db, sport, rows.flatMap((r) => [r.home, r.away]), leagueId)
  const existing = new Map<string, typeof matches.$inferSelect>()
  const matchIds = rows.map((r) => r.id)
  for (let i = 0; i < matchIds.length; i += 500)
    for (const m of await db.select().from(matches).where(inArray(matches.id, matchIds.slice(i, i + 500)))) existing.set(m.id, m)

  const changed: string[] = []
  for (const r of rows) {
    const { home, away, ...rest } = r
    const row = { ...rest, homeId: ids.get(home.espnId)!, awayId: ids.get(away.espnId)!, minute: null, clockSeconds: null }
    const prev = existing.get(row.id)
    const differs =
      !prev ||
      prev.status !== row.status ||
      prev.period !== row.period ||
      prev.clockDisplay !== row.clockDisplay ||
      prev.statusText !== row.statusText ||
      prev.homeScore !== row.homeScore ||
      prev.awayScore !== row.awayScore ||
      prev.kickoff.getTime() !== row.kickoff.getTime() ||
      sameLines(prev.linescores, row.linescores) === false
    if (!differs) continue
    await db
      .insert(matches)
      .values(row)
      .onConflictDoUpdate({ target: matches.id, set: { ...row, updatedAt: sql`now()` } })
    changed.push(row.id)
  }
  return changed
}

// jsonb hands keys back in its own order, so compare the values, not the JSON text.
const canon = (l: Linescores | null | undefined) => (l ? JSON.stringify([l.home, l.away, l.homeTb ?? null, l.awayTb ?? null]) : "")
const sameLines = (x: Linescores | null | undefined, y: Linescores | null | undefined) => canon(x) === canon(y)

const lines = (c: EspnCompetitor) => (c.linescores ?? []).map((l) => Number(l.value ?? 0) || 0)

/** Team sports: one event is one game. */
function teamRows(sport: OtherSport, leagueId: string, events: EspnSportEvent[]): Row[] {
  return events.flatMap((ev) => {
    const comp = ev.competitions?.[0]
    const h = comp?.competitors?.find((c) => c.homeAway === "home")
    const a = comp?.competitors?.find((c) => c.homeAway === "away")
    if (!comp || !h?.team || !a?.team) return []
    const party = (t: EspnTeam): Party => ({
      espnId: `${sport}:${t.id}`,
      name: t.displayName,
      short: t.abbreviation ?? t.displayName.slice(0, 3).toUpperCase(),
      city: t.location ?? null,
      color: hex(t.color, "#334155"),
      color2: hex(t.alternateColor, "#ffffff"),
      logo: t.logo ?? null,
    })
    const played = (h.linescores?.length ?? 0) > 0
    return [
      {
        id: `espn-${sport}-${ev.id}`,
        espnId: `${sport}:${ev.id}`,
        sport,
        leagueId,
        home: party(h.team),
        away: party(a.team),
        homeScore: Number(h.score ?? 0) || 0,
        awayScore: Number(a.score ?? 0) || 0,
        ...mapStatus(ev.status ?? comp.status),
        linescores: played ? { home: lines(h), away: lines(a) } : null,
        kickoff: new Date(ev.date),
        venue: comp.venue?.fullName ?? null,
      },
    ]
  })
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

/** Tennis: each tournament draw (men's singles, women's doubles…) is a league; its matches are sets. */
function tennisDraws(events: EspnSportEvent[]) {
  const draws: { league: LeagueSeed; rows: Row[] }[] = []
  for (const ev of events) {
    for (const g of ev.groupings ?? []) {
      const draw = g.grouping?.displayName ?? "Singles"
      const leagueId = `tennis.${ev.id}.${g.grouping?.slug ?? slugify(draw)}`.slice(0, 64)
      const tour = /women/i.test(draw) ? "WTA" : /mixed/i.test(draw) ? "Tennis" : "ATP"
      const rows = (g.competitions ?? []).flatMap((comp): Row[] => {
        const sides = [...(comp.competitors ?? [])].sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
        const [h, a] = sides
        const party = (c: EspnCompetitor): Party | null => {
          const name = c.athlete?.displayName ?? c.roster?.shortDisplayName ?? c.roster?.displayName
          // "TBD" marks a slot waiting on an earlier round.
          if (!name || !c.id || /^tbd$/i.test(name.trim())) return null
          const flag = c.athlete?.flag ?? c.roster?.athletes?.[0]?.flag
          const last = (c.athlete?.displayName ?? name).split(/[\s/]+/).filter(Boolean).pop() ?? name
          return { espnId: `tennis:${c.id}`, name, short: last.slice(0, 3).toUpperCase(), city: flag?.alt ?? null, color: "#334155", color2: "#ffffff", logo: flag?.href ?? null }
        }
        const home = h && party(h)
        const away = a && party(a)
        if (!h || !a || !home || !away) return []
        const sets = (c: EspnCompetitor) => (c.linescores ?? []).filter((l) => l.winner === true).length
        const tb = (c: EspnCompetitor) => (c.linescores ?? []).map((l) => (typeof l.tiebreak === "number" ? l.tiebreak : null))
        const st = mapStatus(comp.status)
        const setNo = Math.max(h.linescores?.length ?? 0, a.linescores?.length ?? 0)
        return [
          {
            id: `espn-tennis-${comp.id}`,
            espnId: `tennis:${comp.id}`,
            sport: "tennis",
            leagueId,
            home,
            away,
            homeScore: sets(h),
            awayScore: sets(a),
            ...st,
            statusText: st.status === "LIVE" ? `Set ${Math.max(1, setNo)}` : st.statusText,
            linescores: setNo ? { home: lines(h), away: lines(a), homeTb: tb(h), awayTb: tb(a) } : null,
            kickoff: new Date(comp.date),
            venue: [comp.round?.displayName, comp.venue?.court].filter(Boolean).join(" · ") || null,
          },
        ]
      })
      if (!rows.length) continue
      draws.push({
        league: { id: leagueId, sport: "tennis", name: `${ev.name ?? "Tournament"}, ${draw}`, short: tour, country: tour, logo: null, sortOrder: /singles/i.test(draw) ? 3000 : 3100 },
        rows,
      })
    }
  }
  return draws
}

/**
 * Upserts matches for the other sports and returns the ids that changed. Defaults to every
 * league for yesterday/today/tomorrow (ESPN dates are US Eastern, so late games sit on the day
 * before in UTC); the live loop narrows both.
 */
export async function syncSports(db: DB, fetcher: Fetcher = defaultFetcher, now = new Date(), opts: { days?: number[]; only?: { sport: OtherSport; slug: string }[] } = {}) {
  const days = opts.days ?? [-1, 0, 1]
  const targets = opts.only ?? (Object.keys(SPORT_LEAGUES) as OtherSport[]).flatMap((sport) => SPORT_LEAGUES[sport].map((l) => ({ sport, slug: l.slug as string })))
  const changed: string[] = []
  for (const { sport, slug } of targets) {
    const meta = (SPORT_LEAGUES[sport] as readonly { slug: string; name: string; country: string }[]).find((l) => l.slug === slug)
    if (!meta) continue
    // A tennis scoreboard holds its tournaments' whole draws, so one day covers them.
    const wanted = sport === "tennis" ? (days.includes(0) ? [0] : []) : days
    for (const offset of wanted) {
      try {
        const data = (await fetcher(`${SITE}/${sport}/${slug}/scoreboard?dates=${ymd(new Date(now.getTime() + offset * 86_400_000))}`)) as EspnScoreboard
        if (sport === "tennis") {
          for (const d of tennisDraws(data.events ?? [])) {
            await ensureLeague(db, d.league)
            changed.push(...(await upsertRows(db, sport, d.league.id, d.rows)))
          }
          continue
        }
        const leagueId = `${sport}.${slug}`
        const rows = teamRows(sport, leagueId, data.events ?? [])
        if (!rows.length) continue
        const order = (Object.keys(SPORT_LEAGUES) as OtherSport[]).indexOf(sport) * 10 + SPORT_LEAGUES[sport].findIndex((l) => l.slug === slug)
        await ensureLeague(db, { id: leagueId, sport, name: meta.name, short: data.leagues?.[0]?.abbreviation ?? meta.name, country: meta.country, logo: data.leagues?.[0]?.logos?.[0]?.href ?? null, sortOrder: 2500 + order })
        changed.push(...(await upsertRows(db, sport, leagueId, rows)))
      } catch {
        continue
      }
    }
  }
  return changed
}

/** The other sports' ESPN leagues with a match in play or starting around now. */
export async function sportsInPlay(db: DB, now = new Date()) {
  const MIN = 60_000
  const rows = await db
    .selectDistinct({ sport: matches.sport, leagueId: matches.leagueId })
    .from(matches)
    .where(
      and(
        ne(matches.sport, "soccer"),
        isNotNull(matches.leagueId),
        or(inArray(matches.status, ["LIVE", "HT"]), and(eq(matches.status, "UPCOMING"), between(matches.kickoff, new Date(now.getTime() - 20 * MIN), new Date(now.getTime() + 2 * MIN)))),
      ),
    )
  const seen = new Set<string>()
  const out: { sport: OtherSport; slug: string }[] = []
  for (const r of rows) {
    const sport = r.sport as OtherSport
    if (!(sport in SPORT_LEAGUES)) continue
    // Tennis draws live under the tour scoreboards; team leagues are "<sport>.<slug>".
    const slugs = sport === "tennis" ? SPORT_LEAGUES.tennis.map((l) => l.slug as string) : [r.leagueId!.slice(sport.length + 1)]
    for (const slug of slugs) {
      if (seen.has(`${sport}.${slug}`)) continue
      seen.add(`${sport}.${slug}`)
      out.push({ sport, slug })
    }
  }
  return out
}

/* ───────────── Match details ───────────── */

type EspnBox = { boxscore?: { teams?: { team?: { id?: string }; statistics?: { name?: string; label?: string; displayValue?: string }[] }[] } }

/** Team stats for a game (box score), as labelled rows with both sides' values. Tennis has none. */
export async function sportStats(sport: OtherSport, leagueId: string, espnId: string, homeEspn: string | null, awayEspn: string | null, fetcher: Fetcher = defaultFetcher) {
  if (sport === "tennis") return []
  const bare = (id: string | null) => id?.split(":")[1]
  const raw = (await fetcher(`${SITE}/${sport}/${leagueId.slice(sport.length + 1)}/summary?event=${bare(espnId)}`)) as EspnBox
  const side = (id: string | undefined) => raw.boxscore?.teams?.find((t) => t.team?.id === id)?.statistics ?? []
  const home = side(bare(homeEspn))
  const away = new Map(side(bare(awayEspn)).map((s) => [s.name, s.displayValue]))
  return home
    .flatMap((s) => {
      const a = away.get(s.name)
      return s.name && s.label && s.displayValue != null && a != null ? [{ key: s.name, label: s.label, home: s.displayValue, away: a }] : []
    })
    .slice(0, 18)
}
