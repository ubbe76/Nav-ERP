-- Rapportera (Tillverkning → Rapportera, 2026-11-24, the user: "en egen rutin
-- som är lätt att använda för att manuellt rapportera tillverkningsorder"): an
-- operation's time and quantities reported by hand in one go get their own
-- source in the report log. Its own migration — the value is not used here
-- (55P04, see 0120).
ALTER TYPE "public"."mo_report_source" ADD VALUE 'manual_report';
