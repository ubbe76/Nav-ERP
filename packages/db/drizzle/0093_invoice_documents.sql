CREATE TABLE "invoice_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"reminder_id" uuid,
	"filename" varchar(255) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_documents_kind" CHECK (("invoice_documents"."kind" = 'invoice' and "invoice_documents"."reminder_id" is null) or ("invoice_documents"."kind" = 'reminder' and "invoice_documents"."reminder_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_reminder_id_invoice_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."invoice_reminders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invoice_documents_invoice" ON "invoice_documents" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_one_invoice_pdf" ON "invoice_documents" USING btree ("invoice_id") WHERE "invoice_documents"."kind" = 'invoice';--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_one_per_reminder" ON "invoice_documents" USING btree ("reminder_id");