ALTER TABLE "purchase_order_rows" ADD COLUMN "confirmed_delivery_date" date;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "confirmed_delivery_date" date;--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "expected_delivery_date" date;