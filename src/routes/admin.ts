import { timingSafeEqual } from "node:crypto"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { z } from "zod"
import { streams } from "../db/schema.js"
import { seed } from "../db/seed.js"
import { syncScoreboards, syncStandings, syncTeamDetails } from "../jobs/espn.js"
import { HttpError, notFound, parse, type Deps } from "../http.js"
import { getMatch } from "../services/views.js"

export async function adminRoutes(app: FastifyInstance, { db, config, hub }: Deps) {
  const guard = async (req: FastifyRequest) => {
    const expected = config.ADMIN_TOKEN
    const given = req.headers.authorization?.replace(/^Bearer /, "") ?? ""
    const ok = !!expected && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    if (!ok) throw new HttpError(401, "Admin token required")
  }

  app.post("/api/admin/sync", { onRequest: guard }, async (req) => {
    const { job } = parse(z.object({ job: z.enum(["scoreboards", "standings", "teams", "seed"]) }), req.body)
    switch (job) {
      case "seed":
        return { result: await seed(db) }
      case "standings":
        return { result: { leagues: await syncStandings(db) } }
      case "teams":
        return { result: { teams: await syncTeamDetails(db) } }
      case "scoreboards": {
        const changed = await syncScoreboards(db)
        for (const id of changed) {
          const m = await getMatch(db, id)
          if (m) hub.publishMatch(m)
        }
        return { result: { changed: changed.length } }
      }
    }
  })

  // Attach a licensed stream to a match.
  app.put("/api/admin/matches/:id/stream", { onRequest: guard }, async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params)
    const body = parse(
      z.object({
        provider: z.enum(["mux", "hls"]),
        source: z.string().min(1).max(500),
        signed: z.boolean().default(false),
        quality: z.enum(["HD", "FHD", "4K"]).default("HD"),
      }),
      req.body,
    )
    if (body.provider === "hls" && !/^https:\/\//.test(body.source)) throw new HttpError(400, "source: HLS streams must be https URLs")
    if (!(await getMatch(db, id))) throw notFound("Match")
    await db
      .insert(streams)
      .values({ matchId: id, ...body })
      .onConflictDoUpdate({ target: streams.matchId, set: body })
    return reply.code(204).send()
  })
}
