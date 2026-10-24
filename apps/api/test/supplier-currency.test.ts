import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  db,
  purchaseOrders,
  suppliers,
  supplierInvoices,
  supplierPaymentRows,
  supplierPayments,
  verificationRows,
} from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import {
  createSupplierInvoiceService,
  SupplierInvoiceExchangeRateError,
  SupplierInvoiceExchangeRateMissingError,
} from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createSupplierPaymentRepository } from "../src/modules/purchase/repository/supplier-payment.repository.js";
import {
  createSupplierPaymentService,
  PaymentMixedCurrenciesError,
  SupplierPaymentAmountSekError,
} from "../src/modules/purchase/service/supplier-payment.service.js";
import { payablesTotalAsOf } from "../src/modules/purchase/repository/open-amounts.js";
import {
  ExchangeRateUnavailableError,
  type ExchangeRateLookup,
  type ExchangeRateReader,
} from "../src/modules/system/service/exchange-rates.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testSystemService } from "./helpers/services.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// Valuta steg 1: leverantörsfaktura och leverantörsbetalning i annan valuta
// än SEK, end to end on the real poster and the real posting settings. The
// rate lookup is a stub — the Riksbanken client has its own suite.

const TODAY = new Date().toLocaleDateString("sv-SE");
const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));

// What the stub answers per currency; absent = unavailable.
const stubRates = new Map<string, Omit<ExchangeRateLookup, "currency" | "requestedDate">>();
const lookups: { currency: string; date: string }[] = [];
const rates: ExchangeRateReader = {
  async getRate(currency, date) {
    lookups.push({ currency, date });
    const found = stubRates.get(currency);
    if (!found) throw new ExchangeRateUnavailableError(currency, date);
    return { currency, requestedDate: date, ...found };
  },
};

const authRepo = createAuthRepository(db);
const poster = createVerificationPoster({ read: readPostingSettings });
const invoices = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster, undefined, rates);
const payments = createSupplierPaymentService(createSupplierPaymentRepository(db), poster);

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_payment_rows, supplier_payments, supplier_invoice_rows, supplier_invoices, purchase_order_rows, purchase_orders, suppliers, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5 });
  stubRates.clear();
  lookups.length = 0;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5 });
});

