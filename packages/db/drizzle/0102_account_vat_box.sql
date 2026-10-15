ALTER TABLE "accounts" ADD COLUMN "vat_box" varchar(4);--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "account_vat_box_valid" CHECK ("accounts"."vat_box" IN ('05', '10', '11', '12', '35', '36', '42', '48', 'none'));--> statement-breakpoint
-- vat-box-backfill:start
-- Reproduces the pre-migration bucketMovements classification exactly, from
-- the CURRENT posting settings (same BAS fallbacks as decodePostingSettings),
-- so the VAT report is unchanged by the deploy. Remaining accounts in class 3
-- and 26xx get 'none' (they were not counted before either), so only
-- accounts created after the migration can trigger the "no box" warning.
WITH s AS (
  SELECT
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_out_25'), ''), '2610') AS vat_out_25,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_out_12'), ''), '2620') AS vat_out_12,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_out_6'), ''), '2630') AS vat_out_6,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_in'), ''), '2640') AS vat_in,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_revenue_0'), ''), '3004') AS revenue_0,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_reminder_fee_account'), ''), '3540') AS reminder_fee,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_payment_writeoff'), ''), '3740') AS writeoff
)
UPDATE accounts SET vat_box = CASE
  WHEN accounts.number = s.vat_out_25 THEN '10'
  WHEN accounts.number = s.vat_out_12 THEN '11'
  WHEN accounts.number = s.vat_out_6 THEN '12'
  WHEN accounts.number = s.vat_in THEN '48'
  WHEN accounts.number = s.revenue_0 THEN '42'
  WHEN accounts.number = '3108' THEN '35'
  WHEN accounts.number = '3105' THEN '36'
  WHEN accounts.number IN (s.reminder_fee, s.writeoff) THEN 'none'
  WHEN accounts.number BETWEEN '3000' AND '3799' THEN '05'
  WHEN accounts.number LIKE '3%' OR accounts.number LIKE '26%' THEN 'none'
  ELSE NULL
END
FROM s;
-- vat-box-backfill:end
