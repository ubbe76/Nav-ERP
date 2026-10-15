CREATE TABLE "customer_payment_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"applied_amount" numeric(14, 2) NOT NULL,
	"write_off_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_number" varchar(20) NOT NULL,
	"customer_id" uuid NOT NULL,
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
	CONSTRAINT "customer_payments_payment_number_unique" UNIQUE("payment_number")
);
--> statement-breakpoint
ALTER TABLE "customer_payment_rows" ADD CONSTRAINT "customer_payment_rows_payment_id_customer_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_rows" ADD CONSTRAINT "customer_payment_rows_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_cancellation_verification_id_verifications_id_fk" FOREIGN KEY ("cancellation_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_payment_rows_payment" ON "customer_payment_rows" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "idx_customer_payment_rows_invoice" ON "customer_payment_rows" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_customer_payments_customer" ON "customer_payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_customer_payments_verification" ON "customer_payments" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "idx_customer_payments_cancellation" ON "customer_payments" USING btree ("cancellation_verification_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_due_date" ON "invoices" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_invoices_ocr" ON "invoices" USING btree ("ocr_number");