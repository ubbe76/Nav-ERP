import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, invoices, systemSettings } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import {
  PeriodicSummaryEmptyError,
  PeriodicSummaryNoValidRowsError,
  PeriodicSummaryReporterIncompleteError,
  createPeriodicSummaryService,
} from "../src/modules/economy/service/periodic-summary.service.js";
import { PeriodicSummaryPeriodInvalidError } from "../src/modules/economy/service/periodic-summary.js";
import {
  VAT_CONTACT_EMAIL_KEY,
  VAT_CONTACT_NAME_KEY,
  VAT_CONTACT_PHONE_KEY,
  VAT_REPORTING_PERIOD_KEY,
  writeVatReportingSettings,
} from "../src/modules/system/service/vat-reporting-settings.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { resetVatCodes, vatCodeId } from "./helpers/vat-codes.js";

// Periodisk sammanställning (Momskoder steg 3) against Postgres: which
// invoices count (issued and paid invoices and credit notes in the range,
// never drafts or cancelled drafts), the buyer's number per invoice snapshot
// (missing ⇒ warning, older unprefixed numbers get the customer's prefix,
// one row per number), and the reconciliation against the booked ruta 35/39.
// Invoices are issued through the real service, so their verifications are
// what the ledger side reads.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
const freightReader = { freightArticleId: async () => null };
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository,
  undefined,
  undefined,
  undefined,
  undefined,
  freightReader
);
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  documentPdfService,
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  auditRepository,
  articleService,
  freightReader
);

let companyVatNumber: string | null = "SE556000016701";
const service = createPeriodicSummaryService({ db, company: { vatNumber: async () => companyVatNumber } });

const SETTING_KEYS = [VAT_REPORTING_PERIOD_KEY, VAT_CONTACT_NAME_KEY, VAT_CONTACT_PHONE_KEY, VAT_CONTACT_EMAIL_KEY];
const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_documents, invoice_rows, invoices, audit_log, sales_order_rows, sales_orders, customers, payment_terms, articles, users CASCADE`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  await resetVatCodes();
  await setupPostingBaseline();
  companyVatNumber = "SE556000016701";
  user = await authRepo.create({
    email: `ps-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonom",
    role: "admin",
  });
});

afterAll(async () => {
  await db.execute(TABLES);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  await resetVatCodes();
});

// The issue date is the server's today (invoiceService.issue), so the
// summaries below cover the current month/quarter.
const TODAY = new Date().toLocaleDateString("sv-SE");
const YEAR = Number(TODAY.slice(0, 4));
const MONTH = Number(TODAY.slice(5, 7));
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
const THIS_MONTH = { from: `${YEAR}-${pad(MONTH)}-01`, to: lastDay(YEAR, MONTH) };
const QUARTER_START = MONTH - ((MONTH - 1) % 3);
const THIS_QUARTER = { from: `${YEAR}-${pad(QUARTER_START)}-01`, to: lastDay(YEAR, QUARTER_START + 2) };
const PREV = MONTH === 1 ? { year: YEAR - 1, month: 12 } : { year: YEAR, month: MONTH - 1 };
const PREV_MONTH = { from: `${PREV.year}-${pad(PREV.month)}-01`, to: lastDay(PREV.year, PREV.month) };
const YYMM = `${String(YEAR % 100).padStart(2, "0")}${pad(MONTH)}`;

type CustomerOverrides = Partial<Parameters<typeof salesService.createCustomer>[0]>;
async function makeCustomer(overrides: CustomerOverrides = {}) {
  return salesService.createCustomer({
    name: "Kunde GmbH",
    active: true,
    country: "DE",
    vatNumber: "DE123456789",
    discountPercent: 0,
    collectiveInvoicing: false,
    privatePerson: false,
    reverseChargeConstruction: false,
    showConfigurationPrices: false,
    invoiceDelivery: "email",
    ...overrides,
  } as Parameters<typeof salesService.createCustomer>[0]);
}

type RowInput = { description: string; quantity: number; unitPrice: number; vatCodeId?: string };

async function draftInvoice(customerId: string, rows: RowInput[]) {
  const invoice = await invoiceService.create({ customerId, rows }, user.id);
  return invoice!;
}

async function issuedInvoice(customerId: string, rows: RowInput[]) {
  const draft = await draftInvoice(customerId, rows);
  const issued = await invoiceService.issue(draft.id, user.id);
  return { id: issued!.id, invoiceNumber: issued!.invoiceNumber! };
}

