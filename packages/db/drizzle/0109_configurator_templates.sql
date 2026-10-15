CREATE TYPE "public"."configurator_group_kind" AS ENUM('choice', 'boolean', 'number');--> statement-breakpoint
CREATE TYPE "public"."configurator_mode" AS ENUM('variants', 'to_order');--> statement-breakpoint
CREATE TYPE "public"."configurator_rule_effect" AS ENUM('exclude', 'require', 'limit');--> statement-breakpoint
CREATE TABLE "configurator_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"kind" "configurator_group_kind" NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer NOT NULL,
	"price_add" numeric(14, 2) DEFAULT '0' NOT NULL,
	"default_value_id" uuid,
	"unit" varchar(20),
	"min_value" numeric(14, 4),
	"max_value" numeric(14, 4),
	"step" numeric(14, 4),
	"default_number" numeric(14, 4),
	"price_per_unit" numeric(14, 4) DEFAULT '0' NOT NULL,
	"price_base_value" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "configurator_groups_article_code_unique" UNIQUE("article_id","code"),
	CONSTRAINT "configurator_groups_code_format" CHECK ("configurator_groups"."code" ~ '^[A-Z0-9]{1,20}$'),
	CONSTRAINT "configurator_groups_number_fields" CHECK (("configurator_groups"."kind" = 'number') = ("configurator_groups"."min_value" is not null and "configurator_groups"."max_value" is not null)
          and ("configurator_groups"."kind" = 'number' or ("configurator_groups"."unit" is null and "configurator_groups"."step" is null and "configurator_groups"."default_number" is null
               and "configurator_groups"."price_per_unit" = 0 and "configurator_groups"."price_base_value" = 0))),
	CONSTRAINT "configurator_groups_min_max" CHECK ("configurator_groups"."min_value" is null or "configurator_groups"."min_value" <= "configurator_groups"."max_value"),
	CONSTRAINT "configurator_groups_step_positive" CHECK ("configurator_groups"."step" is null or "configurator_groups"."step" > 0),
	CONSTRAINT "configurator_groups_price_per_unit" CHECK ("configurator_groups"."price_per_unit" >= 0),
	CONSTRAINT "configurator_groups_boolean_price" CHECK ("configurator_groups"."kind" = 'boolean' or "configurator_groups"."price_add" = 0),
	CONSTRAINT "configurator_groups_choice_default" CHECK ("configurator_groups"."kind" = 'choice' or "configurator_groups"."default_value_id" is null),
	CONSTRAINT "configurator_groups_required" CHECK ("configurator_groups"."kind" <> 'boolean' or not "configurator_groups"."required")
);
--> statement-breakpoint
CREATE TABLE "configurator_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"effect" "configurator_rule_effect" NOT NULL,
	"conditions" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"message" varchar(255) NOT NULL,
	"sort_order" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "configurator_templates" (
	"article_id" uuid PRIMARY KEY NOT NULL,
	"mode" "configurator_mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "configurator_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"price_add" numeric(14, 2) DEFAULT '0' NOT NULL,
	"sort_order" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "configurator_values_group_code_unique" UNIQUE("group_id","code"),
	CONSTRAINT "configurator_values_code_format" CHECK ("configurator_values"."code" ~ '^[A-Z0-9]{1,20}$')
);
--> statement-breakpoint
ALTER TABLE "configurator_groups" ADD CONSTRAINT "configurator_groups_article_id_configurator_templates_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."configurator_templates"("article_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_groups" ADD CONSTRAINT "configurator_groups_default_value_id_configurator_values_id_fk" FOREIGN KEY ("default_value_id") REFERENCES "public"."configurator_values"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_rules" ADD CONSTRAINT "configurator_rules_article_id_configurator_templates_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."configurator_templates"("article_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_templates" ADD CONSTRAINT "configurator_templates_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_values" ADD CONSTRAINT "configurator_values_group_id_configurator_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."configurator_groups"("id") ON DELETE cascade ON UPDATE no action;