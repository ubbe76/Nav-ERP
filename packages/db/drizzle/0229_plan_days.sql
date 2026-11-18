-- Detaljplanering per dag (#18): the plan's unit is the day. The allocation
-- moves from mo_operation_plan_weeks (minutes per ISO week) to
-- mo_operation_plan_days (minutes per day), the mirrors on mo_operations from
-- planned_start_week/planned_end_week to planned_start_date/planned_end_date,
-- and run_position (the order within a day on a resource) is added. Weeks
-- are never stored again — always derived from the days.
--
-- Order: create the new → copy → set the mirrors → drop the old. Tested by
-- apps/api/test/plan-days-migration.test.ts, which runs this very file
-- against a database migrated up to 0228 with week plans in it.
CREATE TABLE "mo_operation_plan_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mo_operation_id" uuid NOT NULL,
	"plan_date" date NOT NULL,
	"minutes" numeric(10, 2) NOT NULL,
	CONSTRAINT "mo_operation_plan_days_operation_date" UNIQUE("mo_operation_id","plan_date"),
	CONSTRAINT "mo_operation_plan_days_minutes" CHECK ("mo_operation_plan_days"."minutes" > 0)
);
--> statement-breakpoint
ALTER TABLE "mo_operation_plan_days" ADD CONSTRAINT "mo_operation_plan_days_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "planned_start_date" date;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "planned_end_date" date;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "run_position" integer;--> statement-breakpoint
-- The existing week plans, converted: each week's minutes are shared evenly
-- over its working days (Mon–Fri minus full-day holidays — a holiday with a
-- day schedule is a short day and still a working day), the remainder on the
-- week's last day so the sum is exactly the week's minutes. A week made of
-- holidays only keeps its Monday. A week too small to share (a part or the
-- remainder would be under 0.01 minutes, which CHECK minutes > 0 and the
-- writer's MIN_PLAN_MINUTES refuse) goes whole on the week's first day. The
-- resource's own calendar is not read (the day schedules' net minutes are
-- computed in code) — Planera puts the unlocked operations on the right days.
INSERT INTO "mo_operation_plan_days" ("mo_operation_id", "plan_date", "minutes")
WITH working AS (
	SELECT w."id", w."mo_operation_id", w."minutes", (w."week_monday" + g.i) AS d
	FROM "mo_operation_plan_weeks" w
	CROSS JOIN generate_series(0, 4) AS g(i)
	WHERE NOT EXISTS (
		SELECT 1 FROM "holidays" h
		WHERE h."date" = w."week_monday" + g.i AND h."day_schedule_id" IS NULL
	)
), week_days AS (
	SELECT * FROM working
	UNION ALL
	SELECT w."id", w."mo_operation_id", w."minutes", w."week_monday"
	FROM "mo_operation_plan_weeks" w
	WHERE NOT EXISTS (SELECT 1 FROM working k WHERE k."id" = w."id")
), numbered AS (
	SELECT x.*,
		count(*) OVER (PARTITION BY x."id") AS n,
		row_number() OVER (PARTITION BY x."id" ORDER BY x.d) AS rn
	FROM week_days x
), parts AS (
	SELECT y.*, round(y."minutes" / y.n, 2) AS part FROM numbered y
), shared AS (
	SELECT p.*, (p.part < 0.01 OR p."minutes" - p.part * (p.n - 1) < 0.01) AS lumped FROM parts p
)
SELECT s."mo_operation_id", s.d,
	CASE
		WHEN s.lumped THEN s."minutes"
		WHEN s.rn = s.n THEN s."minutes" - s.part * (s.n - 1)
		ELSE s.part
	END
FROM shared s
WHERE NOT s.lumped OR s.rn = 1;--> statement-breakpoint
-- The mirrors: first and last day of the operation's new rows. Operations
-- without rows stay null; plan_locked and planned_at are not touched.
UPDATE "mo_operations" o
SET "planned_start_date" = p.start_date, "planned_end_date" = p.end_date
FROM (
	SELECT "mo_operation_id", min("plan_date") AS start_date, max("plan_date") AS end_date
	FROM "mo_operation_plan_days"
	GROUP BY "mo_operation_id"
) p
WHERE p."mo_operation_id" = o."id";--> statement-breakpoint
-- A lock on an operation whose mirror had no allocation rows (the writer
-- never leaves one) would fail the new CHECK below — it locks nothing.
UPDATE "mo_operations" SET "plan_locked" = false WHERE "plan_locked" AND "planned_start_date" IS NULL;--> statement-breakpoint
DROP TABLE "mo_operation_plan_weeks" CASCADE;--> statement-breakpoint
ALTER TABLE "mo_operations" DROP CONSTRAINT "mo_operations_plan_weeks";--> statement-breakpoint
ALTER TABLE "mo_operations" DROP CONSTRAINT "mo_operations_plan_locked";--> statement-breakpoint
DROP INDEX "idx_mo_operations_planned_start";--> statement-breakpoint
ALTER TABLE "mo_operations" DROP COLUMN "planned_start_week";--> statement-breakpoint
ALTER TABLE "mo_operations" DROP COLUMN "planned_end_week";--> statement-breakpoint
CREATE INDEX "idx_mo_operation_plan_days_date" ON "mo_operation_plan_days" USING btree ("plan_date");--> statement-breakpoint
CREATE INDEX "idx_mo_operations_planned_start" ON "mo_operations" USING btree ("work_center_id","planned_start_date");--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_plan_dates" CHECK (("mo_operations"."planned_start_date" is null) = ("mo_operations"."planned_end_date" is null) and ("mo_operations"."planned_start_date" is null or "mo_operations"."planned_start_date" <= "mo_operations"."planned_end_date"));--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_run_position" CHECK ("mo_operations"."run_position" is null or ("mo_operations"."run_position" > 0 and "mo_operations"."planned_start_date" is not null));--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_plan_locked" CHECK (not "mo_operations"."plan_locked" or "mo_operations"."planned_start_date" is not null);
