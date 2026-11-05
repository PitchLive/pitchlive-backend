import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { DB } from "../db/client.js"
import { matches, teams, type MatchStatus } from "../db/schema.js"
import { defaultFetcher } from "../jobs/espn.js"

type Fetcher = (url: string) => Promise<unknown>
type Side = "home" | "away"

export type StatRow = { key: string; label: string; home: string; away: string }

export type LineupPlayer = {
  id: string
  name: string
  shortName: string
  number: string | null
  position: string | null // ESPN abbreviation, e.g. "CD-L", "CM-R", "F"
  formationPlace: number | null
  starter: boolean
  subbedIn: string | null // minute, e.g. "62'"
  subbedOut: string | null
  goals: number
  ownGoals: number
  yellow: boolean
  red: boolean
}

export type Lineup = { formation: string | null; starters: LineupPlayer[]; bench: LineupPlayer[] }

export type MatchEvent = {
  id: string
  type: string // goal, own-goal, penalty-goal, yellow-card, red-card, substitution, halftime, ...
  minute: string
  period: number | null
  side: Side | null
  players: string[] // scorer + assist, player in + player out, ...
  text: string
}

export type CommentaryLine = { seq: number; minute: string; type: string | null; side: Side | null; text: string }

export type MatchDetails = {
  matchId: string
  stats: StatRow[]
  lineups: { home: Lineup; away: Lineup } | null
  events: MatchEvent[]
  commentary: CommentaryLine[] // newest first
  updatedAt: string
}

// Flashscore-style order. Anything ESPN sends that isn't listed is left out.
const STATS: [key: string, label: string][] = [
  ["possessionPct", "Ball possession"],
  ["totalShots", "Total shots"],
  ["shotsOnTarget", "Shots on target"],
  ["blockedShots", "Blocked shots"],
  ["wonCorners", "Corner kicks"],
  ["offsides", "Offsides"],
  ["foulsCommitted", "Fouls"],
  ["yellowCards", "Yellow cards"],
  ["redCards", "Red cards"],
  ["saves", "Goalkeeper saves"],
  ["totalPasses", "Passes"],
  ["passPct", "Pass accuracy"],
  ["totalCrosses", "Crosses"],
  ["totalTackles", "Tackles"],
  ["interceptions", "Interceptions"],
  ["totalClearance", "Clearances"],
]
const PERCENT = new Set(["possessionPct", "passPct"])

// Event types shown in the summary timeline; the rest only appear in commentary.
/**
 * ESPN tags goals with variants ("goal---header", "goal---volley", "goal---free-kick",
 * "penalty---scored"); fold them into the few types the site shows. The detail stays in the text.
 */
export function normalizeEventType(type: string | undefined, scoringPlay?: boolean): string | null {
  if (!type) return scoringPlay ? "goal" : null
  if (type === "own-goal") return "own-goal"
  if (type === "penalty---scored" || (scoringPlay && type.startsWith("penalty"))) return "penalty-goal"
  if (type.startsWith("goal") || scoringPlay) return "goal"
  if (type === "yellow-red-card" || type === "second-yellow-card") return "second-yellow-card"
  if (type.includes("red-card")) return "red-card"
  return type
}

const KEY_EVENT_TYPES = new Set([
  "goal",
  "own-goal",
  "penalty---scored",
  "penalty-goal",
  "penalty---missed",
  "yellow-card",
  "red-card",
  "second-yellow-card",
  "substitution",
  "halftime",
  "end-regular-time",
  "var---referee-decision-cancelled",
])

/* ───────────── ESPN payload (only the parts used) ───────────── */

