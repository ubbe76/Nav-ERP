-- Reklamationer och avvikelser (Kvalitet): the deviation register with its
-- costs, links, files and history, the shared Avvikelseorsaker register (also
-- the scrap reason), the e-mail log's include_details, the AV- series and the
-- new menu permission `kvalitet`.
CREATE TYPE "public"."deviation_cost_kind" AS ENUM('material', 'labour', 'freight', 'credit', 'other', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."deviation_decision" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."deviation_event" AS ENUM('created', 'status_changed', 'updated', 'cost_added', 'cost_removed', 'link_added', 'link_removed', 'file_added', 'file_removed', 'email_sent');--> statement-breakpoint
CREATE TYPE "public"."deviation_link_document_type" AS ENUM('credit_invoice', 'sales_order', 'purchase_order', 'manufacturing_order', 'supplier_invoice');--> statement-breakpoint
CREATE TYPE "public"."deviation_status" AS ENUM('registered', 'investigating', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."deviation_type" AS ENUM('customer', 'supplier', 'internal');--> statement-breakpoint
ALTER TYPE "public"."email_document_type" ADD VALUE 'deviation';--> statement-breakpoint
CREATE TABLE "deviation_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" varchar(100) NOT NULL,
	"applies_customer" boolean DEFAULT false NOT NULL,
	"applies_supplier" boolean DEFAULT false NOT NULL,
	"applies_internal" boolean DEFAULT false NOT NULL,
	"applies_scrap" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deviation_reasons_code_unique" UNIQUE("code"),
	CONSTRAINT "deviation_reasons_name_unique" UNIQUE("name"),
	CONSTRAINT "deviation_reasons_applies_any" CHECK ("deviation_reasons"."applies_customer" OR "deviation_reasons"."applies_supplier" OR "deviation_reasons"."applies_internal" OR "deviation_reasons"."applies_scrap")
);
--> statement-breakpoint
CREATE TABLE "deviation_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deviation_id" uuid NOT NULL,
	"kind" "deviation_cost_kind" NOT NULL,
	"description" varchar(200),
	"amount" numeric(14, 2) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deviation_costs_amount_positive" CHECK ("deviation_costs"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "deviation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deviation_id" uuid NOT NULL,
	"event" "deviation_event" NOT NULL,
	"detail" jsonb,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deviation_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deviation_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"content_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"data" "bytea" NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deviation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deviation_id" uuid NOT NULL,
	"document_type" "deviation_link_document_type" NOT NULL,
	"document_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deviation_links_unique" UNIQUE("deviation_id","document_type","document_id")
);
--> statement-breakpoint
CREATE TABLE "deviations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deviation_number" varchar(20) NOT NULL,
	"type" "deviation_type" NOT NULL,
	"status" "deviation_status" DEFAULT 'registered' NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"reported_date" date NOT NULL,
	"reason_id" uuid,
	"responsible_user_id" uuid,
	"due_date" date,
	"customer_id" uuid,
	"supplier_id" uuid,
	"counterparty_reference" varchar(100),
	"sales_order_id" uuid,
	"sales_order_row_id" uuid,
	"invoice_id" uuid,
	"purchase_order_id" uuid,
	"purchase_order_row_id" uuid,
	"manufacturing_order_id" uuid,
	"mo_operation_id" uuid,
	"article_id" uuid,
	"quantity" numeric(14, 4),
	"cause_analysis" text,
	"corrective_action" text,
	"preventive_action" text,
	"decision" "deviation_decision",
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" varchar(500),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deviations_deviation_number_unique" UNIQUE("deviation_number"),
	CONSTRAINT "deviations_customer_type" CHECK (("deviations"."type" = 'customer') = ("deviations"."customer_id" IS NOT NULL)),
	CONSTRAINT "deviations_supplier_type" CHECK (("deviations"."type" = 'supplier') = ("deviations"."supplier_id" IS NOT NULL)),
	CONSTRAINT "deviations_customer_links" CHECK ("deviations"."type" = 'customer' OR ("deviations"."sales_order_id" IS NULL AND "deviations"."sales_order_row_id" IS NULL AND "deviations"."invoice_id" IS NULL)),
	CONSTRAINT "deviations_supplier_links" CHECK ("deviations"."type" = 'supplier' OR ("deviations"."purchase_order_id" IS NULL AND "deviations"."purchase_order_row_id" IS NULL)),
	CONSTRAINT "deviations_internal_decision" CHECK ("deviations"."type" <> 'internal' OR "deviations"."decision" IS NULL),
	CONSTRAINT "deviations_quantity_positive" CHECK ("deviations"."quantity" IS NULL OR "deviations"."quantity" > 0),
	CONSTRAINT "deviations_closed_at" CHECK (("deviations"."status" = 'closed') = ("deviations"."closed_at" IS NOT NULL)),
	CONSTRAINT "deviations_cancelled_at" CHECK (("deviations"."status" = 'cancelled') = ("deviations"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "include_details" boolean;--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ADD COLUMN "reason_id" uuid;--> statement-breakpoint
ALTER TABLE "deviation_costs" ADD CONSTRAINT "deviation_costs_deviation_id_deviations_id_fk" FOREIGN KEY ("deviation_id") REFERENCES "public"."deviations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_costs" ADD CONSTRAINT "deviation_costs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_events" ADD CONSTRAINT "deviation_events_deviation_id_deviations_id_fk" FOREIGN KEY ("deviation_id") REFERENCES "public"."deviations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_events" ADD CONSTRAINT "deviation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_files" ADD CONSTRAINT "deviation_files_deviation_id_deviations_id_fk" FOREIGN KEY ("deviation_id") REFERENCES "public"."deviations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_files" ADD CONSTRAINT "deviation_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_links" ADD CONSTRAINT "deviation_links_deviation_id_deviations_id_fk" FOREIGN KEY ("deviation_id") REFERENCES "public"."deviations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_links" ADD CONSTRAINT "deviation_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_reason_id_deviation_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."deviation_reasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_sales_order_row_id_sales_order_rows_id_fk" FOREIGN KEY ("sales_order_row_id") REFERENCES "public"."sales_order_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_purchase_order_row_id_purchase_order_rows_id_fk" FOREIGN KEY ("purchase_order_row_id") REFERENCES "public"."purchase_order_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_manufacturing_order_id_manufacturing_orders_id_fk" FOREIGN KEY ("manufacturing_order_id") REFERENCES "public"."manufacturing_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_mo_operation_id_mo_operations_id_fk" FOREIGN KEY ("mo_operation_id") REFERENCES "public"."mo_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations" ADD CONSTRAINT "deviations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deviation_costs_deviation" ON "deviation_costs" USING btree ("deviation_id");--> statement-breakpoint
CREATE INDEX "idx_deviation_events_deviation" ON "deviation_events" USING btree ("deviation_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_deviation_files_deviation" ON "deviation_files" USING btree ("deviation_id");--> statement-breakpoint
CREATE INDEX "idx_deviation_links_document" ON "deviation_links" USING btree ("document_type","document_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_status" ON "deviations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_deviations_reported_date" ON "deviations" USING btree ("reported_date");--> statement-breakpoint
CREATE INDEX "idx_deviations_customer" ON "deviations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_supplier" ON "deviations" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_sales_order" ON "deviations" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_invoice" ON "deviations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_purchase_order" ON "deviations" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_manufacturing_order" ON "deviations" USING btree ("manufacturing_order_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_article" ON "deviations" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_deviations_reason" ON "deviations" USING btree ("reason_id");--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ADD CONSTRAINT "mo_operation_scrap_reason_id_deviation_reasons_id_fk" FOREIGN KEY ("reason_id") REFERENCES "public"."deviation_reasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operation_scrap" ADD CONSTRAINT "mo_operation_scrap_reason" CHECK ("mo_operation_scrap"."reason_id" IS NOT NULL OR "mo_operation_scrap"."reason" IS NOT NULL);--> statement-breakpoint
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits") VALUES ('deviation', 'AV-', 1, 0)
  ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- Kvalitet: every group that registers deviations from its orders today
-- (Försäljning, Inköp or Tillverkning) gets the new menu permission, so
-- nobody loses the Ny avvikelse buttons on their own cards.
UPDATE "permission_groups"
SET "permissions" = array_append("permissions", 'kvalitet')
WHERE ('forsaljning' = ANY("permissions") OR 'inkop' = ANY("permissions") OR 'tillverkning' = ANY("permissions"))
  AND NOT ('kvalitet' = ANY("permissions"));
