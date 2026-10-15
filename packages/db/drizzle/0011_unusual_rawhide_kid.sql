ALTER TABLE "purchase_orders" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "exchange_rate" numeric(12, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;