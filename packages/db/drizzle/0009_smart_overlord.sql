CREATE TYPE "public"."cost_calculation_type" AS ENUM('pre', 'post');--> statement-breakpoint
CREATE TABLE "cost_calculations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"manufacturing_order_id" uuid,
	"quantity" numeric(14, 4) NOT NULL,
	"material_cost" numeric(14, 4) NOT NULL,
	"labor_cost" numeric(14, 4) NOT NULL,
	"overhead" numeric(14, 4) NOT NULL,
	"type" "cost_calculation_type" NOT NULL,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD CONSTRAINT "cost_calculations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_calculations" ADD CONSTRAINT "cost_calculations_manufacturing_order_id_manufacturing_orders_id_fk" FOREIGN KEY ("manufacturing_order_id") REFERENCES "public"."manufacturing_orders"("id") ON DELETE restrict ON UPDATE no action;