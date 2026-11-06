-- Ställ och produktion i den verkliga tiden (#14 etapp 3, spec
-- private/superpowers/specs/2026-11-06-avvikelseanalys-efterkalkyl-design.md,
-- alternativ (a)). A work stamp and a time report may say whether the time
-- was ställ (setup) or produktion (run); the stamp's kind follows it to the
-- time report it materializes. Both nullable: null = ej uppdelad — every
-- report from before, and every one made without the setting
-- time_kind_split (Dela tid i ställ och produktion, a system_settings key,
-- off when unset — no row here). The server never requires the kind. The
-- efterkalkyl sums the hours per kind into setup_hours/run_hours. No
-- backfill: there is no source to split old reports from.
CREATE TYPE "public"."time_kind" AS ENUM('setup', 'run');--> statement-breakpoint
ALTER TABLE "stamp_sessions" ADD COLUMN "kind" time_kind;--> statement-breakpoint
ALTER TABLE "time_reports" ADD COLUMN "kind" time_kind;