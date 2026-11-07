-- Påslag per varugrupp, kund och order, etapp 3: ordern (#16, spec
-- private/superpowers/specs/2026-11-07-paslag-per-grupp-kund-order-design.md).
-- The order header (quote and customer order alike — the same row) gets its
-- own generellt påslag and materialpåslag: null = inherit (kund → varugrupp →
-- företaget), 0 = explicitly 0 %, CHECK 0–1000 like the customer's. A value
-- on either gives the order's rows the price chain's Kalkylpris step; a
-- change reprices the rows with calculated_price that are neither delivered
-- nor invoiced (the header PATCH, after a confirmation). Every existing
-- order inherits.
ALTER TABLE "sales_orders" ADD COLUMN "general_markup_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "material_markup_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_markups_range" CHECK (("sales_orders"."general_markup_percent" is null or "sales_orders"."general_markup_percent" between 0 and 1000) and ("sales_orders"."material_markup_percent" is null or "sales_orders"."material_markup_percent" between 0 and 1000));