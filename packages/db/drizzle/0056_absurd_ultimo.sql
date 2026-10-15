ALTER TYPE "public"."email_document_type" ADD VALUE 'payment_reminder' BEFORE 'test';--> statement-breakpoint
CREATE TABLE "invoice_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"fee" numeric(14, 2) DEFAULT '0' NOT NULL,
	"fee_verification_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_fee_verification_id_verifications_id_fk" FOREIGN KEY ("fee_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invoice_reminders_invoice" ON "invoice_reminders" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_reminders_one_fee" ON "invoice_reminders" USING btree ("invoice_id") WHERE "invoice_reminders"."fee" > 0;