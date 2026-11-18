import { createQuoteSchema, createStockLocationSchema, salesRowAmounts } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
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
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { resetVatCodes } from "./helpers/vat-codes.js";
import { vatRateGroupId } from "./helpers/vat-group.js";
import { parsed } from "./helpers/parsed.js";

import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { salesOrderRowVat, salesOrderVatSummary } from "../src/modules/sales/service/order-vat.js";

// Moms på offert och orderbekräftelse: the quote/order confirmation prints
// Summa exkl. moms / Moms (X %) på … per sats / Summa inkl. moms (never Att
// betala), GET /sales-orders/:id carries the same figures as vatSummary, and
// both are computed with the invoice row's own rule (salesRowAmounts), so
// the invoice issued for the order has the same VAT per rate.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
let freightArticleId: string | null = null;
const freightReader = { freightArticleId: async () => freightArticleId };
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

const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_documents, invoice_rows, invoices, audit_log, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  await resetVatCodes();
  await setupPostingBaseline();
  freightArticleId = null;
  user = await authRepo.create({
    email: `vat-inv-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Fakturerare",
    role: "admin",
  });
});

afterAll(async () => {
  await db.execute(TABLES);
  await resetVatCodes();
});

type CustomerOverrides = Partial<Parameters<typeof salesService.createCustomer>[0]>;
async function makeCustomer(overrides: CustomerOverrides = {}) {
  return salesService.createCustomer({
    name: "Kund AB",
    active: true,
    country: "SE",
    discountPercent: 0,
    collectiveInvoicing: false,
    privatePerson: false,
    reverseChargeConstruction: false,
    showConfigurationPrices: false,
    invoiceDelivery: "email",
    ...overrides,
  } as Parameters<typeof salesService.createCustomer>[0]);
}

async function makeArticle(type: "manufactured" | "purchased" | "service" = "purchased", vatRate?: number) {
  return articleService.createArticle({
    articleNumber: `ART-VAT-${crypto.randomUUID().slice(0, 8)}`,
    name: type === "service" ? "Montagetjänst" : "Bänkskiva",
    type,
    active: true,
    ...(vatRate !== undefined ? { groupId: await vatRateGroupId(vatRate) } : {}),
  } as Parameters<typeof articleService.createArticle>[0]);
}


type QuoteRow = { articleId: string; quantity: number; unitPrice: number; discountPercent?: number };
async function quote(customerId: string, rows: QuoteRow[], extra: Record<string, unknown> = {}) {
  return salesService.createQuote(parsed(createQuoteSchema, { customerId, rows, ...extra }), user.id);
}
async function quoteText(orderId: string, variant: "quote" | "confirmation" = "quote") {
  return pdfText((await salesService.getSalesOrderPdf(orderId, variant)).content);
}

describe("salesRowAmounts / salesOrderVatSummary — the rule", () => {
  it("bakes the discount into the net with one rounding and rounds the VAT per row", () => {
    expect(salesRowAmounts({ quantity: 3, unitPrice: 33.33, discountPercent: 0, vatRate: 25 })).toEqual({ lineAmount: 99.99, vatAmount: 25 });
    expect(salesRowAmounts({ quantity: 7, unitPrice: 1.115, discountPercent: 0, vatRate: 12 })).toEqual({ lineAmount: 7.81, vatAmount: 0.94 });
    expect(salesRowAmounts({ quantity: 1, unitPrice: 1000, discountPercent: 10, vatRate: 25 })).toEqual({ lineAmount: 900, vatAmount: 225 });
  });

  it("groups per rate and code, highest rate first, and sums each row's own rounded VAT", () => {
    const row = (code: "MP25" | "MP12" | "EUV", name: string, quantity: number, unitPrice: number) =>
      salesOrderRowVat({ quantity, unitPrice, discountPercent: 0, code, name });
    // Three rows of 0,06 at 25 %: 0,02 each (0,015 rounded up) = 0,06 — not 25 % of 0,18 = 0,05.
    const summary = salesOrderVatSummary([
      row("MP12", "Moms 12 %", 1, 100),
      row("MP25", "Moms 25 %", 1, 0.06),
      row("MP25", "Moms 25 %", 1, 0.06),
      row("MP25", "Moms 25 %", 1, 0.06),
      row("EUV", "Varor till annat EU-land", 1, 50),
    ]);
    expect(summary).toEqual({
      lines: [
        { code: "MP25", name: "Moms 25 %", rate: 25, net: 0.18, vatAmount: 0.06 },
        { code: "MP12", name: "Moms 12 %", rate: 12, net: 100, vatAmount: 12 },
        { code: "EUV", name: "Varor till annat EU-land", rate: 0, net: 50, vatAmount: 0 },
      ],
      totalExclVat: 150.18,
      vatAmount: 12.06,
      totalInclVat: 162.24,
    });
    expect(salesOrderVatSummary([])).toEqual({ lines: [], totalExclVat: 0, vatAmount: 0, totalInclVat: 0 });
  });
});

describe("quote / order confirmation PDF — momssummeringen", () => {
  it("a company customer at 25 %: Summa exkl. moms, Moms (25 %) på underlaget, Summa inkl. moms — never Att betala", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const { order } = await quote(customer.id, [{ articleId: goods.id, quantity: 2, unitPrice: 100 }]);
    for (const variant of ["quote", "confirmation"] as const) {
      const text = await quoteText(order.id, variant);
      expect(text).toContain("Summa exkl. moms SEK200,00");
      expect(text).toContain("Moms (25 %) på 200,0050,00");
      expect(text).toContain("Summa inkl. moms SEK250,00");
      expect(text).not.toContain("Att betala");
      expect(text).not.toContain("Summa SEK");
      expect(text).not.toContain("Varav moms");
      expect(text).not.toContain("Priser inklusive moms");
    }
  });

  it("two rates: one line per rate with its own base, highest first, each row's VAT rounded like the invoice row", async () => {
    const customer = await makeCustomer();
    const a25 = await makeArticle("purchased");
    const a12 = await makeArticle("purchased", 12);
    const { order } = await quote(customer.id, [
      { articleId: a12.id, quantity: 7, unitPrice: 1.115 },
      { articleId: a25.id, quantity: 3, unitPrice: 33.33 },
      { articleId: a25.id, quantity: 1, unitPrice: 1000, discountPercent: 10 },
    ]);
    const text = await quoteText(order.id);
    expect(text).toContain("Summa exkl. moms SEK1 007,80");
    expect(text).toContain("Moms (25 %) på 999,99250,00");
    expect(text).toContain("Moms (12 %) på 7,810,94");
    expect(text.indexOf("Moms (25 %)")).toBeLessThan(text.indexOf("Moms (12 %)"));
    expect(text).toContain("Summa inkl. moms SEK1 258,74");
  });

  it("an EU customer: the 0 % code by name with its base, the gross equals the net, the code's text under the totals", async () => {
    const de = await makeCustomer({ name: "Kunde GmbH", country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const { order } = await quote(de.id, [{ articleId: goods.id, quantity: 1, unitPrice: 100 }]);
    const text = await quoteText(order.id);
    expect(text).toContain("Summa exkl. moms SEK100,00");
    expect(text).toContain("Varor till annat EU-land på 100,000,00");
    expect(text).toContain("Summa inkl. moms SEK100,00");
    expect(text).not.toContain("Moms (");
    const totals = text.indexOf("Summa inkl. moms SEK");
    expect(text.indexOf("Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)")).toBeGreaterThan(totals);
  });

  it("a private person is unchanged: Summa inkl. moms + Varav moms, no line per rate", async () => {
    const privat = await makeCustomer({ name: "Privat Person", privatePerson: true });
    const goods = await makeArticle("purchased", 12);
    const { order } = await quote(privat.id, [{ articleId: goods.id, quantity: 1, unitPrice: 100 }]);
    const text = await quoteText(order.id);
    expect(text).toContain("Priser inklusive moms");
    expect(text).toContain("Summa inkl. moms SEK112,00");
    expect(text).toContain("Varav moms12,00");
    expect(text).not.toContain("Summa exkl. moms");
    expect(text).not.toContain("Moms (12 %)");
    expect(text).not.toContain("Att betala");
  });

  it("an English customer gets the dictionary's English lines", async () => {
    const customer = await makeCustomer({ language: "en" });
    const goods = await makeArticle("purchased");
    const { order } = await quote(customer.id, [{ articleId: goods.id, quantity: 2, unitPrice: 100 }]);
    const text = await quoteText(order.id);
    expect(text).toContain("Total excl. VAT SEK200.00");
    expect(text).toContain("VAT (25%) on 200.0050.00");
    expect(text).toContain("Total incl. VAT SEK250.00");
    expect(text).not.toContain("Amount due");
    expect(text).not.toContain("Summa");
    expect(text).not.toContain("Moms");
  });

  it("a row at price 0 counts as 0 — an order row always has a price, so there is no 'exkl. rader utan pris' total", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const free = await makeArticle("purchased");
    const { order } = await quote(customer.id, [
      { articleId: goods.id, quantity: 2, unitPrice: 100 },
      { articleId: free.id, quantity: 5, unitPrice: 0 },
    ]);
    const text = await quoteText(order.id);
    expect(text).toContain("Summa exkl. moms SEK200,00");
    expect(text).toContain("Moms (25 %) på 200,0050,00");
    expect(text).toContain("Summa inkl. moms SEK250,00");
    expect(text).not.toContain("exkl. rader utan pris");
  });

  it("a quote in another currency: the sums in the order's currency, no Moms i SEK line", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const { order } = await quote(customer.id, [{ articleId: goods.id, quantity: 2, unitPrice: 100 }], { currency: "EUR", exchangeRate: 11 });
    const text = await quoteText(order.id);
    expect(text).toContain("Summa exkl. moms EUR200,00");
    expect(text).toContain("Moms (25 %) på 200,0050,00");
    expect(text).toContain("Summa inkl. moms EUR250,00");
    expect(text).not.toContain("Moms i SEK");
  });
});

describe("GET /sales-orders/:id — vatSummary", () => {
  it("carries the same figures as the PDF, per rate and code, with the codes' Swedish names", async () => {
    const customer = await makeCustomer({ language: "en" });
    const a25 = await makeArticle("purchased");
    const a12 = await makeArticle("purchased", 12);
    const { order } = await quote(customer.id, [
      { articleId: a12.id, quantity: 7, unitPrice: 1.115 },
      { articleId: a25.id, quantity: 3, unitPrice: 33.33 },
      { articleId: a25.id, quantity: 1, unitPrice: 1000, discountPercent: 10 },
    ]);
    expect((await salesService.getSalesOrder(order.id))!.vatSummary).toEqual({
      lines: [
        { code: "MP25", name: "Moms 25 %", rate: 25, net: 999.99, vatAmount: 250 },
        { code: "MP12", name: "Moms 12 %", rate: 12, net: 7.81, vatAmount: 0.94 },
      ],
      totalExclVat: 1007.8,
      vatAmount: 250.94,
      totalInclVat: 1258.74,
    });
  });

  it("an EU customer has a 0 % line with the code's name; a private person gets the ordinary summary", async () => {
    const de = await makeCustomer({ name: "Kunde GmbH", country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const eu = await quote(de.id, [{ articleId: goods.id, quantity: 1, unitPrice: 100 }]);
    expect((await salesService.getSalesOrder(eu.order.id))!.vatSummary).toEqual({
      lines: [{ code: "EUV", name: "Varor till annat EU-land", rate: 0, net: 100, vatAmount: 0 }],
      totalExclVat: 100,
      vatAmount: 0,
      totalInclVat: 100,
    });

    const privat = await makeCustomer({ name: "Privat Person", privatePerson: true });
    const own = await quote(privat.id, [{ articleId: goods.id, quantity: 1, unitPrice: 100 }]);
    expect((await salesService.getSalesOrder(own.order.id))!.vatSummary).toMatchObject({ totalExclVat: 100, vatAmount: 25, totalInclVat: 125 });
  });

  it("agrees with the invoice issued for the order: the same net and VAT per rate", async () => {
    const customer = await makeCustomer();
    const a25 = await makeArticle("purchased");
    const a12 = await makeArticle("purchased", 12);
    const location = await stockService.createLocation(parsed(createStockLocationSchema, {
      warehouseId: (await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID().slice(0, 6)}`, active: true }))!.id,
      name: "A1",
      active: true,
    }));
    for (const articleId of [a25.id, a12.id]) {
      await stockService.recordTransaction({ articleId, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });
    }
    const { order, rows } = await quote(
      customer.id,
      [
        { articleId: a12.id, quantity: 7, unitPrice: 1.115 },
        { articleId: a25.id, quantity: 3, unitPrice: 33.33 },
        { articleId: a25.id, quantity: 3, unitPrice: 0.06 },
        { articleId: a25.id, quantity: 1, unitPrice: 1000, discountPercent: 12.5 },
      ],
      { confirm: true }
    );
    await salesService.startProduction(order.id);
    await salesService.deliverBatch(
      order.id,
      { locationId: location.id, rows: rows.map((r) => ({ rowId: r.id, quantity: Number(r.quantityOrdered) })) },
      user.id
    );
    const summary = (await salesService.getSalesOrder(order.id))!.vatSummary!;

    const [invoiceable] = await invoiceService.listInvoiceableOrders(customer.id);
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: invoiceable!.rows.map((r) => ({
          articleId: r.articleId,
          salesOrderRowId: r.salesOrderRowId,
          description: r.articleName,
          quantity: r.rest,
          unitPrice: Number(r.unitPrice),
          discountPercent: Number(r.discountPercent),
        })),
      },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, user.id);
    const invoice = await invoiceService.getInvoice(issued!.id);
    const perRate = new Map<number, { net: number; vatAmount: number }>();
    for (const row of invoice!.rows) {
      const group = perRate.get(Number(row.vatRate)) ?? { net: 0, vatAmount: 0 };
      group.net += Number(row.lineAmount);
      group.vatAmount += Number(row.vatAmount);
      perRate.set(Number(row.vatRate), group);
    }
    expect(invoice!.rows).toHaveLength(4);
    expect(summary.lines).toHaveLength(2);
    for (const line of summary.lines) {
      expect(perRate.get(line.rate)!.net).toBeCloseTo(line.net, 6);
      expect(perRate.get(line.rate)!.vatAmount).toBeCloseTo(line.vatAmount, 6);
    }
    // And the invoice PDF prints the very lines the order confirmation did.
    const confirmation = await quoteText(order.id, "confirmation");
    const invoiceText = pdfText((await invoiceService.renderPdf(issued!.id)).content);
    const vatLines = (text: string) => [...text.matchAll(/Moms \(\d+ %\) på [\d ]+,\d\d[\d ]+,\d\d/g)].map((m) => m[0]);
    expect(vatLines(confirmation)).toHaveLength(2);
    expect(vatLines(invoiceText)).toEqual(vatLines(confirmation));
    expect(invoiceText).toContain("Att betala SEK");
    expect(confirmation).toContain(`Summa inkl. moms SEK${invoiceText.split("Att betala SEK")[1]!.match(/^[\d ]+,\d\d/)![0]}`);
  });
});

