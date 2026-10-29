ALTER TABLE "employees" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
-- Radera eller anonymisera en anställd (GDPR, #2; spec
-- 2026-10-29-radera-anonymisera-anstalld-design.md). Once anonymized an
-- employee row is frozen and gets nothing new — these triggers enforce it for
-- every writer (manual time reports, absences, ATF, schedule overrides, the
-- terminal), the way the bookkeeping lock (0095) does for booked records.
-- Refusals raise SQLSTATE NV002, mapped to 409 "employee-anonymized" by the
-- API's error handler. TRUNCATE fires no row triggers.
CREATE OR REPLACE FUNCTION nav_employee_anonymized_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'employees' THEN
    IF OLD.anonymized_at IS NOT NULL THEN
      RAISE EXCEPTION 'Employee % is anonymized and cannot change', OLD.id USING ERRCODE = 'NV002';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF EXISTS (SELECT 1 FROM employees WHERE id = NEW.employee_id AND anonymized_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Employee % is anonymized and gets no new rows', NEW.employee_id USING ERRCODE = 'NV002';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER employees_anonymized_guard
  BEFORE UPDATE OR DELETE ON employees
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER time_reports_anonymized_guard BEFORE INSERT ON time_reports
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER stamp_sessions_anonymized_guard BEFORE INSERT ON stamp_sessions
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER attendance_sessions_anonymized_guard BEFORE INSERT ON attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER absences_anonymized_guard BEFORE INSERT ON absences
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER atf_transactions_anonymized_guard BEFORE INSERT ON atf_transactions
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER overtime_dispositions_anonymized_guard BEFORE INSERT ON overtime_dispositions
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER employee_week_overrides_anonymized_guard BEFORE INSERT ON employee_week_overrides
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER employee_day_overrides_anonymized_guard BEFORE INSERT ON employee_day_overrides
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
--> statement-breakpoint
CREATE TRIGGER employee_work_centers_anonymized_guard BEFORE INSERT ON employee_work_centers
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
