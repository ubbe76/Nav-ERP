ALTER TYPE "public"."work_center_type" ADD VALUE 'subcontract';--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "work_centers" ADD CONSTRAINT "work_centers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;