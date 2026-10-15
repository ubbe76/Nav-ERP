CREATE TABLE "routing_operation_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routing_operation_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routing_operation_files_routing_operation_id_unique" UNIQUE("routing_operation_id")
);
--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "subcontract_amount" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "subcontract_supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "setup_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "unit_price" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "mo_operations" ADD COLUMN "show_net_weight" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "subcontract_supplier_id" uuid;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "setup_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "unit_price" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "show_net_weight" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD COLUMN "use_article_drawing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "routing_operation_files" ADD CONSTRAINT "routing_operation_files_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_subcontract_supplier_id_suppliers_id_fk" FOREIGN KEY ("subcontract_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_subcontract_supplier_id_suppliers_id_fk" FOREIGN KEY ("subcontract_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;