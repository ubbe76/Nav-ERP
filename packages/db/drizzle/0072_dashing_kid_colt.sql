ALTER TABLE "manufacturing_orders" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "week_schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "work_centers" ADD COLUMN "capacity_factor" numeric(6, 2) DEFAULT '1' NOT NULL;--> statement-breakpoint
-- Hand-added FK (see work_centers.weekScheduleId in schema/manufacturing.ts:
-- declaring it via .references() would create an import cycle with
-- timereport.ts). set null: a deleted schedule degrades to "no capacity".
ALTER TABLE "work_centers" ADD CONSTRAINT "work_centers_week_schedule_id_week_schedules_id_fk" FOREIGN KEY ("week_schedule_id") REFERENCES "week_schedules"("id") ON DELETE set null;
