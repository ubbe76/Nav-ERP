CREATE TABLE "employee_terminal_pins" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"pin_hash" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "employee_terminal_pins" ADD CONSTRAINT "employee_terminal_pins_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- An anonymized employee chooses no new code (0170's NV002, as the other
-- tables that hang on an employee). The anonymization itself deletes the row.
CREATE TRIGGER employee_terminal_pins_anonymized_guard BEFORE INSERT ON employee_terminal_pins
  FOR EACH ROW EXECUTE FUNCTION nav_employee_anonymized_guard();