// A manual verification crediting a revenue account — what the ledger side
// sees but the invoices do not.
async function bookManualSale(revenueAccount: string, amount: number) {
  const series = await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
  const account = async (number: string) => (await testEconomyRepository.findAccountByNumber(number))!.id;
  const draft = await testEconomyService.createVerification(
    {
      seriesId: series.id,
      date: TODAY,
      description: "Manuell EU-försäljning",
      rows: [
        { accountId: await account("1510"), debit: amount, credit: 0 },
        { accountId: await account(revenueAccount), debit: 0, credit: amount },
      ],
    },
    user.id
  );
  await testEconomyService.book(draft.id, user.id);
}

describe("GET summary — which invoices count", () => {
  it("counts issued and paid invoices and credit notes in the period, never drafts or cancelled drafts", async () => {
    const de = await makeCustomer();
    const EUT = await vatCodeId("EUT");
    const EUV = await vatCodeId("EUV");
    const i1 = await issuedInvoice(de.id, [
      // A free row of an EU customer with a VAT number is goods (EUV).
      { description: "Bänkskiva", quantity: 2, unitPrice: 1000.25 },
      { description: "Montage", quantity: 1, unitPrice: 500, vatCodeId: EUT },
      // A Swedish row on the same invoice is not EU sales.
      { description: "Svensk rad", quantity: 1, unitPrice: 300, vatCodeId: await vatCodeId("MP25") },
    ]);
    const i4 = await issuedInvoice(de.id, [{ description: "Diskho", quantity: 1, unitPrice: 100 }]);
    await db.update(invoices).set({ status: "paid", paidAt: new Date() }).where(eq(invoices.id, i4.id));
    const credit = await invoiceService.createCredit(
      i1.id,
      { rows: [{ description: "Retur", quantity: 1, unitPrice: 1000.25, vatCodeId: EUV }] },
      user.id
    );
    const c1 = await invoiceService.issue(credit!.id, user.id);

    // Not counted: a draft, a cancelled draft and a credit-note draft.
    await draftInvoice(de.id, [{ description: "Utkast", quantity: 1, unitPrice: 300 }]);
    const cancelled = await draftInvoice(de.id, [{ description: "Makulerad", quantity: 1, unitPrice: 400 }]);
    await invoiceService.cancel(cancelled.id, user.id);
    await invoiceService.createCredit(i4.id, {}, user.id);

    const summary = await service.getSummary(THIS_MONTH);
    expect(summary.kind).toBe("month");
    expect(summary.periodCode).toBe(YYMM);
    expect(summary.rows).toEqual([
      {
        vatNumber: "DE123456789",
        customers: [{ id: de.id, name: "Kunde GmbH" }],
        // 2000.50 + 100 − 1000.25 = 1100.25
        goods: 1100,
        triangular: null,
        services: 500,
        invoices: [
          { id: i1.id, invoiceNumber: i1.invoiceNumber },
          { id: i4.id, invoiceNumber: i4.invoiceNumber },
          { id: c1!.id, invoiceNumber: c1!.invoiceNumber },
        ].sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber)),
      },
    ]);
    expect(summary.totals).toEqual({ goods: 1100, services: 500 });
    // The issued invoices booked 3108 (ruta 35) and 3308 (ruta 39).
    expect(summary.ledger).toEqual({ box35: 1100, box39: 500 });
    expect(summary.differences).toEqual({ goods: 0, services: 0 });
    expect(summary.warnings).toEqual([]);

    // The calendar quarter around it sees the same invoices.
    const quarter = await service.getSummary(THIS_QUARTER);
    expect(quarter.kind).toBe("quarter");
    expect(quarter.periodCode).toBe(`${String(YEAR % 100).padStart(2, "0")}-${(QUARTER_START - 1) / 3 + 1}`);
    expect(quarter.rows.map((row) => [row.vatNumber, row.goods, row.services])).toEqual([["DE123456789", 1100, 500]]);
  });

  it("selects on the invoice date", async () => {
    const de = await makeCustomer();
    const invoice = await issuedInvoice(de.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 700 }]);
    await db.update(invoices).set({ invoiceDate: PREV_MONTH.from }).where(eq(invoices.id, invoice.id));

    expect((await service.getSummary(THIS_MONTH)).rows).toEqual([]);
    const previous = await service.getSummary(PREV_MONTH);
    expect(previous.rows.map((row) => [row.vatNumber, row.goods])).toEqual([["DE123456789", 700]]);
  });

  it("refuses a range that is not a calendar month or quarter", async () => {
    await expect(service.getSummary({ from: `${YEAR}-01-01`, to: `${YEAR}-12-31` })).rejects.toBeInstanceOf(
      PeriodicSummaryPeriodInvalidError
    );
    await expect(service.getFile({ from: `${YEAR}-01-02`, to: `${YEAR}-01-31` })).rejects.toBeInstanceOf(
      PeriodicSummaryPeriodInvalidError
    );
  });
});