async function makeUser() {
  return authRepo.create({ email: `fx-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Valuta", role: "admin" });
}

async function makeSupplier(currency: string, name = `Lev ${currency}`) {
  const [row] = await db
    .insert(suppliers)
    .values({ name, supplierNumber: `FX-${crypto.randomUUID()}`, currency, country: currency === "SEK" ? "SE" : "DE", active: true })
    .returning();
  return row!;
}

async function verificationRowsOf(verificationId: string) {
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(verificationRows.createdAt));
  const byAccount: Record<string, { debit: number; credit: number }> = {};
  for (const row of rows) byAccount[row.number] = { debit: Number(row.debit), credit: Number(row.credit) };
  return byAccount;
}

async function attestedEurInvoice(userId: string, supplierId: string, grossAmount: number, exchangeRate: number, invoiceNumber = `E-${crypto.randomUUID()}`) {
  const created = await invoices.create(
    { supplierId, invoiceNumber, invoiceDate: TODAY, netAmount: grossAmount, vatAmount: 0, grossAmount, exchangeRate, vatCodeId: await vatCodeId("IEUV25"), rows: [] },
    userId
  );
  return (await invoices.approve(created!.id, userId))!;
}

async function ledgerBalance(number: string) {
  const [row] = await db.execute<{ balance: string }>(sql`
    SELECT COALESCE(SUM(vr.debit - vr.credit), 0) AS balance
    FROM verification_rows vr JOIN accounts a ON a.id = vr.account_id JOIN verifications v ON v.id = vr.verification_id
    WHERE a.number = ${number} AND v.status = 'booked'
  `);
  return Math.round(Number(row!.balance) * 100) / 100;
}

describe("leverantörsfaktura i valuta — kursen", () => {
  it("looks the rate up for the invoice date (Riksbanken ⇒ riksbank, a manual rate ⇒ register)", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    stubRates.set("EUR", { date: "2026-10-23", rate: 11.131, source: "riksbank" });
    const fromRiksbank = await invoices.create({ supplierId: eur.id, invoiceNumber: "R-1", invoiceDate: TODAY, grossAmount: 100, netAmount: 100, vatAmount: 0, rows: [] }, user.id);
    expect(fromRiksbank).toMatchObject({ currency: "EUR", exchangeRate: "11.131000", exchangeRateSource: "riksbank", exchangeRateDate: "2026-10-23", grossAmountSek: null });
    expect(fromRiksbank!.sekAmounts).toEqual({ grossAmount: 1113.1, vatAmount: 0, netAmount: 1113.1 });
    expect(lookups).toEqual([{ currency: "EUR", date: TODAY }]);

    stubRates.set("EUR", { date: "2026-10-22", rate: 11.2, source: "manual" });
    const fromRegister = await invoices.create({ supplierId: eur.id, invoiceNumber: "R-2", invoiceDate: TODAY, rows: [] }, user.id);
    expect(fromRegister).toMatchObject({ exchangeRate: "11.200000", exchangeRateSource: "register", exchangeRateDate: "2026-10-22" });
  });

  it("takes a typed rate as manual, and falls back to the linked purchase order's rate when none can be looked up", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const typed = await invoices.create({ supplierId: eur.id, invoiceNumber: "T-1", invoiceDate: TODAY, exchangeRate: 11.05, rows: [] }, user.id);
    expect(typed).toMatchObject({ exchangeRate: "11.050000", exchangeRateSource: "manual", exchangeRateDate: null });
    expect(lookups).toEqual([]);

    const [order] = await db
      .insert(purchaseOrders)
      .values({ orderNumber: `IO-FX-${crypto.randomUUID().slice(0, 8)}`, supplierId: eur.id, currency: "EUR", exchangeRate: "11.4" })
      .returning();
    const fromOrder = await invoices.create({ supplierId: eur.id, invoiceNumber: "T-2", invoiceDate: TODAY, purchaseOrderId: order!.id, rows: [] }, user.id);
    expect(fromOrder).toMatchObject({ exchangeRate: "11.400000", exchangeRateSource: "purchase_order" });

    // No lookup, no order: 409 exchange-rate-unavailable, nothing created.
    await expect(invoices.create({ supplierId: eur.id, invoiceNumber: "T-3", invoiceDate: TODAY, rows: [] }, user.id)).rejects.toBeInstanceOf(
      ExchangeRateUnavailableError
    );
  });

  it("keeps SEK at 1 without a lookup and refuses another rate on a SEK invoice", async () => {
    const user = await makeUser();
    const sek = await makeSupplier("SEK");
    const invoice = await invoices.create({ supplierId: sek.id, invoiceNumber: "S-1", invoiceDate: TODAY, exchangeRate: 1, rows: [] }, user.id);
    expect(invoice).toMatchObject({ currency: "SEK", exchangeRate: "1.000000", exchangeRateSource: null, exchangeRateMissing: false });
    await expect(invoices.create({ supplierId: sek.id, invoiceNumber: "S-2", invoiceDate: TODAY, exchangeRate: 2, rows: [] }, user.id)).rejects.toBeInstanceOf(
      SupplierInvoiceExchangeRateError
    );
    expect(lookups).toEqual([]);
  });

  it("looks the rate up again on a new invoice date — unless it was typed — and on a supplier change to another currency", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const sek = await makeSupplier("SEK");
    stubRates.set("EUR", { date: "2026-10-23", rate: 11.131, source: "riksbank" });
    const invoice = await invoices.create({ supplierId: eur.id, invoiceNumber: "P-1", invoiceDate: "2026-10-24", rows: [] }, user.id);

    stubRates.set("EUR", { date: "2026-10-20", rate: 11.123, source: "riksbank" });
    const redated = await invoices.updateHeader(invoice!.id, { invoiceDate: "2026-10-20" }, user.id);
    expect(redated).toMatchObject({ exchangeRate: "11.123000", exchangeRateSource: "riksbank", exchangeRateDate: "2026-10-20" });

    const typed = await invoices.updateHeader(invoice!.id, { exchangeRate: 11.3 }, user.id);
    expect(typed).toMatchObject({ exchangeRate: "11.300000", exchangeRateSource: "manual", exchangeRateDate: null });
    const keptTyped = await invoices.updateHeader(invoice!.id, { invoiceDate: "2026-10-21" }, user.id);
    expect(keptTyped).toMatchObject({ exchangeRate: "11.300000", exchangeRateSource: "manual" });

    const toSek = await invoices.updateHeader(invoice!.id, { supplierId: sek.id }, user.id);
    expect(toSek).toMatchObject({ currency: "SEK", exchangeRate: "1.000000", exchangeRateSource: null });
    const backToEur = await invoices.updateHeader(invoice!.id, { supplierId: eur.id }, user.id);
    expect(backToEur).toMatchObject({ currency: "EUR", exchangeRate: "11.123000", exchangeRateSource: "riksbank" });
  });

  // The header PATCH's contract (webben bygger mot den): a number is typed
  // (manual), null is the automatic rate again, and left out the rate is
  // looked up whenever it is missing — an automatic lookup that finds
  // nothing leaves "kurs saknas" instead of failing the edit.
  it("PATCH exchangeRate: null goes back to the automatic rate — or to kurs saknas without an error", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const audited: { action: string; detail: unknown }[] = [];
    const service = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster, { log: async (e) => void audited.push(e as never) }, rates);
    const invoice = await service.create({ supplierId: eur.id, invoiceNumber: "N-1", invoiceDate: TODAY, exchangeRate: 11.3, rows: [] }, user.id);
    expect(invoice).toMatchObject({ exchangeRate: "11.300000", exchangeRateSource: "manual" });

    stubRates.set("EUR", { date: "2026-10-23", rate: 11.131, source: "riksbank" });
    const automatic = await service.updateHeader(invoice!.id, { exchangeRate: null }, user.id);
    expect(automatic).toMatchObject({ exchangeRate: "11.131000", exchangeRateSource: "riksbank", exchangeRateDate: "2026-10-23", exchangeRateMissing: false });
    expect(audited.map((e) => e.action)).toEqual(["created", "exchange_rate_changed"]);
    expect(audited[1]!.detail).toMatchObject({
      before: { exchangeRate: "11.300000", exchangeRateSource: "manual" },
      after: { exchangeRate: "11.131", exchangeRateSource: "riksbank" },
    });

    // A new date with no rate to be had: kurs saknas, the edit goes through.
    stubRates.clear();
    const redated = await service.updateHeader(invoice!.id, { invoiceDate: "2026-10-20" }, user.id);
    expect(redated).toMatchObject({ invoiceDate: "2026-10-20", exchangeRateSource: null, exchangeRateDate: null, exchangeRateMissing: true });
    await expect(service.approve(invoice!.id, user.id)).rejects.toBeInstanceOf(SupplierInvoiceExchangeRateMissingError);

    // Missing, any field: looked up again — still nothing, still no error …
    const noted = await service.updateHeader(invoice!.id, { note: "Väntar på kurs" }, user.id);
    expect(noted).toMatchObject({ note: "Väntar på kurs", exchangeRateMissing: true });
    // … and found once a rate exists.
    stubRates.set("EUR", { date: "2026-10-20", rate: 11.05, source: "manual" });
    const found = await service.updateHeader(invoice!.id, { note: null }, user.id);
    expect(found).toMatchObject({ exchangeRate: "11.050000", exchangeRateSource: "register", exchangeRateDate: "2026-10-20", exchangeRateMissing: false });
    expect(lookups.at(-1)).toEqual({ currency: "EUR", date: "2026-10-20" });

    // null with nothing to look up: kurs saknas, no error.
    stubRates.clear();
    const cleared = await service.updateHeader(invoice!.id, { exchangeRate: null }, user.id);
    expect(cleared).toMatchObject({ exchangeRateSource: null, exchangeRateMissing: true });
    // A typed rate after that is manual again and attestable.
    const typed = await service.updateHeader(invoice!.id, { exchangeRate: 11.2 }, user.id);
    expect(typed).toMatchObject({ exchangeRate: "11.200000", exchangeRateSource: "manual", exchangeRateMissing: false });
  });

  // Migration 0143: a foreign draft saved before the feature (the manual said
  // "registrera fakturan i SEK") keeps kurs saknas — even with a linked
  // purchase order in the currency — and cannot be attested until a rate is
  // entered.
  it("0143 leaves an old foreign draft without a rate, whatever its purchase order says", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const [order] = await db
      .insert(purchaseOrders)
      .values({ orderNumber: `IO-FX-${crypto.randomUUID().slice(0, 8)}`, supplierId: eur.id, currency: "EUR", exchangeRate: "11.4" })
      .returning();
    const draft = await invoices.create(
      { supplierId: eur.id, invoiceNumber: "OLD-1", invoiceDate: TODAY, purchaseOrderId: order!.id, netAmount: 1000, grossAmount: 1000, exchangeRate: 11, rows: [] },
      user.id
    );
    // The state before 0143: rate 1, no source.
    await db.update(supplierInvoices).set({ exchangeRate: "1", exchangeRateSource: null, exchangeRateDate: null }).where(eq(supplierInvoices.id, draft!.id));
    const migration = readFileSync(join(MIGRATIONS, readdirSync(MIGRATIONS).find((file) => file.endsWith("_exchange_rates.sql"))!), "utf8");
    const updates = migration
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
      .filter((statement) => /^UPDATE "supplier_invoices"/.test(statement));
    expect(updates.length).toBeGreaterThan(0);
    for (const statement of updates) await db.execute(sql.raw(statement));

    expect((await invoices.getInvoice(draft!.id))!).toMatchObject({ exchangeRate: "1.000000", exchangeRateSource: null, exchangeRateMissing: true });
    await expect(invoices.approve(draft!.id, user.id)).rejects.toBeInstanceOf(SupplierInvoiceExchangeRateMissingError);
  });

  it("previews omvänd moms on the SEK base and books it so at the attest, stamping gross_amount_sek", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const created = await invoices.create(
      { supplierId: eur.id, invoiceNumber: "O-1", invoiceDate: TODAY, netAmount: 1000, vatAmount: 0, grossAmount: 1000, exchangeRate: 11.131, vatCodeId: await vatCodeId("IEUV25"), rows: [] },
      user.id
    );
    expect(created!.reverseVat).toEqual([{ code: "IEUV25", base: 11131, vat: 2782.75 }]);

    const approved = await invoices.approve(created!.id, user.id);
    expect(approved).toMatchObject({ status: "approved", grossAmountSek: "11131.00", openAmount: 1000, openAmountSek: 11131 });
    expect(await verificationRowsOf(approved!.verificationId!)).toEqual({
      "2440": { debit: 0, credit: 11131 },
      "4515": { debit: 11131, credit: 0 },
      "2614": { debit: 0, credit: 2782.75 },
      "2645": { debit: 2782.75, credit: 0 },
    });
  });
});

describe("leverantörsbetalning i valuta", () => {
  it("books a kursförlust and the bank fee, releases the whole SEK debt and pays the invoice", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const invoice = await attestedEurInvoice(user.id, eur.id, 1000, 11.131);

    const payment = await payments.create(
      { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1000, amountSek: 11200, bankFeeSek: 50, rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }] },
      user.id
    );
    expect(payment).toMatchObject({ currency: "EUR", amount: "1000.00", amountSek: "11200.00", bankFeeSek: "50.00", exchangeRateDifferenceSek: -19 });
    expect(payment.rows[0]).toMatchObject({ appliedAmount: "1000.00", appliedAmountSek: "11131.00", writeOffAmountSek: "0.00" });
    expect(await verificationRowsOf(payment.verificationId!)).toEqual({
      "1930": { debit: 0, credit: 11200 },
      "2440": { debit: 11131, credit: 0 },
      "6570": { debit: 50, credit: 0 },
      "7960": { debit: 19, credit: 0 },
    });
    expect((await invoices.getInvoice(invoice.id))!).toMatchObject({ status: "paid", openAmount: 0, openAmountSek: 0 });
    expect(await ledgerBalance("2440")).toBe(0);
  });

  it("books a kursvinst when less SEK left the bank", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const invoice = await attestedEurInvoice(user.id, eur.id, 1000, 11.131);
    const payment = await payments.create(
      { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1000, amountSek: 11000, rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }] },
      user.id
    );
    expect(payment.exchangeRateDifferenceSek).toBe(131);
    expect(await verificationRowsOf(payment.verificationId!)).toEqual({
      "1930": { debit: 0, credit: 11000 },
      "2440": { debit: 11131, credit: 0 },
      "3960": { debit: 0, credit: 131 },
    });
  });

  it("releases exactly gross_amount_sek over three partial payments, and the reskontra's SEK sum follows", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    // 300 EUR à 37,103367 = 11 131,01 SEK; three 100 EUR payments would
    // release 3 × 3 710,34 = 11 131,02 proportionally.
    const invoice = await attestedEurInvoice(user.id, eur.id, 300, 37.103367);
    expect(invoice.grossAmountSek).toBe("11131.01");
    expect(await payablesTotalAsOf(db, TODAY)).toBe(11131.01);

    const released: string[] = [];
    for (const amountSek of [3700, 3720, 3711]) {
      const payment = await payments.create(
        { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 100, amountSek, rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 100 }] },
        user.id
      );
      released.push(payment.rows[0]!.appliedAmountSek);
    }
    expect(released).toEqual(["3710.34", "3710.34", "3710.33"]);
    expect((await invoices.getInvoice(invoice.id))!).toMatchObject({ status: "paid", openAmountSek: 0 });
    expect(await payablesTotalAsOf(db, TODAY)).toBe(0);
    // The payable account agrees with the reskontra; the differences sit on 3960/7960.
    expect(await ledgerBalance("2440")).toBe(0);
    expect(await ledgerBalance("1930")).toBe(-11131);
    expect(Math.round((await ledgerBalance("3960")) * 100 + (await ledgerBalance("7960")) * 100) / 100).toBe(-0.01);
  });

  it("writes off within the tolerance worth in the invoice's currency (5 kr ≈ 0,44 EUR)", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const partial = await attestedEurInvoice(user.id, eur.id, 1000, 11.131);
    const first = await payments.create(
      { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 999.5, amountSek: 11125, rows: [{ supplierInvoiceId: partial.id, appliedAmount: 999.5 }] },
      user.id
    );
    expect(first.rows[0]!.writeOffAmount).toBe("0.00");
    expect((await invoices.getInvoice(partial.id))!).toMatchObject({ status: "approved", openAmount: 0.5 });

    const closing = await attestedEurInvoice(user.id, eur.id, 1000, 11.131);
    const second = await payments.create(
      { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 999.6, amountSek: 11126.55, rows: [{ supplierInvoiceId: closing.id, appliedAmount: 999.6 }] },
      user.id
    );
    expect(second.rows[0]).toMatchObject({ writeOffAmount: "0.40", appliedAmountSek: "11126.55", writeOffAmountSek: "4.45" });
    expect(await verificationRowsOf(second.verificationId!)).toEqual({
      "1930": { debit: 0, credit: 11126.55 },
      "2440": { debit: 11131, credit: 0 },
      "3740": { debit: 0, credit: 4.45 },
    });
    expect((await invoices.getInvoice(closing.id))!).toMatchObject({ status: "paid" });
  });

  it("makulering books the omföring and reopens the invoice's SEK debt", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const invoice = await attestedEurInvoice(user.id, eur.id, 1000, 11.131);
    const payment = await payments.create(
      { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1000, amountSek: 11200, bankFeeSek: 50, rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 1000 }] },
      user.id
    );
    const cancelled = await payments.cancel(payment.id, user.id);
    expect(cancelled.cancellationVerificationId).not.toBeNull();
    expect(await verificationRowsOf(cancelled.cancellationVerificationId!)).toEqual({
      "1930": { debit: 11200, credit: 0 },
      "2440": { debit: 0, credit: 11131 },
      "6570": { debit: 0, credit: 50 },
      "7960": { debit: 0, credit: 19 },
    });
    expect((await invoices.getInvoice(invoice.id))!).toMatchObject({ status: "approved", openAmount: 1000, openAmountSek: 11131 });
    expect(await payablesTotalAsOf(db, TODAY)).toBe(11131);
    expect(await ledgerBalance("2440")).toBe(-11131);
  });

  it("never mixes currencies on one payment and sums the reskontra in SEK", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const eurInvoice = await attestedEurInvoice(user.id, eur.id, 100, 11.131);
    const sekInvoice = await invoices.create({ supplierId: eur.id, invoiceNumber: "SEK-1", invoiceDate: TODAY, exchangeRate: 11, rows: [] }, user.id);
    // The supplier is EUR; a SEK invoice from it needs a SEK supplier snapshot.
    await db.update(supplierInvoices).set({ currency: "SEK", exchangeRate: "1", exchangeRateSource: null, exchangeRateDate: null, netAmount: "500", grossAmount: "500" }).where(eq(supplierInvoices.id, sekInvoice!.id));
    await invoices.approve(sekInvoice!.id, user.id);

    expect(await payablesTotalAsOf(db, TODAY)).toBe(1113.1 + 500);

    const error = await payments
      .create(
        {
          supplierId: eur.id,
          paymentDate: TODAY,
          bankAccountNumber: "1930",
          amount: 600,
          amountSek: 1600,
          rows: [
            { supplierInvoiceId: eurInvoice.id, appliedAmount: 100 },
            { supplierInvoiceId: sekInvoice!.id, appliedAmount: 500 },
          ],
        },
        user.id
      )
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(PaymentMixedCurrenciesError);
    expect((error as PaymentMixedCurrenciesError).currencies).toEqual(["EUR", "SEK"]);
    expect(await db.select().from(supplierPayments)).toHaveLength(0);
  });

  it("requires the SEK amount on a foreign payment and keeps a SEK payment exactly as before", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const sek = await makeSupplier("SEK");
    const eurInvoice = await attestedEurInvoice(user.id, eur.id, 100, 11.131);
    const reason = async (input: Parameters<typeof payments.create>[0]) =>
      ((await payments.create(input, user.id).catch((err: unknown) => err)) as SupplierPaymentAmountSekError).reason;
    const base = { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 100, rows: [{ supplierInvoiceId: eurInvoice.id, appliedAmount: 100 }] };
    expect(await reason(base)).toBe("required");
    expect(await reason({ ...base, amountSek: -1113 })).toBe("sign");
    expect(await reason({ ...base, amountSek: 1113, bankFeeSek: 2000 })).toBe("fee");

    const sekCreated = await invoices.create({ supplierId: sek.id, invoiceNumber: "K-1", invoiceDate: TODAY, netAmount: 400, vatAmount: 100, grossAmount: 500, rows: [] }, user.id);
    const sekInvoice = await invoices.approve(sekCreated!.id, user.id);
    const sekBase = { supplierId: sek.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 500, rows: [{ supplierInvoiceId: sekInvoice!.id, appliedAmount: 500 }] };
    expect(await reason({ ...sekBase, amountSek: 499 })).toBe("sek");
    expect(await reason({ ...sekBase, bankFeeSek: 10 })).toBe("sek");

    const paid = await payments.create({ ...sekBase, amountSek: 500, bankFeeSek: 0 }, user.id);
    expect(paid).toMatchObject({ currency: "SEK", amount: "500.00", amountSek: "500.00", bankFeeSek: "0.00", exchangeRateDifferenceSek: 0 });
    expect(await verificationRowsOf(paid.verificationId!)).toEqual({
      "1930": { debit: 0, credit: 500 },
      "2440": { debit: 500, credit: 0 },
    });
    const [row] = await db.select().from(supplierPaymentRows).where(eq(supplierPaymentRows.paymentId, paid.id));
    expect(row).toMatchObject({ appliedAmount: "500.00", appliedAmountSek: "500.00", writeOffAmountSek: "0.00" });
  });

  it("lists the open items with currency and SEK values", async () => {
    const user = await makeUser();
    const eur = await makeSupplier("EUR");
    const invoice = await attestedEurInvoice(user.id, eur.id, 1000, 11.131);
    await payments.create(
      { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 400, amountSek: 4400, rows: [{ supplierInvoiceId: invoice.id, appliedAmount: 400 }] },
      user.id
    );
    const open = await payments.listOpenInvoices({ limit: 50, offset: 0, overdueOnly: false });
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0]).toMatchObject({ currency: "EUR", exchangeRate: 11.131, grossAmount: 1000, openAmount: 600, grossAmountSek: 11131, openAmountSek: 6678.6 });

    const list = await invoices.list({ limit: 50, offset: 0 });
    expect(list.rows[0]).toMatchObject({ currency: "EUR", grossSekValue: "11131.00" });
  });
});
