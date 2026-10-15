ALTER TABLE "manufacturing_orders" ADD COLUMN "quantity_received" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Backfill: every receipt so far was the single mo_receipt written by Slutför.
UPDATE "manufacturing_orders" mo
SET "quantity_received" = r.total
FROM (
  SELECT "reference_id", SUM("quantity_delta") AS total
  FROM "stock_transactions"
  WHERE "transaction_type" = 'mo_receipt'
  GROUP BY "reference_id"
) r
WHERE r."reference_id" = mo."id";
