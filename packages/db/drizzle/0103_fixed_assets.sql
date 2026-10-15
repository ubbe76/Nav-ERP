CREATE TYPE "public"."fixed_asset_disposal_type" AS ENUM('sale', 'scrap');--> statement-breakpoint
CREATE TYPE "public"."fixed_asset_status" AS ENUM('active', 'disposed');--> statement-breakpoint
CREATE TABLE "fixed_asset_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"asset_account_id" uuid NOT NULL,
	"accumulated_depreciation_account_id" uuid NOT NULL,
	"depreciation_expense_account_id" uuid NOT NULL,
	"disposal_gain_account_id" uuid NOT NULL,
	"disposal_loss_account_id" uuid NOT NULL,
	"default_useful_life_months" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_categories_name_unique" UNIQUE("name"),
	CONSTRAINT "fixed_asset_category_life_positive" CHECK ("fixed_asset_categories"."default_useful_life_months" > 0),
	CONSTRAINT "fixed_asset_category_accounts_distinct" CHECK ("fixed_asset_categories"."asset_account_id" <> "fixed_asset_categories"."accumulated_depreciation_account_id" AND "fixed_asset_categories"."depreciation_expense_account_id" NOT IN ("fixed_asset_categories"."asset_account_id", "fixed_asset_categories"."accumulated_depreciation_account_id"))
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_depreciation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"through_month" date NOT NULL,
	"verification_id" uuid NOT NULL,
	"disposal_asset_id" uuid,
	"reversal_verification_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_depreciation_runs_verification_id_unique" UNIQUE("verification_id"),
	CONSTRAINT "fixed_asset_depreciation_runs_reversal_verification_id_unique" UNIQUE("reversal_verification_id"),
	CONSTRAINT "fixed_asset_run_month_first_day" CHECK (extract(day from "fixed_asset_depreciation_runs"."through_month") = 1)
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_depreciations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"superseded_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_depreciation_amount_positive" CHECK ("fixed_asset_depreciations"."amount" > 0),
	CONSTRAINT "fixed_asset_depreciation_month_first_day" CHECK (extract(day from "fixed_asset_depreciations"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_number" varchar(20) NOT NULL,
	"name" varchar(200) NOT NULL,
	"note" text,
	"category_id" uuid NOT NULL,
	"acquisition_date" date NOT NULL,
	"acquisition_cost" numeric(14, 2) NOT NULL,
	"residual_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_start_month" date NOT NULL,
	"status" "fixed_asset_status" DEFAULT 'active' NOT NULL,
	"disposal_date" date,
	"disposal_type" "fixed_asset_disposal_type",
	"disposal_price" numeric(14, 2),
	"disposal_verification_id" uuid,
	"supplier_invoice_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_asset_number_unique" UNIQUE("asset_number"),
	CONSTRAINT "fixed_asset_cost_positive" CHECK ("fixed_assets"."acquisition_cost" > 0),
	CONSTRAINT "fixed_asset_residual_range" CHECK ("fixed_assets"."residual_value" >= 0 AND "fixed_assets"."residual_value" <= "fixed_assets"."acquisition_cost"),
	CONSTRAINT "fixed_asset_life_positive" CHECK ("fixed_assets"."useful_life_months" > 0),
	CONSTRAINT "fixed_asset_start_month_first_day" CHECK (extract(day from "fixed_assets"."depreciation_start_month") = 1),
	CONSTRAINT "fixed_asset_start_after_acquisition" CHECK ("fixed_assets"."depreciation_start_month" >= date_trunc('month', "fixed_assets"."acquisition_date"::timestamp)::date),
	CONSTRAINT "fixed_asset_disposal_date_after_acquisition" CHECK ("fixed_assets"."disposal_date" IS NULL OR "fixed_assets"."disposal_date" >= "fixed_assets"."acquisition_date"),
	CONSTRAINT "fixed_asset_disposal_price_nonnegative" CHECK ("fixed_assets"."disposal_price" IS NULL OR "fixed_assets"."disposal_price" >= 0),
	CONSTRAINT "fixed_asset_disposal_consistent" CHECK (("fixed_assets"."status" = 'disposed') = ("fixed_assets"."disposal_date" IS NOT NULL AND "fixed_assets"."disposal_type" IS NOT NULL AND "fixed_assets"."disposal_verification_id" IS NOT NULL) AND COALESCE("fixed_assets"."disposal_type" = 'sale', false) = ("fixed_assets"."disposal_price" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "fixed_asset_categories" ADD CONSTRAINT "fixed_asset_categories_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_categories" ADD CONSTRAINT "fixed_asset_categories_accumulated_depreciation_account_id_accounts_id_fk" FOREIGN KEY ("accumulated_depreciation_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_categories" ADD CONSTRAINT "fixed_asset_categories_depreciation_expense_account_id_accounts_id_fk" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_categories" ADD CONSTRAINT "fixed_asset_categories_disposal_gain_account_id_accounts_id_fk" FOREIGN KEY ("disposal_gain_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_categories" ADD CONSTRAINT "fixed_asset_categories_disposal_loss_account_id_accounts_id_fk" FOREIGN KEY ("disposal_loss_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_runs" ADD CONSTRAINT "fixed_asset_depreciation_runs_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_runs" ADD CONSTRAINT "fixed_asset_depreciation_runs_disposal_asset_id_fixed_assets_id_fk" FOREIGN KEY ("disposal_asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_runs" ADD CONSTRAINT "fixed_asset_depreciation_runs_reversal_verification_id_verifications_id_fk" FOREIGN KEY ("reversal_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciation_runs" ADD CONSTRAINT "fixed_asset_depreciation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_run_id_fixed_asset_depreciation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."fixed_asset_depreciation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_depreciations" ADD CONSTRAINT "fixed_asset_depreciations_superseded_by_run_id_fixed_asset_depreciation_runs_id_fk" FOREIGN KEY ("superseded_by_run_id") REFERENCES "public"."fixed_asset_depreciation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_category_id_fixed_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."fixed_asset_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_verification_id_verifications_id_fk" FOREIGN KEY ("disposal_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_supplier_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("supplier_invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fixed_asset_runs_created" ON "fixed_asset_depreciation_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_asset_depreciations_asset_month_active" ON "fixed_asset_depreciations" USING btree ("asset_id","month") WHERE "fixed_asset_depreciations"."superseded_by_run_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_fixed_asset_depreciations_run" ON "fixed_asset_depreciations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_disposal_verification_unique" ON "fixed_assets" USING btree ("disposal_verification_id") WHERE "fixed_assets"."disposal_verification_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_fixed_assets_category" ON "fixed_assets" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_fixed_assets_status" ON "fixed_assets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fixed_assets_supplier_invoice" ON "fixed_assets" USING btree ("supplier_invoice_id");--> statement-breakpoint
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits") VALUES ('fixed_asset', 'AN-', 1, 0);
