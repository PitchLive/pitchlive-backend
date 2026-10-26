import type { FastifyBaseLogger } from "fastify"
import { and, between, eq, inArray, isNotNull, or } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { matches } from "../db/schema.js"
import type { LiveHub } from "../live/hub.js"
import { getMatch } from "../services/views.js"
import { purgeExpiredSessions } from "../auth/session.js"
import { syncScoreboards, syncStandings, syncTeamDetails } from "./espn.js"

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

export function startJobs({ db, hub, log, espn }: Opts) {
  const stops: (() => void)[] = []

  const broadcast = async (ids: string[]) => {
    for (const id of ids) {
      const m = await getMatch(db, id)
      if (m) hub.publishMatch(m)
    }
  }

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
    // Fast path: only leagues with something happening right now.
    stops.push(
      loop("live-scores", log, 15 * SEC, async () => {
        const leagues = await leaguesInPlay(db)
        if (leagues.length) await broadcast(await syncScoreboards(db, undefined, new Date(), { leagues, days: [-1, 0] }))
        return LIVE_POLL_MS
      }),
    )
    stops.push(
      loop("standings", log, 30 * SEC, async () => {
        log.info({ leagues: await syncStandings(db) }, "standings synced")
        return (await leaguesInPlay(db)).length ? 5 * MIN : 15 * MIN
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
