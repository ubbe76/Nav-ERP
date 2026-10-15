CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."invoice_type" AS ENUM('invoice', 'credit');--> statement-breakpoint
CREATE TABLE "invoice_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"article_id" uuid,
	"sales_order_row_id" uuid,
	"description" varchar(255) NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"unit_id" uuid,
	"unit_factor" numeric(16, 6),
	"vat_rate" numeric(5, 2) NOT NULL,
	"line_amount" numeric(14, 2) NOT NULL,
	"vat_amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" varchar(20),
	"type" "invoice_type" DEFAULT 'invoice' NOT NULL,
	"credited_invoice_id" uuid,
	"customer_id" uuid NOT NULL,
	"payment_term_id" uuid,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"currency" varchar(3) DEFAULT 'SEK' NOT NULL,
	"invoice_date" date,
	"due_date" date,
	"ocr_number" varchar(30),
	"customer_name" varchar(255),
	"invoice_address" text,
	"invoice_postal_code" varchar(20),
	"invoice_city" varchar(100),
	"org_number" varchar(20),
	"vat_number" varchar(30),
	"payment_term_code" varchar(50),
	"payment_term_name" varchar(100),
	"note" text,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_sales_order_row_id_sales_order_rows_id_fk" FOREIGN KEY ("sales_order_row_id") REFERENCES "public"."sales_order_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credited_invoice_id_invoices_id_fk" FOREIGN KEY ("credited_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_invoice_rows_invoice" ON "invoice_rows" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_invoice_rows_order_row" ON "invoice_rows" USING btree ("sales_order_row_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_customer" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_status" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_invoices_credited" ON "invoices" USING btree ("credited_invoice_id");