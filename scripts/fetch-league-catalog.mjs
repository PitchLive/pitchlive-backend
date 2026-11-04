// Builds data/league-catalog.json: every current soccer competition ESPN covers, with
// the country it belongs to (names match the frontend's country menu). Run with:
//   npm run data:catalog
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/league-catalog.json")

// ESPN slug prefix → country name as used in the site's country menu.
const COUNTRY = {
  eng: "England", sco: "Scotland", esp: "Spain", ger: "Germany", ita: "Italy", fra: "France", ned: "Netherlands",
  por: "Portugal", bel: "Belgium", aut: "Austria", gre: "Greece", tur: "Türkiye", rus: "Russia", swe: "Sweden",
  nor: "Norway", den: "Denmark", usa: "United States", can: "Canada", mex: "Mexico", gua: "Guatemala",
  crc: "Costa Rica", hon: "Honduras", slv: "El Salvador", arg: "Argentina", bra: "Brazil", chi: "Chile",
  uru: "Uruguay", par: "Paraguay", col: "Colombia", ecu: "Ecuador", ven: "Venezuela", bol: "Bolivia", per: "Peru",
  aus: "Australia", ksa: "Saudi Arabia", chn: "China", jpn: "Japan", ind: "India", rsa: "South Africa",
}
// Confederations and worldwide competitions.
const WORLD = new Set(["fifa", "uefa", "concacaf", "conmebol", "caf", "afc", "aff", "global", "club", "nonfifa", "friendly", "campeones"])

const get = async (url) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url.replace("http://", "https://"))
      if (r.ok) return await r.json()
    } catch {}
    await new Promise((r) => setTimeout(r, 500 * (i + 1)))
  }
  return null
}

const index = await get("https://sports.core.api.espn.com/v2/sports/soccer/leagues?limit=1000")
const refs = index.items.map((i) => i.$ref)
const out = []
let n = 0
await Promise.all(
  Array.from({ length: 12 }, async () => {
    while (n < refs.length) {
      const l = await get(refs[n++])
      if (!l?.slug) continue
      const prefix = l.slug.split(".")[0]
      const country = COUNTRY[prefix] ?? (WORLD.has(prefix) ? "World" : null)
      if (!country) continue
      out.push({
        slug: l.slug,
        name: l.name,
        short: l.abbreviation ?? l.shortName ?? l.name,
        country,
        season: l.season?.year ?? null,
        cup: !!l.isTournament,
        women: l.gender === "FEMALE",
        logo: l.logos?.find((x) => x.rel?.includes("dark"))?.href ?? l.logos?.[0]?.href ?? null,
      })
    }
  }),
)

// Defunct competitions (no season in the last two years) are left out.
const thisYear = new Date().getUTCFullYear()
const current = out.filter((l) => (l.season ?? 0) >= thisYear - 1)
// Top flight first, then lower divisions, cups, women's competitions.
const rank = (l) => (l.women ? 3 : 0) + (l.cup ? 1 : 0) + (/\.\d$/.test(l.slug) ? Number(l.slug.at(-1)) / 10 : 0.5)
current.sort((a, b) => a.country.localeCompare(b.country) || rank(a) - rank(b) || a.name.localeCompare(b.name))
fs.writeFileSync(OUT, JSON.stringify(current, null, 1) + "\n")
console.log(`${current.length} competitions in ${new Set(current.map((l) => l.country)).size} countries/regions (${out.length - current.length} defunct skipped)`)
