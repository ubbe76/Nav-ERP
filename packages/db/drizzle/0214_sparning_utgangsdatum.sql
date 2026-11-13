-- Spårbarhet etapp 2 (#8), steg 1–2. Artikelns Spårning blir en enum
-- (none | batch | serial — "antingen eller") i stället för booleanen
-- batch_tracked; datat flyttas för hand nedan. Batchen får Utgångsdatum
-- (expires_on, sista användbara dag) och Batchdatum (batch_date, åldern när
-- den inte är radens created_at), artikeln Hållbarhet (dagar) och valet
-- Serienummer skapas (används från serienummersteget). Bara NYA typer —
-- inga ALTER TYPE … ADD VALUE, så allt ryms i migrationens transaktion.
-- stock_batches är inte en del av den oföränderliga loggen; lagerloggen rörs
-- inte.
CREATE TYPE "public"."article_serial_assigned_at" AS ENUM('receipt', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."article_tracking" AS ENUM('none', 'batch', 'serial');--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "tracking" "article_tracking" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "shelf_life_days" integer;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "serial_assigned_at" "article_serial_assigned_at" DEFAULT 'receipt' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD COLUMN "batch_date" date;--> statement-breakpoint
CREATE INDEX "idx_stock_batches_expires_on" ON "stock_batches" USING btree ("expires_on") WHERE "stock_batches"."expires_on" IS NOT NULL;--> statement-breakpoint
-- Written by hand: carry the flag over before the column goes. The only
-- trigger on articles is prishistorikens (AFTER … UPDATE OF sales_price).
UPDATE "articles" SET "tracking" = 'batch' WHERE "batch_tracked";--> statement-breakpoint
ALTER TABLE "articles" DROP COLUMN "batch_tracked";--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_shelf_life_days_range" CHECK ("articles"."shelf_life_days" IS NULL OR "articles"."shelf_life_days" BETWEEN 1 AND 36500);