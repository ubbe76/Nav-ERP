import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import {
  accounts,
  articles,
  customerPaymentRows,
  customerPrices,
  customers,
  db,
  invoices,
  priceListRows,
  priceLists,
  salesOrders,
  verificationRows,
  verifications,
} from "@navet/db";
import { fromSek, invoiceSekAmounts, toSek } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService, InvalidStatusTransitionError, SalesOrderNotFoundError } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import {
  PriceListCurrencyLockedError,
  SalesOrderCurrencyLockedError,
  SalesOrderExchangeRateError,
} from "../src/modules/sales/service/sales.errors.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import {
  createInvoiceService,
  InvoiceExchangeRateError,
  InvoiceRowCurrencyMismatchError,
  ReminderFeeCurrencyError,
} from "../src/modules/sales/service/invoice.service.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import {
  createPaymentService,
  CustomerPaymentAmountSekError,
  PaymentMixedCurrenciesError,
} from "../src/modules/sales/service/payment.service.js";
import { receivablesTotalAsOf } from "../src/modules/sales/repository/open-amounts.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import {
  ExchangeRateUnavailableError,
  type ExchangeRateLookup,
  type ExchangeRateReader,
} from "../src/modules/system/service/exchange-rates.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testSystemService } from "./helpers/services.js";
import { pdfText } from "./helpers/pdf.js";

// Valuta steg 3: kunder, prislistor, kundordrar, kundfakturor och
// kundbetalningar i annan valuta än SEK — end to end on the real services,
// the real poster and the real posting settings. The rate lookup is a stub
// (the suite never calls Riksbanken).

const TODAY = new Date().toLocaleDateString("sv-SE");

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
const rate = (currency: string, value: number) => stubRates.set(currency, { date: TODAY, rate: value, source: "riksbank" });

const sentMails: unknown[] = [];
const fakeTransport: MailTransportFactory = () => ({
  async sendMail(opts) {
    sentMails.push(opts);
  },
});

const authRepo = createAuthRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransport);
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
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
  undefined,
  rates
);
const poster = createVerificationPoster({ read: readPostingSettings });
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  documentPdfService,
  poster,
  auditRepository,
  articleService,
  undefined,
  rates
);
const paymentService = createPaymentService(createPaymentRepository(db), poster, auditRepository);

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_documents, invoice_reminders, invoice_rows, invoices, sales_order_rows, sales_orders, customer_prices, price_list_rows, price_lists, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, email_log, audit_log, users CASCADE`;

let userId = "";

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5, reminderFee: 60 });
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
  stubRates.clear();
  lookups.length = 0;
  sentMails.length = 0;
  userId = (await authRepo.create({ email: `fx-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Valuta", role: "admin" })).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5, reminderFee: 60 });
});

async function makeCustomer(currency = "SEK", extra: Partial<typeof customers.$inferInsert> = {}) {
  return salesService.createCustomer({ name: `Kund ${currency}`, active: true, currency, ...extra } as never);
}

async function makeArticle(salesPrice?: number) {
  const article = await articleService.createArticle({
    articleNumber: `FX-${crypto.randomUUID()}`,
    name: "Valutaartikel",
    type: "purchased",
    active: true,
  });
  if (salesPrice !== undefined) await db.update(articles).set({ salesPrice: String(salesPrice) }).where(eq(articles.id, article.id));
  return article;
}

async function makePriceList(currency: string, rows: { articleId: string; unitPrice: number }[]) {
  const list = await salesService.createPriceList({ code: `PL-${crypto.randomUUID().slice(0, 6)}`, name: `Lista ${crypto.randomUUID()}`, currency });
  for (const row of rows) {
    await db.insert(priceListRows).values({ priceListId: list.id, articleId: row.articleId, fromQuantity: "1", unitPrice: String(row.unitPrice) });
  }
  return list;
}

