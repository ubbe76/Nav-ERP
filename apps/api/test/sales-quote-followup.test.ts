import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, quoteLossReasons, salesOrders } from "@navet/db";
import { createQuoteSchema, updateSalesOrderHeaderSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import {
  createSalesService,
  InvalidStatusTransitionError,
  QuoteLossReasonInvalidError,
} from "../src/modules/sales/service/sales.service.js";
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
import { addDays, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { pdfText } from "./helpers/pdf.js";
import { testDocumentPdfService } from "./helpers/services.js";

// Uppföljning av offerter against Postgres: Giltig t.o.m. (default, 0
// days, explicit, never on a direct order), the header PATCH guard, Förlorad
// and Öppna igen through every status, the lock on a lost quote, the manual
// status override and that a lost quote is never demand.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const auditRepository = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const sentMails: { to: string }[] = [];
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    sentMails.push(opts);
  },
});
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository
);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, articleService);
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: {
    createPurchaseOrder: async () => {
      throw new Error("not used");
    },
    addRow: async () => {},
    cancel: async () => {},
  },
  manufacturing: mfgService,
  requirementsCacheMs: 0,
});

const TRUNCATE = sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customers, quote_loss_reasons, stock_transactions,
  stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  sentMails.length = 0;
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local", quoteValidityDays: 30 });
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await systemService.updateSettings({ quoteValidityDays: 30 });
});

const today = () => stockholmToday();

