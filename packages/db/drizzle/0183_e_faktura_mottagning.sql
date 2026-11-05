ALTER TYPE "public"."invoice_scan_source" ADD VALUE 'einvoice';--> statement-breakpoint
CREATE TABLE "einvoice_receptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" varchar(10) NOT NULL,
	"provider_invoice_id" varchar(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_type" varchar(12),
	"document_number" varchar(100),
	"issue_date" date,
	"sender_endpoint" varchar(80),
	"sender_name" varchar(200),
	"currency" varchar(3),
	"payable_amount" numeric(14, 2),
	"original_xml" "bytea" NOT NULL,
	"original_sha256" varchar(64) NOT NULL,
	"original_content_type" varchar(100) NOT NULL,
	"interpretation_xml" "bytea",
	"attachments" jsonb,
	"outcome" varchar(12) NOT NULL,
	"detail" text,
	"invoice_scan_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "einvoice_receptions_outcome" CHECK ("einvoice_receptions"."outcome" IN ('imported', 'duplicate', 'unreadable', 'dismissed')),
	CONSTRAINT "einvoice_receptions_environment" CHECK ("einvoice_receptions"."environment" IN ('sandbox', 'production')),
	CONSTRAINT "einvoice_receptions_document_type" CHECK ("einvoice_receptions"."document_type" IS NULL OR "einvoice_receptions"."document_type" IN ('invoice', 'credit_note'))
);
--> statement-breakpoint
ALTER TABLE "einvoice_receptions" ADD CONSTRAINT "einvoice_receptions_invoice_scan_id_invoice_scans_id_fk" FOREIGN KEY ("invoice_scan_id") REFERENCES "public"."invoice_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_receptions_provider" ON "einvoice_receptions" USING btree ("environment","provider_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_einvoice_receptions_received" ON "einvoice_receptions" USING btree ("received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_einvoice_receptions_scan" ON "einvoice_receptions" USING btree ("invoice_scan_id");--> statement-breakpoint
-- Mottagningsloggen is räkenskapsinformation (bokföringslagen 5 kap 6 §,
-- 7 kap): the received e-invoice exactly as the access point served it must
-- stay unchanged. Same NV001 pattern as migration 0133's
-- einvoice_transmissions guard — the API's error handler maps the SQLSTATE
-- to 409 bookkeeping-record-locked. Rows are never deleted. The original,
-- its hash and content type and the row's identity are fully frozen; the
-- document's identity columns (document_type … payable_amount), the
-- interpretation XML and the attachment list are FILL-ONCE: a row logged
-- `unreadable` has them null and gets them when the document can be read
-- later, after which they are frozen too. The outcome columns (outcome,
-- detail, invoice_scan_id — also nulled by the FK when a rejected post is
-- deleted) may always change.
CREATE OR REPLACE FUNCTION nav_einvoice_receptions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'En mottagen e-faktura kan inte raderas (mottagning %)', OLD.id
      USING ERRCODE = 'NV001';
  END IF;
  IF NEW.original_xml IS DISTINCT FROM OLD.original_xml
     OR NEW.original_sha256 IS DISTINCT FROM OLD.original_sha256
     OR NEW.original_content_type IS DISTINCT FROM OLD.original_content_type
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Originalet i en mottagen e-faktura kan inte ändras (mottagning %)', OLD.id
      USING ERRCODE = 'NV001';
  END IF;
  IF (OLD.document_type IS NOT NULL AND NEW.document_type IS DISTINCT FROM OLD.document_type)
     OR (OLD.document_number IS NOT NULL AND NEW.document_number IS DISTINCT FROM OLD.document_number)
     OR (OLD.issue_date IS NOT NULL AND NEW.issue_date IS DISTINCT FROM OLD.issue_date)
     OR (OLD.sender_endpoint IS NOT NULL AND NEW.sender_endpoint IS DISTINCT FROM OLD.sender_endpoint)
     OR (OLD.sender_name IS NOT NULL AND NEW.sender_name IS DISTINCT FROM OLD.sender_name)
     OR (OLD.currency IS NOT NULL AND NEW.currency IS DISTINCT FROM OLD.currency)
     OR (OLD.payable_amount IS NOT NULL AND NEW.payable_amount IS DISTINCT FROM OLD.payable_amount)
     OR (OLD.interpretation_xml IS NOT NULL AND NEW.interpretation_xml IS DISTINCT FROM OLD.interpretation_xml)
     OR (OLD.attachments IS NOT NULL AND NEW.attachments IS DISTINCT FROM OLD.attachments) THEN
    RAISE EXCEPTION 'Uppgifterna om en mottagen e-faktura kan inte ändras (mottagning %)', OLD.id
      USING ERRCODE = 'NV001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER einvoice_receptions_bookkeeping_lock
  BEFORE UPDATE OR DELETE ON einvoice_receptions
  FOR EACH ROW EXECUTE FUNCTION nav_einvoice_receptions_guard();
