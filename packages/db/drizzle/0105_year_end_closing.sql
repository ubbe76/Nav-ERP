CREATE TYPE "public"."fiscal_year_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."year_end_accrual_kind" AS ENUM('prepaid_expense', 'accrued_income', 'accrued_expense', 'prepaid_income');--> statement-breakpoint
CREATE TYPE "public"."year_end_closing_status" AS ENUM('in_progress', 'closed');--> statement-breakpoint
CREATE TYPE "public"."year_end_step" AS ENUM('inventory', 'accruals', 'result_transfer', 'profit_disposition');--> statement-breakpoint
CREATE TYPE "public"."year_end_verification_role" AS ENUM('booking', 'accrual_reversal', 'cancellation');--> statement-breakpoint
CREATE TABLE "profit_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closing_id" uuid NOT NULL,
	"agm_date" date NOT NULL,
	"result_amount" numeric(14, 2) NOT NULL,
	"dividend_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"verification_id" uuid NOT NULL,
	"reversal_verification_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profit_dispositions_verification_id_unique" UNIQUE("verification_id"),
	CONSTRAINT "profit_dispositions_reversal_verification_id_unique" UNIQUE("reversal_verification_id"),
	CONSTRAINT "profit_disposition_dividend_nonnegative" CHECK ("profit_dispositions"."dividend_amount" >= 0),
	CONSTRAINT "profit_disposition_nonzero" CHECK ("profit_dispositions"."result_amount" <> 0 OR "profit_dispositions"."dividend_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "year_end_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closing_id" uuid NOT NULL,
	"verification_id" uuid NOT NULL,
	"kind" "year_end_accrual_kind" NOT NULL,
	"balance_account_id" uuid NOT NULL,
	"result_account_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"description" varchar(255) NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "year_end_accrual_amount_positive" CHECK ("year_end_accruals"."amount" > 0),
	CONSTRAINT "year_end_accrual_accounts_distinct" CHECK ("year_end_accruals"."balance_account_id" <> "year_end_accruals"."result_account_id")
);
--> statement-breakpoint
CREATE TABLE "year_end_closing_verifications" (
	"verification_id" uuid PRIMARY KEY NOT NULL,
	"closing_id" uuid NOT NULL,
	"step" "year_end_step" NOT NULL,
	"role" "year_end_verification_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "year_end_closings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"closing_date" date NOT NULL,
	"status" "year_end_closing_status" DEFAULT 'in_progress' NOT NULL,
	"inventory_method" varchar(20),
	"inventory_value" numeric(14, 2),
	"inventory_verification_id" uuid,
	"inventory_booked_at" timestamp with time zone,
	"accruals_verification_id" uuid,
	"accruals_reversal_verification_id" uuid,
	"accruals_booked_at" timestamp with time zone,
	"result_transfer_verification_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "year_end_closings_fiscal_year_id_unique" UNIQUE("fiscal_year_id"),
	CONSTRAINT "year_end_closings_inventory_verification_id_unique" UNIQUE("inventory_verification_id"),
	CONSTRAINT "year_end_closings_accruals_verification_id_unique" UNIQUE("accruals_verification_id"),
	CONSTRAINT "year_end_closings_accruals_reversal_verification_id_unique" UNIQUE("accruals_reversal_verification_id"),
	CONSTRAINT "year_end_closings_result_transfer_verification_id_unique" UNIQUE("result_transfer_verification_id"),
	CONSTRAINT "year_end_inventory_method_valid" CHECK ("year_end_closings"."inventory_method" IN ('standard', 'latest_purchase', 'moving_average')),
	CONSTRAINT "year_end_inventory_consistent" CHECK (("year_end_closings"."inventory_booked_at" IS NULL) = ("year_end_closings"."inventory_method" IS NULL) AND ("year_end_closings"."inventory_booked_at" IS NULL) = ("year_end_closings"."inventory_value" IS NULL) AND ("year_end_closings"."inventory_verification_id" IS NULL OR "year_end_closings"."inventory_booked_at" IS NOT NULL)),
	CONSTRAINT "year_end_accruals_pair" CHECK (("year_end_closings"."accruals_verification_id" IS NULL) = ("year_end_closings"."accruals_reversal_verification_id" IS NULL) AND ("year_end_closings"."accruals_verification_id" IS NULL OR "year_end_closings"."accruals_booked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD COLUMN "status" "fiscal_year_status" DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "profit_dispositions" ADD CONSTRAINT "profit_dispositions_closing_id_year_end_closings_id_fk" FOREIGN KEY ("closing_id") REFERENCES "public"."year_end_closings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_dispositions" ADD CONSTRAINT "profit_dispositions_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_dispositions" ADD CONSTRAINT "profit_dispositions_reversal_verification_id_verifications_id_fk" FOREIGN KEY ("reversal_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_dispositions" ADD CONSTRAINT "profit_dispositions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_accruals" ADD CONSTRAINT "year_end_accruals_closing_id_year_end_closings_id_fk" FOREIGN KEY ("closing_id") REFERENCES "public"."year_end_closings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_accruals" ADD CONSTRAINT "year_end_accruals_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_accruals" ADD CONSTRAINT "year_end_accruals_balance_account_id_accounts_id_fk" FOREIGN KEY ("balance_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_accruals" ADD CONSTRAINT "year_end_accruals_result_account_id_accounts_id_fk" FOREIGN KEY ("result_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closing_verifications" ADD CONSTRAINT "year_end_closing_verifications_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closing_verifications" ADD CONSTRAINT "year_end_closing_verifications_closing_id_year_end_closings_id_fk" FOREIGN KEY ("closing_id") REFERENCES "public"."year_end_closings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_inventory_verification_id_verifications_id_fk" FOREIGN KEY ("inventory_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_accruals_verification_id_verifications_id_fk" FOREIGN KEY ("accruals_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_accruals_reversal_verification_id_verifications_id_fk" FOREIGN KEY ("accruals_reversal_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_result_transfer_verification_id_verifications_id_fk" FOREIGN KEY ("result_transfer_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profit_dispositions_one_active" ON "profit_dispositions" USING btree ("closing_id") WHERE "profit_dispositions"."reversal_verification_id" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_year_end_accruals_verification" ON "year_end_accruals" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "idx_year_end_accruals_closing" ON "year_end_accruals" USING btree ("closing_id");--> statement-breakpoint
CREATE INDEX "idx_year_end_closing_verifications_closing" ON "year_end_closing_verifications" USING btree ("closing_id");--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_year_closed_consistent" CHECK (("fiscal_years"."status" = 'closed') = ("fiscal_years"."closed_at" IS NOT NULL));
--> statement-breakpoint
-- Årsbokslut: no verification may be BOOKED into a closed fiscal year, for
-- any writer. FOR SHARE on the year row: closeYear updates that row BEFORE
-- its final checks, so a booking in flight finishes (and is seen by the
-- checks) and a booking that starts later waits and then sees 'closed'.
-- Drafts are left alone (the app refuses them; they never touch the books).
CREATE OR REPLACE FUNCTION nav_closed_year_booking_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  IF NEW.status = 'booked' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    SELECT status::text INTO v_status FROM fiscal_years WHERE id = NEW.fiscal_year_id FOR SHARE;
    IF v_status = 'closed' THEN
      RAISE EXCEPTION 'Räkenskapsåret är stängt — inga verifikat kan bokföras i det (verifikat %)', NEW.id
        USING ERRCODE = 'NV001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verifications_closed_year_lock
  BEFORE INSERT OR UPDATE ON verifications
  FOR EACH ROW EXECUTE FUNCTION nav_closed_year_booking_guard();
--> statement-breakpoint
-- A period of a closed fiscal year can never be reopened — reopen the year.
CREATE OR REPLACE FUNCTION nav_closed_year_period_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'locked' AND NEW.status = 'open'
     AND (SELECT status::text FROM fiscal_years WHERE id = NEW.fiscal_year_id) = 'closed' THEN
    RAISE EXCEPTION 'Perioden tillhör ett stängt räkenskapsår — öppna året igen under Bokslut'
      USING ERRCODE = 'NV001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER accounting_periods_closed_year_lock
  BEFORE UPDATE ON accounting_periods
  FOR EACH ROW EXECUTE FUNCTION nav_closed_year_period_guard();
