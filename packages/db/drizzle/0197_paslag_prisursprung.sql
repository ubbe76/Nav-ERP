-- Påslag på offert och order, rättelser efter granskningen av etapp 3 (#16,
-- spec private/superpowers/specs/2026-11-07-paslag-per-grupp-kund-order-design.md).
-- 0195's calculated_price boolean becomes the row's price origin:
-- manual = an à-pris or a rabatt written by hand, chain = the price chain set
-- it (kundpris, prislista, variantsteget, artikelpriset), calculated = the
-- chain's Kalkylpris step. A change of the order's markups re-runs the chain
-- for the chain and calculated rows, so a row that fell back to the
-- article's price (cleared markups, an outdated calculation) or was added
-- before the order got a markup follows the markups again; manual rows never
-- move. The default is manual: a row written without an origin (ställkostnad,
-- frakt) is never repriced.
--
-- Backfill: the calculated rows stay calculated. Every other existing row
-- becomes manual — whether the chain priced it cannot be known afterwards,
-- and manual is the safe answer (never repriced). 0195/0196 are unchanged.
CREATE TYPE "public"."sales_row_price_origin" AS ENUM('manual', 'chain', 'calculated');--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "price_origin" "sales_row_price_origin" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
UPDATE "sales_order_rows" SET "price_origin" = 'calculated' WHERE "calculated_price" = true;--> statement-breakpoint
ALTER TABLE "sales_order_rows" DROP COLUMN "calculated_price";
