ALTER TABLE "purchase_order_rows" ADD COLUMN "mo_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_rows" ADD COLUMN "setup_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "purchase_order_rows" ADD CONSTRAINT "purchase_order_rows_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_purchase_order_rows_mo_operation" ON "purchase_order_rows" ("mo_operation_id");
