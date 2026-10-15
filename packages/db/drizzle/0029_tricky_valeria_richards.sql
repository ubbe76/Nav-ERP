CREATE TABLE "mo_operation_scrap" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mo_operation_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"reason" text NOT NULL,
	"employee_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "quantity_scrapped" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ADD CONSTRAINT "mo_operation_scrap_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ADD CONSTRAINT "mo_operation_scrap_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Hand-added: FK to employees declared here to avoid a circular schema import.
ALTER TABLE "mo_operation_scrap" ADD CONSTRAINT "mo_operation_scrap_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;