async function location() {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

// A confirmed, fully delivered order in the customer's currency at `orderRate`.
async function deliveredOrder(customerId: string, opts: { currency?: string; orderRate?: number; unitPrice?: number; quantity?: number } = {}) {
  const article = await makeArticle();
  const loc = await location();
  const quantity = opts.quantity ?? 10;
  await stockService.recordTransaction({ articleId: article.id, locationId: loc.id, quantityDelta: quantity, transactionType: "inventory_adjustment" });
  const { order, rows } = await salesService.createQuote(
    {
      customerId,
      rows: [{ articleId: article.id, quantity, unitPrice: opts.unitPrice ?? 100 }],
      confirm: true,
      ...(opts.currency ? { currency: opts.currency } : {}),
      ...(opts.orderRate ? { exchangeRate: opts.orderRate } : {}),
    } as never,
    userId
  );
  await salesService.startProduction(order.id);
  await salesService.deliverGoods(order.id, rows[0]!.id, { locationId: loc.id, quantity }, userId);
  return { order, row: rows[0]!, article };
}

// An issued invoice with free rows in `currency`, at a typed rate.
async function issuedInvoice(customerId: string, currency: string, invoiceRate: number, rows: { unitPrice: number; vatRate?: number }[], type?: "credit") {
  const draft = await invoiceService.create(
    {
      customerId,
      currency,
      ...(currency === "SEK" ? {} : { exchangeRate: invoiceRate }),
      rows: rows.map((r, i) => ({ description: `Rad ${i + 1}`, quantity: 1, unitPrice: r.unitPrice, vatRate: r.vatRate ?? 25 })),
    } as never,
    userId
  );
  void type;
  return (await invoiceService.issue(draft!.id, userId))!;
}

async function rowsOf(verificationId: string) {
  const rows = await db
    .select({ number: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(verificationRows.createdAt));
  const byAccount: Record<string, number> = {};
  for (const row of rows) byAccount[row.number] = Math.round(((byAccount[row.number] ?? 0) + Number(row.debit) - Number(row.credit)) * 100) / 100;
  return byAccount;
}

async function ledgerBalance(number: string) {
  const [row] = await db.execute<{ balance: string }>(sql`
    SELECT COALESCE(SUM(vr.debit - vr.credit), 0) AS balance
    FROM verification_rows vr JOIN accounts a ON a.id = vr.account_id JOIN verifications v ON v.id = vr.verification_id
    WHERE a.number = ${number} AND v.status = 'booked'
  `);
  return Math.round(Number(row!.balance) * 100) / 100;
}

const sum = (values: number[]) => Math.round(values.reduce((s, v) => s + v, 0) * 100) / 100;

describe("kund och prislista i valuta", () => {
  it("customer and price list carry their currency (default SEK, upper-cased by zod)", async () => {
    const sek = await salesService.createCustomer({ name: "Svensk", active: true } as never);
    expect(sek.currency).toBe("SEK");
    const eur = await makeCustomer("EUR");
    expect(eur.currency).toBe("EUR");
    expect((await salesService.updateCustomer(eur.id, { currency: "NOK" })).currency).toBe("NOK");
    const list = await salesService.createPriceList({ code: "PL-A", name: "A" } as never);
    expect(list.currency).toBe("SEK");
  });

  it("a price list's currency cannot change while it has rows", async () => {
    const article = await makeArticle();
    const empty = await makePriceList("SEK", []);
    expect((await salesService.updatePriceList(empty.id, { currency: "EUR" })).currency).toBe("EUR");
    const full = await makePriceList("SEK", [{ articleId: article.id, unitPrice: 10 }]);
    await expect(salesService.updatePriceList(full.id, { currency: "EUR" })).rejects.toBeInstanceOf(PriceListCurrencyLockedError);
    // Changing something else on it still works.
    expect((await salesService.updatePriceList(full.id, { name: "Nytt namn" })).name).toBe("Nytt namn");
  });
});

describe("kundorder i valuta — prissättning", () => {
  it("prices in the order's currency: särpris (customer currency) → price list in the currency → article price converted", async () => {
    const special = await makeArticle(1000);
    const listed = await makeArticle(2000);
    const plain = await makeArticle(1113.1);
    const eurList = await makePriceList("EUR", [{ articleId: listed.id, unitPrice: 70 }]);
    const customer = await makeCustomer("EUR", { priceListId: eurList.id });
    await db.insert(customerPrices).values({ customerId: customer.id, articleId: special.id, fromQuantity: "1", unitPrice: "80" });

    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, exchangeRate: 11.131, rows: [special, listed, plain].map((a) => ({ articleId: a.id, quantity: 1 })) } as never,
      userId
    );
    expect(order).toMatchObject({ currency: "EUR", exchangeRate: "11.131000" });
    expect(rows.map((r) => Number(r.unitPrice))).toEqual([80, 70, fromSek(1113.1, 11.131)]);
    expect(Number(rows[2]!.unitPrice)).toBe(100);
  });

  it("a price list in another currency than the order's is skipped; särpriser only in the customer's currency", async () => {
    const special = await makeArticle(1000);
    const listed = await makeArticle(2000);
    const sekList = await makePriceList("SEK", [{ articleId: listed.id, unitPrice: 1500 }]);
    const customer = await makeCustomer("EUR", { priceListId: sekList.id });
    await db.insert(customerPrices).values({ customerId: customer.id, articleId: special.id, fromQuantity: "1", unitPrice: "80" });

    // EUR order: the SEK list is skipped — the article price converted.
    const eur = await salesService.createQuote({ customerId: customer.id, exchangeRate: 10, rows: [{ articleId: listed.id, quantity: 1 }] } as never, userId);
    expect(Number(eur.rows[0]!.unitPrice)).toBe(200);
    // SEK order for the EUR customer: the särpris (EUR) does not apply, the SEK list does.
    const sek = await salesService.createQuote(
      { customerId: customer.id, currency: "SEK", rows: [{ articleId: special.id, quantity: 1 }, { articleId: listed.id, quantity: 1 }] } as never,
      userId
    );
    expect(sek.order).toMatchObject({ currency: "SEK", exchangeRate: "1.000000" });
    expect(sek.rows.map((r) => Number(r.unitPrice))).toEqual([1000, 1500]);
  });

  it("a SEK order is priced exactly as before — the SEK price is never rounded", async () => {
    const article = await makeArticle(12.3456);
    const customer = await makeCustomer();
    const { order, rows } = await salesService.createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] }, userId);
    expect(order).toMatchObject({ currency: "SEK", exchangeRate: "1.000000" });
    expect(rows[0]!.unitPrice).toBe("12.3456");
    expect(lookups).toEqual([]);
  });

  it("today's rate unless one is sent; no rate ⇒ ExchangeRateUnavailableError; a SEK order takes only rate 1", async () => {
    const article = await makeArticle(1000);
    const customer = await makeCustomer("EUR");
    await expect(salesService.createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] }, userId)).rejects.toBeInstanceOf(
      ExchangeRateUnavailableError
    );
    rate("EUR", 11.5);
    const { order } = await salesService.createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] }, userId);
    expect(order.exchangeRate).toBe("11.500000");
    expect(lookups.at(-1)).toEqual({ currency: "EUR", date: TODAY });
    const sekCustomer = await makeCustomer();
    await expect(
      salesService.createQuote({ customerId: sekCustomer.id, exchangeRate: 2, rows: [{ articleId: article.id, quantity: 1 }] } as never, userId)
    ).rejects.toBeInstanceOf(SalesOrderExchangeRateError);
  });

  it("header: the rate changes as a quote/confirmed order; the currency only without rows; in production nothing", async () => {
    const article = await makeArticle(1000);
    const customer = await makeCustomer("EUR");
    const { order, rows } = await salesService.createQuote({ customerId: customer.id, exchangeRate: 10, rows: [{ articleId: article.id, quantity: 1 }] } as never, userId);
    expect((await salesService.updateSalesOrderHeader(order.id, { exchangeRate: 10.5 }))!.exchangeRate).toBe("10.500000");
    await expect(salesService.updateSalesOrderHeader(order.id, { currency: "USD" })).rejects.toBeInstanceOf(SalesOrderCurrencyLockedError);
    await salesService.deleteRow(order.id, rows[0]!.id);
    rate("USD", 9.25);
    const usd = await salesService.updateSalesOrderHeader(order.id, { currency: "USD" });
    expect(usd).toMatchObject({ currency: "USD", exchangeRate: "9.250000" });
    // SEK takes rate 1 only.
    const sek = await salesService.updateSalesOrderHeader(order.id, { currency: "SEK" });
    expect(sek).toMatchObject({ currency: "SEK", exchangeRate: "1.000000" });
    await expect(salesService.updateSalesOrderHeader(order.id, { exchangeRate: 2 })).rejects.toBeInstanceOf(SalesOrderExchangeRateError);

    const delivered = await deliveredOrder((await makeCustomer("EUR")).id, { orderRate: 11 });
    await expect(salesService.updateSalesOrderHeader(delivered.order.id, { exchangeRate: 12 })).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("new rows and the freight row are priced with the order's rate", async () => {
    const article = await makeArticle(1113.1);
    const freight = await makeArticle();
    const customer = await makeCustomer("EUR");
    const { order } = await salesService.createQuote({ customerId: customer.id, exchangeRate: 11.131, rows: [{ articleId: (await makeArticle(1)).id, quantity: 1 }] } as never, userId);
    const added = await salesService.addRow(order.id, { articleId: article.id, quantity: 1 });
    expect(Number(added.unitPrice)).toBe(100);
    // setFreightRow takes the kundpris in SEK.
    const freightRow = await salesService.setFreightRow(order.id, { articleId: freight.id, unitPrice: 556.55 });
    expect(Number(freightRow.unitPrice)).toBe(fromSek(556.55, 11.131));
  });

  it("GET /price-quote: in the order's currency, or a chosen one; another customer's order is no answer", async () => {
    const article = await makeArticle(1113.1);
    const customer = await makeCustomer("EUR");
    const { order } = await salesService.createQuote({ customerId: customer.id, exchangeRate: 11.131, rows: [{ articleId: article.id, quantity: 1 }] } as never, userId);
    expect(await salesService.getPriceQuote({ customerId: customer.id, articleId: article.id, quantity: 1, salesOrderId: order.id })).toMatchObject({
      currency: "EUR",
      exchangeRate: 11.131,
      price: { unitPrice: 100, source: "article" },
    });
    expect(await salesService.getPriceQuote({ customerId: customer.id, articleId: article.id, quantity: 1, currency: "SEK" })).toMatchObject({
      currency: "SEK",
      price: { unitPrice: 1113.1 },
    });
    const other = await makeCustomer("EUR");
    await expect(
      salesService.getPriceQuote({ customerId: other.id, articleId: article.id, quantity: 1, salesOrderId: order.id })
    ).rejects.toBeInstanceOf(SalesOrderNotFoundError);
  });

  it("the quote PDF prints the order's currency", async () => {
    const customer = await makeCustomer("EUR");
    const { order } = await salesService.createQuote({ customerId: customer.id, exchangeRate: 11, rows: [{ articleId: (await makeArticle(110)).id, quantity: 1 }] } as never, userId);
    const pdf = await salesService.getSalesOrderPdf(order.id, "quote");
    const text = pdfText(pdf.content);
    expect(text).toContain("EUR");
    expect(text).not.toContain("Summa exkl. moms SEK");
  });
});

