-- Varugrupp (article_groups in the database) steers the article's VAT rate:
-- the group gets the rate, and articles.vat_rate goes in 0156. Each existing
-- group takes the most common rate among its articles (a tie goes to the
-- higher rate); a group without articles keeps 25. Articles whose own rate
-- differs from the result (or that have no group and a rate other than 25)
-- change rate — run the check in the release notes before migrating.
-- Artikelkoder: a new Grunddata register for selection/grouping in lists.
CREATE TABLE "article_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_codes_code_unique" UNIQUE("code"),
	CONSTRAINT "article_codes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "article_groups" ADD COLUMN "vat_rate" numeric(5, 2) DEFAULT '25' NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "article_code_id" uuid;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_article_code_id_article_codes_id_fk" FOREIGN KEY ("article_code_id") REFERENCES "public"."article_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "article_groups_vat_rate_check" CHECK ("article_groups"."vat_rate" IN (25, 12, 6, 0));--> statement-breakpoint
UPDATE "article_groups" g SET "vat_rate" = m."rate"
FROM (
  SELECT "group_id", mode() WITHIN GROUP (ORDER BY "vat_rate" DESC) AS "rate"
  FROM "articles" WHERE "group_id" IS NOT NULL GROUP BY "group_id"
) m
WHERE m."group_id" = g."id";
