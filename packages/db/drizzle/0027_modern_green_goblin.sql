ALTER TABLE "mo_material_consumptions" DROP CONSTRAINT "mo_material_consumptions_manufacturing_order_id_component_article_id_unique";--> statement-breakpoint
ALTER TABLE "stock_transactions" ALTER COLUMN "location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bom_components" ADD COLUMN "routing_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD COLUMN "mo_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "routing_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "quantity_completed" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD CONSTRAINT "mo_material_consumptions_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD CONSTRAINT "mo_material_unique_per_operation" UNIQUE NULLS NOT DISTINCT("manufacturing_order_id","component_article_id","mo_operation_id");--> statement-breakpoint
-- Hand-added: bom_components.routing_operation_id is declared without
-- .references() in article.ts to avoid a circular import with
-- manufacturing.ts, so the FK is created here. ON DELETE SET NULL clears the
-- link when a routing operation is removed.
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE set null ON UPDATE no action;