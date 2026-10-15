CREATE TABLE "article_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "is_phantom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_group_id_article_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."article_groups"("id") ON DELETE set null ON UPDATE no action;