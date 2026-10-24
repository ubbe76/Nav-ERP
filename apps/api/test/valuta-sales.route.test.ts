import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { articles, db, priceListRows } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { invoiceRoutes } from "../src/modules/sales/routes/invoice.routes.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { paymentRoutes } from "../src/modules/sales/routes/payment.routes.js";
import { configuratorRoutes as oauthConfiguratorRoutes } from "../src/modules/oauth/routes/configurator.routes.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import {
  ExchangeRateUnavailableError,
  type ExchangeRateLookup,
  type ExchangeRateReader,
} from "../src/modules/system/service/exchange-rates.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testSystemService } from "./helpers/services.js";

// Valuta steg 3 — the HTTP contract of the new fields and errors on the
// sales routes (customers, price lists, orders, price quote, invoices,
// payments). The rate lookup is a stub.

const stubRates = new Map<string, number>();
const rates: ExchangeRateReader = {
  async getRate(currency, date): Promise<ExchangeRateLookup> {
    const rate = stubRates.get(currency);
    if (rate === undefined) throw new ExchangeRateUnavailableError(currency, date);
    return { currency, requestedDate: date, date, rate, source: "riksbank" };
  },
};

const authRepo = createAuthRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const documentPdfService = createDocumentPdfService(systemService);
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  mailService,
  documentPdfService,
  createStockService(createStockRepository(db)),
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  rates
);
const poster = createVerificationPoster({ read: readPostingSettings });
const invoiceService = createInvoiceService(createInvoiceRepository(db), mailService, documentPdfService, poster, undefined, articleService, undefined, rates);
const paymentService = createPaymentService(createPaymentRepository(db), poster);

