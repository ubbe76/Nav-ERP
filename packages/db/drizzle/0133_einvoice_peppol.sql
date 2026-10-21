CREATE TYPE "public"."invoice_delivery" AS ENUM('email', 'peppol');--> statement-breakpoint
CREATE TYPE "public"."einvoice_status" AS ENUM('sending', 'sent', 'delivered', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "einvoice_transmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"environment" varchar(10) NOT NULL,
	"recipient_id" varchar(60) NOT NULL,
	"status" "einvoice_status" NOT NULL,
	"provider_invoice_id" varchar(40),
	"provider_state" varchar(40),
	"error_message" text,
	"document" "bytea" NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"status_updated_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "invoice_delivery" "invoice_delivery" DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "peppol_id" varchar(60);--> statement-breakpoint
ALTER TABLE "einvoice_transmissions" ADD CONSTRAINT "einvoice_transmissions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_transmissions" ADD CONSTRAINT "einvoice_transmissions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_einvoice_transmissions_invoice" ON "einvoice_transmissions" USING btree ("invoice_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "einvoice_transmissions_live" ON "einvoice_transmissions" USING btree ("invoice_id") WHERE "einvoice_transmissions"."status" IN ('sending', 'sent', 'delivered');--> statement-breakpoint
-- Sändningsloggen is räkenskapsinformation (bokföringslagen 5 kap 6 §, 7 kap):
-- the UBL document exactly as it reached the customer must stay unchanged.
-- Same NV001 pattern as migration 0095's invoice_documents guard — the API's
-- error handler maps the SQLSTATE to 409 bookkeeping-record-locked. Rows are
-- never deleted; the status columns (status, provider_*, error_message,
-- sent_at, status_updated_at, last_polled_at) are what the status job
-- updates, and the creator FK may be nulled by a deleted login.
CREATE OR REPLACE FUNCTION nav_einvoice_transmissions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'En e-fakturasändning kan inte raderas (sändning %)', OLD.id
      USING ERRCODE = 'NV001';
  END IF;
  -- UPDATE: the document, its hash and what identifies the send are frozen.
  IF NEW.document IS DISTINCT FROM OLD.document
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'Dokumentet i en e-fakturasändning kan inte ändras (sändning %)', OLD.id
      USING ERRCODE = 'NV001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER einvoice_transmissions_bookkeeping_lock
  BEFORE UPDATE OR DELETE ON einvoice_transmissions
  FOR EACH ROW EXECUTE FUNCTION nav_einvoice_transmissions_guard();
