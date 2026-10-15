CREATE TYPE "public"."schedule_break_type" AS ENUM('unpaid', 'paid');--> statement-breakpoint
CREATE TABLE "day_schedule_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day_schedule_id" uuid NOT NULL,
	"type" "schedule_break_type" NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL
);
--> statement-breakpoint
CREATE TABLE "day_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "day_schedules_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "employee_day_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"day_schedule_id" uuid,
	CONSTRAINT "employee_day_overrides_date_unique" UNIQUE("employee_id","date")
);
--> statement-breakpoint
CREATE TABLE "employee_week_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"iso_year" smallint NOT NULL,
	"iso_week" smallint NOT NULL,
	"week_schedule_id" uuid NOT NULL,
	CONSTRAINT "employee_week_overrides_week_unique" UNIQUE("employee_id","iso_year","iso_week")
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"name" varchar(100) NOT NULL,
	"day_schedule_id" uuid,
	CONSTRAINT "holidays_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE TABLE "week_schedule_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_schedule_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"day_schedule_id" uuid NOT NULL,
	CONSTRAINT "week_schedule_days_weekday_unique" UNIQUE("week_schedule_id","weekday")
);
--> statement-breakpoint
CREATE TABLE "week_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "week_schedules_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "default_week_schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "day_schedule_breaks" ADD CONSTRAINT "day_schedule_breaks_day_schedule_id_day_schedules_id_fk" FOREIGN KEY ("day_schedule_id") REFERENCES "public"."day_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_day_overrides" ADD CONSTRAINT "employee_day_overrides_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_day_overrides" ADD CONSTRAINT "employee_day_overrides_day_schedule_id_day_schedules_id_fk" FOREIGN KEY ("day_schedule_id") REFERENCES "public"."day_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_week_overrides" ADD CONSTRAINT "employee_week_overrides_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_week_overrides" ADD CONSTRAINT "employee_week_overrides_week_schedule_id_week_schedules_id_fk" FOREIGN KEY ("week_schedule_id") REFERENCES "public"."week_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_day_schedule_id_day_schedules_id_fk" FOREIGN KEY ("day_schedule_id") REFERENCES "public"."day_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_schedule_days" ADD CONSTRAINT "week_schedule_days_week_schedule_id_week_schedules_id_fk" FOREIGN KEY ("week_schedule_id") REFERENCES "public"."week_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "week_schedule_days" ADD CONSTRAINT "week_schedule_days_day_schedule_id_day_schedules_id_fk" FOREIGN KEY ("day_schedule_id") REFERENCES "public"."day_schedules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_default_week_schedule_id_week_schedules_id_fk" FOREIGN KEY ("default_week_schedule_id") REFERENCES "public"."week_schedules"("id") ON DELETE restrict ON UPDATE no action;