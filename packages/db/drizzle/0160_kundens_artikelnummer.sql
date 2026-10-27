CREATE TABLE "customer_article_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"customer_article_number" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_article_numbers_customer_article_unique" UNIQUE("customer_id","article_id")
);
--> statement-breakpoint
ALTER TABLE "customer_article_numbers" ADD CONSTRAINT "customer_article_numbers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_article_numbers" ADD CONSTRAINT "customer_article_numbers_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_customer_article_numbers_article" ON "customer_article_numbers" USING btree ("article_id");