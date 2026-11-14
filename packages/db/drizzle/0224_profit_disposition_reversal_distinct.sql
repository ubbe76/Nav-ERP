-- Vinstdispositionens omföring är ett annat verifikat än dispositionen
-- (kodkvalitetsomgången 2026-11-14; ingen skrivare har brutit regeln).
ALTER TABLE "profit_dispositions" ADD CONSTRAINT "profit_disposition_reversal_distinct" CHECK ("profit_dispositions"."reversal_verification_id" IS NULL OR "profit_dispositions"."reversal_verification_id" <> "profit_dispositions"."verification_id");