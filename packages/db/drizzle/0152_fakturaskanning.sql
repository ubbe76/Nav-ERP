-- Fakturaskanning (Fakturainkorgen): invoice_scans, the supplier label hints
-- and the e-mail job's log. The FI- series is seeded here and created on
-- first use if it is ever missing (invoice-scan.repository.ts).
CREATE TYPE "public"."invoice_scan_engine" AS ENUM('rules', 'ai');--> statement-breakpoint
CREATE TYPE "public"."invoice_scan_hint_field" AS ENUM('invoiceNumber', 'invoiceDate', 'dueDate', 'paymentReference', 'grossAmount', 'netAmount', 'vatAmount', 'purchaseOrderReference');--> statement-breakpoint
CREATE TYPE "public"."invoice_scan_mail_outcome" AS ENUM('imported', 'no_attachment', 'duplicate', 'too_large', 'unsupported', 'error');--> statement-breakpoint
CREATE TYPE "public"."invoice_scan_source" AS ENUM('upload', 'email');--> statement-breakpoint
CREATE TYPE "public"."invoice_scan_status" AS ENUM('new', 'interpreted', 'converted', 'rejected');--> statement-breakpoint
CREATE TABLE "invoice_scan_hints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"field" "invoice_scan_hint_field" NOT NULL,
	"label" varchar(60) NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_scan_mail_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_id" varchar(998),
	"email_from" varchar(320),
	"email_subject" varchar(998),
	"received_at" timestamp with time zone,
	"outcome" "invoice_scan_mail_outcome" NOT NULL,
	"detail" text,
	"scan_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_number" varchar(20) NOT NULL,
	"source" "invoice_scan_source" NOT NULL,
	"status" "invoice_scan_status" DEFAULT 'new' NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"data" "bytea",
	"supplier_invoice_file_id" uuid,
	"has_text_layer" boolean,
	"page_count" integer,
	"result" jsonb,
	"interpreted_by" "invoice_scan_engine",
	"interpreted_at" timestamp with time zone,
	"ai_started_at" timestamp with time zone,
	"ai_error" varchar(200),
	"supplier_invoice_id" uuid,
	"email_message_id" varchar(998),
	"email_attachment_index" integer,
	"email_from" varchar(320),
	"email_subject" varchar(998),
	"email_received_at" timestamp with time zone,
	"rejected_reason" varchar(200),
	"rejected_at" timestamp with time zone,
	"rejected_by" uuid,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_scans_scan_number_unique" UNIQUE("scan_number"),
	CONSTRAINT "invoice_scans_supplier_invoice_file_id_unique" UNIQUE("supplier_invoice_file_id"),
	CONSTRAINT "invoice_scans_supplier_invoice_id_unique" UNIQUE("supplier_invoice_id"),
	CONSTRAINT "invoice_scans_converted_invoice" CHECK (("invoice_scans"."status" = 'converted') = ("invoice_scans"."supplier_invoice_id" IS NOT NULL)),
	CONSTRAINT "invoice_scans_data_or_file" CHECK (("invoice_scans"."data" IS NULL) = ("invoice_scans"."supplier_invoice_file_id" IS NOT NULL)),
	CONSTRAINT "invoice_scans_rejected_at" CHECK ("invoice_scans"."status" <> 'rejected' OR "invoice_scans"."rejected_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "invoice_scan_hints" ADD CONSTRAINT "invoice_scan_hints_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_scans" ADD CONSTRAINT "invoice_scans_supplier_invoice_file_id_supplier_invoice_files_id_fk" FOREIGN KEY ("supplier_invoice_file_id") REFERENCES "public"."supplier_invoice_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_scans" ADD CONSTRAINT "invoice_scans_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_scans" ADD CONSTRAINT "invoice_scans_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_scans" ADD CONSTRAINT "invoice_scans_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_scan_hints_supplier_field_label" ON "invoice_scan_hints" USING btree ("supplier_id","field","label");--> statement-breakpoint
CREATE INDEX "idx_invoice_scan_mail_log_run_at" ON "invoice_scan_mail_log" USING btree ("run_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_scans_email_attachment" ON "invoice_scans" USING btree ("email_message_id","email_attachment_index") WHERE "invoice_scans"."email_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_scans_sha256_live" ON "invoice_scans" USING btree ("sha256") WHERE "invoice_scans"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "idx_invoice_scans_status_created" ON "invoice_scans" USING btree ("status","created_at");--> statement-breakpoint
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits") VALUES ('invoice_scan', 'FI-', 1, 0)
  ON CONFLICT ("key") DO NOTHING;
