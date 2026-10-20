ALTER TABLE "delivery_rows" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD COLUMN "stock_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD COLUMN "undone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD COLUMN "undone_by" uuid;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD CONSTRAINT "delivery_rows_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD CONSTRAINT "delivery_rows_stock_transaction_id_stock_transactions_id_fk" FOREIGN KEY ("stock_transaction_id") REFERENCES "public"."stock_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_rows" ADD CONSTRAINT "delivery_rows_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_rows_by_stock_transaction" ON "delivery_rows" USING btree ("stock_transaction_id");--> statement-breakpoint
-- Backfill: pair every existing delivery row with the stock movement that
-- delivered it, so it can be undone too. deliverBatch wrote both in ONE
-- transaction, so the movement's created_at equals the delivery's
-- delivered_at exactly (both now()); reference_id is the order. The same
-- article can sit twice on one följesedel (configured rows of one template)
-- — row_number() pairs them, and either pairing is equivalent (same article,
-- quantity and location). Rows without a match stay null: not undoable.
WITH dr AS (
  SELECT r."id", d."sales_order_id", d."delivered_at", sor."article_id", r."quantity",
         row_number() OVER (PARTITION BY r."delivery_id", sor."article_id", r."quantity" ORDER BY r."id") AS rn
  FROM "delivery_rows" r
  JOIN "deliveries" d ON d."id" = r."delivery_id"
  JOIN "sales_order_rows" sor ON sor."id" = r."sales_order_row_id"
), st AS (
  SELECT t."id", t."location_id", t."reference_id", t."article_id", -t."quantity_delta" AS quantity, t."created_at",
         row_number() OVER (PARTITION BY t."reference_id", t."article_id", t."created_at", t."quantity_delta" ORDER BY t."id") AS rn
  FROM "stock_transactions" t
  WHERE t."transaction_type" = 'sales_delivery' AND t."quantity_delta" < 0
)
UPDATE "delivery_rows" target
SET "location_id" = st."location_id", "stock_transaction_id" = st."id"
FROM dr
JOIN st ON st."reference_id" = dr."sales_order_id" AND st."article_id" = dr."article_id"
  AND st."quantity" = dr."quantity" AND st."created_at" = dr."delivered_at" AND st."rn" = dr."rn"
WHERE target."id" = dr."id";
