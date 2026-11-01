-- Dokument på engelska (#7). One document language per counterparty
-- (customers/suppliers.language, 'sv' or 'en'), stamped on the invoice at
-- Utfärda (invoices.language — existing invoices were written in Swedish, so
-- the default is right for them), and English texts on the things the
-- documents print: article name/extra description, the terms' names, the
-- unit code and the VAT codes' name/invoice text. The backfills below fill
-- the English texts of the seeded register rows where they are still null —
-- the same texts as COMBITERMS/STANDARD_UNITS in register.service.ts and
-- VAT_CODE_CATALOG in @navet/shared (the 0067/0033 duplicated-seed
-- precedent: keep the two in sync if the wording moves). The marked blocks
-- are re-run by document-language.test.ts.
ALTER TABLE "articles" ADD COLUMN "name_en" varchar(255);--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN "extra_description_en" text;--> statement-breakpoint
ALTER TABLE "vat_codes" ADD COLUMN "name_en" varchar(100);--> statement-breakpoint
ALTER TABLE "vat_codes" ADD COLUMN "invoice_text_en" varchar(255);--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "language" varchar(2) DEFAULT 'sv' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_terms" ADD COLUMN "name_en" varchar(100);--> statement-breakpoint
ALTER TABLE "payment_terms" ADD COLUMN "name_en" varchar(100);--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "code_en" varchar(20);--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "language" varchar(2) DEFAULT 'sv' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "language" varchar(2) DEFAULT 'sv' NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_language_valid" CHECK ("suppliers"."language" IN ('sv', 'en'));--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_language_valid" CHECK ("customers"."language" IN ('sv', 'en'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_language_valid" CHECK ("invoices"."language" IN ('sv', 'en'));--> statement-breakpoint
-- document-language-backfill:start
-- Combiterms: the Incoterms 2020 names, only where the code matches and no English name is set.
UPDATE "delivery_terms" AS t SET "name_en" = v.name_en FROM (VALUES
  ('EXW', 'Ex Works'),
  ('FCA', 'Free Carrier'),
  ('FAS', 'Free Alongside Ship'),
  ('FOB', 'Free On Board'),
  ('CFR', 'Cost and Freight'),
  ('CIF', 'Cost, Insurance and Freight'),
  ('CPT', 'Carriage Paid To'),
  ('CIP', 'Carriage and Insurance Paid To'),
  ('DAP', 'Delivered at Place'),
  ('DPU', 'Delivered at Place Unloaded'),
  ('DDP', 'Delivered Duty Paid')
) AS v(code, name_en) WHERE t."code" = v.code AND t."name_en" IS NULL;--> statement-breakpoint
-- Standard units: the English abbreviation where it differs from the code (kg, g, m, m2, m3, l keep their code).
UPDATE "units" AS u SET "code_en" = v.code_en FROM (VALUES
  ('st', 'pcs'),
  ('tim', 'h'),
  ('förp', 'pkg')
) AS v(code, code_en) WHERE u."code" = v.code AND u."code_en" IS NULL;--> statement-breakpoint
-- VAT codes: the catalog's English name and invoice text, where still null.
UPDATE "vat_codes" AS c SET "name_en" = COALESCE(c."name_en", v.name_en), "invoice_text_en" = COALESCE(c."invoice_text_en", v.invoice_text_en) FROM (VALUES
  ('MP25', 'VAT 25%', NULL),
  ('MP12', 'VAT 12%', NULL),
  ('MP6', 'VAT 6%', NULL),
  ('MF', 'VAT exempt', 'VAT-exempt supply'),
  ('EUV', 'Goods to another EU country', 'Intra-Community supply (Article 138 of the VAT Directive)'),
  ('EUT', 'Services to another EU country', 'Reverse charge (Article 196 of the VAT Directive)'),
  ('EXV', 'Export of goods', 'Export of goods, exempt from VAT (Article 146 of the VAT Directive)'),
  ('EXT', 'Services outside the EU', 'Service supplied outside Sweden'),
  ('OB', 'Reverse charge, Sweden', 'Reverse charge'),
  ('UTM', 'Outside the scope of VAT', NULL),
  ('IEUV25', 'Purchase of goods from the EU 25%', NULL),
  ('IEUV12', 'Purchase of goods from the EU 12%', NULL),
  ('IEUV6', 'Purchase of goods from the EU 6%', NULL),
  ('IEUT', 'Purchase of services from the EU 25%', NULL),
  ('IUTT', 'Purchase of services outside the EU 25%', NULL),
  ('IOBV', 'Purchase of goods in Sweden, reverse charge', NULL),
  ('IOBT', 'Purchase of services in Sweden, reverse charge', NULL),
  ('IUTV', 'Purchase of goods outside the EU (import VAT separate)', NULL),
  ('IMP25', 'Import VAT 25%', NULL),
  ('IMP12', 'Import VAT 12%', NULL),
  ('IMP6', 'Import VAT 6%', NULL)
) AS v(code, name_en, invoice_text_en) WHERE c."code" = v.code AND (c."name_en" IS NULL OR c."invoice_text_en" IS NULL);
-- document-language-backfill:end
