-- Fler förmedlare: en försändelse kan bokas via nShift eller Shipmondo
-- förutom Sendify (och ett eget fraktsätt, 'manual').
ALTER TABLE "shipments" DROP CONSTRAINT "shipments_provider_known";--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_provider_known" CHECK ("shipments"."provider" IN ('sendify', 'nshift', 'shipmondo', 'manual'));