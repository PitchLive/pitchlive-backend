import { boolean, index, integer, pgTable, primaryKey, serial, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const leagues = pgTable("leagues", {
  id: text("id").primaryKey(), // ESPN slug, e.g. "eng.1"
  name: text("name").notNull().unique(),
  short: text("short").notNull(),
  country: text("country").notNull(),
  code: text("code").notNull(),
  region: text("region").notNull(),
  founded: integer("founded").notNull(),
  recordHolder: text("record_holder").notNull(),
  accent: text("accent").notNull(),
  blurb: text("blurb").notNull(),
  logo: text("logo"),
  season: text("season"),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(), // same ids the frontend uses ("ars", "esp-96", "t-123")
    espnId: text("espn_id").unique(),
    name: text("name").notNull(),
    short: text("short").notNull(),
    city: text("city"),
    country: text("country"),
    stadium: text("stadium"),
    color: text("color").notNull(),
    color2: text("color2").notNull(),
    logo: text("logo"),
    leagueId: text("league_id").references(() => leagues.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("teams_league_idx").on(t.leagueId)],
)

export const standings = pgTable(
  "standings",
  {
    leagueId: text("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    groupName: text("group_name").notNull().default(""),
    position: integer("position").notNull(),
    played: integer("played").notNull(),
    won: integer("won").notNull(),
    drawn: integer("drawn").notNull(),
    lost: integer("lost").notNull(),
    goalsFor: integer("goals_for").notNull(),
    goalsAgainst: integer("goals_against").notNull(),
    points: integer("points").notNull(),
    form: text("form").notNull().default(""), // e.g. "WWDLW", oldest first
    note: text("note"),
    noteColor: text("note_color"),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.teamId] })],
)

export const matchStatuses = ["UPCOMING", "LIVE", "HT", "FT", "POSTPONED"] as const
export type MatchStatus = (typeof matchStatuses)[number]

export const matches = pgTable(
  "matches",
  {
    id: text("id").primaryKey(), // "espn-<event id>" or "demo-<n>"
    espnId: text("espn_id").unique(),
    leagueId: text("league_id").references(() => leagues.id),
    homeId: text("home_id")
      .notNull()
      .references(() => teams.id),
    awayId: text("away_id")
      .notNull()
      .references(() => teams.id),
    homeScore: integer("home_score").notNull().default(0),
    awayScore: integer("away_score").notNull().default(0),
    status: text("status").$type<MatchStatus>().notNull(),
    minute: integer("minute"),
    kickoff: timestamp("kickoff", { withTimezone: true }).notNull(),
    venue: text("venue"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("matches_kickoff_idx").on(t.kickoff), index("matches_status_idx").on(t.status)],
)

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the cookie token; the raw token is never stored
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
)

export const favorites = pgTable(
  "favorites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.teamId] })],
)

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_match_idx").on(t.matchId, t.createdAt)],
)

// Licensed streams attached to matches. Only content you hold rights to belongs here.
export const streams = pgTable("streams", {
  matchId: text("match_id")
    .primaryKey()
    .references(() => matches.id, { onDelete: "cascade" }),
  provider: text("provider").$type<"mux" | "hls">().notNull(),
  // Mux playback id, or a full HLS URL for provider "hls".
  source: text("source").notNull(),
  signed: boolean("signed").notNull().default(false),
  quality: text("quality").notNull().default("HD"),
})
