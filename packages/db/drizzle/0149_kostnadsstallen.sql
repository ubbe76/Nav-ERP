-- Kostnadsställen och projekt (bokföringsgranskningen etapp 5 del A, spec
-- private/superpowers/specs/2026-10-24-kostnadsstallen-budget-ranta-design.md):
-- the two fixed SIE dimensions (1 Kostnadsställe, 6 Projekt) as registers,
-- nullable ON DELETE restrict columns on verification rows, templates, invoice
-- rows/headers, supplier invoice rows/headers, purchase orders and bank rules,
-- the defaults on article groups, suppliers and fixed asset categories, and
-- accounts.cost_center_required (Kräver kostnadsställe).
CREATE TYPE "public"."project_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TABLE "cost_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_centers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"status" "project_status" DEFAULT 'open' NOT NULL,
	"customer_id" uuid,
	"start_date" date,
	"end_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "article_groups" ADD COLUMN "default_cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cost_center_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "verification_rows" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_rows" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "fixed_asset_categories" ADD COLUMN "default_cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "default_cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_template_rows" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_template_rows" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "article_groups_default_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("default_cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_rows" ADD CONSTRAINT "verification_rows_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_rows" ADD CONSTRAINT "verification_rows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_categories" ADD CONSTRAINT "fixed_asset_categories_default_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("default_cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD CONSTRAINT "supplier_invoice_rows_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD CONSTRAINT "supplier_invoice_rows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_default_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("default_cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_template_rows" ADD CONSTRAINT "verification_template_rows_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_template_rows" ADD CONSTRAINT "verification_template_rows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD CONSTRAINT "bank_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_verification_rows_cost_center" ON "verification_rows" USING btree ("cost_center_id");--> statement-breakpoint
CREATE INDEX "idx_verification_rows_project" ON "verification_rows" USING btree ("project_id");