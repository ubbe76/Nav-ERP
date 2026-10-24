import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db, suppliers, supplierInvoices } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { supplierInvoiceRoutes } from "../src/modules/purchase/routes/supplier-invoice.routes.js";
import { createSupplierPaymentRepository } from "../src/modules/purchase/repository/supplier-payment.repository.js";
import { createSupplierPaymentService } from "../src/modules/purchase/service/supplier-payment.service.js";
import { supplierPaymentRoutes } from "../src/modules/purchase/routes/supplier-payment.routes.js";
import { createExchangeRateService } from "../src/modules/system/service/exchange-rates.js";
import { exchangeRateRoutes } from "../src/modules/system/routes/exchange-rates.routes.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testSystemService } from "./helpers/services.js";

// Valuta steg 1 — the HTTP contract of the new routes and fields. Riksbanken
// is a fake fetch (the suite never calls out).

const TODAY = new Date().toLocaleDateString("sv-SE");
const authRepo = createAuthRepository(db);
let userId = "";

const replies: { status: number; body?: unknown }[] = [];
const fetched: string[] = [];
const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
  fetched.push(String(input));
  const reply = replies.shift() ?? { status: 204 };
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
}) as typeof fetch;

const rateService = createExchangeRateService({ db, fetch: fakeFetch, today: () => "2026-10-24", log: () => {} });
const poster = createVerificationPoster({ read: readPostingSettings });
const invoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster, undefined, rateService);
const paymentService = createSupplierPaymentService(createSupplierPaymentRepository(db), poster);

function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed" });
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "fx@example.com", name: "Valuta", role: "admin" } as never;
  });
  app.register(exchangeRateRoutes, { service: rateService });
  app.register(supplierInvoiceRoutes, { service: invoiceService });
  app.register(supplierPaymentRoutes, { service: paymentService });
  return app;
}

const TRUNCATE = sql`TRUNCATE exchange_rates, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_payment_rows, supplier_payments, supplier_invoice_rows, supplier_invoices, suppliers, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key IN ('exchange_rate_source', 'riksbank_api_key')`);
  await setupPostingBaseline();
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5 });
  const user = await authRepo.create({ email: `fx-route-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Valuta", role: "admin" });
  userId = user.id;
  replies.length = 0;
  fetched.length = 0;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key IN ('exchange_rate_source', 'riksbank_api_key')`);
});

async function supplier(currency: string) {
  const [row] = await db
    .insert(suppliers)
    .values({ name: `Lev ${currency}`, supplierNumber: `FXR-${crypto.randomUUID()}`, currency, active: true })
    .returning();
  return row!;
}

