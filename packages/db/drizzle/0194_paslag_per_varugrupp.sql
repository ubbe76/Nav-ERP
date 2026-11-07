-- Påslag per varugrupp, kund och order, etapp 1: förkalkylen (#16, spec
-- private/superpowers/specs/2026-11-07-paslag-per-grupp-kund-order-design.md).
-- The varugrupp gets its own generellt påslag and materialpåslag (null =
-- inherit the company's, 0 = explicitly 0 %, CHECK 0–1000 like the settings);
-- only the PRICE markups — MO, LO, Affo and TO never vary per group, so TVK
-- and SVK (standard cost, stock, efterkalkyl, PIA, the variance analysis, TB)
-- are unaffected. The calculation's header records the level each price
-- markup came from (company/group/trial, trial = Pröva påslag) and the base
-- the materialpåslag was taken on, so the Kalkylpris (etapp 2) can re-price
-- it exactly; a semi row carries its sub-calculation's base beside its
-- material_markup_amount.
CREATE TYPE "public"."costing_markup_level" AS ENUM('company', 'group', 'trial');--> statement-breakpoint
ALTER TABLE "article_groups" ADD COLUMN "general_markup_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "article_groups" ADD COLUMN "material_markup_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "cost_calculation_material_rows" ADD COLUMN "material_markup_base" numeric(14, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "general_markup_level" "costing_markup_level" DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "material_markup_level" "costing_markup_level" DEFAULT 'company' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD COLUMN "material_markup_base" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "article_groups_markups_range" CHECK (("article_groups"."general_markup_percent" is null or "article_groups"."general_markup_percent" between 0 and 1000) and ("article_groups"."material_markup_percent" is null or "article_groups"."material_markup_percent" between 0 and 1000));--> statement-breakpoint
-- Backfill of the header's base: exact for a single-level calculation (no
-- semi rows, so no lifted base) — efterkalkyler included, which are never
-- multi-level. A multi-level calculation saved before 0194 keeps null: the
-- sub-levels' base cannot be rebuilt (with 0 % their markup amount is 0).
UPDATE "cost_calculations" SET "material_markup_base" = "material_cost" + "material_overhead" WHERE "multi_level" = false;
