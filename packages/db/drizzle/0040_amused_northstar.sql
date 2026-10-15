CREATE TYPE "public"."supplier_invoice_status" AS ENUM('draft', 'approved', 'paid', 'cancelled');--> statement-breakpoint
CREATE TABLE "article_suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_article_number" varchar(100),
	"price" numeric(14, 4),
	"currency" varchar(3) DEFAULT 'SEK' NOT NULL,
	"lead_time_days" integer,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_suppliers_article_supplier_unique" UNIQUE("article_id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"article_id" uuid,
	"purchase_order_row_id" uuid,
	"description" varchar(255) NOT NULL,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(14, 4) NOT NULL,
	"line_amount" numeric(14, 2) NOT NULL,
	"vat_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"vat_rate" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_number" varchar(20) NOT NULL,
	"invoice_number" varchar(50) NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"invoice_date" date NOT NULL,
	"due_date" date,
	"currency" varchar(3) DEFAULT 'SEK' NOT NULL,
	"status" "supplier_invoice_status" DEFAULT 'draft' NOT NULL,
	"net_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"vat_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"gross_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoices_registration_number_unique" UNIQUE("registration_number"),
	CONSTRAINT "supplier_invoices_supplier_invoice_number_unique" UNIQUE("supplier_id","invoice_number")
);
--> statement-breakpoint
ALTER TABLE "article_suppliers" ADD CONSTRAINT "article_suppliers_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_suppliers" ADD CONSTRAINT "article_suppliers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD CONSTRAINT "supplier_invoice_rows_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD CONSTRAINT "supplier_invoice_rows_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD CONSTRAINT "supplier_invoice_rows_purchase_order_row_id_purchase_order_rows_id_fk" FOREIGN KEY ("purchase_order_row_id") REFERENCES "public"."purchase_order_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_suppliers_one_primary" ON "article_suppliers" USING btree ("article_id") WHERE "article_suppliers"."is_primary";--> statement-breakpoint
CREATE INDEX "idx_article_suppliers_article" ON "article_suppliers" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_invoice_rows_invoice" ON "supplier_invoice_rows" USING btree ("supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_invoice_rows_article" ON "supplier_invoice_rows" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_invoices_supplier" ON "supplier_invoices" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_invoices_status" ON "supplier_invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_supplier_invoices_po" ON "supplier_invoices" USING btree ("purchase_order_id");--> statement-breakpoint
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits") VALUES ('supplier_invoice', 'LF-', 1, 0);