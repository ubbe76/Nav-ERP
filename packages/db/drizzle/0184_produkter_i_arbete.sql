-- Produkter i arbete (PIA) per datum (#25, spec
-- private/superpowers/specs/2026-11-06-produkter-i-arbete-design.md).
-- The year-end step work_in_progress: the PIA value per the closing date with
-- the chosen underlag (wip_basis manufacturing_cost|direct), the live BS
-- verification and when the step was done — the same shape and consistency
-- CHECK as steg 2 (year_end_inventory_consistent). The value itself is never
-- stored anywhere else: the report derives it from the logs.
ALTER TYPE "public"."year_end_step" ADD VALUE 'work_in_progress';--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "wip_basis" varchar(20);--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "wip_value" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "wip_verification_id" uuid;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "wip_booked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_wip_verification_id_verifications_id_fk" FOREIGN KEY ("wip_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_wip_verification_id_unique" UNIQUE("wip_verification_id");--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_wip_basis_valid" CHECK ("year_end_closings"."wip_basis" IN ('manufacturing_cost', 'direct'));--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_wip_consistent" CHECK (("year_end_closings"."wip_booked_at" IS NULL) = ("year_end_closings"."wip_basis" IS NULL) AND ("year_end_closings"."wip_booked_at" IS NULL) = ("year_end_closings"."wip_value" IS NULL) AND ("year_end_closings"."wip_verification_id" IS NULL OR "year_end_closings"."wip_booked_at" IS NOT NULL));--> statement-breakpoint
-- Konto 1440 Produkter i arbete and 4940 Förändring av produkter i arbete
-- (the default posting_wip and posting_wip_change accounts), added to an
-- existing chart of accounts when missing — never to an empty one (Förifyll
-- BAS-kontoplan seeds everything then). A chart without them would block the
-- step as soon as there is work in progress. Same names as bas-accounts.ts;
-- no momsruta, like 1460/4990.
INSERT INTO "accounts" ("number", "name", "vat_box")
SELECT v.number, v.name, v.box FROM (VALUES
  ('1440', 'Produkter i arbete', NULL),
  ('4940', 'Förändring av produkter i arbete', NULL)
) AS v(number, name, box)
WHERE EXISTS (SELECT 1 FROM "accounts")
  AND NOT EXISTS (SELECT 1 FROM "accounts" WHERE "accounts"."number" = v.number);
