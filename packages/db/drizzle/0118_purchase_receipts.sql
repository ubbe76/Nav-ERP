CREATE TABLE "purchase_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"purchase_order_row_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"location_id" uuid,
	"stock_transaction_id" uuid,
	"mo_report_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid
);
--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_order_row_id_purchase_order_rows_id_fk" FOREIGN KEY ("purchase_order_row_id") REFERENCES "public"."purchase_order_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_stock_transaction_id_stock_transactions_id_fk" FOREIGN KEY ("stock_transaction_id") REFERENCES "public"."stock_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_receipts_by_order" ON "purchase_receipts" USING btree ("purchase_order_id","created_at");--> statement-breakpoint
CREATE INDEX "purchase_receipts_by_stock_transaction" ON "purchase_receipts" USING btree ("stock_transaction_id");--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_mo_report_id_mo_reports_id_fk" FOREIGN KEY ("mo_report_id") REFERENCES "public"."mo_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill: every receipt so far becomes a log row, so it can be undone too.
-- An ordinary row's receipt is exactly one positive purchase_receipt stock
-- movement (reference_id = the order, one row per article and order).
INSERT INTO "purchase_receipts" ("purchase_order_id", "purchase_order_row_id", "quantity", "location_id",
  "stock_transaction_id", "created_by", "created_at")
SELECT por."purchase_order_id", por."id", st."quantity_delta", st."location_id", st."id", st."created_by", st."created_at"
FROM "stock_transactions" st
JOIN "purchase_order_rows" por ON por."purchase_order_id" = st."reference_id" AND por."article_id" = st."article_id"
WHERE st."transaction_type" = 'purchase_receipt' AND st."quantity_delta" > 0 AND por."mo_operation_id" IS NULL;--> statement-breakpoint
-- A lego row books no purchase stock; its receipts are the TO reports they
-- made (logged since 0117). Receipts whose report failed, or that predate
-- the report log, have no record and cannot be undone.
INSERT INTO "purchase_receipts" ("purchase_order_id", "purchase_order_row_id", "quantity", "mo_report_id", "created_by", "created_at")
SELECT por."purchase_order_id", por."id", r."quantity_ok", r."id", r."created_by", r."created_at"
FROM "mo_reports" r
JOIN "purchase_order_rows" por ON por."purchase_order_id" = r."purchase_order_id" AND por."mo_operation_id" = r."mo_operation_id"
WHERE r."source" = 'purchase_receipt' AND r."undone_at" IS NULL;
