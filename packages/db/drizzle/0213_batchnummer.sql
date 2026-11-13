-- Spårbarhet med batchnummer (#8, etapp 1). A batch is a dimension on the
-- stock log: stock_transactions.batch_id, NULL = "Okänd" (every existing row
-- — no backfill; the log is append-only and its trigger compares the whole
-- row, so the new column can never be changed afterwards either). The
-- nullable columns are catalogue changes only; the FK validation and the
-- partial index read the log once.
CREATE TYPE "public"."stock_batch_origin" AS ENUM('purchase_receipt', 'manufacturing_order', 'manual', 'import');--> statement-breakpoint
CREATE TABLE "stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"batch_number" varchar(50) NOT NULL,
	"origin" "stock_batch_origin" NOT NULL,
	"purchase_order_id" uuid,
	"manufacturing_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "stock_batches_number_trimmed" CHECK ("stock_batches"."batch_number" = btrim("stock_batches"."batch_number") AND "stock_batches"."batch_number" <> ''),
	CONSTRAINT "stock_batches_number_not_reserved" CHECK (lower("stock_batches"."batch_number") <> 'okänd')
);
--> statement-breakpoint
ALTER TABLE "stock_count_rows" DROP CONSTRAINT "stock_count_rows_session_id_article_id_unique";--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "batch_tracked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mo_report_materials" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD COLUMN "receipt_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_count_rows" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_transactions" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Declared by hand: purchase.ts and manufacturing.ts import stock.ts, so the
-- schema cannot reference them without a circular import.
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_manufacturing_order_id_manufacturing_orders_id_fk" FOREIGN KEY ("manufacturing_order_id") REFERENCES "public"."manufacturing_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_batches_article_number_unique" ON "stock_batches" USING btree ("article_id",lower("batch_number"));--> statement-breakpoint
CREATE INDEX "idx_stock_batches_manufacturing_order" ON "stock_batches" USING btree ("manufacturing_order_id") WHERE "stock_batches"."manufacturing_order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_stock_batches_number_search" ON "stock_batches" USING btree (lower("batch_number") text_pattern_ops);--> statement-breakpoint
ALTER TABLE "mo_report_materials" ADD CONSTRAINT "mo_report_materials_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_reports" ADD CONSTRAINT "mo_reports_receipt_batch_id_stock_batches_id_fk" FOREIGN KEY ("receipt_batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_rows" ADD CONSTRAINT "stock_count_rows_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_stock_transactions_batch" ON "stock_transactions" USING btree ("batch_id") WHERE "stock_transactions"."batch_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_count_rows" ADD CONSTRAINT "stock_count_rows_session_article_batch_unique" UNIQUE NULLS NOT DISTINCT("session_id","article_id","batch_id");