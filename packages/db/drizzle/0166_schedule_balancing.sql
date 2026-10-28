ALTER TABLE "absence_types" ADD COLUMN "earns_atf" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "week_schedules" ADD COLUMN "ordinary_minutes_per_week" integer;--> statement-breakpoint
ALTER TABLE "week_schedules" ADD COLUMN "atf_minutes_per_week" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "week_schedules" ADD CONSTRAINT "week_schedules_ordinary_minutes_range" CHECK ("week_schedules"."ordinary_minutes_per_week" IS NULL OR "week_schedules"."ordinary_minutes_per_week" BETWEEN 60 AND 10080);--> statement-breakpoint
ALTER TABLE "week_schedules" ADD CONSTRAINT "week_schedules_atf_minutes_range" CHECK ("week_schedules"."atf_minutes_per_week" BETWEEN 0 AND 600);--> statement-breakpoint
-- Sjuk, VAB, föräldraledig and tjänstledig earn no ATF (the standard codes;
-- the flag is editable per frånvarokod).
UPDATE "absence_types" SET "earns_atf" = false WHERE "code" IN ('SJK', 'VAB', 'FPE', 'TJL');
