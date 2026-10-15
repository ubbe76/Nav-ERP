CREATE TYPE "public"."article_type" AS ENUM('manufactured', 'purchased', 'service');--> statement-breakpoint
CREATE TYPE "public"."stock_transaction_type" AS ENUM('purchase_receipt', 'sales_delivery', 'mo_consumption', 'mo_receipt', 'inventory_adjustment');--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_number" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "article_type" NOT NULL,
	"unit" varchar(20) DEFAULT 'st' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_article_number_unique" UNIQUE("article_number")
);
--> statement-breakpoint
CREATE TABLE "bom_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_article_id" uuid NOT NULL,
	"component_article_id" uuid NOT NULL,
	"quantity" numeric(14, 4) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bom_components_parent_article_id_component_article_id_unique" UNIQUE("parent_article_id","component_article_id"),
	CONSTRAINT "no_self_reference" CHECK ("bom_components"."parent_article_id" <> "bom_components"."component_article_id")
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "stock_locations_warehouse_id_name_unique" UNIQUE("warehouse_id","name")
);
--> statement-breakpoint
CREATE TABLE "stock_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity_delta" numeric(14, 4) NOT NULL,
	"transaction_type" "stock_transaction_type" NOT NULL,
	"reference_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_parent_article_id_articles_id_fk" FOREIGN KEY ("parent_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_component_article_id_articles_id_fk" FOREIGN KEY ("component_article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bom_parent" ON "bom_components" USING btree ("parent_article_id");--> statement-breakpoint
CREATE INDEX "idx_bom_component" ON "bom_components" USING btree ("component_article_id");--> statement-breakpoint
CREATE INDEX "idx_stock_transactions_article_location" ON "stock_transactions" USING btree ("article_id","location_id");--> statement-breakpoint
CREATE VIEW "public"."stock_balances" AS (select "article_id", "location_id", sum("quantity_delta") as "quantity_on_hand" from "stock_transactions" group by "stock_transactions"."article_id", "stock_transactions"."location_id");