ALTER TABLE "leagues" ADD COLUMN "featured" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "leagues" ADD COLUMN "last_viewed_at" timestamp with time zone;