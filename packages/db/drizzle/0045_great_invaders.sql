CREATE TYPE "public"."cost_material_row_kind" AS ENUM('material', 'subcontract');--> statement-breakpoint
CREATE TYPE "public"."cost_price_source" AS ENUM('supplier', 'standard', 'none');--> statement-breakpoint
CREATE TYPE "public"."costing_material_source" AS ENUM('supplier', 'standard');--> statement-breakpoint
CREATE TABLE "cost_calculation_material_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cost_calculation_id" uuid NOT NULL,
	"component_article_id" uuid NOT NULL,
	"kind" "cost_material_row_kind" NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_id" uuid,
	"unit_factor" numeric(16, 6),
	"unit_cost" numeric(14, 4) NOT NULL,
	"price_source" "cost_price_source" NOT NULL,
	"amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_calculation_operation_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cost_calculation_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"work_center_id" uuid NOT NULL,
	"hours" numeric(12, 4) NOT NULL,
	"hourly_rate" numeric(10, 2) NOT NULL,
	"overhead_percent" numeric(5, 2) NOT NULL,
	"labor_amount" numeric(14, 4) NOT NULL,
	"overhead_amount" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "material_source" "costing_material_source" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "mo_percent" numeric(6, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "lo_percent" numeric(6, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "affo_percent" numeric(6, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "general_markup_percent" numeric(6, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD CONSTRAINT "cost_calculation_material_rows_cost_calculation_id_cost_calculations_id_fk" FOREIGN KEY ("cost_calculation_id") REFERENCES "public"."cost_calculations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD CONSTRAINT "cost_calculation_material_rows_component_article_id_articles_id_fk" FOREIGN KEY ("component_article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD CONSTRAINT "cost_calculation_material_rows_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD CONSTRAINT "cost_calculation_operation_rows_cost_calculation_id_cost_calculations_id_fk" FOREIGN KEY ("cost_calculation_id") REFERENCES "public"."cost_calculations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD CONSTRAINT "cost_calculation_operation_rows_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cost_calculation_material_rows_calculation" ON "cost_calculation_material_rows" USING btree ("cost_calculation_id");--> statement-breakpoint
CREATE INDEX "idx_cost_calculation_material_rows_article" ON "cost_calculation_material_rows" USING btree ("component_article_id");--> statement-breakpoint
CREATE INDEX "idx_cost_calculation_operation_rows_calculation" ON "cost_calculation_operation_rows" USING btree ("cost_calculation_id");