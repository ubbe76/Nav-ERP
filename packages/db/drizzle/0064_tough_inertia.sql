CREATE TABLE "article_standard_cost_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"cost" numeric(14, 4) NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "article_standard_cost_history" ADD CONSTRAINT "article_standard_cost_history_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_standard_cost_history" ADD CONSTRAINT "article_standard_cost_history_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_std_cost_history_article_from" ON "article_standard_cost_history" USING btree ("article_id","valid_from");--> statement-breakpoint
INSERT INTO "article_standard_cost_history" ("article_id", "cost")
SELECT "id", "standard_cost" FROM "articles" WHERE "standard_cost" IS NOT NULL;