describe("kundfaktura i valuta", () => {
  it("takes the order's currency; Utfärda books in SEK at the invoice date's rate", async () => {
    const customer = await makeCustomer("EUR");
    const { row } = await deliveredOrder(customer.id, { orderRate: 11, unitPrice: 100, quantity: 10 });
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: row.articleId, salesOrderRowId: row.id, description: "Leverans", quantity: 10, unitPrice: 100 }] },
      userId
    );
    expect(draft).toMatchObject({ currency: "EUR", exchangeRate: null, exchangeRateManual: false, sekAmounts: null });

    rate("EUR", 11.131);
    const issued = (await invoiceService.issue(draft!.id, userId))!;
    expect(lookups).toContainEqual({ currency: "EUR", date: TODAY });
    expect(issued.exchangeRate).toBe("11.131000");
    // 1 000 + 25 % = 1 250 EUR.
    expect(Number(issued.grossAmountSek)).toBe(toSek(1250, 11.131));
    expect(issued.sekAmounts).toEqual({ grossAmount: toSek(1250, 11.131), vatAmount: toSek(250, 11.131), netAmount: toSek(1250, 11.131) - toSek(250, 11.131) });
    expect(issued.openAmountSek).toBe(toSek(1250, 11.131));

    const booked = await rowsOf(issued.verificationId!);
    expect(booked["1510"]).toBe(toSek(1250, 11.131));
    expect(sum(Object.values(booked))).toBe(0);
    expect(booked["2610"]).toBe(-toSek(250, 11.131));
    const [verification] = await db.select().from(verifications).where(eq(verifications.id, issued.verificationId!));
    expect(verification!.description).toContain("EUR 1 250,00 à 11,131000");
  });

  it("a rate typed on the draft wins and is never looked up; null makes it automatic again", async () => {
    const customer = await makeCustomer("EUR");
    const draft = await invoiceService.create({ customerId: customer.id, currency: "EUR", rows: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 25 }] } as never, userId);
    const typed = await invoiceService.updateHeader(draft!.id, { exchangeRate: 10.5 });
    expect(typed).toMatchObject({ exchangeRate: "10.500000", exchangeRateManual: true, sekAmounts: { grossAmount: 1312.5 } });
    const automatic = await invoiceService.updateHeader(draft!.id, { exchangeRate: null });
    expect(automatic).toMatchObject({ exchangeRate: null, exchangeRateManual: false });
    await invoiceService.updateHeader(draft!.id, { exchangeRate: 10.5 });
    const issued = (await invoiceService.issue(draft!.id, userId))!;
    expect(lookups).toEqual([]);
    expect(Number(issued.grossAmountSek)).toBe(1312.5);
  });

  it("no rate at Utfärda leaves the draft a draft (no FA number burned)", async () => {
    const customer = await makeCustomer("EUR");
    const draft = await invoiceService.create({ customerId: customer.id, currency: "EUR", rows: [{ description: "X", quantity: 1, unitPrice: 100 }] } as never, userId);
    await expect(invoiceService.issue(draft!.id, userId)).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, draft!.id));
    expect(row).toMatchObject({ status: "draft", invoiceNumber: null, verificationId: null });
  });

  it("refuses an order row in another currency and a rate that does not fit", async () => {
    const customer = await makeCustomer("EUR");
    const sekOrder = await deliveredOrder(customer.id, { currency: "SEK" });
    await expect(
      invoiceService.create(
        { customerId: customer.id, currency: "EUR", rows: [{ articleId: sekOrder.row.articleId, salesOrderRowId: sekOrder.row.id, description: "x", quantity: 1, unitPrice: 100 }] } as never,
        userId
      )
    ).rejects.toBeInstanceOf(InvoiceRowCurrencyMismatchError);
    const eurDraft = await invoiceService.create({ customerId: customer.id, currency: "EUR", rows: [] } as never, userId);
    await expect(
      invoiceService.addRow(eurDraft!.id, { articleId: sekOrder.row.articleId, salesOrderRowId: sekOrder.row.id, description: "x", quantity: 1, unitPrice: 100 })
    ).rejects.toBeInstanceOf(InvoiceRowCurrencyMismatchError);
    await expect(
      invoiceService.create({ customerId: customer.id, currency: "SEK", exchangeRate: 2, rows: [] } as never, userId)
    ).rejects.toMatchObject({ reason: "sek" });
    const sekDraft = await invoiceService.create({ customerId: customer.id, currency: "SEK", rows: [] } as never, userId);
    await expect(invoiceService.updateHeader(sekDraft!.id, { exchangeRate: 2 })).rejects.toBeInstanceOf(InvoiceExchangeRateError);
  });

  it("a credit note takes the source invoice's currency and rate, whatever today's rate is", async () => {
    const customer = await makeCustomer("EUR");
    rate("EUR", 11.131);
    const source = await issuedInvoice(customer.id, "EUR", 11.131, [{ unitPrice: 800 }]);
    rate("EUR", 12);
    const credit = await invoiceService.createCredit(source.id, {}, userId);
    expect(credit).toMatchObject({ currency: "EUR", exchangeRate: "11.131000", exchangeRateManual: false });
    await expect(invoiceService.updateHeader(credit!.id, { exchangeRate: 12 })).rejects.toMatchObject({ reason: "credit" });
    const issued = (await invoiceService.issue(credit!.id, userId))!;
    expect(issued.exchangeRate).toBe("11.131000");
    expect(Number(issued.grossAmountSek)).toBe(toSek(1000, 11.131));
    const booked = await rowsOf(issued.verificationId!);
    expect(booked["1510"]).toBe(-toSek(1000, 11.131));
    expect(issued.openAmountSek).toBe(-toSek(1000, 11.131));
  });

  it("several VAT codes at an odd rate: the receivable is toSek(brutto), the VAT toSek(Σ moms), the verification balances", async () => {
    const customer = await makeCustomer("EUR");
    const issued = await issuedInvoice(customer.id, "EUR", 11.131, [{ unitPrice: 333.33, vatRate: 25 }, { unitPrice: 333.33, vatRate: 12 }, { unitPrice: 333.34, vatRate: 0 }]);
    const rows = issued.rows.map((r) => ({ lineAmount: Number(r.lineAmount), vatAmount: Number(r.vatAmount) }));
    const expected = invoiceSekAmounts({ rate: 11.131, rows });
    const booked = await rowsOf(issued.verificationId!);
    expect(booked["1510"]).toBe(expected.grossAmount);
    expect(sum(Object.values(booked))).toBe(0);
    expect(sum([booked["2610"] ?? 0, booked["2620"] ?? 0])).toBe(-expected.vatAmount);
    expect(Number(issued.grossAmountSek)).toBe(expected.grossAmount);
  });

  it("no påminnelseavgift on an invoice in another currency; the reminder itself is written in its currency", async () => {
    const customer = await makeCustomer("EUR");
    const issued = await issuedInvoice(customer.id, "EUR", 11, [{ unitPrice: 800 }]);
    const mail = { to: "kund@example.com", subject: "Påminnelse", message: "" };
    await expect(invoiceService.sendReminder(issued.id, { ...mail, withFee: true }, userId)).rejects.toBeInstanceOf(ReminderFeeCurrencyError);
    await expect(invoiceService.renderReminderPdf(issued.id, true)).rejects.toBeInstanceOf(ReminderFeeCurrencyError);
    expect(sentMails).toHaveLength(0);
    const preview = await invoiceService.renderReminderPdf(issued.id, false);
    expect(pdfText(preview.content)).toContain("Att betala EUR");
    const sent = await invoiceService.sendReminder(issued.id, { ...mail, withFee: false }, userId);
    expect(sent.reminders).toHaveLength(1);
  });

  it("samlingsfakturering makes one invoice per customer and currency", async () => {
    const customer = await makeCustomer("EUR", { collectiveInvoicing: true });
    await deliveredOrder(customer.id, { orderRate: 11 });
    await deliveredOrder(customer.id, { currency: "SEK" });
    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [customer.id], issue: false }, userId);
    expect(results.map((r) => [r.currency, r.status, r.rowCount])).toEqual([
      ["SEK", "draft", 1],
      ["EUR", "draft", 1],
    ]);
    const created = await db.select({ currency: invoices.currency }).from(invoices).orderBy(asc(invoices.currency));
    expect(created.map((r) => r.currency)).toEqual(["EUR", "SEK"]);
    const candidates = await invoiceService.listCollectiveInvoicingCandidates();
    expect(candidates).toEqual([]);
  });
});

