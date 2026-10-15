ALTER TABLE "manufacturing_orders" ADD COLUMN "configuration" jsonb;--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "configuration_cost" jsonb;