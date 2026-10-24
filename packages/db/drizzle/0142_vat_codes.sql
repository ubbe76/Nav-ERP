-- Momskoder (bokföringsgranskningen etapp 1). One vat_codes row per code of
-- the fixed catalog in @navet/shared's vat-codes.ts (accounts as numbers, not
-- FKs, like the posting_* settings). The eight per-rate posting settings move
-- onto the domestic codes and are removed; every declaration box becomes a
-- valid momsruta; the accounts the catalog points at are added to an existing
-- chart of accounts; posting rules, invoice rows and supplier invoices are
-- keyed on a momskod instead of a rate. The marked blocks are re-run by
-- vat-codes-migration.test.ts.
CREATE TABLE "vat_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" varchar(100) NOT NULL,
	"invoice_text" varchar(255),
	"active" boolean DEFAULT true NOT NULL,
	"revenue_account" varchar(4),
	"output_vat_account" varchar(4),
	"input_vat_account" varchar(4),
	"cost_account" varchar(4),
	"base_account" varchar(4),
	"base_counter_account" varchar(4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
-- vat-codes-seed:start
-- The domestic codes take the company's current posting settings (same BAS
-- fallbacks as decodePostingSettings did); ingående moms goes to all three
-- MP codes. Idempotent so the test can re-seed after truncating vat_codes.
WITH s AS (
  SELECT
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_revenue_25'), ''), '3001') AS revenue_25,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_revenue_12'), ''), '3002') AS revenue_12,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_revenue_6'), ''), '3003') AS revenue_6,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_revenue_0'), ''), '3004') AS revenue_0,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_out_25'), ''), '2610') AS vat_out_25,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_out_12'), ''), '2620') AS vat_out_12,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_out_6'), ''), '2630') AS vat_out_6,
    COALESCE(NULLIF((SELECT value FROM system_settings WHERE key = 'posting_vat_in'), ''), '2640') AS vat_in
)
INSERT INTO "vat_codes" ("code", "name", "invoice_text", "revenue_account", "output_vat_account", "input_vat_account")
SELECT 'MP25', 'Moms 25 %', NULL, s.revenue_25, s.vat_out_25, s.vat_in FROM s
UNION ALL SELECT 'MP12', 'Moms 12 %', NULL, s.revenue_12, s.vat_out_12, s.vat_in FROM s
UNION ALL SELECT 'MP6', 'Moms 6 %', NULL, s.revenue_6, s.vat_out_6, s.vat_in FROM s
UNION ALL SELECT 'MF', 'Momsfri', 'Momsfri omsättning', s.revenue_0, NULL, NULL FROM s
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
INSERT INTO "vat_codes" ("code", "name", "invoice_text", "revenue_account", "output_vat_account", "input_vat_account", "cost_account", "base_account", "base_counter_account") VALUES
  ('EUV', 'Varor till annat EU-land', 'Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)', '3108', NULL, NULL, NULL, NULL, NULL),
  ('EUT', 'Tjänster till annat EU-land', 'Omvänd betalningsskyldighet (artikel 196 i mervärdesskattedirektivet)', '3308', NULL, NULL, NULL, NULL, NULL),
  ('EXV', 'Export av varor', 'Export av varor, undantagen från moms (artikel 146 i mervärdesskattedirektivet)', '3105', NULL, NULL, NULL, NULL, NULL),
  ('EXT', 'Tjänster till land utanför EU', 'Tjänsten är omsatt utanför Sverige', '3305', NULL, NULL, NULL, NULL, NULL),
  ('OB', 'Omvänd betalningsskyldighet, Sverige', 'Omvänd betalningsskyldighet', '3231', NULL, NULL, NULL, NULL, NULL),
  ('IEUV25', 'Inköp varor från EU 25 %', NULL, NULL, '2614', '2645', '4515', NULL, NULL),
  ('IEUV12', 'Inköp varor från EU 12 %', NULL, NULL, '2624', '2645', '4516', NULL, NULL),
  ('IEUV6', 'Inköp varor från EU 6 %', NULL, NULL, '2634', '2645', '4517', NULL, NULL),
  ('IEUT', 'Inköp tjänster från EU 25 %', NULL, NULL, '2614', '2645', '4535', NULL, NULL),
  ('IUTT', 'Inköp tjänster utanför EU 25 %', NULL, NULL, '2614', '2645', '4531', NULL, NULL),
  ('IOBV', 'Inköp varor i Sverige, omvänd betalningsskyldighet', NULL, NULL, '2614', '2647', '4415', NULL, NULL),
  ('IOBT', 'Inköp tjänster i Sverige, omvänd betalningsskyldighet', NULL, NULL, '2614', '2647', '4425', NULL, NULL),
  ('IUTV', 'Inköp varor utanför EU (importmoms separat)', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('IMP25', 'Importmoms 25 %', NULL, NULL, '2615', '2645', NULL, '4545', '4549'),
  ('IMP12', 'Importmoms 12 %', NULL, NULL, '2625', '2645', NULL, '4546', '4549'),
  ('IMP6', 'Importmoms 6 %', NULL, NULL, '2635', '2645', NULL, '4547', '4549')
ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
DELETE FROM "system_settings" WHERE "key" IN (
  'posting_revenue_25', 'posting_revenue_12', 'posting_revenue_6', 'posting_revenue_0',
  'posting_vat_out_25', 'posting_vat_out_12', 'posting_vat_out_6', 'posting_vat_in'
);--> statement-breakpoint
-- vat-codes-seed:end
ALTER TABLE "accounts" DROP CONSTRAINT "account_vat_box_valid";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "account_vat_box_valid" CHECK ("accounts"."vat_box" IN ('05', '06', '07', '08', '10', '11', '12', '20', '21', '22', '23', '24', '30', '31', '32', '35', '36', '37', '38', '39', '40', '41', '42', '48', '50', '60', '61', '62', 'none'));--> statement-breakpoint
-- vat-codes-accounts:start
-- Accounts only, never bookings, and only into a chart that exists — a fresh
-- installation gets them from Generera BAS-kontoplan like the rest of BAS.
-- An existing account keeps its own momsruta; only an unclassified one
-- (vat_box null) gets the catalog's box. Names and boxes are exactly
-- bas-accounts.ts's (BAS 2026 for the new accounts; 4549 is not in BAS 2026
-- and keeps its long-established name).
INSERT INTO "accounts" ("number", "name", "vat_box")
SELECT v.number, v.name, v.box FROM (VALUES
  ('2614', 'Utgående moms omvänd betalningsskyldighet, 25 %', '30'),
  ('2615', 'Utgående moms import av varor, 25 %', '60'),
  ('2624', 'Utgående moms omvänd betalningsskyldighet, 12 %', '31'),
  ('2625', 'Utgående moms import av varor, 12 %', '61'),
  ('2634', 'Utgående moms omvänd betalningsskyldighet, 6 %', '32'),
  ('2635', 'Utgående moms import av varor, 6 %', '62'),
  ('2645', 'Beräknad ingående moms på förvärv från utlandet', '48'),
  ('2647', 'Ingående moms omvänd betalningsskyldighet varor och tjänster i Sverige', '48'),
  ('3105', 'Försäljning varor till land utanför EU', '36'),
  ('3108', 'Försäljning varor till annat EU-land', '35'),
  ('3231', 'Försäljning inom byggsektorn, omvänd betalningsskyldighet moms', '41'),
  ('3305', 'Försäljning tjänster till land utanför EU', '40'),
  ('3308', 'Försäljning tjänster till annat EU-land', '39'),
  ('4415', 'Inköp av råvaror och material i Sverige, omvänd betalningsskyldighet, 25 % moms', '23'),
  ('4425', 'Inköp av tjänster i Sverige, omvänd betalningsskyldighet, 25 % moms', '24'),
  ('4515', 'Inköp varor från annat EU-land 25 %', '20'),
  ('4516', 'Inköp av råvaror och material från annat EU-land, 12 %', '20'),
  ('4517', 'Inköp av råvaror och material från annat EU-land, 6 %', '20'),
  ('4531', 'Inköp av tjänster från ett land utanför EU, 25 % moms', '22'),
  ('4535', 'Inköp av tjänster från annat EU-land, 25 %', '21'),
  ('4545', 'Import av råvaror och material, 25 % moms', '50'),
  ('4546', 'Import av råvaror och material, 12 % moms', '50'),
  ('4547', 'Import av råvaror och material, 6 % moms', '50'),
  ('4549', 'Motkonto beskattningsunderlag import', 'none')
) AS v(number, name, box)
WHERE EXISTS (SELECT 1 FROM "accounts")
ON CONFLICT ("number") DO NOTHING;--> statement-breakpoint
UPDATE "accounts" SET "vat_box" = v.box
FROM (VALUES
  ('2614', '30'), ('2615', '60'), ('2624', '31'), ('2625', '61'), ('2634', '32'), ('2635', '62'),
  ('2645', '48'), ('2647', '48'), ('3105', '36'), ('3108', '35'), ('3231', '41'), ('3305', '40'),
  ('3308', '39'), ('4415', '23'), ('4425', '24'), ('4515', '20'), ('4516', '20'), ('4517', '20'),
  ('4531', '22'), ('4535', '21'), ('4545', '50'), ('4546', '50'), ('4547', '50'), ('4549', 'none')
) AS v(number, box)
WHERE "accounts"."number" = v.number AND "accounts"."vat_box" IS NULL;--> statement-breakpoint
-- Migration 0102 could only hand out the boxes that existed then, so it
-- gave every 26xx account 'none' and every account 3000–3799 '05'. A catalog
-- account still carrying exactly that forced value gets the catalog's box —
-- but only while no booked verification row touches it: moving a box under
-- booked rows would change the report of periods already declared (those
-- accounts are flagged by the Momskoder page and the VAT report instead).
-- 3105/3108 are not here: 0102 already gave them 36/35.
UPDATE "accounts" SET "vat_box" = v.box
FROM (VALUES
  ('2614', 'none', '30'), ('2615', 'none', '60'), ('2624', 'none', '31'), ('2625', 'none', '61'),
  ('2634', 'none', '32'), ('2635', 'none', '62'), ('2645', 'none', '48'), ('2647', 'none', '48'),
  ('3231', '05', '41'), ('3305', '05', '40'), ('3308', '05', '39')
) AS v(number, forced, box)
WHERE "accounts"."number" = v.number
  AND "accounts"."vat_box" = v.forced
  AND NOT EXISTS (
    SELECT 1 FROM "verification_rows"
    JOIN "verifications" ON "verifications"."id" = "verification_rows"."verification_id"
    WHERE "verification_rows"."account_id" = "accounts"."id" AND "verifications"."status" = 'booked'
  );--> statement-breakpoint
