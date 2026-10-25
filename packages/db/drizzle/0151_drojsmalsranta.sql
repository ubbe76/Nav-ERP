CREATE TABLE "late_interest_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"from_date" date,
	"to_date" date,
	"days" integer DEFAULT 0 NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"fee" numeric(14, 2) DEFAULT '0' NOT NULL,
	"charge_invoice_id" uuid NOT NULL,
	"charge_invoice_row_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "late_interest_charges_period" CHECK (("late_interest_charges"."from_date" IS NULL AND "late_interest_charges"."to_date" IS NULL) OR ("late_interest_charges"."from_date" IS NOT NULL AND "late_interest_charges"."to_date" IS NOT NULL AND "late_interest_charges"."to_date" >= "late_interest_charges"."from_date")),
	CONSTRAINT "late_interest_charges_amount" CHECK ("late_interest_charges"."amount" >= 0),
	CONSTRAINT "late_interest_charges_fee" CHECK ("late_interest_charges"."fee" >= 0),
	CONSTRAINT "late_interest_charges_days" CHECK ("late_interest_charges"."days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reference_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"valid_from" date NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"source" varchar(10) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_rates_valid_from_unique" UNIQUE("valid_from"),
	CONSTRAINT "reference_rates_source_valid" CHECK ("reference_rates"."source" IN ('riksbank', 'manual')),
	CONSTRAINT "reference_rates_half_year" CHECK (EXTRACT(DAY FROM "reference_rates"."valid_from") = 1 AND EXTRACT(MONTH FROM "reference_rates"."valid_from") IN (1, 7))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "late_interest" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "late_interest_rate" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "late_fee" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD COLUMN "revenue_account" varchar(4);--> statement-breakpoint
ALTER TABLE "late_interest_charges" ADD CONSTRAINT "late_interest_charges_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_interest_charges" ADD CONSTRAINT "late_interest_charges_charge_invoice_id_invoices_id_fk" FOREIGN KEY ("charge_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_interest_charges" ADD CONSTRAINT "late_interest_charges_charge_invoice_row_id_invoice_rows_id_fk" FOREIGN KEY ("charge_invoice_row_id") REFERENCES "public"."invoice_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "late_interest_charges" ADD CONSTRAINT "late_interest_charges_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_rates" ADD CONSTRAINT "reference_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_late_interest_charges_invoice" ON "late_interest_charges" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "idx_late_interest_charges_charge_invoice" ON "late_interest_charges" USING btree ("charge_invoice_id");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_late_interest_rate" CHECK ("customers"."late_interest_rate" IS NULL OR "customers"."late_interest_rate" >= 0);--> statement-breakpoint
-- Dröjsmålsränta och förseningsersättning (bokföringsgranskningen etapp 5
-- del C). Momskod UTM "Utanför momsens tillämpningsområde": försäljning, 0 %,
-- intäktskonto 3990 utan ruta — the code a räntefaktura's rows carry (the
-- interest and the förseningsersättning are outside the VAT system).
-- Idempotent like the 0142 seed (vat-codes-migration.test.ts re-runs the
-- marked block after truncating vat_codes).
-- utm-seed:start
INSERT INTO "vat_codes" ("code", "name", "invoice_text", "revenue_account", "output_vat_account", "input_vat_account", "cost_account", "base_account", "base_counter_account") VALUES
  ('UTM', 'Utanför momsens tillämpningsområde', NULL, '3990', NULL, NULL, NULL, NULL, NULL)
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- utm-seed:end
-- Konto 8313 Ränteintäkter från kortfristiga fordringar (the default
-- posting_late_interest account) and 3990 Övriga ersättningar och intäkter
-- (posting_late_fee, UTM's revenue account), added to an existing chart of
-- accounts when missing — never to an empty one (Förifyll BAS-kontoplan
-- seeds everything then). Same names and boxes as bas-accounts.ts.
INSERT INTO "accounts" ("number", "name", "vat_box")
SELECT v.number, v.name, v.box FROM (VALUES
  ('8313', 'Ränteintäkter från kortfristiga fordringar', NULL),
  ('3990', 'Övriga ersättningar och intäkter', 'none')
) AS v(number, name, box)
WHERE EXISTS (SELECT 1 FROM "accounts")
  AND NOT EXISTS (SELECT 1 FROM "accounts" WHERE "accounts"."number" = v.number);
