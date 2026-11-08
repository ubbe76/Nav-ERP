import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, customers, db, deliveryTerms, suppliers, units, vatCodes } from "@navet/db";
import { VAT_CODE_CATALOG, createArticleSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createQualityRepository } from "../src/modules/quality/repository/quality.repository.js";
import { createQualityService } from "../src/modules/quality/service/quality.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { COMBITERMS, createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { resetVatCodes } from "./helpers/vat-codes.js";
import { parsed } from "./helpers/parsed.js";

// Dokument på engelska (#7), the data model: the language on customers and
// suppliers, the English texts on articles, the terms, the units and the
// VAT codes, the seeding/backfill of migration 0175 and the detail GETs'
// language fields. The invoice stamp lives in customer-invoice.service.test.ts,
// the imports in import-customers/suppliers/articles.test.ts. All data made up.

const registerService = createRegisterService(createRegisterRepository(db));
const articleService = createArticleService(createArticleRepository(db));
const salesRepo = createSalesRepository(db);
const purchaseRepo = createPurchaseRepository(db);
const mail = createMailService(createMailRepository(db), testSystemService, () => ({ sendMail: async () => {} }));
const quality = createQualityService({ repo: createQualityRepository(db), pdf: testDocumentPdfService, mail });

const TRUNCATE = sql`TRUNCATE deviations, customers, suppliers, bom_components, stock_transactions, articles, delivery_terms, payment_terms, units CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
});

// drizzle wraps the Postgres error (DrizzleQueryError, the CHECK name in
// `cause`) — match either message.
function violates(constraint: string) {
  return (error: unknown) => {
    const err = error as { message?: string; cause?: { message?: string } };
    return new RegExp(constraint).test(`${err.message ?? ""} ${err.cause?.message ?? ""}`);
  };
}

async function stUnit() {
  await registerService.units.create({ code: "st", name: "Styck", codeEn: "pcs" });
  return (await registerService.units.list())[0]!;
}

describe("customers and suppliers — language", () => {
  it("defaults to sv, round-trips en and refuses another language at the database", async () => {
    const swedish = await salesRepo.createCustomer({ name: "Kund AB", active: true, country: "SE", currency: "SEK", language: "sv" } as never);
    expect(swedish.language).toBe("sv");
    const english = await salesRepo.createCustomer({ name: "Customer Ltd", active: true, country: "GB", currency: "GBP", language: "en" } as never);
    expect(english.language).toBe("en");
    const back = await salesRepo.updateCustomer(english.id, { language: "sv" });
    expect(back?.language).toBe("sv");
    await expect(db.update(customers).set({ language: "de" }).where(eq(customers.id, english.id))).rejects.toSatisfy(violates("customers_language_valid"));

    const supplier = await purchaseRepo.createSupplier({ name: "Supplier GmbH", active: true, currency: "EUR", country: "DE", language: "en" } as never);
    expect(supplier.language).toBe("en");
    const plain = await purchaseRepo.createSupplier({ name: "Leverantör AB", active: true, currency: "SEK", country: "SE" } as never);
    expect(plain.language).toBe("sv");
    expect((await purchaseRepo.updateSupplier(supplier.id, { language: "sv" }))?.language).toBe("sv");
    await expect(db.update(suppliers).set({ language: "xx" }).where(eq(suppliers.id, supplier.id))).rejects.toSatisfy(violates("suppliers_language_valid"));
  });

  it("the deviation detail carries the counterparty's language (null for an internal case)", async () => {
    const customer = await salesRepo.createCustomer({ name: "Customer Ltd", active: true, country: "GB", currency: "GBP", language: "en" } as never);
    const supplier = await purchaseRepo.createSupplier({ name: "Leverantör AB", active: true, currency: "SEK", country: "SE" } as never);
    const complaint = await quality.create({ type: "customer", title: "Damaged", customerId: customer.id }, null, { seePrices: true });
    const claim = await quality.create({ type: "supplier", title: "Fel antal", supplierId: supplier.id }, null, { seePrices: true });
    const internal = await quality.create({ type: "internal", title: "Sprucken svets" }, null, { seePrices: true });
    expect((await quality.get(complaint.id, { seePrices: true })).counterpartyLanguage).toBe("en");
    expect((await quality.get(claim.id, { seePrices: true })).counterpartyLanguage).toBe("sv");
    expect((await quality.get(internal.id, { seePrices: true })).counterpartyLanguage).toBeNull();
  });
});

describe("articles — Benämning (engelska) and Extra benämning (engelska)", () => {
  it("stores, returns, clears and copies the English texts", async () => {
    const unit = await stUnit();
    const created = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: "SB-1200",
      name: "Diskbänk 1200",
      nameEn: "Sink unit 1200",
      extraDescriptionEn: "Brushed stainless steel",
      type: "manufactured",
      unitId: unit.id,
      active: true,
    }));
    expect(created.nameEn).toBe("Sink unit 1200");
    expect(created.extraDescriptionEn).toBe("Brushed stainless steel");
    expect((await articleService.getArticle(created.id))!.nameEn).toBe("Sink unit 1200");

    // Kopiera från → Information takes both.
    const copy = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: "SB-1200-K",
      name: "Diskbänk 1200 kopia",
      type: "manufactured",
      unitId: unit.id,
      active: true,
      copyFrom: { articleId: created.id, parts: ["information"] },
    }));
    expect([copy.nameEn, copy.extraDescriptionEn]).toEqual(["Sink unit 1200", "Brushed stainless steel"]);

    // null clears (the schema turns "" into null before the service).
    const cleared = await articleService.updateArticle(created.id, { nameEn: null, extraDescriptionEn: null });
    expect([cleared!.nameEn, cleared!.extraDescriptionEn]).toEqual([null, null]);
    const [row] = await db.select({ nameEn: articles.nameEn }).from(articles).where(eq(articles.id, created.id));
    expect(row!.nameEn).toBeNull();

    // Without English texts the columns are null — the Swedish text is printed.
    const plain = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "P-1", name: "Plåt", type: "purchased", unitId: unit.id, active: true }));
    expect([plain.nameEn, plain.extraDescriptionEn]).toEqual([null, null]);
  });
});

describe("registers — nameEn and codeEn", () => {
  it("terms store and update Benämning (engelska), units Kod (engelska); the English name need not be unique", async () => {
    const dap = await registerService.deliveryTerms.create({ code: "DAP", name: "Levererat angiven plats", nameEn: "Delivered at Place" });
    expect(dap.nameEn).toBe("Delivered at Place");
    // Same English name on another code — allowed (only the Swedish name is unique).
    const own = await registerService.deliveryTerms.create({ code: "EGEN", name: "Vår egen", nameEn: "Delivered at Place" });
    expect(own.nameEn).toBe("Delivered at Place");
    const renamed = await registerService.deliveryTerms.update(dap.id, { code: "DAP", name: "Levererat angiven plats", nameEn: null });
    expect(renamed.nameEn).toBeNull();

    const net30 = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto", nameEn: "30 days net" });
    expect(net30.nameEn).toBe("30 days net");
    expect((await registerService.paymentTerms.create({ code: "10", name: "10 dagar netto" })).nameEn).toBeNull();

    const st = await registerService.units.create({ code: "st", name: "Styck", codeEn: "pcs" });
    expect(st.codeEn).toBe("pcs");
    expect((await registerService.units.update(st.id, { code: "st", name: "Styck", codeEn: null })).codeEn).toBeNull();
    // A plain register ignores an English field it has no column for.
    const dhl = await registerService.carriers.create({ code: "DHL", name: "DHL Freight", nameEn: "ignored" } as never);
    expect("nameEn" in dhl).toBe(false);
  });

  it("generate-combiterms fills name_en on the rows it creates and never on existing ones", async () => {
    await registerService.deliveryTerms.create({ code: "EXW", name: "Hämtas hos oss" });
    const result = await registerService.seedCombiterms();
    expect(result).toEqual({ created: 10, skipped: 1 });
    const terms = await registerService.deliveryTerms.list();
    for (const term of COMBITERMS.filter((t) => t.code !== "EXW")) {
      expect(terms.find((t) => t.code === term.code)?.nameEn, term.code).toBe(term.nameEn);
    }
    // The customized EXW keeps its name and gets no English name here — that
    // is the migration backfill's job (below), not the seeding's.
    expect(terms.find((t) => t.code === "EXW")).toMatchObject({ name: "Hämtas hos oss", nameEn: null });
  });

  it("generate-standard fills code_en for st/tim/förp only", async () => {
    await registerService.seedStandardUnits();
    const rows = await registerService.units.list();
    expect(Object.fromEntries(rows.map((u) => [u.code, u.codeEn]))).toEqual({
      st: "pcs",
      tim: "h",
      förp: "pkg",
      kg: null,
      g: null,
      m: null,
      m2: null,
      m3: null,
      l: null,
    });
  });
});

// The backfill SQL is read from the migration file itself (between the
// marker comments) and re-run against fixtures — the same guard as
// vat-box-backfill.test.ts.
const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const migrationFile = readdirSync(MIGRATIONS).find((file) => file.endsWith("_dokument_pa_engelska.sql"));
const backfillStatements = (() => {
  if (!migrationFile) return [];
  const text = readFileSync(join(MIGRATIONS, migrationFile), "utf8");
  const start = text.indexOf("-- document-language-backfill:start");
  const end = text.indexOf("-- document-language-backfill:end");
  if (start < 0 || end <= start) return [];
  return text
    .slice(start, end)
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
})();

async function runBackfill() {
  for (const statement of backfillStatements) await db.execute(sql.raw(statement));
}

describe("migration 0175 — backfill", () => {
  it("has three marked statements", () => {
    expect(migrationFile).toBeDefined();
    expect(backfillStatements).toHaveLength(3);
  });

  it("fills the Combiterms' English names where the code matches and name_en is null — never over a set one", async () => {
    await registerService.deliveryTerms.create({ code: "EXW", name: "Hämtas hos oss" });
    await registerService.deliveryTerms.create({ code: "DAP", name: "Levererat", nameEn: "Our own DAP" });
    await registerService.deliveryTerms.create({ code: "FRITT", name: "Fritt vårt lager" });
    await runBackfill();
    const rows = await db.select({ code: deliveryTerms.code, nameEn: deliveryTerms.nameEn }).from(deliveryTerms);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.nameEn]))).toEqual({ EXW: "Ex Works", DAP: "Our own DAP", FRITT: null });
  });

  it("fills code_en for st/tim/förp and leaves the other units alone", async () => {
    await registerService.units.create({ code: "st", name: "Styck" });
    await registerService.units.create({ code: "tim", name: "Timme", codeEn: "hrs" });
    await registerService.units.create({ code: "förp", name: "Förpackning" });
    await registerService.units.create({ code: "kg", name: "Kilogram" });
    await runBackfill();
    const rows = await db.select({ code: units.code, codeEn: units.codeEn }).from(units);
    expect(Object.fromEntries(rows.map((r) => [r.code, r.codeEn]))).toEqual({ st: "pcs", tim: "hrs", förp: "pkg", kg: null });
  });

  it("fills the VAT codes' English name and invoice text where null; a fresh database already carries them", async () => {
    // The test database is migrated from scratch, so the seeded rows already
    // have the catalog's English texts.
    await resetVatCodes();
    const seeded = await db.select({ code: vatCodes.code, nameEn: vatCodes.nameEn, invoiceTextEn: vatCodes.invoiceTextEn }).from(vatCodes);
    for (const entry of VAT_CODE_CATALOG) {
      expect(seeded.find((r) => r.code === entry.code), entry.code).toEqual({ code: entry.code, nameEn: entry.labelEn, invoiceTextEn: entry.invoiceTextEn });
    }

    // Blank them, keep one company-owned text, re-run: only the nulls fill.
    await db.update(vatCodes).set({ nameEn: null, invoiceTextEn: null });
    await db.update(vatCodes).set({ nameEn: "Our EU goods", invoiceTextEn: null }).where(eq(vatCodes.code, "EUV"));
    await runBackfill();
    const after = await db.select({ code: vatCodes.code, nameEn: vatCodes.nameEn, invoiceTextEn: vatCodes.invoiceTextEn }).from(vatCodes);
    expect(after.find((r) => r.code === "EUV")).toEqual({
      code: "EUV",
      nameEn: "Our EU goods",
      invoiceTextEn: "Intra-Community supply (Article 138 of the VAT Directive)",
    });
    expect(after.find((r) => r.code === "MF")).toEqual({ code: "MF", nameEn: "VAT exempt", invoiceTextEn: "VAT-exempt supply" });
    expect(after.find((r) => r.code === "MP25")).toEqual({ code: "MP25", nameEn: "VAT 25%", invoiceTextEn: null });
  });
});
