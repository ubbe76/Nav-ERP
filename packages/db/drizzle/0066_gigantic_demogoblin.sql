CREATE TYPE "public"."stock_count_status" AS ENUM('open', 'posted', 'cancelled');--> statement-breakpoint
CREATE TABLE "stock_count_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"snapshot_quantity" numeric(14, 4) NOT NULL,
	"counted_quantity" numeric(14, 4),
	"note" text,
	CONSTRAINT "stock_count_rows_session_id_article_id_unique" UNIQUE("session_id","article_id")
);
--> statement-breakpoint
CREATE TABLE "stock_count_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_number" varchar(20) NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "stock_count_status" DEFAULT 'open' NOT NULL,
	"blocks_transactions" boolean NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"posted_at" timestamp with time zone,
	CONSTRAINT "stock_count_sessions_count_number_unique" UNIQUE("count_number")
);
--> statement-breakpoint
ALTER TABLE "stock_count_rows" ADD CONSTRAINT "stock_count_rows_session_id_stock_count_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."stock_count_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_rows" ADD CONSTRAINT "stock_count_rows_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_sessions" ADD CONSTRAINT "stock_count_sessions_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_sessions" ADD CONSTRAINT "stock_count_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_stock_count_open_location" ON "stock_count_sessions" USING btree ("location_id") WHERE "stock_count_sessions"."status" = 'open';
--> statement-breakpoint
INSERT INTO "number_series" ("key","prefix","next_number","digits") VALUES ('stock_count','INV-',1001,0) ON CONFLICT ("key") DO NOTHING;