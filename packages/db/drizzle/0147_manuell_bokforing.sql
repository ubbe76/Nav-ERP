-- Snabbare manuell bokföring (bokföringsgranskningen etapp 3, spec
-- private/superpowers/specs/2026-10-24-manuell-bokforing-design.md):
-- verifikatmallar (kontonummer, inte FK), återkommande verifikat med
-- körningsloggen som reservation (unik per post och månad) och fördelning
-- över perioder (schedule_amounts), samt dubblettspärren för SIE-importen av
-- verifikat (sha256 unik). Inga ändringar i verifications/verification_rows —
-- mallkörningar och importen skapar vanliga verifikat via create/book.
CREATE TYPE "public"."recurring_run_status" AS ENUM('created', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."recurring_verification_mode" AS ENUM('draft', 'book');--> statement-breakpoint
CREATE TABLE "recurring_verification_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recurring_id" uuid,
	"month" varchar(7) NOT NULL,
	"status" "recurring_run_status" NOT NULL,
	"error" varchar(500),
	"verification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_run_month" CHECK ("recurring_verification_runs"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "recurring_run_outcome" CHECK (("recurring_verification_runs"."status" = 'created' AND "recurring_verification_runs"."verification_id" IS NOT NULL AND "recurring_verification_runs"."error" IS NULL) OR ("recurring_verification_runs"."status" = 'failed' AND "recurring_verification_runs"."verification_id" IS NULL AND "recurring_verification_runs"."error" IS NOT NULL) OR ("recurring_verification_runs"."status" = 'skipped' AND "recurring_verification_runs"."verification_id" IS NULL AND "recurring_verification_runs"."error" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "recurring_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"day_of_month" smallint,
	"start_month" varchar(7) NOT NULL,
	"end_month" varchar(7),
	"mode" "recurring_verification_mode" DEFAULT 'draft' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"schedule_amounts" jsonb,
	"allocation" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_verification_day" CHECK ("recurring_verifications"."day_of_month" IS NULL OR ("recurring_verifications"."day_of_month" BETWEEN 1 AND 28)),
	CONSTRAINT "recurring_verification_start_month" CHECK ("recurring_verifications"."start_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "recurring_verification_end_month" CHECK ("recurring_verifications"."end_month" IS NULL OR ("recurring_verifications"."end_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "recurring_verifications"."end_month" >= "recurring_verifications"."start_month")),
	CONSTRAINT "recurring_verification_allocation_pair" CHECK (("recurring_verifications"."schedule_amounts" IS NULL) = ("recurring_verifications"."allocation" IS NULL)),
	CONSTRAINT "recurring_verification_allocation_ends" CHECK ("recurring_verifications"."schedule_amounts" IS NULL OR "recurring_verifications"."end_month" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "sie_verification_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"verification_count" integer NOT NULL,
	"imported_by" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sie_verification_imports_sha256_unique" UNIQUE("sha256")
);
--> statement-breakpoint
CREATE TABLE "verification_template_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"account_number" varchar(4) NOT NULL,
	"description" varchar(255),
	"debit" numeric(14, 2),
	"credit" numeric(14, 2),
	"sort_order" integer NOT NULL,
	CONSTRAINT "verification_template_row_account_number" CHECK ("verification_template_rows"."account_number" ~ '^[0-9]{4}$'),
	CONSTRAINT "verification_template_row_amounts" CHECK (("verification_template_rows"."debit" IS NULL OR "verification_template_rows"."debit" > 0) AND ("verification_template_rows"."credit" IS NULL OR "verification_template_rows"."credit" > 0) AND NOT ("verification_template_rows"."debit" IS NOT NULL AND "verification_template_rows"."credit" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "verification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"series_id" uuid NOT NULL,
	"description" varchar(255) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "recurring_verification_runs" ADD CONSTRAINT "recurring_verification_runs_recurring_id_recurring_verifications_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_verifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_verification_runs" ADD CONSTRAINT "recurring_verification_runs_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_verifications" ADD CONSTRAINT "recurring_verifications_template_id_verification_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."verification_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_verifications" ADD CONSTRAINT "recurring_verifications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sie_verification_imports" ADD CONSTRAINT "sie_verification_imports_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_template_rows" ADD CONSTRAINT "verification_template_rows_template_id_verification_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."verification_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_templates" ADD CONSTRAINT "verification_templates_series_id_verification_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."verification_series"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_templates" ADD CONSTRAINT "verification_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_verification_runs_recurring_month_unique" ON "recurring_verification_runs" USING btree ("recurring_id","month");--> statement-breakpoint
CREATE INDEX "idx_recurring_verification_runs_verification" ON "recurring_verification_runs" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "idx_recurring_verifications_template" ON "recurring_verifications" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_verification_template_rows_template" ON "verification_template_rows" USING btree ("template_id");