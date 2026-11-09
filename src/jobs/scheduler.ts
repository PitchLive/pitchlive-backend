import type { FastifyBaseLogger } from "fastify"
import { and, between, eq, inArray, isNotNull, or } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { matches } from "../db/schema.js"
import type { LiveHub } from "../live/hub.js"
import { getMatch } from "../services/views.js"
import { purgeExpiredSessions } from "../auth/session.js"
import { syncScoreboards, syncSeason, syncStandings, syncTeamDetails } from "./espn.js"
import { getMatchDetails } from "../services/matchDetails.js"
import { syncAllCompetitions } from "../services/leagueCatalog.js"

type Opts = { db: DB; hub: LiveHub; log: FastifyBaseLogger; espn: boolean }

const SEC = 1000
const MIN = 60 * SEC
// How often leagues with a match in play are re-read. ESPN's own feed refreshes
// at roughly this rate; clients tick the clock every second in between.
export const LIVE_POLL_MS = 10 * SEC

/** Runs a task forever; the task returns how long to wait before the next run. */
function loop(name: string, log: FastifyBaseLogger, initialDelay: number, task: () => Promise<number>) {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const run = async () => {
    let next = 5 * MIN
    try {
      next = await task()
    } catch (err) {
      log.warn({ err, job: name }, "job failed")
    }
    if (!stopped) timer = setTimeout(run, next)
  }
  timer = setTimeout(run, initialDelay)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** Leagues with a match in play, or one kicking off around now (so the kick-off itself is caught quickly). */
export async function leaguesInPlay(db: DB, now = new Date()) {
  const rows = await db
    .selectDistinct({ leagueId: matches.leagueId })
    .from(matches)
    .where(
      and(
        isNotNull(matches.leagueId),
        or(
          inArray(matches.status, ["LIVE", "HT"]),
          and(eq(matches.status, "UPCOMING"), between(matches.kickoff, new Date(now.getTime() - 20 * MIN), new Date(now.getTime() + 2 * MIN))),
        ),
      ),
    )
  return rows.map((r) => r.leagueId!)
}

/**
 * Leagues whose table should be re-read because one of their matches just ended.
 * ESPN updates tables a few minutes after full time, so each is checked several times.
 */
export class TableRechecks {
  static readonly AFTER_MS = [30 * SEC, 3 * MIN, 8 * MIN]
  private due = new Map<string, number[]>()

  schedule(leagueId: string, now = Date.now()) {
    this.due.set(leagueId, TableRechecks.AFTER_MS.map((d) => now + d))
  }

  /** Leagues with a check due now (each returned once per due time). */
  take(now = Date.now()): string[] {
    const ready: string[] = []
    for (const [leagueId, times] of this.due) {
      const left = times.filter((t) => t > now)
      if (left.length < times.length) ready.push(leagueId)
      if (left.length) this.due.set(leagueId, left)
      else this.due.delete(leagueId)
    }
    return ready
  }
}

/**
 * Re-reads league tables and tells every connected client (all listen on "scores")
 * which ones changed, so they re-fetch them. Returns the changed league ids.
 */
export async function syncAndPublishTables(db: DB, hub: LiveHub, opts: { leagues?: string[]; fetcher?: (url: string) => Promise<unknown> } = {}) {
  const changed = await syncStandings(db, opts.fetcher, { leagues: opts.leagues })
  for (const leagueId of changed) hub.publish("scores", { type: "table", leagueId })
  return changed
}

export const DETAILS_POLL_MS = 12 * SEC

/**
 * Re-reads details for watched matches that can still change: in play, kicking off
 * within the next 90 minutes (line-ups land about an hour before), or finished in
 * the last 15 minutes (late stats corrections). Changes are pushed to the match topic.
 */
export async function refreshWatchedDetails(db: DB, hub: LiveHub, fetcher?: (url: string) => Promise<unknown>, now = new Date()) {
  const ids = hub.watchedMatches()
  if (!ids.length) return 0
  const rows = await db.select({ id: matches.id, status: matches.status, kickoff: matches.kickoff, updatedAt: matches.updatedAt }).from(matches).where(inArray(matches.id, ids))
  let pushed = 0
  for (const m of rows) {
    const active =
      m.status === "LIVE" ||
      m.status === "HT" ||
      (m.status === "UPCOMING" && m.kickoff.getTime() - now.getTime() < 90 * MIN) ||
      (m.status === "FT" && now.getTime() - m.updatedAt.getTime() < 15 * MIN)
    if (!active) continue
    const result = await getMatchDetails(db, m.id, { fetcher, force: true })
    if (result?.changed) {
      hub.publish(`match:${m.id}`, { type: "details", details: result.details })
      pushed++
    }
  }
  return pushed
}

export function startJobs({ db, hub, log, espn }: Opts) {
  const stops: (() => void)[] = []

  const broadcast = async (ids: string[]) => {
    for (const id of ids) {
      const m = await getMatch(db, id)
      if (m) hub.publishMatch(m)
    }
  }
  const rechecks = new TableRechecks()

  if (espn) {
    // Every league, yesterday to tomorrow: picks up new fixtures, kick-off changes and late results.
    stops.push(
      loop("scoreboards", log, 2 * SEC, async () => {
        const changed = await syncScoreboards(db)
        await broadcast(changed)
        log.info({ changed: changed.length }, "scoreboards synced")
        return (await leaguesInPlay(db)).length ? 2 * MIN : 5 * MIN
      }),
    )
    // Every other competition with matches from yesterday to tomorrow (cups, internationals,
    // women's football), then the rest of the coming week less often.
    stops.push(
      loop("all-competitions", log, 20 * SEC, async () => {
        const changed = await syncAllCompetitions(db)
        await broadcast(changed)
        log.info({ changed: changed.length }, "all competitions synced")
        return 10 * MIN
      }),
    )
    stops.push(
      loop("week-ahead", log, 90 * SEC, async () => {
        const changed = await syncAllCompetitions(db, undefined, new Date(), [2, 3, 4, 5, 6, 7])
        log.info({ changed: changed.length }, "week ahead synced")
        return 60 * MIN
      }),
    )
    // Whole seasons (results and fixtures) for league pages, club pages and form.
    stops.push(
      loop("season", log, 5 * SEC, async () => {
        const changed = await syncSeason(db)
        log.info({ changed: changed.length }, "season results and fixtures synced")
        return 6 * 60 * MIN
      }),
    )
    // Fast path: only leagues with something happening right now.
    stops.push(
      loop("live-scores", log, 15 * SEC, async () => {
        const leagues = await leaguesInPlay(db)
        if (leagues.length) {
          const changed = await syncScoreboards(db, undefined, new Date(), { leagues, days: [-1, 0] })
          await broadcast(changed)
          // A match that just finished changes its league's table.
          if (changed.length) {
            const ended = await db.selectDistinct({ leagueId: matches.leagueId }).from(matches).where(and(inArray(matches.id, changed), eq(matches.status, "FT")))
            for (const e of ended) {
              if (!e.leagueId) continue
              rechecks.schedule(e.leagueId)
              // Form ("last 5") comes from results, so it changes the moment a match ends.
              hub.publish("scores", { type: "table", leagueId: e.leagueId })
            }
          }
        }
        const due = rechecks.take()
        if (due.length) await syncAndPublishTables(db, hub, { leagues: due })
        return LIVE_POLL_MS
      }),
    )
    // Stats, line-ups and commentary for matches someone is watching right now.
    stops.push(
      loop("match-details", log, 10 * SEC, async () => {
        await refreshWatchedDetails(db, hub)
        return DETAILS_POLL_MS
      }),
    )
    stops.push(
      loop("standings", log, 30 * SEC, async () => {
        const changed = await syncAndPublishTables(db, hub)
        log.info({ changed }, "standings synced")
        return (await leaguesInPlay(db)).length ? 2 * MIN : 15 * MIN
      }),
    )
    stops.push(
      loop("team-details", log, 5 * MIN, async () => {
        log.info({ teams: await syncTeamDetails(db) }, "team details synced")
        return 24 * 60 * MIN
      }),
    )
  }

  stops.push(
    loop("session-cleanup", log, MIN, async () => {
      await purgeExpiredSessions(db)
      return 60 * MIN
    }),
  )

  return () => stops.forEach((s) => s())
}
