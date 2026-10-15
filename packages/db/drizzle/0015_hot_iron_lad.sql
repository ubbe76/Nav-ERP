CREATE TYPE "public"."employment_type" AS ENUM('hourly', 'monthly');--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "production_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_group_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	CONSTRAINT "production_group_members_production_group_id_employee_id_unique" UNIQUE("production_group_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "production_group_work_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"production_group_id" uuid NOT NULL,
	"work_center_id" uuid NOT NULL,
	CONSTRAINT "production_group_work_centers_production_group_id_work_center_id_unique" UNIQUE("production_group_id","work_center_id")
);
--> statement-breakpoint
CREATE TABLE "production_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_groups_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "phone" varchar(50);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "email" varchar(255);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "address" varchar(255);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "city" varchar(100);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "personal_identity_number" varchar(13);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employed_from" date;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employed_to" date;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "employment_type" "employment_type";--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "wage" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "weekly_hours" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_group_members" ADD CONSTRAINT "production_group_members_production_group_id_production_groups_id_fk" FOREIGN KEY ("production_group_id") REFERENCES "public"."production_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_group_members" ADD CONSTRAINT "production_group_members_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_group_work_centers" ADD CONSTRAINT "production_group_work_centers_production_group_id_production_groups_id_fk" FOREIGN KEY ("production_group_id") REFERENCES "public"."production_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_group_work_centers" ADD CONSTRAINT "production_group_work_centers_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_sessions_open_by_employee" ON "attendance_sessions" USING btree ("employee_id") WHERE "attendance_sessions"."stopped_at" is null;