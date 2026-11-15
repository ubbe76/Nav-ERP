-- The closed year's period guard (0105/0106) covered only UPDATE (locked →
-- open). A period could still be INSERTed into, or DELETEd from, a closed
-- fiscal year — no code path does either (createFiscalYear makes the
-- periods while the year is open, nothing deletes them), but the guard is
-- the database's promise for any writer, a script included (kodkvalitet
-- 2026-11-15). Same message family, so isClosedFiscalYearViolation maps it
-- to 409 fiscal-year-closed; the year row read FOR SHARE as in 0106.
CREATE OR REPLACE FUNCTION nav_closed_year_period_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'locked' AND NEW.status = 'open'
       AND (SELECT status::text FROM fiscal_years WHERE id = NEW.fiscal_year_id FOR SHARE) = 'closed' THEN
      RAISE EXCEPTION 'Perioden tillhör ett stängt räkenskapsår — öppna året igen under Bokslut'
        USING ERRCODE = 'NV001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (SELECT status::text FROM fiscal_years WHERE id = NEW.fiscal_year_id FOR SHARE) = 'closed' THEN
      RAISE EXCEPTION 'Perioden tillhör ett stängt räkenskapsår — inga perioder kan läggas till'
        USING ERRCODE = 'NV001';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE
  IF (SELECT status::text FROM fiscal_years WHERE id = OLD.fiscal_year_id FOR SHARE) = 'closed' THEN
    RAISE EXCEPTION 'Perioden tillhör ett stängt räkenskapsår — den kan inte tas bort'
      USING ERRCODE = 'NV001';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS accounting_periods_closed_year_lock ON accounting_periods;
--> statement-breakpoint
CREATE TRIGGER accounting_periods_closed_year_lock
  BEFORE INSERT OR UPDATE OR DELETE ON accounting_periods
  FOR EACH ROW EXECUTE FUNCTION nav_closed_year_period_guard();
