CREATE TABLE "mo_operation_plan_weeks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mo_operation_id" uuid NOT NULL,
	"week_monday" date NOT NULL,
	"minutes" numeric(10, 2) NOT NULL,
	CONSTRAINT "mo_operation_plan_weeks_operation_week" UNIQUE("mo_operation_id","week_monday"),
	CONSTRAINT "mo_operation_plan_weeks_monday" CHECK (extract(isodow from "mo_operation_plan_weeks"."week_monday") = 1),
	CONSTRAINT "mo_operation_plan_weeks_minutes" CHECK ("mo_operation_plan_weeks"."minutes" > 0)
);
--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "planned_start_week" date;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "planned_end_week" date;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "plan_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "planned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mo_operation_plan_weeks" ADD CONSTRAINT "mo_operation_plan_weeks_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mo_operation_plan_weeks_week" ON "mo_operation_plan_weeks" USING btree ("week_monday");--> statement-breakpoint
CREATE INDEX "idx_mo_operations_planned_start" ON "mo_operations" USING btree ("planned_start_week");--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_plan_weeks" CHECK (("mo_operations"."planned_start_week" is null) = ("mo_operations"."planned_end_week" is null) and ("mo_operations"."planned_start_week" is null or ("mo_operations"."planned_start_week" <= "mo_operations"."planned_end_week" and extract(isodow from "mo_operations"."planned_start_week") = 1 and extract(isodow from "mo_operations"."planned_end_week") = 1)));--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_plan_locked" CHECK (not "mo_operations"."plan_locked" or "mo_operations"."planned_start_week" is not null);