describe("kundbetalning i valuta", () => {
  async function eurInvoice(customerId: string, gross: number, invoiceRate: number) {
    // gross incl. 25 % VAT.
    return issuedInvoice(customerId, "EUR", invoiceRate, [{ unitPrice: gross / 1.25 }]);
  }

  it("kursvinst: more SEK came in than the receivable was booked at", async () => {
    const customer = await makeCustomer("EUR");
    const invoice = await eurInvoice(customer.id, 1000, 11);
    const payment = await paymentService.create(
      { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1000, amountSek: 11200, rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }] },
      userId
    );
    expect(payment).toMatchObject({ currency: "EUR", amount: "1000.00", amountSek: "11200.00", bankFeeSek: "0.00", exchangeRateDifferenceSek: 200 });
    expect(await rowsOf(payment.verificationId!)).toEqual({ "1930": 11200, "1510": -11000, "3960": -200 });
    expect((await invoiceService.getInvoice(invoice.id))!).toMatchObject({ status: "paid", openAmount: 0, openAmountSek: 0 });
  });

  it("kursförlust and bankavgift", async () => {
    const customer = await makeCustomer("EUR");
    const invoice = await eurInvoice(customer.id, 1000, 11);
    const payment = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        amountSek: 10800,
        bankFeeSek: 50,
        rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }],
      },
      userId
    );
    expect(await rowsOf(payment.verificationId!)).toEqual({ "1930": 10800, "6570": 50, "7960": 150, "1510": -11000 });
    expect(payment.exchangeRateDifferenceSek).toBe(-150);
  });

  it("three partial payments release exactly the receivable; makulering reopens it", async () => {
    const customer = await makeCustomer("EUR");
    const invoice = await eurInvoice(customer.id, 1000, 11.131);
    const grossSek = Number(invoice.grossAmountSek);
    const ids: string[] = [];
    for (const applied of [333.33, 333.33, 333.34]) {
      const p = await paymentService.create(
        { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: applied, amountSek: toSek(applied, 11.2), rows: [{ invoiceId: invoice.id, appliedAmount: applied }] },
        userId
      );
      ids.push(p.id);
    }
    const released = await db.select({ sek: customerPaymentRows.appliedAmountSek }).from(customerPaymentRows).where(eq(customerPaymentRows.invoiceId, invoice.id));
    expect(sum(released.map((r) => Number(r.sek)))).toBe(grossSek);
    expect((await invoiceService.getInvoice(invoice.id))!).toMatchObject({ status: "paid", openAmountSek: 0 });
    expect(await ledgerBalance("1510")).toBe(0);

    await paymentService.cancel(ids[2]!, userId);
    const reopened = (await invoiceService.getInvoice(invoice.id))!;
    expect(reopened.status).toBe("issued");
    expect(reopened.openAmount).toBe(333.34);
    expect(reopened.openAmountSek).toBe(Math.round((grossSek - Number(released[0]!.sek) - Number(released[1]!.sek)) * 100) / 100);
    expect(await receivablesTotalAsOf(db, TODAY)).toBe(await ledgerBalance("1510"));
  });

  it("the reskontra's SEK sum equals the receivable account with SEK and EUR mixed", async () => {
    const eurCustomer = await makeCustomer("EUR");
    const sekCustomer = await makeCustomer();
    const eur = await eurInvoice(eurCustomer.id, 1000, 11.131);
    await eurInvoice(eurCustomer.id, 400, 10.9);
    const sek = await issuedInvoice(sekCustomer.id, "SEK", 1, [{ unitPrice: 800 }]);
    await paymentService.create(
      { customerId: eurCustomer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 500, amountSek: 5600, rows: [{ invoiceId: eur.id, appliedAmount: 500 }] },
      userId
    );
    await paymentService.create({ customerId: sekCustomer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 400, rows: [{ invoiceId: sek.id, appliedAmount: 400 }] }, userId);
    const total = await receivablesTotalAsOf(db, TODAY);
    expect(total).toBe(await ledgerBalance("1510"));
    expect(total).toBe(Math.round((toSek(1000, 11.131) - toSek(500, 11.131 * 1) + toSek(400, 10.9) + 600) * 100) / 100);
    const open = await paymentService.listOpenInvoices({ limit: 50, offset: 0, overdueOnly: false } as never);
    const row = open.rows.find((r) => r.id === eur.id)!;
    expect(row).toMatchObject({ currency: "EUR", openAmount: 500, grossAmountSek: toSek(1000, 11.131) });
  });

  it("guards: one currency per payment, SEK amounts that fit", async () => {
    const customer = await makeCustomer("EUR");
    const eur = await eurInvoice(customer.id, 1000, 11);
    const sek = await issuedInvoice(customer.id, "SEK", 1, [{ unitPrice: 800 }]);
    const base = { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930" };
    await expect(
      paymentService.create({ ...base, amount: 2000, amountSek: 22000, rows: [{ invoiceId: eur.id, appliedAmount: 1000 }, { invoiceId: sek.id, appliedAmount: 1000 }] }, userId)
    ).rejects.toBeInstanceOf(PaymentMixedCurrenciesError);
    await expect(paymentService.create({ ...base, amount: 1000, rows: [{ invoiceId: eur.id, appliedAmount: 1000 }] }, userId)).rejects.toMatchObject({
      reason: "required",
    });
    await expect(
      paymentService.create({ ...base, amount: 1000, amountSek: -11000, rows: [{ invoiceId: eur.id, appliedAmount: 1000 }] }, userId)
    ).rejects.toMatchObject({ reason: "sign" });
    await expect(
      paymentService.create({ ...base, amount: 1000, amountSek: 999, rows: [{ invoiceId: sek.id, appliedAmount: 1000 }] }, userId)
    ).rejects.toBeInstanceOf(CustomerPaymentAmountSekError);
    // A bank entry in EUR must find EUR invoices.
    await expect(
      paymentService.create({ ...base, currency: "EUR", amount: 1000, rows: [{ invoiceId: sek.id, appliedAmount: 1000 }] }, userId)
    ).rejects.toMatchObject({ currencies: ["EUR", "SEK"] });
  });

  it("the tolerance is in the invoice's currency", async () => {
    const customer = await makeCustomer("EUR");
    const invoice = await eurInvoice(customer.id, 1000, 11);
    // 5 kr at 11 = 0,45 EUR: 999,60 closes with 0,40 EUR written off.
    const payment = await paymentService.create(
      { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 999.6, amountSek: 10995.6, rows: [{ invoiceId: invoice.id, appliedAmount: 999.6 }] },
      userId
    );
    expect(payment.rows[0]).toMatchObject({ writeOffAmount: "0.40", writeOffAmountSek: "4.40", appliedAmountSek: "10995.60" });
    expect(await rowsOf(payment.verificationId!)).toEqual({ "1930": 10995.6, "1510": -11000, "3740": 4.4 });
    await expect(
      paymentService.create(
        { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1, amountSek: 11, rows: [{ invoiceId: (await eurInvoice(customer.id, 1000, 11)).id, appliedAmount: 1000.5 }] },
        userId
      )
    ).rejects.toThrow();
  });

  it("kvittning between items booked at different rates books only the exchange difference", async () => {
    const customer = await makeCustomer("EUR");
    const a = await eurInvoice(customer.id, 1000, 11);
    const b = await eurInvoice(customer.id, 500, 12);
    const credit = await invoiceService.createCredit(b.id, {}, userId);
    const creditIssued = (await invoiceService.issue(credit!.id, userId))!;
    const netting = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { invoiceId: a.id, appliedAmount: 500 },
          { invoiceId: creditIssued.id, appliedAmount: -500 },
        ],
      },
      userId
    );
    // A releases 5 500 SEK of its 11 000, the credit its whole −6 000.
    expect(await rowsOf(netting.verificationId!)).toEqual({ "1510": 500, "3960": -500 });
    expect(await receivablesTotalAsOf(db, TODAY)).toBe(await ledgerBalance("1510"));
    // The same items at one rate net to nothing — no verification.
    const c = await eurInvoice(customer.id, 200, 11);
    const cCredit = (await invoiceService.issue((await invoiceService.createCredit(c.id, {}, userId))!.id, userId))!;
    const flat = await paymentService.create(
      {
        customerId: customer.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 0,
        rows: [
          { invoiceId: c.id, appliedAmount: 200 },
          { invoiceId: cCredit.id, appliedAmount: -200 },
        ],
      },
      userId
    );
    expect(flat.verificationId).toBeNull();
  });

  it("a SEK payment books exactly as before (no SEK fields needed)", async () => {
    const customer = await makeCustomer();
    const invoice = await issuedInvoice(customer.id, "SEK", 1, [{ unitPrice: 800 }]);
    const payment = await paymentService.create(
      { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1000, rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }] },
      userId
    );
    expect(payment).toMatchObject({ currency: "SEK", amountSek: "1000.00", bankFeeSek: "0.00", exchangeRateDifferenceSek: 0 });
    expect(await rowsOf(payment.verificationId!)).toEqual({ "1930": 1000, "1510": -1000 });
  });
});

