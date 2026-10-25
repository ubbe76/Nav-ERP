-- Budget (bokföringsgranskningen etapp 5 del B, spec
-- private/superpowers/specs/2026-10-24-kostnadsstallen-budget-ranta-design.md Del B):
-- budgets per räkenskapsår (at most one default per year, partial unique
-- index) and budget_lines per (account number, period ordinal, cost center),
-- unique NULLS NOT DISTINCT so the lines without a cost center are unique too.
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_number" varchar(4) NOT NULL,
	"month" smallint NOT NULL,
	"cost_center_id" uuid,
	"amount" numeric(14, 2) NOT NULL,
	CONSTRAINT "budget_lines_budget_account_month_cost_center_unique" UNIQUE NULLS NOT DISTINCT("budget_id","account_number","month","cost_center_id"),
	CONSTRAINT "budget_line_account_number" CHECK ("budget_lines"."account_number" ~ '^[0-9]{4}$'),
	CONSTRAINT "budget_line_month" CHECK ("budget_lines"."month" BETWEEN 1 AND 24),
	CONSTRAINT "budget_line_amount_nonzero" CHECK ("budget_lines"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_cost_center_id_cost_centers_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."cost_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_budget_lines_budget" ON "budget_lines" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX "idx_budget_lines_cost_center" ON "budget_lines" USING btree ("cost_center_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_year_name_unique" ON "budgets" USING btree ("fiscal_year_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_year_default_unique" ON "budgets" USING btree ("fiscal_year_id") WHERE "budgets"."is_default";