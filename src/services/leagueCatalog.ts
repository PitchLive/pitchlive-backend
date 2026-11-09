import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { and, eq, sql } from "drizzle-orm"
import type { DB } from "../db/client.js"
import { leagues } from "../db/schema.js"
import { defaultFetcher, syncSeason, syncStandings, upsertEvents, type EspnEvent } from "../jobs/espn.js"

export type CatalogLeague = {
  slug: string
  name: string
  short: string
  country: string // as named in the site's country menu, or "World"
  season: number | null
  cup: boolean
  women: boolean
  logo: string | null
}

// Built by scripts/fetch-league-catalog.mjs (npm run data:catalog).
const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data/league-catalog.json")
export const catalog: CatalogLeague[] = JSON.parse(fs.readFileSync(FILE, "utf8"))
const bySlug = new Map(catalog.map((l) => [l.slug, l]))

export function countries() {
  const counts = new Map<string, number>()
  for (const l of catalog) counts.set(l.country, (counts.get(l.country) ?? 0) + 1)
  return [...counts.entries()].map(([country, leagues]) => ({ country, leagues })).sort((a, b) => a.country.localeCompare(b.country))
}

export function leaguesOf(country: string) {
  const key = country.toLowerCase()
  return catalog.filter((l) => l.country.toLowerCase() === key)
}

type Fetcher = (url: string) => Promise<unknown>
const loading = new Map<string, Promise<void>>()
const loadedAt = new Map<string, number>()
const RELOAD_MS = 10 * 60_000

/**
 * Makes sure a league from the catalogue exists and has data. The first visit loads its
 * table and whole season from ESPN (shared by concurrent visitors); later visits just mark
 * it as viewed, which keeps the background jobs refreshing it. Returns false for unknown ids.
 */
export async function ensureLeague(db: DB, slug: string, fetcher?: Fetcher): Promise<boolean> {
  const [row] = await db.select({ id: leagues.id, featured: leagues.featured, lastViewedAt: leagues.lastViewedAt }).from(leagues).where(eq(leagues.id, slug)).limit(1)
  const entry = bySlug.get(slug)
  if (!row && !entry) return false

  if (!row && entry) {
    await db
      .insert(leagues)
      .values({
        id: entry.slug,
        name: entry.name,
        short: entry.short,
        country: entry.country,
        code: entry.slug.split(".")[0]!.toUpperCase(),
        region: entry.country === "World" ? "International" : "Other",
        founded: 0,
        recordHolder: "",
        accent: "#3d7bff",
        blurb: "",
        logo: entry.logo,
        season: entry.season ? String(entry.season) : null,
        sortOrder: 1000,
        featured: false,
      })
      .onConflictDoNothing()
  }
  if (row?.featured) return true

  // Viewed now (throttled to one write a minute).
  if (!row?.lastViewedAt || Date.now() - row.lastViewedAt.getTime() > 60_000)
    await db.update(leagues).set({ lastViewedAt: sql`now()` }).where(and(eq(leagues.id, slug), eq(leagues.featured, false)))

  // Load (or reload, when stale) its data. Concurrent requests wait for the same load.
  const last = loadedAt.get(slug) ?? 0
  if (Date.now() - last > RELOAD_MS) {
    let pending = loading.get(slug)
    if (!pending) {
      pending = (async () => {
        try {
          await syncStandings(db, fetcher, { leagues: [slug] })
          await syncSeason(db, fetcher, { leagues: [slug] })
          loadedAt.set(slug, Date.now())
        } finally {
          loading.delete(slug)
        }
      })()
      loading.set(slug, pending)
    }
    // A failed load still lets the page render with whatever we have.
    await pending.catch(() => {})
  }
  return true
}

export function catalogEntry(slug: string) {
  return bySlug.get(slug)
}

/* ───────────── Every competition of the day ───────────── */

const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/soccer"
const HEADER = "https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=soccer&dates="
type HeaderLeague = { id?: string; slug?: string; name?: string; abbreviation?: string; events?: unknown[] }
const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "")

/** A league row for a competition we have matches in, from the catalogue or ESPN's own listing. */
async function ensureLeagueRow(db: DB, g: HeaderLeague & { slug: string }) {
  const [row] = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.id, g.slug)).limit(1)
  if (row) return true
  const entry = bySlug.get(g.slug)
  const name = entry?.name ?? g.name ?? g.slug
  const values = {
    id: g.slug,
    name,
    short: entry?.short ?? g.abbreviation ?? name,
    country: entry?.country ?? "World",
    code: g.slug.split(".")[0]!.toUpperCase(),
    region: (entry?.country ?? "World") === "World" ? "International" : "Other",
    founded: 0,
    recordHolder: "",
    accent: "#3d7bff",
    blurb: "",
    logo: entry?.logo ?? (g.id ? `https://a.espncdn.com/i/leaguelogos/soccer/500/${g.id}.png` : null),
    season: entry?.season ? String(entry.season) : null,
    sortOrder: 2000,
    featured: false,
  }
  await db.insert(leagues).values(values).onConflictDoNothing()
  // League names are unique: two competitions sharing one keep apart by slug.
  const [made] = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.id, g.slug)).limit(1)
  if (!made) await db.insert(leagues).values({ ...values, name: `${name} (${g.slug})` }).onConflictDoNothing()
  return true
}

/**
 * Matches in every competition ESPN covers on these days (cups, internationals, women's football
 * and leagues nobody has opened yet), so the day's list is complete, not just the curated leagues.
 * ESPN's scoreboard header names the competitions with matches each day; each one's scoreboard
 * has the full events. Returns the ids of matches that changed.
 */
export async function syncAllCompetitions(db: DB, fetcher: Fetcher = defaultFetcher, now = new Date(), days = [-1, 0, 1]) {
  const changed: string[] = []
  for (const offset of days) {
    const day = ymd(new Date(now.getTime() + offset * 86_400_000))
    let groups: HeaderLeague[] = []
    try {
      const header = (await fetcher(HEADER + day)) as { sports?: { leagues?: HeaderLeague[] }[] }
      groups = header.sports?.[0]?.leagues ?? []
    } catch {
      continue
    }
    for (const g of groups) {
      if (!g.slug || !g.events?.length) continue
      try {
        await ensureLeagueRow(db, { ...g, slug: g.slug })
        const data = (await fetcher(`${SCOREBOARD}/${g.slug}/scoreboard?dates=${day}`)) as { events?: EspnEvent[] }
        changed.push(...(await upsertEvents(db, g.slug, data.events ?? [])))
      } catch {
        continue
      }
    }
  }
  return changed
}