-- BAS: 4531 is tjänster från land UTANFÖR EU (the old seed called it EU).
-- Renamed only when it still carries exactly the old seed name.
UPDATE "accounts" SET "name" = 'Inköp av tjänster från ett land utanför EU, 25 % moms'
WHERE "number" = '4531' AND "name" = 'Inköp tjänster från annat EU-land 25 %';--> statement-breakpoint
-- vat-codes-accounts:end
ALTER TABLE "posting_rules" ADD COLUMN "vat_code_id" uuid;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_vat_code_id_vat_codes_id_fk" FOREIGN KEY ("vat_code_id") REFERENCES "public"."vat_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- vat-codes-rules-backfill:start
-- A rule per rate becomes a rule for the rate's domestic code; the catch-all
-- (vat_rate null) stays "Alla momskoder".
UPDATE "posting_rules" SET "vat_code_id" = "vat_codes"."id"
FROM "vat_codes"
WHERE "posting_rules"."vat_rate" IS NOT NULL
  AND "vat_codes"."code" = CASE "posting_rules"."vat_rate"
    WHEN 25 THEN 'MP25' WHEN 12 THEN 'MP12' WHEN 6 THEN 'MP6' WHEN 0 THEN 'MF' END;--> statement-breakpoint
-- vat-codes-rules-backfill:end
DROP INDEX "posting_rules_group_rate_unique";--> statement-breakpoint
DROP INDEX "posting_rules_group_norate_unique";--> statement-breakpoint
ALTER TABLE "posting_rules" DROP COLUMN "vat_rate";--> statement-breakpoint
CREATE UNIQUE INDEX "posting_rules_group_code_unique" ON "posting_rules" USING btree ("article_group_id","vat_code_id") WHERE "posting_rules"."vat_code_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "posting_rules_group_nocode_unique" ON "posting_rules" USING btree ("article_group_id") WHERE "posting_rules"."vat_code_id" IS NULL;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD COLUMN "vat_code_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD COLUMN "delivery_date" date;--> statement-breakpoint
ALTER TABLE "invoice_rows" ADD CONSTRAINT "invoice_rows_vat_code_id_vat_codes_id_fk" FOREIGN KEY ("vat_code_id") REFERENCES "public"."vat_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- vat-codes-invoice-rows-backfill:start
-- Every existing row was svensk moms or momsfri. A rate outside the Swedish
-- set can only sit on a draft (issuing refuses it); it gets MP25 and keeps
-- its rate, so issuing still refuses it.
UPDATE "invoice_rows" SET "vat_code_id" = "vat_codes"."id"
FROM "vat_codes"
WHERE "invoice_rows"."vat_code_id" IS NULL
  AND "vat_codes"."code" = CASE
    WHEN "invoice_rows"."vat_rate" = 12 THEN 'MP12'
    WHEN "invoice_rows"."vat_rate" = 6 THEN 'MP6'
    WHEN "invoice_rows"."vat_rate" = 0 THEN 'MF'
    ELSE 'MP25' END;--> statement-breakpoint
