import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { notFound, parse, requireUser, type Deps } from "../http.js"
import { getMatch } from "../services/views.js"
import { playbackFor } from "../streaming/playback.js"

export async function streamingRoutes(app: FastifyInstance, { db, config }: Deps) {
  // Signed-in users only. This is where subscription and geo checks belong once content is licensed.
  app.get("/api/matches/:id/playback", async (req, reply) => {
    await requireUser(db, req)
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params)
    if (!(await getMatch(db, id))) throw notFound("Match")
    reply.header("cache-control", "private, no-store")
    return { playback: await playbackFor(db, config, id) }
  })
}
