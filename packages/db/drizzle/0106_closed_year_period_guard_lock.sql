-- The period guard from 0105, now reading the fiscal year FOR SHARE (like
-- nav_closed_year_booking_guard): an unlock racing a close waits for the
-- close's UPDATE of the year row and then reads 'closed' — otherwise the
-- close's lockAllPeriods (WHERE status = 'open') could skip a month the
-- unlock had opened but not yet committed, leaving a closed year with an
-- open month.
CREATE OR REPLACE FUNCTION nav_closed_year_period_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'locked' AND NEW.status = 'open'
     AND (SELECT status::text FROM fiscal_years WHERE id = NEW.fiscal_year_id FOR SHARE) = 'closed' THEN
    RAISE EXCEPTION 'Perioden tillhör ett stängt räkenskapsår — öppna året igen under Bokslut'
      USING ERRCODE = 'NV001';
  END IF;
  RETURN NEW;
END;
$$;
