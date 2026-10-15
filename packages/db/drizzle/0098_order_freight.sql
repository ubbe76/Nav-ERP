ALTER TABLE "sales_orders" ADD COLUMN "freight_product_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "freight_carrier_price" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "freight_quote" jsonb;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_freight_product_id_freight_products_id_fk" FOREIGN KEY ("freight_product_id") REFERENCES "public"."freight_products"("id") ON DELETE restrict ON UPDATE no action;