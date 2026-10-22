import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, numberSeries, quoteLossReasons, salesOrders } from "@navet/db";
import { salesDocumentKind } from "@navet/shared";
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
import { createMailService, MailSendError, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";

// Offerter (migration 0138): a quote is numbered from the OF- series and
// takes the next KO- number when it becomes an order, through every path
// (Bekräfta, the order confirmation mail, the manual status override), with
// the OF- number kept as quote_number. Also the derived document kind, the
// kind filter and the search on the quote number, and the documents.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const auditRepository = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db));

const sentMails: { subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
let failNextSend = false;
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("SMTP connection refused");
    }
    sentMails.push(opts);
  },
});
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const salesRepo = createSalesRepository(db);
const salesService = createSalesService(
  salesRepo,
  registerService,
  mailService,
  createDocumentPdfService(systemService),
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository
);

const TRUNCATE = sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customers, quote_loss_reasons, articles, user_settings, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  sentMails.length = 0;
  failNextSend = false;
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// The series counters survive TRUNCATE (number_series is seeded by the
// migrations), so the tests compare before/after instead of fixed numbers.
async function nextNumber(key: "quote" | "sales_order") {
  const [row] = await db.select({ next: numberSeries.nextNumber }).from(numberSeries).where(eq(numberSeries.key, key));
  return row!.next;
}

async function makeUser() {
  return authRepo.create({
    email: `quote-no-${crypto.randomUUID()}@example.com`,
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
    articleNumber: `ART-OF-${crypto.randomUUID().slice(0, 8)}`,
    name: "Diskbänk",
    type: "purchased",
    unit: "st",
    active: true,
  });
}

async function makeQuote(confirm = false) {
  const user = await makeUser();
  const customer = await makeCustomer();
  const article = await makeArticle();
  const { order } = await salesService.createQuote(
    { customerId: customer.id, confirm, rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }] },
    user.id
  );
  return { order, customer, user };
}

