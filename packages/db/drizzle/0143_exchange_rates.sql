-- Valuta (bokföringsgranskningen etapp 2, steg 1): valutakurser, leverantörs-
-- fakturor och leverantörsbetalningar i annan valuta än SEK. The document is
-- facit in its own currency, the bookkeeping is in SEK (spec
-- private/superpowers/specs/2026-10-24-valuta-design.md §1–3).
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency" varchar(3) NOT NULL,
	"date" date NOT NULL,
	"rate" numeric(14, 6) NOT NULL,
	"source" varchar(10) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_currency_date_source_unique" UNIQUE("currency","date","source"),
	CONSTRAINT "exchange_rates_rate_positive" CHECK ("exchange_rates"."rate" > 0),
	CONSTRAINT "exchange_rates_source_valid" CHECK ("exchange_rates"."source" IN ('riksbank', 'manual')),
	CONSTRAINT "exchange_rates_currency_format" CHECK ("exchange_rates"."currency" ~ '^[A-Z]{3}$' AND "exchange_rates"."currency" <> 'SEK')
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "exchange_rate" numeric(14, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "exchange_rate_source" varchar(20);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "exchange_rate_date" date;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "gross_amount_sek" numeric(14, 2);--> statement-breakpoint
-- Every attested invoice so far is SEK (a foreign one could not be attested,
-- NonSekSupplierInvoiceError): the SEK debt is the gross itself.
UPDATE "supplier_invoices" SET "gross_amount_sek" = "gross_amount" WHERE "status" <> 'draft';--> statement-breakpoint
-- A foreign-currency DRAFT saved before the feature keeps rate 1 without a
-- source = "kurs saknas": the manual told users to register a foreign
-- invoice in SEK, so its amounts may well be SEK already — neither the
-- linked purchase order's rate nor any other is assumed. Its attest is
-- refused (supplier-invoice-exchange-rate-missing) until a rate is entered
-- or looked up on the draft.
ALTER TABLE "supplier_payment_rows" ADD COLUMN "applied_amount_sek" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "supplier_payment_rows" ADD COLUMN "write_off_amount_sek" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
UPDATE "supplier_payment_rows" SET "applied_amount_sek" = "applied_amount", "write_off_amount_sek" = "write_off_amount";--> statement-breakpoint
ALTER TABLE "supplier_payment_rows" ALTER COLUMN "applied_amount_sek" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "amount_sek" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "bank_fee_sek" numeric(14, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
UPDATE "supplier_payments" SET "amount_sek" = "amount";--> statement-breakpoint
ALTER TABLE "supplier_payments" ALTER COLUMN "amount_sek" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_exchange_rates_currency_date" ON "exchange_rates" USING btree ("currency","date");--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_sek_rate" CHECK ("supplier_invoices"."currency" <> 'SEK' OR ("supplier_invoices"."exchange_rate" = 1 AND "supplier_invoices"."exchange_rate_source" IS NULL));--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_rate_positive" CHECK ("supplier_invoices"."exchange_rate" > 0);--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_rate_source_valid" CHECK ("supplier_invoices"."exchange_rate_source" IS NULL OR "supplier_invoices"."exchange_rate_source" IN ('riksbank', 'register', 'manual', 'purchase_order'));--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_sek_amounts" CHECK ("supplier_payments"."currency" <> 'SEK' OR ("supplier_payments"."amount_sek" = "supplier_payments"."amount" AND "supplier_payments"."bank_fee_sek" = 0));--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_fee_non_negative" CHECK ("supplier_payments"."bank_fee_sek" >= 0);--> statement-breakpoint
-- The three new standard accounts (posting_fx_gain 3960, posting_fx_loss
-- 7960, posting_bank_fees 6570) into a chart that exists — a fresh
-- installation gets them from Generera BAS-kontoplan. Names as bas-accounts.ts.
INSERT INTO "accounts" ("number", "name", "vat_box")
SELECT v.number, v.name, v.box FROM (VALUES
  ('3960', 'Valutakursvinster på fordringar och skulder av rörelsekaraktär', 'none'),
  ('6570', 'Bankkostnader', NULL),
  ('7960', 'Valutakursförluster på fordringar och skulder av rörelsekaraktär', NULL)
) AS v(number, name, box)
WHERE EXISTS (SELECT 1 FROM "accounts")
ON CONFLICT ("number") DO NOTHING;
