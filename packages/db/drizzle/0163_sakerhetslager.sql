ALTER TABLE "articles" ADD COLUMN "safety_stock" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "stock_controlled" boolean DEFAULT false NOT NULL;