type EspnRef = { id: string }
type EspnSummary = {
  boxscore?: { teams?: { team: EspnRef; statistics?: { name: string; displayValue: string }[] }[] }
  rosters?: {
    homeAway: Side
    team: EspnRef
    formation?: string
    roster?: {
      starter: boolean
      jersey?: string
      athlete: { id: string; displayName: string; shortName?: string }
      position?: { abbreviation?: string }
      formationPlace?: string
      subbedIn?: boolean | { didSub?: boolean }
      subbedOut?: boolean | { didSub?: boolean }
      plays?: { clock?: { displayValue?: string }; substitution?: boolean; yellowCard?: boolean; redCard?: boolean; scoringPlay?: boolean; ownGoal?: boolean }[]
    }[]
  }[]
  keyEvents?: {
    id: string
    type?: { type?: string }
    scoringPlay?: boolean
    text?: string
    clock?: { displayValue?: string }
    period?: { number?: number }
    team?: EspnRef
    participants?: { athlete?: { displayName?: string } }[]
  }[]
  commentary?: { sequence: number; time?: { displayValue?: string }; text: string; play?: { type?: { type?: string }; scoringPlay?: boolean; team?: EspnRef } }[]
}

const didSub = (v: boolean | { didSub?: boolean } | undefined) => (typeof v === "object" ? !!v?.didSub : !!v)

/** Normalise an ESPN match summary. `espnSide` maps ESPN team ids to home/away. */
export function normalizeSummary(matchId: string, s: EspnSummary, espnSide: Map<string, Side>, now = new Date()): MatchDetails {
  const sideOf = (ref?: EspnRef) => (ref ? (espnSide.get(ref.id) ?? null) : null)

  // Stats: one row per known stat with both sides' values.
  const byTeam = new Map<Side, Map<string, string>>()
  for (const t of s.boxscore?.teams ?? []) {
    const side = sideOf(t.team)
    if (side) byTeam.set(side, new Map((t.statistics ?? []).map((x) => [x.name, x.displayValue])))
  }
  const stats: StatRow[] = []
  if (byTeam.size === 2) {
    for (const [key, label] of STATS) {
      const h = byTeam.get("home")!.get(key)
      const a = byTeam.get("away")!.get(key)
      if (h == null || a == null) continue
      // ESPN mixes scales: possession comes as 52.2, pass accuracy as 0.8.
      const fmt = (v: string) => {
        if (!PERCENT.has(key) || v.endsWith("%")) return v
        const n = Number(v)
        if (!Number.isFinite(n)) return v
        return `${Math.round(n <= 1 ? n * 100 : n)}%`
      }
      stats.push({ key, label, home: fmt(h), away: fmt(a) })
    }
  }

  // Line-ups.
  const lineup = (r: NonNullable<EspnSummary["rosters"]>[number]): Lineup => {
    const players = (r.roster ?? []).map<LineupPlayer>((p) => {
      const plays = p.plays ?? []
      const subMinute = plays.find((x) => x.substitution)?.clock?.displayValue ?? null
      return {
        id: p.athlete.id,
        name: p.athlete.displayName,
        shortName: p.athlete.shortName ?? p.athlete.displayName,
        number: p.jersey ?? null,
        position: p.position?.abbreviation ?? null,
        formationPlace: p.formationPlace ? Number(p.formationPlace) : null,
        starter: p.starter,
        subbedIn: didSub(p.subbedIn) ? subMinute : null,
        subbedOut: didSub(p.subbedOut) ? subMinute : null,
        goals: plays.filter((x) => x.scoringPlay && !x.ownGoal).length,
        ownGoals: plays.filter((x) => x.ownGoal).length,
        yellow: plays.some((x) => x.yellowCard),
        red: plays.some((x) => x.redCard),
      }
    })
    const byPlace = (a: LineupPlayer, b: LineupPlayer) => (a.formationPlace ?? 99) - (b.formationPlace ?? 99)
    return { formation: r.formation ?? null, starters: players.filter((p) => p.starter).sort(byPlace), bench: players.filter((p) => !p.starter) }
  }
  const home = s.rosters?.find((r) => r.homeAway === "home")
  const away = s.rosters?.find((r) => r.homeAway === "away")
  const lineups = home?.roster?.length && away?.roster?.length ? { home: lineup(home), away: lineup(away) } : null

  const events: MatchEvent[] = (s.keyEvents ?? [])
    .map((k) => ({ k, type: normalizeEventType(k.type?.type, k.scoringPlay) }))
    .filter(({ type }) => type && KEY_EVENT_TYPES.has(type))
    .map(({ k, type }) => ({
      id: k.id,
      type: type!,
      minute: k.clock?.displayValue ?? "",
      period: k.period?.number ?? null,
      side: sideOf(k.team),
      players: (k.participants ?? []).map((p) => p.athlete?.displayName).filter((n): n is string => !!n),
      text: k.text ?? "",
    }))

  const commentary: CommentaryLine[] = (s.commentary ?? [])
    .map((c) => ({ seq: c.sequence, minute: c.time?.displayValue ?? "", type: normalizeEventType(c.play?.type?.type, c.play?.scoringPlay), side: sideOf(c.play?.team), text: c.text }))
    .sort((a, b) => b.seq - a.seq)

  return { matchId, stats, lineups, events, commentary, updatedAt: now.toISOString() }
}

