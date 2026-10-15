-- Hand-edited: before restoring NOT NULL, any locationless transactions
-- (possible while location was optional) are moved to the auto-created "***"
-- location so the constraint can't fail on existing installations.
DO $$
DECLARE
  fallback_location uuid;
  fallback_warehouse uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM "stock_transactions" WHERE "location_id" IS NULL) THEN
    SELECT id INTO fallback_location FROM "stock_locations" WHERE name = '***' LIMIT 1;
    IF fallback_location IS NULL THEN
      SELECT id INTO fallback_warehouse FROM "warehouses" WHERE name = '***' LIMIT 1;
      IF fallback_warehouse IS NULL THEN
        INSERT INTO "warehouses" (name, active) VALUES ('***', true) RETURNING id INTO fallback_warehouse;
      END IF;
      INSERT INTO "stock_locations" (warehouse_id, name, active)
        VALUES (fallback_warehouse, '***', true) RETURNING id INTO fallback_location;
    END IF;
    UPDATE "stock_transactions" SET "location_id" = fallback_location WHERE "location_id" IS NULL;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "stock_transactions" ALTER COLUMN "location_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "default_location_id" uuid;--> statement-breakpoint
-- Hand-added: the FK is declared here rather than via .references() in
-- article.ts to avoid a circular import with stock.ts.
ALTER TABLE "articles" ADD CONSTRAINT "articles_default_location_id_stock_locations_id_fk" FOREIGN KEY ("default_location_id") REFERENCES "public"."stock_locations"("id") ON DELETE set null ON UPDATE no action;
