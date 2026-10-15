CREATE TABLE "posting_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_group_id" uuid NOT NULL,
	"vat_rate" numeric(5, 2),
	"revenue_account_id" uuid,
	"cost_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "verification_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "verification_id" uuid;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_article_group_id_article_groups_id_fk" FOREIGN KEY ("article_group_id") REFERENCES "public"."article_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_cost_account_id_accounts_id_fk" FOREIGN KEY ("cost_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "posting_rules_group_rate_unique" ON "posting_rules" USING btree ("article_group_id","vat_rate") WHERE "posting_rules"."vat_rate" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "posting_rules_group_norate_unique" ON "posting_rules" USING btree ("article_group_id") WHERE "posting_rules"."vat_rate" IS NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_supplier_invoices_verification" ON "supplier_invoices" USING btree ("verification_id");--> statement-breakpoint
CREATE INDEX "idx_invoices_verification" ON "invoices" USING btree ("verification_id");