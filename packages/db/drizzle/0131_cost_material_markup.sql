ALTER TABLE "cost_calculation_material_rows" ADD COLUMN "material_markup_amount" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "material_markup" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "material_markup_percent" numeric(6, 2) DEFAULT '0' NOT NULL;