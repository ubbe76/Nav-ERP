-- A stock location holding a balance is always active (stock.md). The
-- writers keep it — resolveStockLocation revives an explicit place,
-- deactivateEmptyLocation only retires a place it found empty under its
-- lock — but an inflow that resolved a temporary place before a concurrent
-- cleanup committed could still land on it after the cleanup made it
-- inactive: stock on a place every list hides.
--
-- The cleanup now locks the place FOR UPDATE, which waits for every
-- transaction that has inserted a row on it (the FK check holds FOR KEY
-- SHARE until commit), and an insert that comes after waits in its FK check
-- until the cleanup has committed. This trigger then revives the place for
-- that insert. It runs after the FK check (AFTER ROW triggers fire in name
-- order and the RI triggers' names sort first), and its UPDATE reads the
-- committed state. Free when the place is active: the WHERE matches nothing
-- and nothing is locked.
CREATE OR REPLACE FUNCTION nav_stock_location_revive() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE stock_locations SET active = true WHERE id = NEW.location_id AND NOT active;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_transactions_revive_location
  AFTER INSERT ON stock_transactions
  FOR EACH ROW EXECUTE FUNCTION nav_stock_location_revive();