-- vat-codes-invoice-rows-backfill:end
ALTER TABLE "invoice_rows" ALTER COLUMN "vat_code_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reverse_charge_construction" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "country" varchar(2) DEFAULT 'SE' NOT NULL;--> statement-breakpoint
-- vat-codes-supplier-country:start
-- An existing supplier's country is read off its momsregistreringsnummer
-- (the prefix, when its first two characters are letters forming an ISO
-- 3166-1 alpha-2 code; the VAT prefixes EL = Greece and XI = Northern
-- Ireland map to GR/GB), else off its IBAN's country code, else Sverige —
-- so a foreign supplier's momskod (förval) is derived as omvänd moms or
-- import instead of svensk moms. Uppercased, separators ignored.
WITH iso(code) AS (VALUES
    ('AD'), ('AE'), ('AF'), ('AG'), ('AI'), ('AL'), ('AM'), ('AO'), ('AQ'), ('AR'), ('AS'), ('AT'), ('AU'), ('AW'), ('AX'), ('AZ'),
    ('BA'), ('BB'), ('BD'), ('BE'), ('BF'), ('BG'), ('BH'), ('BI'), ('BJ'), ('BL'), ('BM'), ('BN'), ('BO'), ('BQ'), ('BR'), ('BS'), ('BT'), ('BV'), ('BW'), ('BY'), ('BZ'),
    ('CA'), ('CC'), ('CD'), ('CF'), ('CG'), ('CH'), ('CI'), ('CK'), ('CL'), ('CM'), ('CN'), ('CO'), ('CR'), ('CU'), ('CV'), ('CW'), ('CX'), ('CY'), ('CZ'),
    ('DE'), ('DJ'), ('DK'), ('DM'), ('DO'), ('DZ'),
    ('EC'), ('EE'), ('EG'), ('EH'), ('ER'), ('ES'), ('ET'),
    ('FI'), ('FJ'), ('FK'), ('FM'), ('FO'), ('FR'),
    ('GA'), ('GB'), ('GD'), ('GE'), ('GF'), ('GG'), ('GH'), ('GI'), ('GL'), ('GM'), ('GN'), ('GP'), ('GQ'), ('GR'), ('GS'), ('GT'), ('GU'), ('GW'), ('GY'),
    ('HK'), ('HM'), ('HN'), ('HR'), ('HT'), ('HU'),
    ('ID'), ('IE'), ('IL'), ('IM'), ('IN'), ('IO'), ('IQ'), ('IR'), ('IS'), ('IT'),
    ('JE'), ('JM'), ('JO'), ('JP'),
    ('KE'), ('KG'), ('KH'), ('KI'), ('KM'), ('KN'), ('KP'), ('KR'), ('KW'), ('KY'), ('KZ'),
    ('LA'), ('LB'), ('LC'), ('LI'), ('LK'), ('LR'), ('LS'), ('LT'), ('LU'), ('LV'), ('LY'),
    ('MA'), ('MC'), ('MD'), ('ME'), ('MF'), ('MG'), ('MH'), ('MK'), ('ML'), ('MM'), ('MN'), ('MO'), ('MP'), ('MQ'), ('MR'), ('MS'), ('MT'), ('MU'), ('MV'), ('MW'), ('MX'), ('MY'), ('MZ'),
    ('NA'), ('NC'), ('NE'), ('NF'), ('NG'), ('NI'), ('NL'), ('NO'), ('NP'), ('NR'), ('NU'), ('NZ'),
    ('OM'),
    ('PA'), ('PE'), ('PF'), ('PG'), ('PH'), ('PK'), ('PL'), ('PM'), ('PN'), ('PR'), ('PS'), ('PT'), ('PW'), ('PY'),
    ('QA'),
    ('RE'), ('RO'), ('RS'), ('RU'), ('RW'),
    ('SA'), ('SB'), ('SC'), ('SD'), ('SE'), ('SG'), ('SH'), ('SI'), ('SJ'), ('SK'), ('SL'), ('SM'), ('SN'), ('SO'), ('SR'), ('SS'), ('ST'), ('SV'), ('SX'), ('SY'), ('SZ'),
    ('TC'), ('TD'), ('TF'), ('TG'), ('TH'), ('TJ'), ('TK'), ('TL'), ('TM'), ('TN'), ('TO'), ('TR'), ('TT'), ('TV'), ('TW'), ('TZ'),
    ('UA'), ('UG'), ('UM'), ('US'), ('UY'), ('UZ'),
    ('VA'), ('VC'), ('VE'), ('VG'), ('VI'), ('VN'), ('VU'),
    ('WF'), ('WS'),
    ('YE'), ('YT'),
    ('ZA'), ('ZM'), ('ZW')
),
candidates AS (
  SELECT
    s.id,
    CASE upper(substr(regexp_replace(coalesce(s.vat_number, ''), '[^A-Za-z0-9]', '', 'g'), 1, 2))
      WHEN 'EL' THEN 'GR' WHEN 'XI' THEN 'GB'
      ELSE upper(substr(regexp_replace(coalesce(s.vat_number, ''), '[^A-Za-z0-9]', '', 'g'), 1, 2))
    END AS from_vat,
    upper(substr(regexp_replace(coalesce(s.iban, ''), '[^A-Za-z0-9]', '', 'g'), 1, 2)) AS from_iban
  FROM "suppliers" s
)
UPDATE "suppliers" SET "country" = COALESCE(
  (SELECT iso.code FROM iso WHERE iso.code = candidates.from_vat),
  (SELECT iso.code FROM iso WHERE iso.code = candidates.from_iban),
  'SE'
)
FROM candidates
WHERE candidates.id = "suppliers"."id";--> statement-breakpoint
-- vat-codes-supplier-country:end
ALTER TABLE "suppliers" ADD COLUMN "default_vat_code_id" uuid;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_default_vat_code_id_vat_codes_id_fk" FOREIGN KEY ("default_vat_code_id") REFERENCES "public"."vat_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "vat_code_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_vat_code_id_vat_codes_id_fk" FOREIGN KEY ("vat_code_id") REFERENCES "public"."vat_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD COLUMN "vat_code_id" uuid;--> statement-breakpoint
ALTER TABLE "supplier_invoice_rows" ADD CONSTRAINT "supplier_invoice_rows_vat_code_id_vat_codes_id_fk" FOREIGN KEY ("vat_code_id") REFERENCES "public"."vat_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- vat-codes-supplier-invoices-backfill:start
-- Svensk moms 25 %; an attested or older invoice without VAT is momsfri. A
-- draft stays MP25 even at 0 kr VAT — its amounts may still be typed in, and
-- MP25 with no VAT posts exactly like before.
UPDATE "supplier_invoices" SET "vat_code_id" = "vat_codes"."id"
FROM "vat_codes"
WHERE "supplier_invoices"."vat_code_id" IS NULL
  AND "vat_codes"."code" = CASE
    WHEN "supplier_invoices"."vat_amount" = 0 AND "supplier_invoices"."status" <> 'draft' THEN 'MF'
    ELSE 'MP25' END;--> statement-breakpoint
-- A draft's row with its own rate keeps the posting rule it matched before
-- (rules were keyed on the row's rate) by getting that rate's code; rows
-- whose code equals the header's stay null (= follows the header).
UPDATE "supplier_invoice_rows" SET "vat_code_id" = "vat_codes"."id"
FROM "vat_codes", "supplier_invoices"
WHERE "supplier_invoices"."id" = "supplier_invoice_rows"."supplier_invoice_id"
  AND "supplier_invoices"."status" = 'draft'
  AND "supplier_invoice_rows"."vat_code_id" IS NULL
  AND "supplier_invoice_rows"."vat_rate" IN (25, 12, 6, 0)
  AND "vat_codes"."code" = CASE "supplier_invoice_rows"."vat_rate"
    WHEN 25 THEN 'MP25' WHEN 12 THEN 'MP12' WHEN 6 THEN 'MP6' WHEN 0 THEN 'MF' END
  AND "vat_codes"."id" <> "supplier_invoices"."vat_code_id";--> statement-breakpoint
-- vat-codes-supplier-invoices-backfill:end
ALTER TABLE "supplier_invoices" ALTER COLUMN "vat_code_id" SET NOT NULL;