let userId = "";
function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed" });
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "fx@example.com", name: "Valuta", role: "admin" } as never;
  });
  app.register(salesRoutes, { service: salesService });
  app.register(invoiceRoutes, { service: invoiceService });
  app.register(paymentRoutes, { service: paymentService });
  app.register(oauthConfiguratorRoutes, { salesService, articleService, configuratorService: {} as never });
  return app;
}

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_documents, invoice_reminders, invoice_rows, invoices, sales_order_rows, sales_orders, customer_prices, price_list_rows, price_lists, customers, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5, reminderFee: 60 });
  stubRates.clear();
  userId = (await authRepo.create({ email: `fxr-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "V", role: "admin" })).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function article(salesPrice = 1100) {
  const a = await articleService.createArticle({ articleNumber: `FXR-${crypto.randomUUID()}`, name: "Vara", type: "purchased", active: true });
  await db.update(articles).set({ salesPrice: String(salesPrice) }).where(eq(articles.id, a.id));
  return a;
}

describe("kunder, prislistor och kundordrar", () => {
  it("POST /customers takes a currency (upper-cased) and refuses a malformed one", async () => {
    const app = buildApp();
    const ok = await app.inject({ method: "POST", url: "/customers", payload: { name: "Euro Kund", currency: "eur" } });
    expect([ok.statusCode, ok.json().currency]).toEqual([201, "EUR"]);
    const bad = await app.inject({ method: "POST", url: "/customers", payload: { name: "Fel", currency: "EURO" } });
    expect([bad.statusCode, bad.json().code]).toEqual([400, "validation-failed"]);
    const patched = await app.inject({ method: "PATCH", url: `/customers/${ok.json().id}`, payload: { currency: "nok" } });
    expect(patched.json().currency).toBe("NOK");
  });

  it("POST /quotes for a customer in EUR gives an order in EUR; PATCH /sales-orders/:id refuses a new currency on rows", async () => {
    const app = buildApp();
    const customer = (await app.inject({ method: "POST", url: "/customers", payload: { name: "Euro Kund", currency: "EUR" } })).json();
    const noRate = await app.inject({ method: "POST", url: "/quotes", payload: { customerId: customer.id, rows: [{ articleId: (await article()).id, quantity: 1 }] } });
    expect([noRate.statusCode, noRate.json().code, noRate.json().currency]).toEqual([409, "exchange-rate-unavailable", "EUR"]);
    stubRates.set("EUR", 11);
    const created = await app.inject({ method: "POST", url: "/quotes", payload: { customerId: customer.id, rows: [{ articleId: (await article()).id, quantity: 1 }] } });
    expect(created.statusCode).toBe(201);
    expect(created.json().order).toMatchObject({ currency: "EUR", exchangeRate: "11.000000" });
    expect(Number(created.json().rows[0].unitPrice)).toBe(100);
    const orderId = created.json().order.id;

    const locked = await app.inject({ method: "PATCH", url: `/sales-orders/${orderId}`, payload: { currency: "USD" } });
    expect([locked.statusCode, locked.json().code]).toEqual([409, "sales-order-currency-locked"]);
    const rate = await app.inject({ method: "PATCH", url: `/sales-orders/${orderId}`, payload: { exchangeRate: "11.25" } });
    expect([rate.statusCode, rate.json().exchangeRate]).toEqual([200, "11.250000"]);
    const detail = await app.inject({ method: "GET", url: `/sales-orders/${orderId}` });
    expect(detail.json()).toMatchObject({ currency: "EUR", exchangeRate: "11.250000" });
    const list = await app.inject({ method: "GET", url: "/sales-orders" });
    expect(list.json().rows[0]).toMatchObject({ currency: "EUR", exchangeRate: "11.250000" });

    const sekCustomer = (await app.inject({ method: "POST", url: "/customers", payload: { name: "Svensk" } })).json();
    const sekQuote = await app.inject({ method: "POST", url: "/quotes", payload: { customerId: sekCustomer.id, rows: [{ articleId: (await article()).id, quantity: 1 }] } });
    const sekRate = await app.inject({ method: "PATCH", url: `/sales-orders/${sekQuote.json().order.id}`, payload: { exchangeRate: 2 } });
    expect([sekRate.statusCode, sekRate.json().code]).toEqual([400, "sales-order-exchange-rate"]);
  });

  it("GET /price-quote answers in a currency; PATCH /price-lists/:id refuses a new currency on rows", async () => {
    const app = buildApp();
    const customer = (await app.inject({ method: "POST", url: "/customers", payload: { name: "Euro Kund", currency: "EUR" } })).json();
    const a = await article(1100);
    const missing = await app.inject({ method: "GET", url: `/price-quote?customerId=${customer.id}&articleId=${a.id}&quantity=1` });
    expect([missing.statusCode, missing.json().code]).toEqual([409, "exchange-rate-unavailable"]);
    const quoted = await app.inject({ method: "GET", url: `/price-quote?customerId=${customer.id}&articleId=${a.id}&quantity=1&exchangeRate=11` });
    expect(quoted.json()).toMatchObject({ currency: "EUR", exchangeRate: 11, price: { unitPrice: 100 } });
    const sek = await app.inject({ method: "GET", url: `/price-quote?customerId=${customer.id}&articleId=${a.id}&quantity=1&currency=sek` });
    expect(sek.json()).toMatchObject({ currency: "SEK", price: { unitPrice: 1100 } });

    const list = await app.inject({ method: "POST", url: "/price-lists", payload: { code: "EU", name: "Euro", currency: "EUR" } });
    expect([list.statusCode, list.json().currency]).toEqual([201, "EUR"]);
    await db.insert(priceListRows).values({ priceListId: list.json().id, articleId: a.id, unitPrice: "90" });
    const locked = await app.inject({ method: "PATCH", url: `/price-lists/${list.json().id}`, payload: { currency: "SEK" } });
    expect([locked.statusCode, locked.json().code]).toEqual([409, "price-list-currency-locked"]);
  });
});

describe("fakturor och betalningar", () => {
  async function eurCustomer(app: ReturnType<typeof buildApp>) {
    return (await app.inject({ method: "POST", url: "/customers", payload: { name: "Euro Kund", currency: "EUR" } })).json();
  }

  it("invoice: currency, rate, SEK values; the errors carry their codes", async () => {
    const app = buildApp();
    const customer = await eurCustomer(app);
    const draft = await app.inject({ method: "POST", url: "/invoices", payload: { customerId: customer.id, rows: [{ description: "X", quantity: 1, unitPrice: 800, vatRate: 25 }] } });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ currency: "EUR", exchangeRate: null, exchangeRateManual: false, sekAmounts: null, openAmountSek: null });
    const id = draft.json().id;
    const noRate = await app.inject({ method: "POST", url: `/invoices/${id}/issue` });
    expect([noRate.statusCode, noRate.json().code, noRate.json().currency]).toEqual([409, "exchange-rate-unavailable", "EUR"]);
    const typed = await app.inject({ method: "PATCH", url: `/invoices/${id}`, payload: { exchangeRate: 11 } });
    expect(typed.json()).toMatchObject({ exchangeRate: "11.000000", exchangeRateManual: true, sekAmounts: { grossAmount: 11000 } });
    const issued = await app.inject({ method: "POST", url: `/invoices/${id}/issue` });
    expect(issued.statusCode).toBe(200);
    expect(issued.json()).toMatchObject({ grossAmountSek: "11000.00", openAmountSek: 11000 });
    const list = await app.inject({ method: "GET", url: "/invoices" });
    expect(list.json().rows[0]).toMatchObject({ currency: "EUR", grossAmountSek: "11000.00" });

    const fee = await app.inject({ method: "POST", url: `/invoices/${id}/reminders`, payload: { to: "a@example.com", subject: "P", withFee: true } });
    expect([fee.statusCode, fee.json().code, fee.json().currency]).toEqual([409, "reminder-fee-currency", "EUR"]);

    const sekCustomer = (await app.inject({ method: "POST", url: "/customers", payload: { name: "Svensk" } })).json();
    const sekDraft = await app.inject({ method: "POST", url: "/invoices", payload: { customerId: sekCustomer.id, rows: [] } });
    const sekRate = await app.inject({ method: "PATCH", url: `/invoices/${sekDraft.json().id}`, payload: { exchangeRate: 2 } });
    expect([sekRate.statusCode, sekRate.json().code, sekRate.json().reason]).toEqual([400, "invoice-exchange-rate", "sek"]);

    const open = await app.inject({ method: "GET", url: "/open-invoices" });
    expect(open.json().rows[0]).toMatchObject({ currency: "EUR", exchangeRate: 11, openAmount: 1000, openAmountSek: 11000 });
  });

  it("payment: amountSek/bankFeeSek, the exchange difference, and the errors", async () => {
    const app = buildApp();
    const customer = await eurCustomer(app);
    const draft = await app.inject({ method: "POST", url: "/invoices", payload: { customerId: customer.id, exchangeRate: 11, rows: [{ description: "X", quantity: 1, unitPrice: 800, vatRate: 25 }] } });
    const invoiceId = draft.json().id;
    await app.inject({ method: "POST", url: `/invoices/${invoiceId}/issue` });
    const today = new Date().toLocaleDateString("sv-SE");
    const base = { customerId: customer.id, paymentDate: today, bankAccountNumber: "1930", amount: 1000, rows: [{ invoiceId, appliedAmount: 1000 }] };

    const missing = await app.inject({ method: "POST", url: "/payments", payload: base });
    expect([missing.statusCode, missing.json().code, missing.json().reason, missing.json().currency]).toEqual([400, "customer-payment-amount-sek", "required", "EUR"]);
    const mixed = await app.inject({ method: "POST", url: "/payments", payload: { ...base, currency: "SEK" } });
    expect([mixed.statusCode, mixed.json().code, mixed.json().currencies]).toEqual([400, "payment-mixed-currencies", ["EUR", "SEK"]]);
    const paid = await app.inject({ method: "POST", url: "/payments", payload: { ...base, amountSek: "11150", bankFeeSek: "25" } });
    expect(paid.statusCode).toBe(201);
    expect(paid.json()).toMatchObject({ currency: "EUR", amountSek: "11150.00", bankFeeSek: "25.00", exchangeRateDifferenceSek: 175 });
    expect(paid.json().rows[0]).toMatchObject({ appliedAmountSek: "11000.00", writeOffAmountSek: "0.00" });
  });
});
