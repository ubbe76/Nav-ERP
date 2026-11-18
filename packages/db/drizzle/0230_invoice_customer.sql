ALTER TABLE "customers" ADD COLUMN "invoice_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "invoice_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_invoice_customer_id_customers_id_fk" FOREIGN KEY ("invoice_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_invoice_customer_id_customers_id_fk" FOREIGN KEY ("invoice_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customers_invoice_customer" ON "customers" USING btree ("invoice_customer_id") WHERE invoice_customer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sales_orders_invoice_customer" ON "sales_orders" USING btree ("invoice_customer_id") WHERE invoice_customer_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_invoice_customer_not_self" CHECK ("customers"."invoice_customer_id" <> "customers"."id");--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_invoice_customer_not_orderer" CHECK ("sales_orders"."invoice_customer_id" <> "sales_orders"."customer_id");