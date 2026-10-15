CREATE TABLE "system_settings" (
	"key" varchar(50) PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stamp_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"mo_operation_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"time_report_id" uuid,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "stamp_sessions" ADD CONSTRAINT "stamp_sessions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stamp_sessions" ADD CONSTRAINT "stamp_sessions_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stamp_sessions" ADD CONSTRAINT "stamp_sessions_time_report_id_time_reports_id_fk" FOREIGN KEY ("time_report_id") REFERENCES "public"."time_reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stamp_sessions" ADD CONSTRAINT "stamp_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stamp_sessions_open_by_employee" ON "stamp_sessions" USING btree ("employee_id") WHERE "stamp_sessions"."stopped_at" is null;