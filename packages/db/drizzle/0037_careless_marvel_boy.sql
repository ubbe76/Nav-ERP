ALTER TABLE "purchase_orders" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;