ALTER TABLE "sales_order_rows" DROP CONSTRAINT "sales_order_rows_sales_order_id_article_id_unique";--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "show_configuration_prices" boolean;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "show_configuration_prices" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD COLUMN "configuration" jsonb;--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "configuration" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_rows_order_article_unique" ON "sales_order_rows" USING btree ("sales_order_id","article_id") WHERE "sales_order_rows"."configuration" IS NULL;