describe("GET summary — the buyer's number", () => {
  it("warns about a missing number, prefixes older numbers and lists each number once", async () => {
    const EUT = await vatCodeId("EUT");
    const fr = await makeCustomer({ name: "Client SARL", country: "FR", vatNumber: "FR12345678901" });
    const frInvoice = await issuedInvoice(fr.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 400 }]);
    // Invoices from before Utfärda required the number: none at all, and
    // numbers without the country prefix.
    await db.update(invoices).set({ vatNumber: null }).where(eq(invoices.id, frInvoice.id));
    const at = await makeCustomer({ name: "Österreich GmbH", country: "AT", vatNumber: "ATU12345678" });
    const atInvoice = await issuedInvoice(at.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 200 }]);
    await db.update(invoices).set({ vatNumber: "U12345678" }).where(eq(invoices.id, atInvoice.id));
    const gr = await makeCustomer({ name: "Hellas AE", country: "GR", vatNumber: "EL123456789" });
    const grInvoice = await issuedInvoice(gr.id, [{ description: "Montage", quantity: 1, unitPrice: 300, vatCodeId: EUT }]);
    await db.update(invoices).set({ vatNumber: "123456789" }).where(eq(invoices.id, grInvoice.id));
    // Two customers with the same number, written differently.
    const alfa = await makeCustomer({ name: "Alfa GmbH", vatNumber: "de 999.999.999" });
    const beta = await makeCustomer({ name: "Beta GmbH", vatNumber: "DE999999999" });
    const alfaInvoice = await issuedInvoice(alfa.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }]);
    const betaInvoice = await issuedInvoice(beta.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }]);

    const summary = await service.getSummary(THIS_MONTH);
    expect(summary.rows.map((row) => [row.vatNumber, row.goods, row.services])).toEqual([
      ["ATU12345678", 200, 0],
      ["DE999999999", 200, 0],
      ["EL123456789", 0, 300],
    ]);
    const merged = summary.rows[1]!;
    expect(merged.customers).toEqual([
      { id: alfa.id, name: "Alfa GmbH" },
      { id: beta.id, name: "Beta GmbH" },
    ]);
    expect(merged.invoices.map((ref) => ref.id).sort()).toEqual([alfaInvoice.id, betaInvoice.id].sort());

    // The invoice without a number stays out — and the ledger, which booked
    // it on 3108, differs by its amount.
    expect(summary.totals).toEqual({ goods: 400, services: 300 });
    expect(summary.ledger).toEqual({ box35: 800, box39: 300 });
    expect(summary.differences).toEqual({ goods: -400, services: 0 });
    expect(summary.warnings.map((warning) => [warning.kind, warning.invoices])).toEqual([
      ["missing_vat_number", [{ id: frInvoice.id, invoiceNumber: frInvoice.invoiceNumber }]],
      ["ledger_difference", []],
    ]);
    expect(summary.warnings[0]!.message).toContain("Client SARL");
    expect(summary.warnings[1]!.message).toContain("ruta 35");
  });
});

describe("GET summary — reconciliation against ruta 35 and 39", () => {
  it("warns when a manual verification moved ruta 39 beside the invoices", async () => {
    const de = await makeCustomer();
    await issuedInvoice(de.id, [{ description: "Service", quantity: 1, unitPrice: 1000, vatCodeId: await vatCodeId("EUT") }]);
    const before = await service.getSummary(THIS_MONTH);
    expect(before.ledger).toEqual({ box35: 0, box39: 1000 });
    expect(before.differences).toEqual({ goods: 0, services: 0 });

    await bookManualSale("3308", 200.5);
    const after = await service.getSummary(THIS_MONTH);
    // 1200.50 rounds half away from zero.
    expect(after.ledger).toEqual({ box35: 0, box39: 1201 });
    // The exact öre difference, in kronor.
    expect(after.differences).toEqual({ goods: 0, services: -200.5 });
    expect(after.warnings).toEqual([
      {
        kind: "ledger_difference",
        message:
          "Tjänster: sammanställningen 1 000,00 kr, bokfört i ruta 39 1 200,50 kr (skillnad -200,50 kr) — typiskt ett manuellt verifikat eller en faktura med fel momskod",
        invoices: [],
      },
    ]);
  });

  it("compares öre: per-row rounding invents no difference, and a few öre beside the invoices are not hidden", async () => {
    await issuedInvoice((await makeCustomer()).id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 0.5 }]);
    await issuedInvoice((await makeCustomer({ name: "Andra GmbH", vatNumber: "DE987654321" })).id, [
      { description: "Bänkskiva", quantity: 1, unitPrice: 0.5 },
    ]);
    const rounded = await service.getSummary(THIS_MONTH);
    // Each row rounds 0.50 up to 1 kr (2 kr in all), the booked 1.00 kr is
    // 1 kr — the öre agree, so nothing to warn about.
    expect(rounded.totals).toEqual({ goods: 2, services: 0 });
    expect(rounded.ledger).toEqual({ box35: 1, box39: 0 });
    expect(rounded.differences).toEqual({ goods: 0, services: 0 });
    expect(rounded.warnings).toEqual([]);

    // 30 öre booked by hand on 3108: rounds away in whole kronor, but is a
    // real difference.
    await bookManualSale("3108", 0.3);
    const after = await service.getSummary(THIS_MONTH);
    expect(after.ledger).toEqual({ box35: 1, box39: 0 });
    expect(after.differences).toEqual({ goods: -0.3, services: 0 });
    expect(after.warnings.map((warning) => warning.message)).toEqual([
      "Varor: sammanställningen 1,00 kr, bokfört i ruta 35 1,30 kr (skillnad -0,30 kr) — typiskt ett manuellt verifikat eller en faktura med fel momskod",
    ]);
  });
});

