CREATE TABLE "supplier_payment_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"applied_amount" numeric(14, 2) NOT NULL,
	"write_off_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_number" varchar(20) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"bank_account_number" varchar(4) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"note" text,
	"verification_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancellation_verification_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_payment_number_unique" UNIQUE("payment_number")
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_payment_rows" ADD CONSTRAINT "supplier_payment_rows_payment_id_supplier_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_rows" ADD CONSTRAINT "supplier_payment_rows_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cancellation_verification_id_verifications_id_fk" FOREIGN KEY ("cancellation_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_supplier_payment_rows_payment" ON "supplier_payment_rows" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_payment_rows_invoice" ON "supplier_payment_rows" USING btree ("supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_payments_supplier" ON "supplier_payments" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_payments_verification" ON "supplier_payments" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_payments_cancellation" ON "supplier_payments" USING btree ("cancellation_verification_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_invoices_due_date" ON "supplier_invoices" USING btree ("due_date");