-- Flera lagerplatser per artikel (etapp 3, spec
-- private/superpowers/specs/2026-11-06-lagerplatser-fortsattning-design.md).
-- article_alternative_locations: the article's alternative places after its
-- huvudplats (articles.default_location_id), sort_order 1..20 (CHECK), one
-- row per place (PK) and one place per position (UNIQUE). Both FKs cascade —
-- the row is only an assignment. The index on location_id serves
-- deactivateEmptyLocation, which deletes a retired place's assignments.
-- No existing article has any: the huvudplats alone keeps today's order.
CREATE TABLE "article_alternative_locations" (
	"article_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"sort_order" smallint NOT NULL,
	CONSTRAINT "article_alternative_locations_article_id_location_id_pk" PRIMARY KEY("article_id","location_id"),
	CONSTRAINT "article_alternative_locations_article_sort_order_unique" UNIQUE("article_id","sort_order"),
	CONSTRAINT "article_alternative_locations_sort_order_range" CHECK ("article_alternative_locations"."sort_order" BETWEEN 1 AND 20)
);
--> statement-breakpoint
ALTER TABLE "article_alternative_locations" ADD CONSTRAINT "article_alternative_locations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_alternative_locations" ADD CONSTRAINT "article_alternative_locations_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_article_alternative_locations_location" ON "article_alternative_locations" USING btree ("location_id");