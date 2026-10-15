CREATE TYPE "public"."accounting_period_status" AS ENUM('open', 'locked');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('draft', 'booked');--> statement-breakpoint
CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "accounting_period_status" DEFAULT 'open' NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" uuid
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(4) NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_number_unique" UNIQUE("number"),
	CONSTRAINT "account_number_four_digits" CHECK ("accounts"."number" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "fiscal_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(20) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_years_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "verification_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(14, 2) DEFAULT '0' NOT NULL,
	"description" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_row_amounts_nonnegative" CHECK ("verification_rows"."debit" >= 0 AND "verification_rows"."credit" >= 0),
	CONSTRAINT "verification_row_debit_xor_credit" CHECK (("verification_rows"."debit" = 0) <> ("verification_rows"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "verification_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_series_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"verification_number" integer,
	"date" date NOT NULL,
	"description" varchar(255) NOT NULL,
	"status" "verification_status" DEFAULT 'draft' NOT NULL,
	"reverses_verification_id" uuid,
	"created_by" uuid,
	"booked_by" uuid,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_counters" ADD CONSTRAINT "verification_counters_series_id_verification_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."verification_series"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_counters" ADD CONSTRAINT "verification_counters_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_rows" ADD CONSTRAINT "verification_rows_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_rows" ADD CONSTRAINT "verification_rows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_series_id_verification_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."verification_series"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_reverses_verification_id_verifications_id_fk" FOREIGN KEY ("reverses_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_booked_by_users_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_periods_year_start_unique" ON "accounting_periods" USING btree ("fiscal_year_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_counters_series_year_unique" ON "verification_counters" USING btree ("series_id","fiscal_year_id");--> statement-breakpoint
CREATE INDEX "idx_verification_rows_verification" ON "verification_rows" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "idx_verification_rows_account" ON "verification_rows" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verifications_series_year_number_unique" ON "verifications" USING btree ("series_id","fiscal_year_id","verification_number") WHERE "verifications"."verification_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "verifications_reverses_unique" ON "verifications" USING btree ("reverses_verification_id") WHERE "verifications"."reverses_verification_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_verifications_year_status" ON "verifications" USING btree ("fiscal_year_id","status");--> statement-breakpoint
CREATE INDEX "idx_verifications_date" ON "verifications" USING btree ("date");