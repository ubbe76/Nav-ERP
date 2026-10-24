-- Valuta (bokföringsgranskningen etapp 2, steg 3): kunder, prislistor,
-- kundordrar, kundfakturor och kundbetalningar i annan valuta än SEK. The
-- document is facit in its own currency, the bookkeeping is in SEK (spec
-- private/superpowers/specs/2026-10-24-valuta-design.md §5).
ALTER TABLE "customers" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;--> statement-breakpoint
ALTER TABLE "price_lists" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "exchange_rate" numeric(14, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_rate" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_rate_manual" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "gross_amount_sek" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "amount_sek" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "bank_fee_sek" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payment_rows" ADD COLUMN "applied_amount_sek" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "customer_payment_rows" ADD COLUMN "write_off_amount_sek" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- valuta-sales-backfill:start
-- Every invoice and payment so far was booked as it stood (invoices.currency
-- was always SEK): rate 1, the receivable in SEK of an issued/paid invoice
-- is its own gross — Σ rows (line + VAT), positive like the rows (the credit
-- sign is applied by invoices.type) — and every payment moved its own amount
-- and released its own amounts. receivablesTotalAsOf is therefore unchanged
-- (customer-currency-migration.test.ts re-runs this block).
UPDATE "invoices" SET "exchange_rate" = 1;--> statement-breakpoint
UPDATE "invoices" i
SET "gross_amount_sek" = COALESCE((
  SELECT SUM(ir."line_amount" + ir."vat_amount") FROM "invoice_rows" ir WHERE ir."invoice_id" = i."id"
), 0)
WHERE i."status" IN ('issued', 'paid');--> statement-breakpoint
UPDATE "customer_payments" SET "amount_sek" = "amount";--> statement-breakpoint
UPDATE "customer_payment_rows" SET "applied_amount_sek" = "applied_amount", "write_off_amount_sek" = "write_off_amount";--> statement-breakpoint
-- valuta-sales-backfill:end
ALTER TABLE "customer_payments" ALTER COLUMN "amount_sek" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payment_rows" ALTER COLUMN "applied_amount_sek" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_sek_amounts" CHECK ("customer_payments"."currency" <> 'SEK' OR ("customer_payments"."amount_sek" = "customer_payments"."amount" AND "customer_payments"."bank_fee_sek" = 0));--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_bank_fee_non_negative" CHECK ("customer_payments"."bank_fee_sek" >= 0);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_currency_format" CHECK ("customers"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sek_rate" CHECK ("invoices"."currency" <> 'SEK' OR (("invoices"."exchange_rate" IS NULL OR "invoices"."exchange_rate" = 1) AND NOT "invoices"."exchange_rate_manual"));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rate_positive" CHECK ("invoices"."exchange_rate" IS NULL OR "invoices"."exchange_rate" > 0);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_manual_rate_set" CHECK (NOT "invoices"."exchange_rate_manual" OR "invoices"."exchange_rate" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_currency_format" CHECK ("price_lists"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_currency_format" CHECK ("sales_orders"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_sek_rate" CHECK ("sales_orders"."currency" <> 'SEK' OR "sales_orders"."exchange_rate" = 1);--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_rate_positive" CHECK ("sales_orders"."exchange_rate" > 0);