describe("rapporter i SEK", () => {
  it("the sales order's register sums in SEK at the order's rate", async () => {
    const { createOrderRegisterRepository } = await import("../src/modules/reports/repository/order-register.repository.js");
    const { buildOrderRegister } = await import("../src/modules/reports/service/order-register.js");
    const customer = await makeCustomer("EUR");
    await salesService.createQuote({ customerId: customer.id, exchangeRate: 11, rows: [{ articleId: (await makeArticle()).id, quantity: 2, unitPrice: 50 }] } as never, userId);
    const repo = createOrderRegisterRepository(db);
    const rows = await repo.loadSalesRows({ dateBasis: "order" } as never, 100);
    expect(rows[0]).toMatchObject({ currency: "EUR", exchangeRate: 11 });
    const report = buildOrderRegister(rows, false);
    expect(report.totals).toMatchObject({ orderValueSek: 1100, converted: true });
  });

  it("the quote follow-up values in SEK at the order's rate", async () => {
    const { createQuoteFollowupRepository } = await import("../src/modules/reports/repository/quote-followup.repository.js");
    const customer = await makeCustomer("EUR");
    await salesService.createQuote({ customerId: customer.id, exchangeRate: 11, rows: [{ articleId: (await makeArticle()).id, quantity: 2, unitPrice: 50 }] } as never, userId);
    const rows = await createQuoteFollowupRepository(db).loadQuotes({ from: TODAY, to: TODAY } as never, 100);
    expect(rows[0]).toMatchObject({ currency: "EUR", currencyValue: 100, value: 1100 });
  });
});

// Keep the imports the suite only touches through types/queries referenced.
void salesOrders;
void priceLists;
