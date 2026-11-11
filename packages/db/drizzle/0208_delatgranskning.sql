ALTER TABLE "purchase_receipts" DROP CONSTRAINT "purchase_receipts_purchase_order_row_id_purchase_order_rows_id_fk";
--> statement-breakpoint
ALTER TABLE "purchase_receipts" ALTER COLUMN "purchase_order_row_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_order_row_id_purchase_order_rows_id_fk" FOREIGN KEY ("purchase_order_row_id") REFERENCES "public"."purchase_order_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Delatgranskningen 2026-11-11 (hand-written below this line).
--
-- The fallback place `***` (stock.md): getOrCreateFallbackLocation was
-- check-then-insert, so two first-ever writers could each create a `***`
-- warehouse and place, and `.limit(1)` then picked either. The name is
-- reserved (StockLocationNameReservedError), so at most one of each may
-- exist; the resolver inserts ON CONFLICT DO NOTHING and reads back. An
-- installation that already has two is left alone (no index, a notice) —
-- merging them would mean moving stock history.
DO $fallback$
BEGIN
  IF (SELECT count(*) FROM warehouses WHERE name = '***') <= 1 THEN
    CREATE UNIQUE INDEX warehouses_fallback_unique ON warehouses (name) WHERE name = '***';
  ELSE
    RAISE NOTICE 'warehouses: more than one *** — warehouses_fallback_unique not created';
  END IF;
  IF (SELECT count(*) FROM stock_locations WHERE name = '***') <= 1 THEN
    CREATE UNIQUE INDEX stock_locations_fallback_unique ON stock_locations (name) WHERE name = '***';
  ELSE
    RAISE NOTICE 'stock_locations: more than one *** — stock_locations_fallback_unique not created';
  END IF;
END
$fallback$;
--> statement-breakpoint
-- Räkenskapsår may not share a day. createFiscalYear checks first, but
-- without a lock — two concurrent creates both passed. 23P01 is mapped to
-- OverlappingFiscalYearError. A range type's own GiST opclass, no btree_gist.
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_no_overlap" EXCLUDE USING gist (daterange("start_date", "end_date", '[]') WITH &&);
--> statement-breakpoint
-- The stock log is append-only (CLAUDE.md principle 1) and the record the
-- year-end valuation is computed from; nothing in the application updates or
-- deletes a row. The one allowed UPDATE is a deleted user's created_by set
-- to null (the FK's ON DELETE SET NULL). Same SQLSTATE as the bookkeeping
-- lock (0095) — the global handler answers 409. Tests that backdate rows do
-- it under session_replication_role = replica (test/helpers/stock-log.ts),
-- as the fast truncate does.
CREATE OR REPLACE FUNCTION nav_stock_transactions_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.created_by IS NULL
     AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Lagerloggen kan inte ändras i efterhand (lagerrad %)', OLD.id USING ERRCODE = 'NV001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_transactions_append_only BEFORE UPDATE OR DELETE ON "stock_transactions"
  FOR EACH ROW EXECUTE FUNCTION nav_stock_transactions_append_only();
