CREATE TYPE "public"."work_center_type" AS ENUM('machine', 'personnel');--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "type" "work_center_type" DEFAULT 'machine' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "production_group_id" uuid;--> statement-breakpoint
ALTER TABLE "work_centers" ADD CONSTRAINT "work_centers_production_group_id_production_groups_id_fk" FOREIGN KEY ("production_group_id") REFERENCES "public"."production_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Preserve existing group memberships before dropping the join table. A
-- resource that was in several groups keeps an arbitrary one (the new model
-- is one group per resource; live data has exactly one each).
UPDATE "work_centers" wc
SET "production_group_id" = l."production_group_id"
FROM "production_group_work_centers" l
WHERE l."work_center_id" = wc."id";--> statement-breakpoint
ALTER TABLE "production_group_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "production_group_work_centers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "production_group_members" CASCADE;--> statement-breakpoint
DROP TABLE "production_group_work_centers" CASCADE;
