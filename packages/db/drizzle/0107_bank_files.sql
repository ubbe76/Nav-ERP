CREATE TYPE "public"."payment_reference_kind" AS ENUM('ocr', 'message');--> statement-breakpoint
CREATE TYPE "public"."supplier_payment_method" AS ENUM('bankgiro', 'plusgiro', 'bank_account', 'iban');--> statement-breakpoint
CREATE TYPE "public"."bank_entry_dedupe_source" AS ENUM('tx_acct_svcr_ref', 'clr_sys_ref', 'entry_ref', 'content_hash');--> statement-breakpoint
CREATE TYPE "public"."bank_entry_direction" AS ENUM('credit', 'debit');--> statement-breakpoint
CREATE TYPE "public"."bank_file_direction" AS ENUM('outgoing', 'incoming');--> statement-breakpoint
CREATE TYPE "public"."payment_batch_item_status" AS ENUM('pending', 'exported', 'confirmed', 'rejected', 'returned', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_batch_status" AS ENUM('draft', 'exported', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TABLE "bank_file_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_file_id" uuid NOT NULL,
	"dedupe_key" varchar(120) NOT NULL,
	"dedupe_source" "bank_entry_dedupe_source" NOT NULL,
	"direction" "bank_entry_direction" NOT NULL,
	"reversal" boolean DEFAULT false NOT NULL,
	"account" varchar(40) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date,
	"end_to_end_id" varchar(35),
	"msg_id" varchar(35),
	"pmt_inf_id" varchar(35),
	"counterparty_name" varchar(140),
	"remittance" jsonb NOT NULL,
	"return_reason" varchar(10),
	"position" integer NOT NULL,
	"ignored_at" timestamp with time zone,
	"ignored_by" uuid,
	"ignore_reason" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_file_entries_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "bank_file_entries_amount_positive" CHECK ("bank_file_entries"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "bank_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"direction" "bank_file_direction" NOT NULL,
	"message_type" varchar(30) NOT NULL,
	"payment_batch_id" uuid,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"data" "bytea" NOT NULL,
	"bank_message_id" varchar(35),
	"bank_created_at" timestamp with time zone,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"skipped_duplicates" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_files_batch_direction" CHECK (("bank_files"."direction" = 'outgoing') = ("bank_files"."payment_batch_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"end_to_end_id" varchar(35) NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"execution_date" date NOT NULL,
	"status" "payment_batch_item_status" DEFAULT 'pending' NOT NULL,
	"creditor_snapshot" jsonb,
	"rejected_reason" varchar(255),
	"return_bank_file_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_batch_items_end_to_end_id_unique" UNIQUE("end_to_end_id"),
	CONSTRAINT "payment_batch_items_seq_unique" UNIQUE("batch_id","seq"),
	CONSTRAINT "payment_batch_items_amount_positive" CHECK ("payment_batch_items"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_number" varchar(20) NOT NULL,
	"status" "payment_batch_status" DEFAULT 'draft' NOT NULL,
	"bank_account_number" varchar(4) NOT NULL,
	"bank_profile" varchar(20),
	"note" text,
	"exported_at" timestamp with time zone,
	"exported_by" uuid,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_batches_batch_number_unique" UNIQUE("batch_number")
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "payment_reference_kind" "payment_reference_kind";--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "payment_reference" varchar(140);--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "payment_batch_item_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "bank_file_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "payment_method" "supplier_payment_method";--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bankgiro" varchar(8);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "plusgiro" varchar(8);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_clearing" varchar(5);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bank_account_number" varchar(15);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "iban" varchar(34);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "bic" varchar(11);--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "bank_file_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD CONSTRAINT "bank_file_entries_bank_file_id_bank_files_id_fk" FOREIGN KEY ("bank_file_id") REFERENCES "public"."bank_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_file_entries" ADD CONSTRAINT "bank_file_entries_ignored_by_users_id_fk" FOREIGN KEY ("ignored_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_files" ADD CONSTRAINT "bank_files_payment_batch_id_payment_batches_id_fk" FOREIGN KEY ("payment_batch_id") REFERENCES "public"."payment_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_files" ADD CONSTRAINT "bank_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_batch_id_payment_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payment_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_return_bank_file_entry_id_bank_file_entries_id_fk" FOREIGN KEY ("return_bank_file_entry_id") REFERENCES "public"."bank_file_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_exported_by_users_id_fk" FOREIGN KEY ("exported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bank_file_entries_file" ON "bank_file_entries" USING btree ("bank_file_id");--> statement-breakpoint
CREATE INDEX "idx_bank_file_entries_e2e" ON "bank_file_entries" USING btree ("end_to_end_id");--> statement-breakpoint
CREATE INDEX "idx_bank_file_entries_booking_date" ON "bank_file_entries" USING btree ("booking_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_files_one_per_batch" ON "bank_files" USING btree ("payment_batch_id") WHERE "bank_files"."direction" = 'outgoing';--> statement-breakpoint
CREATE UNIQUE INDEX "bank_files_incoming_sha256" ON "bank_files" USING btree ("sha256") WHERE "bank_files"."direction" = 'incoming';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_items_invoice_live" ON "payment_batch_items" USING btree ("supplier_invoice_id") WHERE "payment_batch_items"."status" in ('pending', 'exported');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_items_return_entry_unique" ON "payment_batch_items" USING btree ("return_bank_file_entry_id");--> statement-breakpoint
CREATE INDEX "idx_payment_batch_items_batch" ON "payment_batch_items" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "idx_payment_batch_items_invoice" ON "payment_batch_items" USING btree ("supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_payment_batches_status" ON "payment_batches" USING btree ("status");--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_payment_batch_item_id_payment_batch_items_id_fk" FOREIGN KEY ("payment_batch_item_id") REFERENCES "public"."payment_batch_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_file_entry_id_bank_file_entries_id_fk" FOREIGN KEY ("bank_file_entry_id") REFERENCES "public"."bank_file_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_bank_file_entry_id_bank_file_entries_id_fk" FOREIGN KEY ("bank_file_entry_id") REFERENCES "public"."bank_file_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_item_live" ON "supplier_payments" USING btree ("payment_batch_item_id") WHERE "supplier_payments"."cancelled_at" is null and "supplier_payments"."payment_batch_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_entry_live" ON "supplier_payments" USING btree ("bank_file_entry_id") WHERE "supplier_payments"."cancelled_at" is null and "supplier_payments"."bank_file_entry_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_entry_live" ON "customer_payments" USING btree ("bank_file_entry_id") WHERE "customer_payments"."cancelled_at" is null and "customer_payments"."bank_file_entry_id" is not null;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_payment_reference_pair" CHECK (("supplier_invoices"."payment_reference_kind" is null) = ("supplier_invoices"."payment_reference" is null));--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_payment_method_details" CHECK ("suppliers"."payment_method" is null
      or ("suppliers"."payment_method" = 'bankgiro' and "suppliers"."bankgiro" is not null)
      or ("suppliers"."payment_method" = 'plusgiro' and "suppliers"."plusgiro" is not null)
      or ("suppliers"."payment_method" = 'bank_account' and "suppliers"."bank_clearing" is not null and "suppliers"."bank_account_number" is not null)
      or ("suppliers"."payment_method" = 'iban' and "suppliers"."iban" is not null));
--> statement-breakpoint
-- Bankfiler: bank_files is räkenskapsinformation (BFL 7 kap) — our pain.001
-- and the bank's camt.054, kept unaltered for 7 years. Same lock as 0095's
-- invoice_documents: no UPDATE, no DELETE (SQLSTATE NV001 → 409
-- bookkeeping-record-locked), except the FK null-out of uploaded_by when a
-- user is deleted. TRUNCATE (the test suite) is unaffected.
CREATE OR REPLACE FUNCTION nav_bank_files_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.uploaded_by IS NOT NULL AND NEW.uploaded_by IS NULL
     AND (to_jsonb(NEW) - 'uploaded_by') = (to_jsonb(OLD) - 'uploaded_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'En arkiverad bankfil kan inte ändras eller raderas (fil %)', OLD.id
    USING ERRCODE = 'NV001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bank_files_bookkeeping_lock
  BEFORE UPDATE OR DELETE ON bank_files
  FOR EACH ROW EXECUTE FUNCTION nav_bank_files_guard();
--> statement-breakpoint
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits") VALUES ('payment_batch', 'BO-', 1, 0)
  ON CONFLICT ("key") DO NOTHING;