describe("GET /sales-orders/:id — route", () => {
  const app = buildApp();
  const authService = createAuthService(authRepo, "unused", auditRepository);
  beforeAll(async () => {
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  async function session(role: "admin" | "user") {
    const email = `moms-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "Användare", role, permissionGroupId: null });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return { cookie: `session=${login.cookies.find((c) => c.name === "session")!.value}` };
  }

  it("answers with vatSummary for an office user; a user without price permission (no menu) cannot read the order at all", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const { order } = await quote(customer.id, [{ articleId: goods.id, quantity: 2, unitPrice: 100 }]);

    const office = await app.inject({ url: `/api/v1/sales-orders/${order.id}`, headers: await session("admin") });
    expect(office.statusCode).toBe(200);
    expect(office.json().vatSummary).toEqual({
      lines: [{ code: "MP25", name: "Moms 25 %", rate: 25, net: 200, vatAmount: 50 }],
      totalExclVat: 200,
      vatAmount: 50,
      totalInclVat: 250,
    });

    // Prices are office data: the route's read rule is `office`, the same
    // rule canSeePrices is — the workshop profile gets no part of the card.
    const workshop = await app.inject({ url: `/api/v1/sales-orders/${order.id}`, headers: await session("user") });
    expect(workshop.statusCode).toBe(403);
    expect(workshop.body).not.toContain("vatSummary");
  });
});
