-- Samma artikel flera gånger på en order. The unique (order, article) goes
-- on customer order/quote rows, purchase order rows and inquiry rows: the
-- same article may sit on several rows, e.g. a split delivery where the rest
-- comes on another date (rows already carry their own dates). Plain indexes
-- on the same columns replace them — the row lookups by order need them,
-- and the partial sales index could not even serve a query on
-- sales_order_id alone. The single freight row is now guarded by
-- setFreightRow's find-or-add under the order's row lock.
ALTER TABLE "inquiry_rows" DROP CONSTRAINT "inquiry_rows_inquiry_id_article_id_unique";--> statement-breakpoint
ALTER TABLE "purchase_order_rows" DROP CONSTRAINT "purchase_order_rows_purchase_order_id_article_id_unique";--> statement-breakpoint
DROP INDEX "sales_order_rows_order_article_unique";--> statement-breakpoint
CREATE INDEX "idx_inquiry_rows_inquiry_article" ON "inquiry_rows" USING btree ("inquiry_id","article_id");--> statement-breakpoint
CREATE INDEX "idx_purchase_order_rows_order_article" ON "purchase_order_rows" USING btree ("purchase_order_id","article_id");--> statement-breakpoint
CREATE INDEX "idx_sales_order_rows_order_article" ON "sales_order_rows" USING btree ("sales_order_id","article_id");