-- Valuta (bokföringsgranskningen etapp 2, steg 2): utlandsbetalningar i
-- betalfilen (spec private/superpowers/specs/2026-10-24-valuta-design.md §4).
-- The supplier gets an IBAN of any country or a foreign account number with
-- BIC/national bank id, the avgiftsfördelning and Skatteverkets
-- betalningskod (KU81); a batch row carries its invoice's currency; a
-- camt.054 entry keeps the instructed amount, the bank's exchange details
-- and the charges included in it.
ALTER TYPE "public"."supplier_payment_method" ADD VALUE 'foreign_account';--> statement-breakpoint
ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_payment_method_details";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "foreign_account_number" varchar(34);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "clearing_system" varchar(5);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "clearing_member_id" varchar(35);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_name" varchar(70);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "charge_bearer" varchar(4) DEFAULT 'SHAR' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_reporting_code" varchar(3) DEFAULT '101' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD COLUMN "instructed_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD COLUMN "instructed_currency" varchar(3);--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD COLUMN "currency_exchange" jsonb;--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD COLUMN "charges_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD COLUMN "currency" varchar(3) DEFAULT 'SEK' NOT NULL;--> statement-breakpoint
-- Every batch row so far pays a SEK invoice (a foreign one could not be put
-- in a batch before this step); the UPDATE makes that explicit.
UPDATE "payment_batch_items" i SET "currency" = si."currency" FROM "supplier_invoices" si WHERE si."id" = i."supplier_invoice_id" AND i."currency" <> si."currency";--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_clearing_pair" CHECK (("suppliers"."clearing_system" is null) = ("suppliers"."clearing_member_id" is null));--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_charge_bearer_valid" CHECK ("suppliers"."charge_bearer" in ('SHAR', 'DEBT'));--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_reporting_code_format" CHECK ("suppliers"."payment_reporting_code" ~ '^[0-9]{3}$');--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_method_details" CHECK ("suppliers"."payment_method" is null
      or ("suppliers"."payment_method" = 'bankgiro' and "suppliers"."bankgiro" is not null)
      or ("suppliers"."payment_method" = 'plusgiro' and "suppliers"."plusgiro" is not null)
      or ("suppliers"."payment_method" = 'bank_account' and "suppliers"."bank_clearing" is not null and "suppliers"."bank_account_number" is not null)
      or ("suppliers"."payment_method" = 'iban' and "suppliers"."iban" is not null)
      or ("suppliers"."payment_method"::text = 'foreign_account' and "suppliers"."foreign_account_number" is not null
          and ("suppliers"."bic" is not null or "suppliers"."clearing_system" is not null)));--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD CONSTRAINT "bank_file_entries_instructed_pair" CHECK (("bank_file_entries"."instructed_amount" is null) = ("bank_file_entries"."instructed_currency" is null));--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD CONSTRAINT "bank_file_entries_charges_non_negative" CHECK ("bank_file_entries"."charges_amount" is null or "bank_file_entries"."charges_amount" >= 0);