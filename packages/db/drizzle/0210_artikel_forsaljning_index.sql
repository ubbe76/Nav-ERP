CREATE INDEX "idx_customer_prices_article" ON "customer_prices" USING btree ("article_id") WHERE article_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_customer_prices_article_group" ON "customer_prices" USING btree ("article_group_id") WHERE article_group_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_price_list_rows_article" ON "price_list_rows" USING btree ("article_id");