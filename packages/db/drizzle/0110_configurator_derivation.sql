CREATE TYPE "public"."configurator_line_source" AS ENUM('article', 'group');--> statement-breakpoint
CREATE TABLE "configurator_bom_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" "configurator_line_source" NOT NULL,
	"component_article_id" uuid,
	"component_group_id" uuid,
	"quantity" numeric(14, 4),
	"quantity_formula" varchar(500),
	"routing_operation_id" uuid,
	"configurator_operation_id" uuid,
	"note" varchar(255),
	CONSTRAINT "configurator_bom_lines_article_source" CHECK (("configurator_bom_lines"."source" = 'article') = ("configurator_bom_lines"."component_article_id" is not null)),
	CONSTRAINT "configurator_bom_lines_group_source" CHECK (("configurator_bom_lines"."source" = 'group') = ("configurator_bom_lines"."component_group_id" is not null)),
	CONSTRAINT "configurator_bom_lines_quantity_one" CHECK (("configurator_bom_lines"."quantity" is null) <> ("configurator_bom_lines"."quantity_formula" is null)),
	CONSTRAINT "configurator_bom_lines_quantity_positive" CHECK ("configurator_bom_lines"."quantity" is null or "configurator_bom_lines"."quantity" > 0),
	CONSTRAINT "configurator_bom_lines_one_operation" CHECK ("configurator_bom_lines"."routing_operation_id" is null or "configurator_bom_lines"."configurator_operation_id" is null)
);
--> statement-breakpoint
CREATE TABLE "configurator_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"work_center_id" uuid NOT NULL,
	"description" varchar(255),
	"setup_time" numeric(10, 2),
	"setup_formula" varchar(500),
	"run_time_per_unit" numeric(10, 4),
	"run_formula" varchar(500),
	"setup_price" numeric(14, 2),
	"unit_price" numeric(14, 4),
	CONSTRAINT "configurator_operations_setup_one" CHECK (("configurator_operations"."setup_time" is null) <> ("configurator_operations"."setup_formula" is null)),
	CONSTRAINT "configurator_operations_run_one" CHECK (("configurator_operations"."run_time_per_unit" is null) <> ("configurator_operations"."run_formula" is null)),
	CONSTRAINT "configurator_operations_times_nonnegative" CHECK (coalesce("configurator_operations"."setup_time", 0) >= 0 and coalesce("configurator_operations"."run_time_per_unit", 0) >= 0),
	CONSTRAINT "configurator_operations_prices_nonnegative" CHECK (coalesce("configurator_operations"."setup_price", 0) >= 0 and coalesce("configurator_operations"."unit_price", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "configurator_values" ADD COLUMN "article_id" uuid;--> statement-breakpoint
ALTER TABLE "configurator_bom_lines" ADD CONSTRAINT "configurator_bom_lines_article_id_configurator_templates_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."configurator_templates"("article_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_bom_lines" ADD CONSTRAINT "configurator_bom_lines_component_article_id_articles_id_fk" FOREIGN KEY ("component_article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_bom_lines" ADD CONSTRAINT "configurator_bom_lines_component_group_id_configurator_groups_id_fk" FOREIGN KEY ("component_group_id") REFERENCES "public"."configurator_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_bom_lines" ADD CONSTRAINT "configurator_bom_lines_routing_operation_id_routing_operations_id_fk" FOREIGN KEY ("routing_operation_id") REFERENCES "public"."routing_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_bom_lines" ADD CONSTRAINT "configurator_bom_lines_configurator_operation_id_configurator_operations_id_fk" FOREIGN KEY ("configurator_operation_id") REFERENCES "public"."configurator_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_operations" ADD CONSTRAINT "configurator_operations_article_id_configurator_templates_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."configurator_templates"("article_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configurator_operations" ADD CONSTRAINT "configurator_operations_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "configurator_bom_lines_article_idx" ON "configurator_bom_lines" USING btree ("article_id");--> statement-breakpoint
CREATE UNIQUE INDEX "configurator_operations_article_sequence_unique" ON "configurator_operations" USING btree ("article_id","sequence_no");--> statement-breakpoint
CREATE INDEX "configurator_operations_article_idx" ON "configurator_operations" USING btree ("article_id");--> statement-breakpoint
ALTER TABLE "configurator_values" ADD CONSTRAINT "configurator_values_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "configurator_groups_default_value_idx" ON "configurator_groups" USING btree ("default_value_id");--> statement-breakpoint
CREATE INDEX "configurator_rules_article_idx" ON "configurator_rules" USING btree ("article_id");