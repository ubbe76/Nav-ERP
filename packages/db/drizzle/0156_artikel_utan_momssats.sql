-- The article's rate is its varugrupp's since 0155 (articleVatRateSql), and
-- the varugrupp code widens from 3–4 to 1–4 digits (Monitor's varugrupper
-- are single digits; every existing code stays valid).
ALTER TABLE "articles" DROP COLUMN "vat_rate";--> statement-breakpoint
ALTER TABLE "article_groups" DROP CONSTRAINT "code_three_or_four_digits";--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "article_groups_code_digits" CHECK ("article_groups"."code" ~ '^[0-9]{1,4}$');