-- Tidrapportens resurs (#15, granskningen av etapp 1; spec
-- private/superpowers/specs/2026-11-06-alternativa-resurser-design.md).
-- A time report keeps the resource the time was worked on, so a later Byt
-- resurs (or Ändra operationer) never reprices it: the efterkalkyl and
-- Produkter i arbete price each report's hours at its own resource's hourly
-- rate of the work day. The stamp keeps the resource it was stamped in on
-- and carries it to the time report every stop materializes; a manual
-- report takes the operation's resource when it is written. Both nullable:
-- null = written before this migration, counted on the operation's current
-- resource as before. No backfill — the historical resource is not known.
-- Restrict: a resource with time on it cannot be deleted.
ALTER TABLE "stamp_sessions" ADD COLUMN "work_center_id" uuid;--> statement-breakpoint
ALTER TABLE "time_reports" ADD COLUMN "work_center_id" uuid;--> statement-breakpoint
ALTER TABLE "stamp_sessions" ADD CONSTRAINT "stamp_sessions_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_reports" ADD CONSTRAINT "time_reports_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE restrict ON UPDATE no action;