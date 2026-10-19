ALTER TABLE "article_groups" ADD COLUMN "number_series_key" varchar(50);--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "name" varchar(100);--> statement-breakpoint
ALTER TABLE "number_series" ADD COLUMN "for_articles" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "article_groups" ADD CONSTRAINT "article_groups_number_series_key_number_series_key_fk" FOREIGN KEY ("number_series_key") REFERENCES "public"."number_series"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_name_unique" UNIQUE("name");--> statement-breakpoint
-- The default article number series (Artikelnummer): bare numbers from 1001,
-- like the customer series. Taken numbers (imported articles) are skipped
-- when a number is issued.
INSERT INTO "number_series" ("key", "prefix", "next_number", "digits", "for_articles") VALUES ('article', '', 1001, 0, true) ON CONFLICT ("key") DO UPDATE SET "for_articles" = true;