describe("the reporter and the file", () => {
  async function setContact() {
    await writeVatReportingSettings(db, { contactName: "Per Persson", contactPhone: "08-123 456", contactEmail: "ps@example.com" });
  }

  it("writes Skatteverket's file for the period's rows", async () => {
    await setContact();
    const de = await makeCustomer();
    await issuedInvoice(de.id, [
      { description: "Bänkskiva", quantity: 1, unitPrice: 1000 },
      { description: "Montage", quantity: 1, unitPrice: 250.5, vatCodeId: await vatCodeId("EUT") },
    ]);
    const fi = await makeCustomer({ name: "Oy Ab", country: "FI", vatNumber: "FI01409351" });
    await issuedInvoice(fi.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 16400 }]);

    const summary = await service.getSummary(THIS_MONTH);
    expect(summary.reporter).toEqual({
      vatNumber: "SE556000016701",
      contactName: "Per Persson",
      contactPhone: "08-123 456",
      contactEmail: "ps@example.com",
    });
    expect(summary.missing).toEqual([]);

    const { filename, content } = await service.getFile(THIS_MONTH);
    expect(filename).toBe(`PeriodiskSammanstallning${YYMM}.txt`);
    expect(content.toString("latin1")).toBe(
      [
        "SKV574008;",
        `556000016701;${YYMM};Per Persson;08-123456;ps@example.com`,
        "DE123456789;1000;;251;",
        "FI01409351;16400;;;",
        "",
      ].join("\r\n")
    );
  });

  it("lists what the file is missing, and refuses the file until it is there", async () => {
    companyVatNumber = null;
    await writeVatReportingSettings(db, { contactName: "Per Persson", contactPhone: "08/123456" });
    const de = await makeCustomer();
    await issuedInvoice(de.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }]);

    const summary = await service.getSummary(THIS_MONTH);
    expect(summary.reporter).toEqual({ vatNumber: null, contactName: "Per Persson", contactPhone: "08/123456", contactEmail: null });
    expect(summary.missing).toEqual(["vatNumber", "contactPhone"]);
    const err = await service.getFile(THIS_MONTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodicSummaryReporterIncompleteError);
    expect((err as PeriodicSummaryReporterIncompleteError).missing).toEqual(["vatNumber", "contactPhone"]);

    companyVatNumber = "SE5560000167";
    await writeVatReportingSettings(db, { contactName: null, contactPhone: "08-123456" });
    expect((await service.getSummary(THIS_MONTH)).missing).toEqual(["vatNumber", "contactName"]);
  });

  it("refuses a file when there is no EU sales in the period", async () => {
    await setContact();
    const se = await makeCustomer({ name: "Svensk AB", country: "SE", vatNumber: "SE556677889901" });
    await issuedInvoice(se.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }]);
    expect((await service.getSummary(THIS_MONTH)).rows).toEqual([]);
    await expect(service.getFile(THIS_MONTH)).rejects.toBeInstanceOf(PeriodicSummaryEmptyError);
  });

  it("refuses a file with its own error when there are EU sales but none with a valid buyer number", async () => {
    await setContact();
    const de = await makeCustomer();
    const invoice = await issuedInvoice(de.id, [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }]);
    // An invoice from before Utfärda required the number.
    await db.update(invoices).set({ vatNumber: null }).where(eq(invoices.id, invoice.id));
    const summary = await service.getSummary(THIS_MONTH);
    expect(summary.rows).toEqual([]);
    expect(summary.warnings.map((warning) => warning.kind)).toEqual(["missing_vat_number", "ledger_difference"]);
    const err = await service.getFile(THIS_MONTH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodicSummaryNoValidRowsError);
    expect((err as Error).message).toBe("Alla EU-fakturor i perioden saknar giltigt momsnummer — rätta kunderna");
  });
});
