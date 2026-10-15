CREATE TABLE "permission_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_groups_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "permission_group_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_permission_group_id_permission_groups_id_fk" FOREIGN KEY ("permission_group_id") REFERENCES "public"."permission_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_permission_group_idx" ON "users" USING btree ("permission_group_id");--> statement-breakpoint
-- Seed: unchanged behaviour after the migration. Every existing non-admin
-- gets ALLA (the five menus they could already write in); Ekonomi and
-- Rapporter were admin-only and stay out of it. VERKSTAD is the ready-made
-- shop-floor profile.
INSERT INTO "permission_groups" ("code", "name", "permissions") VALUES
  ('ALLA', 'Alla moduler', '{artiklar,inkop,forsaljning,tillverkning,lager}'),
  ('VERKSTAD', 'Verkstad', '{terminal,artikeloversikt,tillverkningsorder_las}');
--> statement-breakpoint
UPDATE "users" SET "permission_group_id" = (SELECT "id" FROM "permission_groups" WHERE "code" = 'ALLA')
WHERE "role" <> 'admin';
