DROP INDEX "sales_order_rows_order_article_unique";--> statement-breakpoint
ALTER TABLE "customer_prices" ADD COLUMN "setup_price" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "setup_for_row_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD CONSTRAINT "sales_order_rows_setup_for_row_id_sales_order_rows_id_fk" FOREIGN KEY ("setup_for_row_id") REFERENCES "public"."sales_order_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_rows_order_article_unique" ON "sales_order_rows" USING btree ("sales_order_id","article_id") WHERE "sales_order_rows"."configuration" IS NULL AND "sales_order_rows"."setup_for_row_id" IS NULL;--> statement-breakpoint
ALTER TABLE "customer_prices" ADD CONSTRAINT "customer_prices_setup_price_nonnegative" CHECK (setup_price IS NULL OR setup_price >= 0);