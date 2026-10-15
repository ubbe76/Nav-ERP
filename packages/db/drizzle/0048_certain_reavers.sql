CREATE TYPE "public"."overtime_compensation" AS ENUM('payout', 'comp');--> statement-breakpoint
CREATE TABLE "overtime_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"disposition" "overtime_compensation" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "overtime_compensation" "overtime_compensation" DEFAULT 'payout' NOT NULL;--> statement-breakpoint
ALTER TABLE "overtime_dispositions" ADD CONSTRAINT "overtime_dispositions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_dispositions" ADD CONSTRAINT "overtime_dispositions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "overtime_dispositions_employee_date_unique" ON "overtime_dispositions" USING btree ("employee_id","date");