-- Before the unique indexes: an installation hit by the race may already
-- hold a second open attendance (or work stamp on the same operation). The
-- earliest stays open; each later one is closed at its own start — a
-- zero-length session that is kept for the history but counts no hours,
-- which is what the double count should have been.
UPDATE "attendance_sessions" a SET "stopped_at" = a."started_at"
WHERE a."stopped_at" IS NULL AND EXISTS (
  SELECT 1 FROM "attendance_sessions" b
  WHERE b."employee_id" = a."employee_id" AND b."stopped_at" IS NULL
    AND (b."started_at", b."id") < (a."started_at", a."id")
);--> statement-breakpoint
UPDATE "stamp_sessions" a SET "stopped_at" = a."started_at"
WHERE a."stopped_at" IS NULL AND EXISTS (
  SELECT 1 FROM "stamp_sessions" b
  WHERE b."employee_id" = a."employee_id" AND b."mo_operation_id" = a."mo_operation_id" AND b."stopped_at" IS NULL
    AND (b."started_at", b."id") < (a."started_at", a."id")
);--> statement-breakpoint
DROP INDEX "attendance_sessions_open_by_employee";--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_one_open_per_employee" ON "attendance_sessions" USING btree ("employee_id") WHERE "attendance_sessions"."stopped_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "stamp_sessions_one_open_per_operation" ON "stamp_sessions" USING btree ("employee_id","mo_operation_id") WHERE "stamp_sessions"."stopped_at" is null;