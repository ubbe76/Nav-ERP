ALTER TABLE "articles" ADD COLUMN "surface_treatment" text;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "colour" text;--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD COLUMN "mo_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD COLUMN "routing_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD COLUMN "setup_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD CONSTRAINT "inquiry_rows_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD CONSTRAINT "inquiry_rows_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_inquiry_rows_mo_operation" ON "inquiry_rows" ("mo_operation_id");
