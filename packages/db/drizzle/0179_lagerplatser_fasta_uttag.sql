-- Förbättrad lagerplatshantering: fasta lagerplatser, uttag där saldot finns,
-- lagerplats per rad i Utleverans.
--
-- 1. stock_locations.fixed — a fixed location stays active when emptied (only a
--    temporary one is deactivated by deactivateEmptyLocation). Every existing
--    location becomes fixed; the inactive ones stay inactive.
-- 2. delivery_row_locations — an automatic outflow may draw one delivery row
--    from several locations, so the single location_id/stock_transaction_id
--    pair on delivery_rows (migration 0132) becomes one row per part. Existing
--    pairs are copied over before the columns go; rows the 0132 backfill could
--    not pair get no parts and stay not undoable, as before.
CREATE TABLE "delivery_row_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_row_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"stock_transaction_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_row_locations" ADD CONSTRAINT "delivery_row_locations_delivery_row_id_delivery_rows_id_fk" FOREIGN KEY ("delivery_row_id") REFERENCES "public"."delivery_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_row_locations" ADD CONSTRAINT "delivery_row_locations_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_row_locations" ADD CONSTRAINT "delivery_row_locations_stock_transaction_id_stock_transactions_id_fk" FOREIGN KEY ("stock_transaction_id") REFERENCES "public"."stock_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_delivery_row_locations_row" ON "delivery_row_locations" USING btree ("delivery_row_id");--> statement-breakpoint
CREATE INDEX "delivery_row_locations_by_stock_transaction" ON "delivery_row_locations" USING btree ("stock_transaction_id");--> statement-breakpoint
-- Every paired delivery row becomes one part: the whole row quantity at the
-- one location it was drawn from.
INSERT INTO "delivery_row_locations" ("delivery_row_id", "location_id", "quantity", "stock_transaction_id")
SELECT "id", "location_id", "quantity", "stock_transaction_id"
FROM "delivery_rows"
WHERE "location_id" IS NOT NULL AND "stock_transaction_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_rows" DROP CONSTRAINT "delivery_rows_location_id_stock_locations_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_rows" DROP CONSTRAINT "delivery_rows_stock_transaction_id_stock_transactions_id_fk";
--> statement-breakpoint
DROP INDEX "delivery_rows_by_stock_transaction";--> statement-breakpoint
ALTER TABLE "delivery_rows" DROP COLUMN "location_id";--> statement-breakpoint
ALTER TABLE "delivery_rows" DROP COLUMN "stock_transaction_id";--> statement-breakpoint
ALTER TABLE "stock_locations" ADD COLUMN "fixed" boolean DEFAULT true NOT NULL;
