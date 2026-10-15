ALTER TABLE "articles" ADD COLUMN "rounding" numeric(14, 3);--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_rounding_positive" CHECK ("articles"."rounding" > 0);