describe("numbering", () => {
  it("a quote takes an OF- number, written to both order_number and quote_number", async () => {
    const before = await nextNumber("sales_order");
    const { order } = await makeQuote();
    expect(order.orderNumber).toMatch(/^OF-\d+$/);
    expect(order.quoteNumber).toBe(order.orderNumber);
    expect(order.documentKind).toBe("quote");
    expect(await nextNumber("sales_order")).toBe(before);
  });

  it("a direct order (Ny kundorder) takes a KO- number and burns no OF- number", async () => {
    const before = await nextNumber("quote");
    const { order } = await makeQuote(true);
    expect(order.status).toBe("confirmed");
    expect(order.orderNumber).toMatch(/^KO-\d+$/);
    expect(order.quoteNumber).toBeNull();
    expect(order.documentKind).toBe("order");
    expect(await nextNumber("quote")).toBe(before);
  });

  it("Bekräfta gives the next KO- number and keeps the OF- number as reference", async () => {
    const { order } = await makeQuote();
    const before = await nextNumber("sales_order");
    const confirmed = await salesService.confirm(order.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.orderNumber).toMatch(/^KO-\d+$/);
    expect(confirmed.quoteNumber).toBe(order.orderNumber);
    expect(confirmed.documentKind).toBe("order");
    expect(await nextNumber("sales_order")).toBe(before + 1);

    const detail = await salesService.getSalesOrder(order.id);
    expect(detail).toMatchObject({ orderNumber: confirmed.orderNumber, quoteNumber: order.orderNumber, documentKind: "order" });
  });

  it("the manual status override to an order status gives the KO- number too", async () => {
    const { order } = await makeQuote();
    const updated = await salesService.setStatus(order.id, "in_production");
    expect(updated!.orderNumber).toMatch(/^KO-\d+$/);
    expect(updated!.quoteNumber).toBe(order.orderNumber);
  });

  it("Förlorad, Öppna igen and Makulera keep the OF- number", async () => {
    const { order, user } = await makeQuote();
    const before = await nextNumber("sales_order");
    const [reason] = await db.insert(quoteLossReasons).values({ code: "PRIS", name: "Pris" }).returning();
    const lost = await salesService.lose(order.id, { lossReasonId: reason!.id }, user.id);
    expect(lost).toMatchObject({ orderNumber: order.orderNumber, documentKind: "quote" });
    const reopened = await salesService.reopen(order.id, user.id);
    expect(reopened).toMatchObject({ orderNumber: order.orderNumber, status: "quote" });
    const cancelled = await salesService.cancel(order.id, user.id);
    expect(cancelled).toMatchObject({ orderNumber: order.orderNumber, status: "cancelled", documentKind: "quote" });
    // The manual override to lost/cancelled is no order status either.
    await salesService.setStatus(order.id, "lost");
    expect((await salesService.getSalesOrder(order.id))!.orderNumber).toBe(order.orderNumber);
    expect(await nextNumber("sales_order")).toBe(before);
  });

  it("a conditional confirm that loses (the quote moved on) burns no KO- number", async () => {
    const { order } = await makeQuote();
    await salesService.setStatus(order.id, "lost");
    const before = await nextNumber("sales_order");
    expect(await salesRepo.updateStatus(order.id, "confirmed", null, "quote")).toBeNull();
    await expect(salesService.confirm(order.id)).rejects.toThrow(InvalidStatusTransitionError);
    expect(await nextNumber("sales_order")).toBe(before);
    expect((await salesService.getSalesOrder(order.id))!.orderNumber).toBe(order.orderNumber);
  });

  it("two concurrent confirmations give one KO- number", async () => {
    const { order } = await makeQuote();
    const before = await nextNumber("sales_order");
    const results = await Promise.allSettled([salesService.confirm(order.id), salesService.confirm(order.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await nextNumber("sales_order")).toBe(before + 1);
  });

  it("an older quote (KO- number, no quote_number) keeps its number on confirm", async () => {
    const customer = await makeCustomer();
    const [legacy] = await db
      .insert(salesOrders)
      .values({ orderNumber: `KO-L${crypto.randomUUID().slice(0, 6)}`, customerId: customer.id, status: "quote", quoted: true })
      .returning();
    const before = await nextNumber("sales_order");
    const confirmed = await salesService.confirm(legacy!.id);
    expect(confirmed.orderNumber).toBe(legacy!.orderNumber);
    expect(confirmed.quoteNumber).toBeNull();
    expect(await nextNumber("sales_order")).toBe(before);
  });

  it("back to quote keeps the KO- number, and a new confirmation draws none", async () => {
    const { order } = await makeQuote();
    const confirmed = await salesService.confirm(order.id);
    const back = await salesService.setStatus(order.id, "quote");
    expect(back).toMatchObject({ orderNumber: confirmed.orderNumber, quoteNumber: order.orderNumber, documentKind: "quote" });
    const before = await nextNumber("sales_order");
    const again = await salesService.confirm(order.id);
    expect(again.orderNumber).toBe(confirmed.orderNumber);
    expect(await nextNumber("sales_order")).toBe(before);
  });

  it("the confirmation mail confirms with the KO- number and attaches it", async () => {
    const { order } = await makeQuote();
    const result = await salesService.sendSalesOrderEmail(order.id, {
      to: "kund@example.com",
      subject: "Orderbekräftelse",
      message: "",
      variant: "confirmation",
      attachDrawings: false,
    });
    expect(result!.status).toBe("confirmed");
    expect(result!.orderNumber).toMatch(/^KO-\d+$/);
    expect(result!.quoteNumber).toBe(order.orderNumber);
    const attachment = sentMails[0]!.attachments![0]!;
    expect(attachment.filename).toBe(`Orderbekraftelse-${result!.orderNumber}.pdf`);
    const text = pdfText(attachment.content);
    expect(text).toContain(`Orderbekräftelse ${result!.orderNumber}`);
    expect(text).toContain(`Vår offert: ${order.orderNumber}`);
  });

  it("a failed confirmation mail keeps the reserved KO- number for the retry, Förlorad gives the OF- number back", async () => {
    const { order } = await makeQuote();
    failNextSend = true;
    await expect(
      salesService.sendSalesOrderEmail(order.id, {
        to: "kund@example.com",
        subject: "Orderbekräftelse",
        message: "",
        variant: "confirmation",
        attachDrawings: false,
      })
    ).rejects.toThrow(MailSendError);
    const after = await salesService.getSalesOrder(order.id);
    expect(after).toMatchObject({ status: "quote", quoteNumber: order.orderNumber, documentKind: "quote" });
    expect(after!.orderNumber).toMatch(/^KO-\d+$/);

    // The retry prints and keeps the same number — nothing new is drawn.
    const before = await nextNumber("sales_order");
    const retried = await salesService.sendSalesOrderEmail(order.id, {
      to: "kund@example.com",
      subject: "Orderbekräftelse",
      message: "",
      variant: "confirmation",
      attachDrawings: false,
    });
    expect(retried).toMatchObject({ status: "confirmed", orderNumber: after!.orderNumber });
    expect(pdfText(sentMails.at(-1)!.attachments![0]!.content)).toContain(`Orderbekräftelse ${after!.orderNumber}`);
    expect(await nextNumber("sales_order")).toBe(before);
  });

  it("a quote holding a reserved KO- number goes back to its OF- number when it is lost or cancelled", async () => {
    for (const end of ["lost", "cancelled"] as const) {
      const { order } = await makeQuote();
      failNextSend = true;
      await expect(
        salesService.sendSalesOrderEmail(order.id, {
          to: "kund@example.com",
          subject: "Orderbekräftelse",
          message: "",
          variant: "confirmation",
          attachDrawings: false,
        })
      ).rejects.toThrow(MailSendError);
      const ended = end === "lost" ? await salesService.setStatus(order.id, "lost") : await salesService.cancel(order.id);
      expect(ended).toMatchObject({ status: end, orderNumber: order.orderNumber, documentKind: "quote" });
    }
  });
});

describe("document kind, kind filter and search", () => {
  it("salesDocumentKind: quote/lost and a cancelled quote are quotes, everything else orders", () => {
    expect(salesDocumentKind({ status: "quote", orderNumber: "KO-1", quoteNumber: null })).toBe("quote");
    expect(salesDocumentKind({ status: "lost", orderNumber: "OF-1", quoteNumber: "OF-1" })).toBe("quote");
    expect(salesDocumentKind({ status: "cancelled", orderNumber: "OF-1", quoteNumber: "OF-1" })).toBe("quote");
    expect(salesDocumentKind({ status: "cancelled", orderNumber: "KO-2", quoteNumber: "OF-1" })).toBe("order");
    expect(salesDocumentKind({ status: "cancelled", orderNumber: "KO-2", quoteNumber: null })).toBe("order");
    expect(salesDocumentKind({ status: "confirmed", orderNumber: "KO-2", quoteNumber: "OF-1" })).toBe("order");
  });

  it("filters the list on the derived kind and finds an order on its OF- number", async () => {
    const { order: open } = await makeQuote();
    const { order: won } = await makeQuote();
    const confirmed = await salesService.confirm(won.id);
    const { order: cancelledQuote } = await makeQuote();
    await salesService.cancel(cancelledQuote.id);
    const { order: cancelledOrder } = await makeQuote();
    await salesService.confirm(cancelledOrder.id);
    await salesService.cancel(cancelledOrder.id);
    const { order: direct } = await makeQuote(true);

    const quotes = await salesService.listSalesOrders({ limit: 50, offset: 0, kind: "quote" });
    expect(quotes.rows.map((r) => r.id).sort()).toEqual([open.id, cancelledQuote.id].sort());
    expect(quotes.total).toBe(2);
    expect(quotes.rows.every((r) => r.documentKind === "quote")).toBe(true);

    const orders = await salesService.listSalesOrders({ limit: 50, offset: 0, kind: "order" });
    expect(orders.rows.map((r) => r.id).sort()).toEqual([won.id, cancelledOrder.id, direct.id].sort());
    expect(orders.rows.find((r) => r.id === won.id)).toMatchObject({ quoteNumber: won.orderNumber, documentKind: "order" });

    // The status filter still applies on top of the kind.
    const cancelledQuotes = await salesService.listSalesOrders({ limit: 50, offset: 0, kind: "quote", status: ["cancelled"] });
    expect(cancelledQuotes.rows.map((r) => r.id)).toEqual([cancelledQuote.id]);

    const found = await salesService.listSalesOrders({ limit: 50, offset: 0, search: won.orderNumber });
    expect(found.rows.map((r) => r.orderNumber)).toEqual([confirmed.orderNumber]);
  });
});

describe("documents", () => {
  it("the quote prints its OF- number even after confirmation; the confirmation prints KO- and Vår offert", async () => {
    const { order } = await makeQuote();
    const confirmed = await salesService.confirm(order.id);
    const quotePdf = await salesService.getSalesOrderPdf(order.id, "quote");
    expect(quotePdf.filename).toBe(`Offert-${order.orderNumber}.pdf`);
    expect(pdfText(quotePdf.content)).toContain(`Offert ${order.orderNumber}`);

    const confirmation = await salesService.getSalesOrderPdf(order.id, "confirmation");
    expect(confirmation.filename).toBe(`Orderbekraftelse-${confirmed.orderNumber}.pdf`);
    const text = pdfText(confirmation.content);
    expect(text).toContain(`Orderbekräftelse ${confirmed.orderNumber}`);
    expect(text).toContain(`Vår offert: ${order.orderNumber}`);
  });

  it("no Vår offert line on a direct order", async () => {
    const { order } = await makeQuote(true);
    const confirmation = await salesService.getSalesOrderPdf(order.id, "confirmation");
    expect(pdfText(confirmation.content)).not.toContain("Vår offert");
  });
});

describe("HTTP contract", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("POST /quotes answers OF-, ?kind filters, a bad kind is 400, confirm answers the KO- number", async () => {
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
      payload: { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }] },
    });
    expect(created.statusCode).toBe(201);
    const quote = created.json().order as { id: string; orderNumber: string; quoteNumber: string; documentKind: string };
    expect(quote).toMatchObject({ quoteNumber: quote.orderNumber, documentKind: "quote" });
    expect(quote.orderNumber).toMatch(/^OF-/);

    const list = await app.inject({ url: "/api/v1/sales-orders?kind=quote", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows.map((r: { id: string }) => r.id)).toEqual([quote.id]);
    expect((await app.inject({ url: "/api/v1/sales-orders?kind=order", headers: { cookie } })).json().total).toBe(0);
    expect((await app.inject({ url: "/api/v1/sales-orders?kind=offert", headers: { cookie } })).statusCode).toBe(400);
    const csv = await app.inject({ url: "/api/v1/sales-orders/csv?kind=quote", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toContain("offerter-");
    expect(csv.body.split(/\r?\n/)[0]).toContain("Ordernummer;Offertnummer;Kund");
    expect(csv.body).toContain(`${quote.orderNumber};${quote.orderNumber};Kund AB`);

    const confirmed = await app.inject({ method: "POST", url: `/api/v1/sales-orders/${quote.id}/confirm`, headers: { cookie } });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "confirmed", quoteNumber: quote.orderNumber, documentKind: "order" });
    expect(confirmed.json().orderNumber).toMatch(/^KO-/);

    const detail = await app.inject({ url: `/api/v1/sales-orders/${quote.id}`, headers: { cookie } });
    expect(detail.json()).toMatchObject({ quoteNumber: quote.orderNumber, documentKind: "order" });
  });
});
