-- Prishistorikens ordning (#14 etapp 4, granskningen; spec
-- private/superpowers/specs/2026-11-06-avvikelseanalys-efterkalkyl-design.md).
-- Replaces the trigger functions of 0169 (försäljningspris, leverantörs-
-- katalogen) and 0189 (timkostnad); 0169 and 0189 themselves are unchanged.
--
-- valid_from = now() is the transaction's START. Two transactions that
-- change the same value therefore recorded it in start order, not in the
-- order the changes took effect: T1 starts 10:00, T2 starts 10:01, sets 700
-- and commits, then T1 sets 600 and records (600, 10:00) — the history said
-- 700 last while the row said 600. Now a new row is never earlier than the
-- latest one: valid_from = greatest(now(), latest.valid_from + 1 µs). The
-- row lock on the changed row (work_centers, articles, article_suppliers)
-- makes T1's trigger run after T2's commit, so it sees T2's row (READ
-- COMMITTED: each statement a new snapshot; under REPEATABLE READ T1's
-- UPDATE of a row T2 changed fails with a serialization error instead).
-- Without the race greatest() is now(), as before. GREATEST ignores NULL, so
-- the first row is now().
--
-- A second change in the same transaction still replaces the transaction's
-- own row — but the own row is now found by who wrote it, not by
-- valid_from = now() (it may lie after now()): xmin = this transaction's id.
-- A row written inside a SAVEPOINT carries the subtransaction's id and is
-- not replaced; the second change then gets a row of its own 1 µs later, so
-- the latest row is still the final value (no writer of these columns uses a
-- savepoint today). TRUNCATE (the test suite's cleanup) fires no row
-- triggers. The standard cost (D1, article_standard_cost_history) is written
-- by the application, recordStandardCostHistory, with the same rule.

CREATE OR REPLACE FUNCTION nav_work_center_rate_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last work_center_rate_history%ROWTYPE;
BEGIN
  DELETE FROM work_center_rate_history
    WHERE work_center_id = NEW.id AND xmin = pg_current_xact_id()::xid;
  SELECT * INTO v_last FROM work_center_rate_history
    WHERE work_center_id = NEW.id ORDER BY valid_from DESC, id DESC LIMIT 1;
  IF FOUND AND v_last.hourly_rate = NEW.hourly_rate THEN
    RETURN NULL;
  END IF;
  INSERT INTO work_center_rate_history (work_center_id, hourly_rate, valid_from)
  VALUES (NEW.id, NEW.hourly_rate, greatest(now(), v_last.valid_from + interval '1 microsecond'));
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nav_article_sales_price_history() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_last article_sales_price_history%ROWTYPE;
BEGIN
  DELETE FROM article_sales_price_history
    WHERE article_id = NEW.id AND xmin = pg_current_xact_id()::xid;
  SELECT * INTO v_last FROM article_sales_price_history
    WHERE article_id = NEW.id ORDER BY valid_from DESC, id DESC LIMIT 1;
  IF FOUND THEN
    IF v_last.price IS NOT DISTINCT FROM NEW.sales_price THEN
      RETURN NULL;
    END IF;
  ELSIF NEW.sales_price IS NULL THEN
    RETURN NULL; -- no history and no price: nothing to record
  END IF;
  INSERT INTO article_sales_price_history (article_id, price, valid_from)
  VALUES (NEW.id, NEW.sales_price, greatest(now(), v_last.valid_from + interval '1 microsecond'));
  RETURN NULL;
END $$;
--> statement-breakpoint
-- The catalog snapshot (deferred, at COMMIT): as 0169, only the new rows'
-- valid_from follows the latest one. It never replaced a row — the first
-- event of the transaction writes the final state and the rest find it
-- identical.
CREATE OR REPLACE FUNCTION nav_snapshot_article_supplier(p_article uuid, p_supplier uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_row article_suppliers%ROWTYPE;
  v_found boolean;
  v_breaks jsonb := '[]'::jsonb;
  v_last article_supplier_price_history%ROWTYPE;
  v_has_last boolean;
BEGIN
  -- The article was deleted in this transaction (the catalog cascades).
  IF NOT EXISTS (SELECT 1 FROM articles WHERE id = p_article) THEN
    RETURN;
  END IF;
  SELECT * INTO v_row FROM article_suppliers WHERE article_id = p_article AND supplier_id = p_supplier;
  v_found := FOUND;
  IF v_found THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('fromQuantity', from_quantity, 'price', price) ORDER BY from_quantity), '[]'::jsonb)
      INTO v_breaks FROM article_supplier_price_breaks WHERE article_supplier_id = v_row.id;
  END IF;
  SELECT * INTO v_last FROM article_supplier_price_history
    WHERE article_id = p_article AND supplier_id = p_supplier
    ORDER BY valid_from DESC, id DESC LIMIT 1;
  v_has_last := FOUND;

  IF NOT v_found THEN
    -- Removed: record it once, and only for a row that has history.
    IF NOT v_has_last OR v_last.removed THEN
      RETURN;
    END IF;
    INSERT INTO article_supplier_price_history (article_id, supplier_id, price, currency, price_breaks, is_primary, removed, valid_from)
    VALUES (p_article, CASE WHEN EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier) THEN p_supplier END,
            v_last.price, v_last.currency, v_last.price_breaks, false, true,
            greatest(now(), v_last.valid_from + interval '1 microsecond'));
    RETURN;
  END IF;

  IF v_has_last AND NOT v_last.removed
     AND v_last.price IS NOT DISTINCT FROM v_row.price
     AND v_last.currency = v_row.currency
     AND v_last.price_breaks = v_breaks
     AND v_last.is_primary = v_row.is_primary THEN
    RETURN;
  END IF;
  INSERT INTO article_supplier_price_history (article_id, supplier_id, price, currency, price_breaks, is_primary, valid_from)
  VALUES (p_article, p_supplier, v_row.price, v_row.currency, v_breaks, v_row.is_primary,
          greatest(now(), v_last.valid_from + interval '1 microsecond'));
END $$;
