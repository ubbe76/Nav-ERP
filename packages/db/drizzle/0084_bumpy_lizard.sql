ALTER TYPE "public"."cost_material_row_kind" ADD VALUE 'semi';--> statement-breakpoint
ALTER TYPE "public"."cost_price_source" ADD VALUE 'calculated';--> statement-breakpoint
ALTER TYPE "public"."cost_price_source" ADD VALUE 'moving_average';--> statement-breakpoint
ALTER TYPE "public"."costing_material_source" ADD VALUE 'actual';--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "semi_finished_cost" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "multi_level" boolean DEFAULT false NOT NULL;