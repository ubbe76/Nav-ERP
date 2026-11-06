-- Spärrade lagerplatser (etapp 1, spec
-- private/superpowers/specs/2026-11-06-lagerplatser-fortsattning-design.md).
-- 1. stock_locations.blocked/blocked_at/blocked_note: a blocked place
--    (Karantän, Reklamation) keeps its balance and its value, but the
--    usable balance (onHandByArticle) leaves it out and Automatiskt never
--    draws from it. Every existing location starts open.
-- 2. Two CHECKs: blocked <=> blocked_at (a note only while blocked), and the
--    "***" fallback can never be blocked — the remainder of an automatic
--    draw lands there.
-- 3. idx_stock_transactions_location_article: per-place reads (the location
--    register's sums, locationHoldsStock, the stock count's freeze). Built
--    without CONCURRENTLY inside the migration transaction — enough for a
--    self-hosted stock log of this size.
ALTER TABLE "stock_locations" ADD COLUMN "blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD COLUMN "blocked_note" varchar(200);--> statement-breakpoint
CREATE INDEX "idx_stock_transactions_location_article" ON "stock_transactions" USING btree ("location_id","article_id");--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_blocked_consistent" CHECK (("stock_locations"."blocked" AND "stock_locations"."blocked_at" IS NOT NULL) OR (NOT "stock_locations"."blocked" AND "stock_locations"."blocked_at" IS NULL AND "stock_locations"."blocked_note" IS NULL));--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_fallback_not_blocked" CHECK (NOT ("stock_locations"."blocked" AND "stock_locations"."name" = '***'));