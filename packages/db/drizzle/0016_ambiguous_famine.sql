ALTER TABLE "article_groups" ADD COLUMN "code" varchar(3);--> statement-breakpoint
-- Backfill existing groups with auto codes 100, 200, ... in name order;
-- the user adjusts them to their real codes in the UI afterwards.
UPDATE "article_groups" g
SET "code" = lpad((n.rn * 100)::text, 3, '0')
FROM (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM "article_groups") n
WHERE g.id = n.id;--> statement-breakpoint
ALTER TABLE "article_groups" ALTER COLUMN "code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "article_groups_code_unique" UNIQUE("code");--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "code_three_digits" CHECK ("article_groups"."code" ~ '^[0-9]{3}$');