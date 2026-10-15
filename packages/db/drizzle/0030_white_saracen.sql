ALTER TABLE "stamp_sessions" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stamp_sessions" ADD COLUMN "paused_seconds" numeric(12, 2) DEFAULT '0' NOT NULL;