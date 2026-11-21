ALTER TABLE "leagues" ADD COLUMN "sport" text DEFAULT 'soccer' NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "sport" text DEFAULT 'soccer' NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "status_text" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "linescores" jsonb;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "sport" text DEFAULT 'soccer' NOT NULL;