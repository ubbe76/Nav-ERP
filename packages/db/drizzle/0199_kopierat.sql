-- Kopierat (#28 etapp 1, spec
-- private/superpowers/specs/2026-11-08-kopierat-och-forkalkylera-flera-design.md).
-- user_copied_articles: the user's own working list of articles, in the
-- order they were copied (position). One row per (user, article); cascades
-- with the user and the article. The 5 000 cap (COPIED_ARTICLES_MAX) is
-- enforced in the article repository under a per-user advisory lock, not here.
CREATE TABLE "user_copied_articles" (
	"user_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_copied_articles_user_id_article_id_pk" PRIMARY KEY("user_id","article_id")
);
--> statement-breakpoint
ALTER TABLE "user_copied_articles" ADD CONSTRAINT "user_copied_articles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_copied_articles" ADD CONSTRAINT "user_copied_articles_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_copied_articles_user_position_idx" ON "user_copied_articles" USING btree ("user_id","position");