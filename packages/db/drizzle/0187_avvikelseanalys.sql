-- Avvikelseanalys i efterkalkylen, etapp 1 (#14, spec
-- private/superpowers/specs/2026-11-06-avvikelseanalys-efterkalkyl-design.md).
-- An efterkalkyl saves the inputs of its variance analysis: on the header N
-- (output_quantity), the preliminary flag, T₀ (base_priced_at) and the
-- förkalkyl's material source the base was priced with; on each material row
-- its base quantity/à-pris/price source and the scrapped share; on each
-- operation row the planned setup/run hours and base rate (time) or the base
-- quantity, received quantity, unit price and one-off (lego). The parts
-- (pris, mängd, tid, påslag) are derived on read in cost-variance.ts and never
-- stored. CHECKs: the header's four all or none and only on type 'post' (never
-- 'actual' as the base's source); each row group all or none. No backfill — an
-- old efterkalkyl's base cannot be rebuilt as it was, so it reads
-- `analysis: null`.
ALTER TABLE "cost_calculation_material_rows" ADD COLUMN "base_quantity" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD COLUMN "base_unit_cost" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD COLUMN "base_price_source" "cost_price_source";--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD COLUMN "scrap_quantity" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "base_setup_hours" numeric(16, 8);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "base_run_hours" numeric(16, 8);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "run_hours" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "base_hourly_rate" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "base_quantity" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "subcontract_quantity" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "base_unit_price" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD COLUMN "base_one_off" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "output_quantity" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "preliminary" boolean;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "base_priced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "base_material_source" "costing_material_source";--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD CONSTRAINT "cost_calculation_material_rows_variance_base" CHECK (("cost_calculation_material_rows"."base_quantity" is null) = ("cost_calculation_material_rows"."base_unit_cost" is null) and ("cost_calculation_material_rows"."base_quantity" is null) = ("cost_calculation_material_rows"."base_price_source" is null) and ("cost_calculation_material_rows"."base_quantity" is null) = ("cost_calculation_material_rows"."scrap_quantity" is null));--> statement-breakpoint
ALTER TABLE "cost_calculation_operation_rows" ADD CONSTRAINT "cost_calculation_operation_rows_variance_base" CHECK (("cost_calculation_operation_rows"."base_setup_hours" is null) = ("cost_calculation_operation_rows"."base_run_hours" is null) and ("cost_calculation_operation_rows"."base_setup_hours" is null) = ("cost_calculation_operation_rows"."base_hourly_rate" is null) and ("cost_calculation_operation_rows"."base_quantity" is null) = ("cost_calculation_operation_rows"."subcontract_quantity" is null) and ("cost_calculation_operation_rows"."base_quantity" is null) = ("cost_calculation_operation_rows"."base_unit_price" is null) and ("cost_calculation_operation_rows"."base_quantity" is null) = ("cost_calculation_operation_rows"."base_one_off" is null) and ("cost_calculation_operation_rows"."base_setup_hours" is null or "cost_calculation_operation_rows"."base_quantity" is null));--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD CONSTRAINT "cost_calculations_variance_base" CHECK (("cost_calculations"."output_quantity" is null and "cost_calculations"."preliminary" is null and "cost_calculations"."base_priced_at" is null and "cost_calculations"."base_material_source" is null) or ("cost_calculations"."output_quantity" is not null and "cost_calculations"."preliminary" is not null and "cost_calculations"."base_priced_at" is not null and "cost_calculations"."base_material_source" is not null and "cost_calculations"."base_material_source" <> 'actual' and "cost_calculations"."type" = 'post'));