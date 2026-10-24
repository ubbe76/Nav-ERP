-- Valuta (bokföringsgranskningen etapp 2, steg 4): valutaomvärdering i
-- årsbokslutet (spec private/superpowers/specs/2026-10-24-valuta-design.md §6).
-- Open customer and supplier invoices in another currency are revalued at
-- the closing date's rate: one BS verification on the closing date and its
-- automatic reversal on the next year's first day, stored as a pair exactly
-- like the accruals (CHECK both-or-neither). fx_booked_at = the step is done
-- (also with nothing to book) and fx_rates the rates the live booking used.
-- Both verifications are logged in year_end_closing_verifications (step
-- fx_revaluation, roles booking/fx_reversal/cancellation), so the generic
-- Omför refuses them and the VAT report excludes them by identity.
ALTER TYPE "public"."year_end_step" ADD VALUE 'fx_revaluation';--> statement-breakpoint
ALTER TYPE "public"."year_end_verification_role" ADD VALUE 'fx_reversal';--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "fx_verification_id" uuid;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "fx_reversal_verification_id" uuid;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "fx_booked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD COLUMN "fx_rates" jsonb;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_fx_verification_id_verifications_id_fk" FOREIGN KEY ("fx_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_fx_reversal_verification_id_verifications_id_fk" FOREIGN KEY ("fx_reversal_verification_id") REFERENCES "public"."verifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_fx_verification_id_unique" UNIQUE("fx_verification_id");--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_fx_reversal_verification_id_unique" UNIQUE("fx_reversal_verification_id");--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_fx_pair" CHECK (("year_end_closings"."fx_verification_id" IS NULL) = ("year_end_closings"."fx_reversal_verification_id" IS NULL) AND ("year_end_closings"."fx_verification_id" IS NULL OR "year_end_closings"."fx_booked_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_fx_rates_booked" CHECK (("year_end_closings"."fx_booked_at" IS NULL) = ("year_end_closings"."fx_rates" IS NULL));