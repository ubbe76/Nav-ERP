-- Påslag per varugrupp, kund och order, etapp 2: kunden och Kalkylpriset
-- (#16, spec private/superpowers/specs/2026-11-07-paslag-per-grupp-kund-order-design.md).
-- The customer gets its own generellt påslag and materialpåslag (null =
-- inherit varugrupp → företaget, 0 = explicitly 0 %, CHECK 0–1000 like the
-- varugrupp's); a value on either field gives the customer's rows the price
-- chain's Kalkylpris step. sales_order_rows.calculated_price says the row's
-- à-pris came from that step and was not written over (set by the server
-- only; every existing row is false — unknown counts as handwritten).
ALTER TABLE "customers" ADD COLUMN "general_markup_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "material_markup_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "calculated_price" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_markups_range" CHECK (("customers"."general_markup_percent" is null or "customers"."general_markup_percent" between 0 and 1000) and ("customers"."material_markup_percent" is null or "customers"."material_markup_percent" between 0 and 1000));--> statement-breakpoint

-- The review of etapp 1: 0194 backfilled the header's materialpåslag base
-- only on single-level calculations. A multi-level calculation without any
-- semi-finished cost has no lifted base either, so its base is exactly
-- dM + MO as well — without it the Kalkylpris refused such a calculation with
-- material-base-missing. 0194 itself is unchanged.
UPDATE "cost_calculations" SET "material_markup_base" = "material_cost" + "material_overhead"
WHERE "material_markup_base" IS NULL AND "multi_level" = true AND "semi_finished_cost" = 0;
