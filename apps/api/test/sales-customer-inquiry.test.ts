import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService, InvalidStatusTransitionError } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
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
import { pdfText } from "./helpers/pdf.js";

// Kundens förfrågan (migration 0139): the customer's inquiry/RFQ reference on
// a quote or order — set on create, edited through the header PATCH under
// the same status guard as Kundens ordernummer, printed as "Er förfrågan:"
// on the quote and the order confirmation.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const fakeTransportFactory: MailTransportFactory = () => ({ async sendMail() {} });
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  createMailService(createMailRepository(db), systemService, fakeTransportFactory),
  createDocumentPdfService(systemService),
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  createAuditRepository(db)
);

const TRUNCATE = sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customers, articles, user_settings, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `inquiry-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Säljare",
    role: "admin",
  });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

async function makeArticle() {
  return articleService.createArticle({
    articleNumber: `ART-FQ-${crypto.randomUUID().slice(0, 8)}`,
    name: "Diskbänk",
    type: "purchased",
    unit: "st",
    active: true,
  });
}

async function makeOrder(fields: { customerInquiryNumber?: string; customerOrderNumber?: string; confirm?: boolean }) {
  const user = await makeUser();
  const customer = await makeCustomer();
  const article = await makeArticle();
  const { order } = await salesService.createQuote(
    { customerId: customer.id, confirm: false, ...fields, rows: [{ articleId: article.id, quantity: 1, unitPrice: 100 }] },
    user.id
  );
  return order;
}

describe("Kundens förfrågan on the order", () => {
  it("is stored on create and returned on the detail and the list", async () => {
    const order = await makeOrder({ customerInquiryNumber: "RFQ-2026-17" });
    expect(order.customerInquiryNumber).toBe("RFQ-2026-17");
    expect(order.customerOrderNumber).toBeNull();
    const fetched = await salesService.getSalesOrder(order.id);
    expect(fetched!.customerInquiryNumber).toBe("RFQ-2026-17");
    const list = await salesService.listSalesOrders({ limit: 50, offset: 0 });
    expect(list.rows.find((r) => r.id === order.id)!.customerInquiryNumber).toBe("RFQ-2026-17");
  });

  it("is null when omitted", async () => {
    const order = await makeOrder({});
    expect(order.customerInquiryNumber).toBeNull();
  });

  it("the header PATCH sets and clears it while quote/confirmed, and refuses it after cancel", async () => {
    const order = await makeOrder({});
    const set = await salesService.updateSalesOrderHeader(order.id, { customerInquiryNumber: "FRF-88" });
    expect(set.customerInquiryNumber).toBe("FRF-88");

    await salesService.confirm(order.id);
    // Omitted leaves it untouched; another field changes alone.
    const untouched = await salesService.updateSalesOrderHeader(order.id, { customerOrderNumber: "PO-1" });
    expect(untouched).toMatchObject({ customerInquiryNumber: "FRF-88", customerOrderNumber: "PO-1" });
    const cleared = await salesService.updateSalesOrderHeader(order.id, { customerInquiryNumber: null });
    expect(cleared.customerInquiryNumber).toBeNull();
    expect(cleared.customerOrderNumber).toBe("PO-1");

    await salesService.cancel(order.id);
    await expect(salesService.updateSalesOrderHeader(order.id, { customerInquiryNumber: "X" })).rejects.toThrow(
      InvalidStatusTransitionError
    );
  });
});

describe("documents", () => {
  it("the quote prints Er förfrågan and no Ert ordernummer when it has none", async () => {
    const order = await makeOrder({ customerInquiryNumber: "RFQ-2026-17" });
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).toContain("Er förfrågan: RFQ-2026-17");
    expect(text).not.toContain("Ert ordernummer");
  });

  it("an older quote with a customer order number still prints it", async () => {
    const order = await makeOrder({ customerOrderNumber: "PO-4711" });
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).toContain("Ert ordernummer: PO-4711");
    expect(text).not.toContain("Er förfrågan");
  });

  it("the order confirmation prints Ert ordernummer and Er förfrågan", async () => {
    const order = await makeOrder({ customerInquiryNumber: "RFQ-2026-17" });
    await salesService.confirm(order.id);
    await salesService.updateSalesOrderHeader(order.id, { customerOrderNumber: "PO-4711" });
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "confirmation")).content);
    expect(text).toContain("Ert ordernummer: PO-4711");
    expect(text).toContain("Er förfrågan: RFQ-2026-17");
  });

  it("no Er förfrågan line on a confirmation without one", async () => {
    const order = await makeOrder({ customerOrderNumber: "PO-4711", confirm: true });
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "confirmation")).content);
    expect(text).toContain("Ert ordernummer: PO-4711");
    expect(text).not.toContain("Er förfrågan");
  });
});

describe("HTTP contract", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("POST /quotes takes customerInquiryNumber, PATCH sets and clears it, the CSV has Kundens förfrågan", async () => {
    app = buildApp();
    const password = "ett-tillräckligt-långt-lösenord";
    const register = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "admin@example.com", password, name: "Admin", setupCode: app.setup.code.code },
    });
    expect(register.statusCode).toBe(201);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password } });
    const cookie = `session=${login.cookies.find((c) => c.name === "session")!.value}`;

    const customer = await makeCustomer();
    const article = await makeArticle();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers: { cookie },
      payload: {
        customerId: customer.id,
        customerInquiryNumber: "RFQ-9",
        rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }],
      },
    });
    expect(created.statusCode).toBe(201);
    const quote = created.json().order as { id: string; orderNumber: string; customerInquiryNumber: string };
    expect(quote.customerInquiryNumber).toBe("RFQ-9");

    const tooLong = await app.inject({
      method: "PATCH",
      url: `/api/v1/sales-orders/${quote.id}`,
      headers: { cookie },
      payload: { customerInquiryNumber: "x".repeat(51) },
    });
    expect(tooLong.statusCode).toBe(400);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/sales-orders/${quote.id}`,
      headers: { cookie },
      payload: { customerInquiryNumber: "RFQ-10", bumpRevision: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().customerInquiryNumber).toBe("RFQ-10");

    const csv = await app.inject({ url: "/api/v1/sales-orders/csv?kind=quote", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split(/\r?\n/)[0]).toContain("Kundens ordernr;Kundens förfrågan;Kundens referens");
    expect(csv.body).toContain(";RFQ-10;");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/sales-orders/${quote.id}`,
      headers: { cookie },
      payload: { customerInquiryNumber: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().customerInquiryNumber).toBeNull();

    await app.inject({ method: "POST", url: `/api/v1/sales-orders/${quote.id}/cancel`, headers: { cookie } });
    const refused = await app.inject({
      method: "PATCH",
      url: `/api/v1/sales-orders/${quote.id}`,
      headers: { cookie },
      payload: { customerInquiryNumber: "RFQ-11" },
    });
    expect(refused.statusCode).toBe(409);
  });
});
