CREATE TYPE "public"."manufacturing_order_status" AS ENUM('planned', 'released', 'in_progress', 'done', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."mo_operation_status" AS ENUM('pending', 'done');--> statement-breakpoint
CREATE SEQUENCE "public"."manufacturing_order_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 2044 CACHE 1;--> statement-breakpoint
CREATE TABLE "manufacturing_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" varchar(20) DEFAULT ('PO-' || nextval('manufacturing_order_number_seq')) NOT NULL,
	"article_id" uuid NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"status" "manufacturing_order_status" DEFAULT 'planned' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manufacturing_orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "mo_material_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturing_order_id" uuid NOT NULL,
	"component_article_id" uuid NOT NULL,
	"quantity_planned" numeric(14, 4) NOT NULL,
	"quantity_consumed" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mo_material_consumptions_manufacturing_order_id_component_article_id_unique" UNIQUE("manufacturing_order_id","component_article_id")
);
--> statement-breakpoint
CREATE TABLE "mo_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturing_order_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"work_center_id" uuid NOT NULL,
	"setup_time" numeric(10, 2) NOT NULL,
	"run_time_per_unit" numeric(10, 4) NOT NULL,
	"status" "mo_operation_status" DEFAULT 'pending' NOT NULL,
	"actual_time" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mo_operations_manufacturing_order_id_sequence_no_unique" UNIQUE("manufacturing_order_id","sequence_no")
);
--> statement-breakpoint
CREATE TABLE "routing_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"sequence_no" integer NOT NULL,
	"work_center_id" uuid NOT NULL,
	"setup_time" numeric(10, 2) NOT NULL,
	"run_time_per_unit" numeric(10, 4) NOT NULL,
	CONSTRAINT "routing_operations_article_id_sequence_no_unique" UNIQUE("article_id","sequence_no")
);
--> statement-breakpoint
CREATE TABLE "work_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manufacturing_orders" ADD CONSTRAINT "manufacturing_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD CONSTRAINT "mo_material_consumptions_manufacturing_order_id_manufacturing_orders_id_fk" FOREIGN KEY ("manufacturing_order_id") REFERENCES "public"."manufacturing_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD CONSTRAINT "mo_material_consumptions_component_article_id_articles_id_fk" FOREIGN KEY ("component_article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_manufacturing_order_id_manufacturing_orders_id_fk" FOREIGN KEY ("manufacturing_order_id") REFERENCES "public"."manufacturing_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_operations" ADD CONSTRAINT "mo_operations_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_operations" ADD CONSTRAINT "routing_operations_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;