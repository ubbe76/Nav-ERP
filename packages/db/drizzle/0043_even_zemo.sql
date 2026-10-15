CREATE TABLE "package_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_types_code_unique" UNIQUE("code"),
	CONSTRAINT "package_types_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "quantity_per_package" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "package_type_id" uuid;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_package_type_id_package_types_id_fk" FOREIGN KEY ("package_type_id") REFERENCES "public"."package_types"("id") ON DELETE restrict ON UPDATE no action;