async function makeUser() {
  return authRepo.create({ email: `q-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Säljare", role: "admin" });
}

async function makeReason(code = "PRIS", name = "Pris", active = true) {
  return registerService.quoteLossReasons.create({ code, name, active });
}

async function fixture() {
  const user = await makeUser();
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  const article = await articleService.createArticle({
    articleNumber: `ART-${crypto.randomUUID().slice(0, 8)}`,
    name: "Diskbänk",
    type: "purchased",
    unit: "st",
    active: true,
    reorderPoint: 0,
  });
  return { user, customer, article };
}

async function makeQuote(extra: Record<string, unknown> = {}) {
  const f = await fixture();
  const input = createQuoteSchema.parse({
    customerId: f.customer.id,
    rows: [{ articleId: f.article.id, quantity: 2, unitPrice: 100 }],
    ...extra,
  });
  const { order } = await salesService.createQuote(input, f.user.id);
  return { ...f, order };
}

async function auditEntries(orderNumber: string, action: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.entityId, orderNumber), eq(auditLog.action, action)));
}

describe("Giltig t.o.m.", () => {
  it("defaults to today + Offertens giltighetstid and marks the order as quoted", async () => {
    const { order } = await makeQuote();
    expect(order.quoted).toBe(true);
    expect(order.quoteValidUntil).toBe(addDays(today(), 30));
    expect(order.status).toBe("quote");
  });

  it("follows the setting: 10 days, and 0 days means no validity date", async () => {
    await systemService.updateSettings({ quoteValidityDays: 10 });
    expect((await makeQuote()).order.quoteValidUntil).toBe(addDays(today(), 10));
    await systemService.updateSettings({ quoteValidityDays: 0 });
    expect((await makeQuote()).order.quoteValidUntil).toBeNull();
  });

  it("takes the caller's date, and null as explicitly none", async () => {
    expect((await makeQuote({ quoteValidUntil: "2031-06-30" })).order.quoteValidUntil).toBe("2031-06-30");
    expect((await makeQuote({ quoteValidUntil: null })).order.quoteValidUntil).toBeNull();
  });

  it("a direct order (confirm: true) is not a quote: quoted = false, no validity date even when sent", async () => {
    const { order } = await makeQuote({ confirm: true, quoteValidUntil: "2031-06-30" });
    expect(order.status).toBe("confirmed");
    expect(order.quoted).toBe(false);
    expect(order.quoteValidUntil).toBeNull();
  });

  it("the header PATCH changes it on a quote (revision bumped) and refuses it on a confirmed order", async () => {
    const { order } = await makeQuote();
    const updated = await salesService.updateSalesOrderHeader(order.id, updateSalesOrderHeaderSchema.parse({ quoteValidUntil: "2031-01-31" }));
    expect(updated!.quoteValidUntil).toBe("2031-01-31");
    expect(updated!.revision).toBe(2);
    const cleared = await salesService.updateSalesOrderHeader(order.id, updateSalesOrderHeaderSchema.parse({ quoteValidUntil: null }));
    expect(cleared!.quoteValidUntil).toBeNull();

    await salesService.confirm(order.id);
    await expect(
      salesService.updateSalesOrderHeader(order.id, updateSalesOrderHeaderSchema.parse({ quoteValidUntil: "2031-01-31" }))
    ).rejects.toThrow(InvalidStatusTransitionError);
    // Other header fields still work on a confirmed order.
    const note = await salesService.updateSalesOrderHeader(order.id, updateSalesOrderHeaderSchema.parse({ customerReference: "Anna" }));
    expect(note!.customerReference).toBe("Anna");
  });

  it("is printed on the quote PDF only, as 'Offerten gäller till och med <date>.'", async () => {
    const { order } = await makeQuote({ quoteValidUntil: "2031-06-30" });
    const quote = await salesService.getSalesOrderPdf(order.id, "quote");
    expect(pdfText(quote.content)).toContain("Offerten gäller till och med 2031-06-30.");
    const confirmation = await salesService.getSalesOrderPdf(order.id, "confirmation");
    expect(pdfText(confirmation.content)).not.toContain("Offerten gäller");

    const undated = await makeQuote({ quoteValidUntil: null });
    expect(pdfText((await salesService.getSalesOrderPdf(undated.order.id, "quote")).content)).not.toContain("Offerten gäller");
  });
});

describe("Förlorad / Öppna igen", () => {
  it("lose from quote sets status, reason, note, when and who, and logs 'lost' with the reason", async () => {
    const { order, user } = await makeQuote();
    const reason = await makeReason();
    const lost = await salesService.lose(order.id, { lossReasonId: reason.id, lossNote: "  För dyrt  " }, user.id);
    expect(lost!.status).toBe("lost");
    expect(lost!.lostReasonId).toBe(reason.id);
    expect(lost!.lostReasonCode).toBe("PRIS");
    expect(lost!.lostReasonName).toBe("Pris");
    expect(lost!.lostNote).toBe("För dyrt");
    expect(lost!.lostAt).toBeInstanceOf(Date);
    expect(lost!.lostBy).toBe(user.id);
    expect(lost!.lostByName).toBe("Säljare");
    // The validity date survives — the user sees and may change it after reopen.
    expect(lost!.quoteValidUntil).toBe(order.quoteValidUntil);

    const [entry] = await auditEntries(order.orderNumber, "lost");
    expect(entry!.detail).toEqual({ reasonCode: "PRIS", reasonName: "Pris", note: "För dyrt" });
    expect(entry!.userId).toBe(user.id);

    // The list carries the same fields.
    const list = await salesService.listSalesOrders({ limit: 10, offset: 0, status: ["lost"] });
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ id: order.id, lostReasonCode: "PRIS", lostReasonName: "Pris", lostByName: "Säljare" });
  });

  it("lose refuses every status but quote, and reopen every status but lost", async () => {
    const reason = await makeReason();
    for (const status of ["confirmed", "in_production", "delivered", "invoiced", "cancelled", "lost"] as const) {
      const { order, user } = await makeQuote();
      await salesService.setStatus(order.id, status, user.id);
      await expect(salesService.lose(order.id, { lossReasonId: reason.id }, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    }
    for (const status of ["quote", "confirmed", "in_production", "delivered", "invoiced", "cancelled"] as const) {
      const { order, user } = await makeQuote();
      await salesService.setStatus(order.id, status, user.id);
      await expect(salesService.reopen(order.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    }
  });

  it("an inactive or unknown reason is refused (400) and nothing changes", async () => {
    const { order, user } = await makeQuote();
    const inactive = await makeReason("GAMMAL", "Gammal orsak", false);
    await expect(salesService.lose(order.id, { lossReasonId: inactive.id }, user.id)).rejects.toThrow(QuoteLossReasonInvalidError);
    await expect(salesService.lose(order.id, { lossReasonId: crypto.randomUUID() }, user.id)).rejects.toThrow(QuoteLossReasonInvalidError);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("quote");
    expect(await auditEntries(order.orderNumber, "lost")).toHaveLength(0);
  });

  it("reopen takes the quote back, clears the lost columns and logs the old reason", async () => {
    const { order, user } = await makeQuote();
    const reason = await makeReason();
    await salesService.lose(order.id, { lossReasonId: reason.id, lossNote: "Sent" }, user.id);
    const reopened = await salesService.reopen(order.id, user.id);
    expect(reopened!.status).toBe("quote");
    expect(reopened!.lostReasonId).toBeNull();
    expect(reopened!.lostNote).toBeNull();
    expect(reopened!.lostAt).toBeNull();
    expect(reopened!.lostBy).toBeNull();
    expect(reopened!.quoteValidUntil).toBe(order.quoteValidUntil);
    const [entry] = await auditEntries(order.orderNumber, "reopened");
    expect(entry!.detail).toEqual({ previousReasonCode: "PRIS", previousReasonName: "Pris", previousNote: "Sent" });
    // ...and it can be lost again, or confirmed.
    await salesService.confirm(order.id);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("confirmed");
  });

  it("a confirm that read the quote before a concurrent Förlorad does not overwrite it", async () => {
    const { order, user } = await makeQuote();
    const reason = await makeReason();
    await salesService.lose(order.id, { lossReasonId: reason.id }, user.id);
    // The confirm path's conditional update: the order is no longer a quote.
    expect(await createSalesRepository(db).updateStatus(order.id, "confirmed", null, "quote")).toBeNull();
    const after = await salesService.getSalesOrder(order.id);
    expect(after!.status).toBe("lost");
    expect(after!.lostReasonId).toBe(reason.id);
  });

  it("a lost quote is locked like a cancelled order: no rows, no header, no PDF, no e-mail, no cancel", async () => {
    const { order, user, article } = await makeQuote();
    const reason = await makeReason();
    await salesService.lose(order.id, { lossReasonId: reason.id }, user.id);
    const rows = await salesService.listRows(order.id);

    await expect(salesService.addRow(order.id, { articleId: article.id, quantity: 1, unitPrice: 1 }, user.id)).rejects.toThrow(
      InvalidStatusTransitionError
    );
    await expect(salesService.updateRow(order.id, rows[0]!.id, { quantity: 5 }, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(salesService.deleteRow(order.id, rows[0]!.id, true, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(
      salesService.updateSalesOrderHeader(order.id, updateSalesOrderHeaderSchema.parse({ customerReference: "x" }))
    ).rejects.toThrow(InvalidStatusTransitionError);
    await expect(salesService.getSalesOrderPdf(order.id, "quote")).rejects.toThrow(InvalidStatusTransitionError);
    await expect(salesService.getPickListPdf(order.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(
      salesService.sendSalesOrderEmail(order.id, { variant: "quote", to: "k@example.com", subject: "Offert", message: "Hej", attachDrawings: false })
    ).rejects.toThrow(InvalidStatusTransitionError);
    expect(sentMails).toHaveLength(0);
    await expect(salesService.cancel(order.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(salesService.confirm(order.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("setStatus to lost works without a reason and stamps when/who; setStatus away from lost clears the lost columns", async () => {
    const { order, user } = await makeQuote();
    const reason = await makeReason();
    const manual = await salesService.setStatus(order.id, "lost", user.id);
    expect(manual!.status).toBe("lost");
    expect(manual!.lostReasonId).toBeNull();
    expect(manual!.lostAt).toBeInstanceOf(Date);
    expect(manual!.lostBy).toBe(user.id);

    // Already lost with a reason: a repeated override keeps the stamp and reason.
    await salesService.reopen(order.id, user.id);
    await salesService.lose(order.id, { lossReasonId: reason.id, lossNote: "n" }, user.id);
    const before = (await salesService.getSalesOrder(order.id))!;
    const again = await salesService.setStatus(order.id, "lost", user.id);
    expect(again!.lostReasonId).toBe(reason.id);
    expect(again!.lostAt!.getTime()).toBe(before.lostAt!.getTime());

    const confirmed = await salesService.setStatus(order.id, "confirmed", user.id);
    expect(confirmed!.status).toBe("confirmed");
    expect(confirmed!.lostReasonId).toBeNull();
    expect(confirmed!.lostNote).toBeNull();
    expect(confirmed!.lostAt).toBeNull();
    expect(confirmed!.lostBy).toBeNull();
    // The reason row itself is untouched (FK restrict would otherwise bite a delete).
    expect(await db.select().from(quoteLossReasons).where(eq(quoteLossReasons.id, reason.id))).toHaveLength(1);
  });

  it("a lost quote is never demand: the article overview and the behovsberäkning drop it once lost", async () => {
    const { order, user, article } = await makeQuote();
    await salesService.confirm(order.id, user.id);
    const demand = (await planningService.getArticleOverview(article.id)).rows.filter((r) => r.documentId === order.id);
    expect(demand).toHaveLength(1);
    expect(demand[0]!.direction).toBe("demand");
    expect((await planningService.requirementProposals()).some((r) => r.articleId === article.id)).toBe(true);

    await salesService.setStatus(order.id, "lost", user.id);
    expect((await planningService.getArticleOverview(article.id)).rows.filter((r) => r.documentId === order.id)).toEqual([]);
    expect((await planningService.requirementProposals()).some((r) => r.articleId === article.id)).toBe(false);
    // The raw column agrees.
    const [row] = await db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, order.id));
    expect(row!.status).toBe("lost");
  });
});
