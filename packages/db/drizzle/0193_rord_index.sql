-- Rörd (#15, granskningen av etapp 2; spec
-- private/superpowers/specs/2026-11-06-alternativa-resurser-design.md).
-- operationTouchedSql asks per operation whether it has any report-log row,
-- time report, stamp or scrap row — for every operation with possible
-- resources each time Beläggning, Planera or the TO card computes förslag,
-- and in Ändra operationer. None of the four tables had an index on
-- mo_operation_id (stamp_sessions' partial unique index leads with the
-- employee and covers only open stamps), so each EXISTS was a sequential scan.
CREATE INDEX "mo_operation_scrap_by_operation" ON "mo_operation_scrap" USING btree ("mo_operation_id");--> statement-breakpoint
CREATE INDEX "mo_reports_by_operation" ON "mo_reports" USING btree ("mo_operation_id");--> statement-breakpoint
CREATE INDEX "stamp_sessions_by_operation" ON "stamp_sessions" USING btree ("mo_operation_id");--> statement-breakpoint
CREATE INDEX "time_reports_by_operation" ON "time_reports" USING btree ("mo_operation_id");