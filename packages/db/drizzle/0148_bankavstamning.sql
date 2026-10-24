-- Bankavstämning (bokföringsgranskningen etapp 4, spec
-- private/superpowers/specs/2026-10-24-bankavstamning-design.md): bankkonton,
-- kontoutdrag (camt.053/CSV) med poster (unik dedupe_key), matchningar mot
-- verifikatrader (partiella unika index på de levande länkraderna), bankregler
-- och avstämningsmärken (append-only). Filerna ligger i bank_files som förut.
CREATE TYPE "public"."bank_match_kind" AS ENUM('auto', 'manual', 'created');--> statement-breakpoint
CREATE TYPE "public"."bank_rule_direction" AS ENUM('in', 'out', 'both');--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"identifier" varchar(40) NOT NULL,
	"ledger_account" varchar(4) NOT NULL,
	"currency" varchar(3) DEFAULT 'SEK' NOT NULL,
	"csv_mapping" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_identifier_unique" UNIQUE("identifier"),
	CONSTRAINT "bank_accounts_ledger_account_four_digits" CHECK ("bank_accounts"."ledger_account" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "bank_match_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_match_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"verification_row_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"kind" "bank_match_kind" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by" uuid
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"through_date" date NOT NULL,
	"statement_balance" numeric(14, 2) NOT NULL,
	"ledger_balance" numeric(14, 2) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text_contains" varchar(100) NOT NULL,
	"direction" "bank_rule_direction" DEFAULT 'both' NOT NULL,
	"account_number" varchar(4) NOT NULL,
	"vat_code" varchar(10),
	"description" varchar(255),
	"auto_book" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_rules_account_number_four_digits" CHECK ("bank_rules"."account_number" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "bank_statement_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"bank_statement_id" uuid NOT NULL,
	"bank_file_id" uuid NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"text" varchar(255) NOT NULL,
	"reference" varchar(140),
	"counterparty" varchar(140),
	"details" jsonb NOT NULL,
	"reversal" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_entries_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "bank_statement_entries_amount_nonzero" CHECK ("bank_statement_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"bank_file_id" uuid NOT NULL,
	"statement_id" varchar(100),
	"from_date" date,
	"to_date" date,
	"opening_balance" numeric(14, 2),
	"closing_balance" numeric(14, 2),
	"closing_balance_date" date,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statements_closing_balance_date" CHECK (("bank_statements"."closing_balance" IS NULL) OR ("bank_statements"."closing_balance_date" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "bank_match_entries" ADD CONSTRAINT "bank_match_entries_match_id_bank_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."bank_matches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_entries" ADD CONSTRAINT "bank_match_entries_entry_id_bank_statement_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."bank_statement_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_rows" ADD CONSTRAINT "bank_match_rows_match_id_bank_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."bank_matches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_match_rows" ADD CONSTRAINT "bank_match_rows_verification_row_id_verification_rows_id_fk" FOREIGN KEY ("verification_row_id") REFERENCES "public"."verification_rows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_bank_statement_id_bank_statements_id_fk" FOREIGN KEY ("bank_statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_entries" ADD CONSTRAINT "bank_statement_entries_bank_file_id_bank_files_id_fk" FOREIGN KEY ("bank_file_id") REFERENCES "public"."bank_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_bank_file_id_bank_files_id_fk" FOREIGN KEY ("bank_file_id") REFERENCES "public"."bank_files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_match_entries_entry_live" ON "bank_match_entries" USING btree ("entry_id") WHERE "bank_match_entries"."active";--> statement-breakpoint
CREATE INDEX "idx_bank_match_entries_match" ON "bank_match_entries" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_match_rows_row_live" ON "bank_match_rows" USING btree ("verification_row_id") WHERE "bank_match_rows"."active";--> statement-breakpoint
CREATE INDEX "idx_bank_match_rows_match" ON "bank_match_rows" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "idx_bank_matches_account" ON "bank_matches" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "idx_bank_reconciliations_account_date" ON "bank_reconciliations" USING btree ("bank_account_id","through_date");--> statement-breakpoint
CREATE INDEX "idx_bank_statement_entries_account_date" ON "bank_statement_entries" USING btree ("bank_account_id","booking_date");--> statement-breakpoint
CREATE INDEX "idx_bank_statement_entries_statement" ON "bank_statement_entries" USING btree ("bank_statement_id");--> statement-breakpoint
CREATE INDEX "idx_bank_statements_account" ON "bank_statements" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "idx_bank_statements_file" ON "bank_statements" USING btree ("bank_file_id");