import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { count, sql } from "drizzle-orm"
import type { DB } from "./client.js"
import { leagues, standings, teams } from "./schema.js"
import { seasonLabel } from "../jobs/espn.js"

const here = path.dirname(fileURLToPath(import.meta.url))
// Shared with the frontend so both sides agree on league facts.
const CATALOG_FILE = path.resolve(here, "../../../src/leagueCatalog.json")
const SNAPSHOT_FILE = path.resolve(here, "../../data/snapshot.json")

type CatalogEntry = {
  slug: string
  name: string
  short: string
  country: string
  code: string
  region: string
  founded: number
  recordHolder: string
  accent: string
  blurb: string
}

type Snapshot = {
  generatedAt: string
  leagues: Record<string, { slug: string; season: string; logo?: string }>
  teams: {
    id: string
    espnId: string
    name: string
    short: string
    city?: string
    country?: string
    stadium?: string
    league?: string
    color: string
    color2: string
    logo?: string
  }[]
  tables: Record<
    string,
    { group?: string; rows: { team: string; p: number; w: number; d: number; l: number; gf: number; ga: number; pts: number; form: string[]; note?: string; noteColor?: string }[] }[]
  >
}

export const readCatalog = (): CatalogEntry[] => JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"))
const readSnapshot = (): Snapshot => JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"))

export async function isSeeded(db: DB) {
  const [row] = await db.select({ n: count() }).from(leagues)
  return (row?.n ?? 0) > 0
}

/** Loads leagues, clubs and tables from the bundled snapshot. Safe to re-run. */
export async function seed(db: DB) {
  const catalog = readCatalog()
  const snap = readSnapshot()
  const slugByName = new Map(catalog.map((l) => [l.name, l.slug]))

  await db.transaction(async (tx) => {
    for (const [i, l] of catalog.entries()) {
      const feed = snap.leagues[l.name]
      const row = { ...l, id: l.slug, logo: feed?.logo ?? null, season: seasonLabel(feed?.season), sortOrder: i }
      await tx
        .insert(leagues)
        .values(row)
        .onConflictDoUpdate({ target: leagues.id, set: { ...row, updatedAt: sql`now()` } })
    }

    for (const t of snap.teams) {
      const row = {
        id: t.id,
        espnId: t.espnId,
        name: t.name,
        short: t.short,
        city: t.city ?? null,
        country: t.country ?? null,
        stadium: t.stadium ?? null,
        color: t.color,
        color2: t.color2,
        logo: t.logo ?? null,
        leagueId: (t.league && slugByName.get(t.league)) ?? null,
      }
      await tx
        .insert(teams)
        .values(row)
        .onConflictDoUpdate({ target: teams.id, set: { ...row, updatedAt: sql`now()` } })
    }

    for (const [name, groups] of Object.entries(snap.tables)) {
      const leagueId = slugByName.get(name)
      if (!leagueId) continue
      await tx.delete(standings).where(sql`${standings.leagueId} = ${leagueId}`)
      const rows = groups.flatMap((g) =>
        g.rows.map((r, i) => ({
          leagueId,
          teamId: r.team,
          groupName: g.group ?? "",
          position: i + 1,
          played: r.p,
          won: r.w,
          drawn: r.d,
          lost: r.l,
          goalsFor: r.gf,
          goalsAgainst: r.ga,
          points: r.pts,
          form: r.form.join(""),
          note: r.note ?? null,
          noteColor: r.noteColor ?? null,
        })),
      )
      if (rows.length) await tx.insert(standings).values(rows)
    }
  })

  return { leagues: catalog.length, teams: snap.teams.length, snapshotDate: snap.generatedAt }
}
