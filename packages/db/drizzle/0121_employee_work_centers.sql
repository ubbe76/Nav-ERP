CREATE TABLE "employee_work_centers" (
	"employee_id" uuid NOT NULL,
	"work_center_id" uuid NOT NULL,
	CONSTRAINT "employee_work_centers_employee_id_work_center_id_pk" PRIMARY KEY("employee_id","work_center_id")
);
--> statement-breakpoint
ALTER TABLE "employee_work_centers" ADD CONSTRAINT "employee_work_centers_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_work_centers" ADD CONSTRAINT "employee_work_centers_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE cascade ON UPDATE no action;