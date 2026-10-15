CREATE TABLE "article_drawing_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drawing_id" uuid NOT NULL,
	"revision" varchar(20) NOT NULL,
	"comment" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_drawing_revisions_drawing_revision_unique" UNIQUE("drawing_id","revision")
);
--> statement-breakpoint
CREATE TABLE "article_drawings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"drawing_number" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_drawings_article_number_unique" UNIQUE("article_id","drawing_number")
);
--> statement-breakpoint
CREATE TABLE "article_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"revision" varchar(20) NOT NULL,
	"comment" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_revisions_article_revision_unique" UNIQUE("article_id","revision")
);
--> statement-breakpoint
ALTER TABLE "article_drawing_revisions" ADD CONSTRAINT "article_drawing_revisions_drawing_id_article_drawings_id_fk" FOREIGN KEY ("drawing_id") REFERENCES "public"."article_drawings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_drawings" ADD CONSTRAINT "article_drawings_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_revisions" ADD CONSTRAINT "article_revisions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "article_drawing_revisions_one_active" ON "article_drawing_revisions" USING btree ("drawing_id") WHERE "article_drawing_revisions"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "article_revisions_one_active" ON "article_revisions" USING btree ("article_id") WHERE "article_revisions"."is_active";