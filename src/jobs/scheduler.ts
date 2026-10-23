import type { FastifyBaseLogger } from "fastify"
import { inArray } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { matches } from "../db/schema.js"
import type { LiveHub } from "../live/hub.js"
import { getMatch } from "../services/views.js"
import { purgeExpiredSessions } from "../auth/session.js"
import { syncScoreboards, syncStandings, syncTeamDetails } from "./espn.js"
import { tickDemoMatches } from "./demo.js"

type Opts = { db: DB; hub: LiveHub; log: FastifyBaseLogger; espn: boolean; demo: boolean }

const MIN = 60_000

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

export function startJobs({ db, hub, log, espn, demo }: Opts) {
  const stops: (() => void)[] = []

  const broadcast = async (ids: string[]) => {
    for (const id of ids) {
      const m = await getMatch(db, id)
      if (m) hub.publishMatch(m)
    }
  }

  if (espn) {
    // Poll every minute while anything is live, otherwise every 5 minutes.
    stops.push(
      loop("scoreboards", log, 2_000, async () => {
        const changed = await syncScoreboards(db)
        await broadcast(changed)
        const live = await db.select({ id: matches.id }).from(matches).where(inArray(matches.status, ["LIVE", "HT"])).limit(1)
        log.info({ changed: changed.length }, "scoreboards synced")
        return live.length ? MIN : 5 * MIN
      }),
    )
    stops.push(
      loop("standings", log, 30_000, async () => {
        log.info({ leagues: await syncStandings(db) }, "standings synced")
        return 15 * MIN
      }),
    )
    stops.push(
      loop("team-details", log, 5 * MIN, async () => {
        log.info({ teams: await syncTeamDetails(db) }, "team details synced")
        return 24 * 60 * MIN
      }),
    )
  }

  if (demo) {
    stops.push(
      loop("demo-matches", log, 10_000, async () => {
        await broadcast(await tickDemoMatches(db))
        return 10_000
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
