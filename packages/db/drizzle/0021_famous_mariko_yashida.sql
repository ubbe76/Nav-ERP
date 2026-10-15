ALTER TABLE "article_groups" DROP CONSTRAINT "code_three_digits";--> statement-breakpoint
ALTER TABLE "article_groups" ALTER COLUMN "code" SET DATA TYPE varchar(4);--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "code_three_or_four_digits" CHECK ("article_groups"."code" ~ '^[0-9]{3,4}$');