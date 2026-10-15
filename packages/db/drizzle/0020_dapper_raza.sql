CREATE TYPE "public"."atf_mode" AS ENUM('bank', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."atf_transaction_type" AS ENUM('withdrawal', 'adjustment');--> statement-breakpoint
CREATE TABLE "atf_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"type" "atf_transaction_type" NOT NULL,
	"minutes" integer NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "atf_mode" "atf_mode" DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "atf_minutes_per_week" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "atf_start_date" date;--> statement-breakpoint
ALTER TABLE "atf_transactions" ADD CONSTRAINT "atf_transactions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atf_transactions" ADD CONSTRAINT "atf_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "atf_transactions_by_employee" ON "atf_transactions" USING btree ("employee_id");