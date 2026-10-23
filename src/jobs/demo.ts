import { eq, like, sql } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { matches, streams } from "../db/schema.js"

// Mirrors the frontend's sample fixtures so the UI has something live to show offline.
const DEMO = [
  { id: "demo-1", leagueId: "uefa.champions", homeId: "ars", awayId: "rma", minute: 67, homeScore: 2, awayScore: 1, stream: true },
  { id: "demo-2", leagueId: "eng.1", homeId: "liv", awayId: "bou", minute: 23, homeScore: 0, awayScore: 0, stream: true },
  { id: "demo-3", leagueId: "eng.1", homeId: "mci", awayId: "che", minute: 81, homeScore: 3, awayScore: 2, stream: false },
  { id: "demo-4", leagueId: "esp.1", homeId: "bar", awayId: "sev", minute: 58, homeScore: 2, awayScore: 0, stream: true },
]

export async function seedDemoMatches(db: DB, demoStreamUrl: string) {
  for (const d of DEMO) {
    const row = {
      id: d.id,
      leagueId: d.leagueId,
      homeId: d.homeId,
      awayId: d.awayId,
      homeScore: d.homeScore,
      awayScore: d.awayScore,
      status: "LIVE" as const,
      minute: d.minute,
      kickoff: new Date(Date.now() - d.minute * 60_000),
      venue: null,
    }
    await db.insert(matches).values(row).onConflictDoUpdate({ target: matches.id, set: row })
    if (d.stream)
      await db
        .insert(streams)
        .values({ matchId: d.id, provider: "hls", source: demoStreamUrl, signed: false, quality: "HD" })
        .onConflictDoNothing()
  }
}

/** Advances every demo match by one minute, with the odd goal. Returns changed ids. */
export async function tickDemoMatches(db: DB, rand: () => number = Math.random) {
  const live = await db.select().from(matches).where(like(matches.id, "demo-%"))
  const changed: string[] = []
  for (const m of live) {
    let { status, minute, homeScore, awayScore } = m
    minute = minute ?? 0
    if (status === "FT") {
      // Loop forever in dev: kick off again.
      ;[status, minute, homeScore, awayScore] = ["LIVE", 1, 0, 0]
    } else if (status === "HT") {
      ;[status, minute] = ["LIVE", 46]
    } else if (minute >= 90) {
      status = "FT"
    } else if (minute === 45) {
      status = "HT"
    } else {
      minute++
      const r = rand()
      if (r < 0.025) homeScore++
      else if (r < 0.045) awayScore++
    }
    await db
      .update(matches)
      .set({ status, minute: status === "FT" ? null : minute, homeScore, awayScore, updatedAt: sql`now()` })
      .where(eq(matches.id, m.id))
    changed.push(m.id)
  }
  return changed
}
