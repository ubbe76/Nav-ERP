CREATE TYPE "public"."configurator_article_field" AS ENUM('colour', 'surface_treatment');--> statement-breakpoint
CREATE TABLE "configurator_variants" (
	"article_id" uuid PRIMARY KEY NOT NULL,
	"template_article_id" uuid NOT NULL,
	"config_key" varchar(1000) NOT NULL,
	"selection" jsonb NOT NULL,
	"calc_quantity" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "configurator_variants_template_key_unique" UNIQUE("template_article_id","config_key")
);
--> statement-breakpoint
ALTER TABLE "configurator_groups" ADD COLUMN "article_field" "configurator_article_field";--> statement-breakpoint
ALTER TABLE "configurator_variants" ADD CONSTRAINT "configurator_variants_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_variants" ADD CONSTRAINT "configurator_variants_template_article_id_configurator_templates_article_id_fk" FOREIGN KEY ("template_article_id") REFERENCES "public"."configurator_templates"("article_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_variants" ADD CONSTRAINT "configurator_variants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "configurator_variants_template_idx" ON "configurator_variants" USING btree ("template_article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "configurator_groups_article_field_unique" ON "configurator_groups" USING btree ("article_id","article_field") WHERE "configurator_groups"."article_field" is not null;--> statement-breakpoint
ALTER TABLE "configurator_groups" ADD CONSTRAINT "configurator_groups_article_field_choice" CHECK ("configurator_groups"."article_field" is null or "configurator_groups"."kind" = 'choice');