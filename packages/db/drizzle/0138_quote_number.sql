-- Offerter: a quote gets its own number series (OF-) and keeps it as a
-- reference when it becomes an order with a KO- number. Existing quotes keep
-- their KO- numbers (no backfill, quote_number stays null).
ALTER TABLE "sales_orders" ADD COLUMN "quote_number" varchar(20);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quote_number_unique" UNIQUE("quote_number");--> statement-breakpoint
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits") VALUES ('quote', 'OF-', 1001, 0)
  ON CONFLICT ("key") DO NOTHING;