/* ───────────── Cache + fetch ───────────── */

// How long a cached copy is good for, by match status.
const TTL_MS: Record<MatchStatus, number> = { LIVE: 12_000, HT: 30_000, UPCOMING: 5 * 60_000, FT: 30 * 60_000, POSTPONED: 60 * 60_000 }

type Entry = { details: MatchDetails; hash: string; fetchedAt: number }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Entry | null>>()

const hashOf = (d: MatchDetails) =>
  createHash("sha1")
    .update(JSON.stringify({ ...d, updatedAt: "" }))
    .digest("hex")

const home = alias(teams, "home")
const away = alias(teams, "away")

async function matchRow(db: DB, matchId: string) {
  const [row] = await db
    .select({ espnId: matches.espnId, leagueId: matches.leagueId, status: matches.status, homeEspn: home.espnId, awayEspn: away.espnId })
    .from(matches)
    .innerJoin(home, eq(home.id, matches.homeId))
    .innerJoin(away, eq(away.id, matches.awayId))
    .where(eq(matches.id, matchId))
    .limit(1)
  return row ?? null
}

/**
 * Details for a match, from cache when fresh enough. Returns null for matches ESPN
 * has no summary for. `changed` is true when the content differs from the last copy.
 */
export async function getMatchDetails(db: DB, matchId: string, opts: { fetcher?: Fetcher; force?: boolean } = {}) {
  const row = await matchRow(db, matchId)
  if (!row?.espnId || !row.leagueId) return null
  const cached = cache.get(matchId)
  if (cached && !opts.force && Date.now() - cached.fetchedAt < TTL_MS[row.status]) return { details: cached.details, changed: false }

  // Concurrent requests for the same match share one ESPN call.
  let pending = inflight.get(matchId)
  if (!pending) {
    pending = (async () => {
      try {
        const raw = (await (opts.fetcher ?? defaultFetcher)(`https://site.api.espn.com/apis/site/v2/sports/soccer/${row.leagueId}/summary?event=${row.espnId}`)) as EspnSummary
        const sides = new Map<string, Side>()
        if (row.homeEspn) sides.set(row.homeEspn, "home")
        if (row.awayEspn) sides.set(row.awayEspn, "away")
        const details = normalizeSummary(matchId, raw, sides)
        const entry = { details, hash: hashOf(details), fetchedAt: Date.now() }
        return entry
      } catch {
        return null
      } finally {
        inflight.delete(matchId)
      }
    })()
    inflight.set(matchId, pending)
  }
  const entry = await pending
  if (!entry) return cached ? { details: cached.details, changed: false } : null
  const changed = entry.hash !== cached?.hash
  // Keep the old timestamp in the payload when nothing changed, so clients can skip re-rendering.
  if (!changed && cached) entry.details = cached.details
  cache.set(matchId, entry)
  return { details: entry.details, changed }
}

export function clearDetailsCache() {
  cache.clear()
}
