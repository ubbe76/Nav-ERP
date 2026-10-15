CREATE TABLE "article_supplier_price_breaks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_supplier_id" uuid NOT NULL,
	"from_quantity" numeric(14, 4) NOT NULL,
	"price" numeric(14, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_supplier_price_breaks_unique" UNIQUE("article_supplier_id","from_quantity"),
	CONSTRAINT "article_supplier_price_breaks_from_quantity_check" CHECK ("article_supplier_price_breaks"."from_quantity" > 1)
);
--> statement-breakpoint
ALTER TABLE "article_supplier_price_breaks" ADD CONSTRAINT "article_supplier_price_breaks_article_supplier_id_article_suppliers_id_fk" FOREIGN KEY ("article_supplier_id") REFERENCES "public"."article_suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_article_supplier_price_breaks_supplier" ON "article_supplier_price_breaks" USING btree ("article_supplier_id");