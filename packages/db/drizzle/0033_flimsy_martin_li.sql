CREATE TABLE "article_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"quantity_per_base" numeric(16, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_units_article_id_unit_id_unique" UNIQUE("article_id","unit_id"),
	CONSTRAINT "quantity_per_base_positive" CHECK ("article_units"."quantity_per_base" > 0)
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_code_unique" UNIQUE("code"),
	CONSTRAINT "units_name_unique" UNIQUE("name")
);
--> statement-breakpoint
INSERT INTO "units" ("code", "name") VALUES
	('st', 'Styck'),
	('kg', 'Kilogram'),
	('g', 'Gram'),
	('m', 'Meter'),
	('m2', 'Kvadratmeter'),
	('m3', 'Kubikmeter'),
	('l', 'Liter'),
	('tim', 'Timme'),
	('förp', 'Förpackning')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "units" ("code", "name")
	SELECT DISTINCT a."unit", a."unit" FROM "articles" a
	WHERE NOT EXISTS (SELECT 1 FROM "units" u WHERE u."code" = a."unit")
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
UPDATE "articles" SET "unit_id" = u."id" FROM "units" u WHERE u."code" = "articles"."unit";--> statement-breakpoint
ALTER TABLE "articles" ALTER COLUMN "unit_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "purchase_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "sales_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "bom_components" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "bom_components" ADD COLUMN "unit_factor" numeric(16, 6);--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD COLUMN "unit_factor" numeric(16, 6);--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD COLUMN "unit_factor" numeric(16, 6);--> statement-breakpoint
ALTER TABLE "purchase_order_rows" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_rows" ADD COLUMN "unit_factor" numeric(16, 6);--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "unit_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD COLUMN "unit_factor" numeric(16, 6);--> statement-breakpoint
ALTER TABLE "article_units" ADD CONSTRAINT "article_units_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_units" ADD CONSTRAINT "article_units_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_article_units_article" ON "article_units" USING btree ("article_id");--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_purchase_unit_id_units_id_fk" FOREIGN KEY ("purchase_unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_sales_unit_id_units_id_fk" FOREIGN KEY ("sales_unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mo_material_consumptions" ADD CONSTRAINT "mo_material_consumptions_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_rows" ADD CONSTRAINT "inquiry_rows_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_rows" ADD CONSTRAINT "purchase_order_rows_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_rows" ADD CONSTRAINT "sales_order_rows_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" DROP COLUMN "unit";