describe("valutakurser", () => {
  it("GET /exchange-rates answers the latest banking day ≤ date, 409 without a rate, 400 for a bad currency", async () => {
    const app = buildApp();
    replies.push({ status: 200, body: [{ date: "2026-10-22", value: 11.112 }, { date: "2026-10-23", value: 11.131 }] });
    const res = await app.inject({ url: "/exchange-rates?currency=eur&date=2026-10-24" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ currency: "EUR", requestedDate: "2026-10-24", date: "2026-10-23", rate: 11.131, source: "riksbank" });

    const none = await app.inject({ url: "/exchange-rates?currency=AED&date=2026-10-24" });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: "exchange-rate-unavailable", currency: "AED", date: "2026-10-24", error: "Ingen kurs för AED 2026-10-24 — ange kursen själv" });

    expect((await app.inject({ url: "/exchange-rates?currency=EURO&date=2026-10-24" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/exchange-rates?currency=EUR" })).statusCode).toBe(400);

    const sek = await app.inject({ url: "/exchange-rates?currency=SEK&date=2026-10-24" });
    expect(sek.json()).toMatchObject({ rate: 1, source: null });
  });

  it("POST /exchange-rates stores a manual rate (201), refuses SEK; /list pages them", async () => {
    const app = buildApp();
    const created = await app.inject({ method: "POST", url: "/exchange-rates", payload: { currency: "usd", date: "2026-10-23", rate: "9.95" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ currency: "USD", date: "2026-10-23", rate: 9.95, source: "manual", createdByName: "Valuta" });
    expect((await app.inject({ method: "POST", url: "/exchange-rates", payload: { currency: "SEK", date: "2026-10-23", rate: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/exchange-rates", payload: { currency: "USD", date: "2026-10-23", rate: 0 } })).statusCode).toBe(400);

    const list = await app.inject({ url: "/exchange-rates/list?currency=USD" });
    expect(list.json()).toMatchObject({ total: 1, rows: [{ currency: "USD", rate: 9.95 }] });
  });

  it("POST /exchange-rates/fetch stores the interval, 502 riksbank-unavailable when Riksbanken refuses", async () => {
    const app = buildApp();
    replies.push({ status: 200, body: [{ date: "2026-10-23", value: 11.131 }] }, { status: 429 });
    const ok = await app.inject({ method: "POST", url: "/exchange-rates/fetch", payload: { currency: "EUR", from: "2026-10-19", to: "2026-10-23" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ currency: "EUR", fetched: 1, rates: [{ date: "2026-10-23", rate: 11.131, source: "riksbank" }] });
    expect(fetched[0]).toBe("https://api.riksbank.se/swea/v1/Observations/SEKEURPMI/2026-10-19/2026-10-23");

    const limited = await app.inject({ method: "POST", url: "/exchange-rates/fetch", payload: { currency: "EUR", from: "2026-10-19", to: "2026-10-23" } });
    expect(limited.statusCode).toBe(502);
    expect(limited.json()).toMatchObject({ code: "riksbank-unavailable", reason: "rate_limited" });
  });

  it("GET/PATCH /exchange-rate-settings keeps the key write-only", async () => {
    const app = buildApp();
    const patched = await app.inject({ method: "PATCH", url: "/exchange-rate-settings", payload: { source: "manual", apiKey: "k-123" } });
    expect(patched.json()).toEqual({ source: "manual", apiKeySet: true });
    expect((await app.inject({ url: "/exchange-rate-settings" })).body).not.toContain("k-123");
    expect((await app.inject({ method: "PATCH", url: "/exchange-rate-settings", payload: { other: 1 } })).statusCode).toBe(400);
  });
});

describe("leverantörsfaktura och betalning i valuta över HTTP", () => {
  it("creates, re-rates, attests and pays a EUR invoice; SEK keeps rate 1", async () => {
    const app = buildApp();
    const eur = await supplier("EUR");

    // No rate anywhere: 409 with the currency and date.
    const none = await app.inject({
      method: "POST",
      url: "/supplier-invoices",
      payload: { supplierId: eur.id, invoiceNumber: "E-1", invoiceDate: TODAY, netAmount: 1000, grossAmount: 1000 },
    });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: "exchange-rate-unavailable", currency: "EUR", date: TODAY });

    const created = await app.inject({
      method: "POST",
      url: "/supplier-invoices",
      payload: { supplierId: eur.id, invoiceNumber: "E-1", invoiceDate: TODAY, netAmount: 1000, grossAmount: 1000, exchangeRate: "11.131" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      currency: "EUR",
      exchangeRate: "11.131000",
      exchangeRateSource: "manual",
      exchangeRateDate: null,
      grossAmountSek: null,
      exchangeRateMissing: false,
      sekAmounts: { grossAmount: 11131, vatAmount: 0, netAmount: 11131 },
      openAmountSek: null,
    });
    const id = created.json().id;

    const rerated = await app.inject({ method: "PATCH", url: `/supplier-invoices/${id}`, payload: { exchangeRate: 11.2 } });
    expect(rerated.statusCode).toBe(200);
    expect(rerated.json()).toMatchObject({ exchangeRate: "11.200000", exchangeRateSource: "manual", sekAmounts: { grossAmount: 11200 } });
    expect((await app.inject({ method: "PATCH", url: `/supplier-invoices/${id}`, payload: { exchangeRate: -1 } })).statusCode).toBe(400);

    const approved = await app.inject({ method: "POST", url: `/supplier-invoices/${id}/approve` });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved", grossAmountSek: "11200.00", openAmount: 1000, openAmountSek: 11200 });

    const list = await app.inject({ url: "/supplier-invoices" });
    expect(list.json().rows[0]).toMatchObject({ currency: "EUR", exchangeRate: "11.200000", grossSekValue: "11200.00" });
    const open = await app.inject({ url: "/open-supplier-invoices" });
    expect(open.json().rows[0]).toMatchObject({ currency: "EUR", openAmount: 1000, openAmountSek: 11200 });

    const missingSek = await app.inject({
      method: "POST",
      url: "/supplier-payments",
      payload: { supplierId: eur.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1000, rows: [{ supplierInvoiceId: id, appliedAmount: 1000 }] },
    });
    expect(missingSek.statusCode).toBe(400);
    expect(missingSek.json()).toMatchObject({ code: "supplier-payment-amount-sek", reason: "required", currency: "EUR" });

    const paid = await app.inject({
      method: "POST",
      url: "/supplier-payments",
      payload: {
        supplierId: eur.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 1000,
        amountSek: "11250",
        bankFeeSek: "25",
        rows: [{ supplierInvoiceId: id, appliedAmount: 1000 }],
      },
    });
    expect(paid.statusCode).toBe(201);
    expect(paid.json()).toMatchObject({
      currency: "EUR",
      amountSek: "11250.00",
      bankFeeSek: "25.00",
      exchangeRateDifferenceSek: -25,
      rows: [{ appliedAmountSek: "11200.00", writeOffAmountSek: "0.00", invoiceExchangeRate: "11.200000" }],
    });
    const card = await app.inject({ url: `/supplier-invoices/${id}` });
    expect(card.json()).toMatchObject({ status: "paid", payments: [{ currency: "EUR", appliedAmountSek: "11200.00" }] });

    // SEK: rate 1 or nothing; any other rate is a 400.
    const sek = await supplier("SEK");
    const sekBad = await app.inject({ method: "POST", url: "/supplier-invoices", payload: { supplierId: sek.id, invoiceNumber: "S-1", invoiceDate: TODAY, exchangeRate: 2 } });
    expect(sekBad.statusCode).toBe(400);
    expect(sekBad.json().code).toBe("supplier-invoice-exchange-rate");
  });

  it("refuses mixed currencies (400) and the attest of a foreign invoice without a rate (409)", async () => {
    const app = buildApp();
    const eur = await supplier("EUR");
    const make = async (number: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/supplier-invoices",
          payload: { supplierId: eur.id, invoiceNumber: number, invoiceDate: TODAY, netAmount: 100, grossAmount: 100, exchangeRate: 11 },
        })
      ).json().id as string;
    const eurId = await make("M-1");
    const sekId = await make("M-2");
    await db.update(supplierInvoices).set({ currency: "SEK", exchangeRate: "1", exchangeRateSource: null }).where(eq(supplierInvoices.id, sekId));
    await app.inject({ method: "POST", url: `/supplier-invoices/${eurId}/approve` });
    await app.inject({ method: "POST", url: `/supplier-invoices/${sekId}/approve` });
    const mixed = await app.inject({
      method: "POST",
      url: "/supplier-payments",
      payload: {
        supplierId: eur.id,
        paymentDate: TODAY,
        bankAccountNumber: "1930",
        amount: 200,
        amountSek: 1200,
        rows: [
          { supplierInvoiceId: eurId, appliedAmount: 100 },
          { supplierInvoiceId: sekId, appliedAmount: 100 },
        ],
      },
    });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json()).toMatchObject({ code: "payment-mixed-currencies", currencies: ["EUR", "SEK"] });

    const legacyId = await make("M-3");
    await db.update(supplierInvoices).set({ exchangeRate: "1", exchangeRateSource: null }).where(eq(supplierInvoices.id, legacyId));
    const legacy = await app.inject({ method: "POST", url: `/supplier-invoices/${legacyId}/approve` });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().code).toBe("supplier-invoice-exchange-rate-missing");
  });
});
