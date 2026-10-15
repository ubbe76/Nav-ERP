import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, units } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService, InvalidUnitError } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const fakeTransportFactory: MailTransportFactory = () => ({ async sendMail() {} });
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  // Lego (Etapp G): SubcontractOperationReporter — never reached in this
  // suite, and loud if it ever is.
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);

const TABLES = sql`TRUNCATE email_log, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, suppliers, stock_transactions, stock_locations, warehouses, article_units, articles, units, users CASCADE`;

let kgId: string;

beforeEach(async () => {
  await db.execute(TABLES);
  const [kg] = await db.insert(units).values({ code: "kg", name: "Kilogram" }).returning();
  kgId = kg!.id;
});

afterAll(async () => {
  await db.execute(TABLES);
});

async function makeUser() {
  return authRepo.create({
    email: `buyer-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Buyer",
    role: "admin",
  });
}

// Article stocked in st, weighing 5 kg apiece (1 st = 5 kg → factor 5).
async function makeKgArticle(articleNumber: string) {
  const article = await articleService.createArticle({
    articleNumber,
    name: articleNumber,
    type: "purchased",
    isPhantom: false,
    active: true,
  });
  await articleService.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });
  return article;
}

describe("purchase — order rows in alternative units", () => {
  async function makeOrder() {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "ACME AB", active: true });
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    return { user, order };
  }

  it("stores base-unit quantity/price and snapshots the factor", async () => {
    const { order } = await makeOrder();
    const article = await makeKgArticle("PU-1");

    await purchaseService.addRow(order.id, { articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId });

    const [row] = await purchaseService.listRows(order.id);
    expect(row?.quantityOrdered).toBe("100.0000");
    expect(row?.unitPrice).toBe("60.0000");
    expect(row?.unitId).toBe(kgId);
    expect(Number(row?.unitFactor)).toBe(5);
    expect(row?.unitCode).toBe("kg");
  });

  it("interprets a row PATCH in the row's unit and supports switching back to the base unit", async () => {
    const { order } = await makeOrder();
    const article = await makeKgArticle("PU-2");
    await purchaseService.addRow(order.id, { articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId });
    const [row] = await purchaseService.listRows(order.id);

    await purchaseService.updateRow(order.id, row!.id, { quantity: 250, unitPrice: 10 });
    let [updated] = await purchaseService.listRows(order.id);
    expect(updated?.quantityOrdered).toBe("50.0000");
    expect(updated?.unitPrice).toBe("50.0000");

    await purchaseService.updateRow(order.id, row!.id, { quantity: 10, unitPrice: 55, unitId: null });
    [updated] = await purchaseService.listRows(order.id);
    expect(updated?.quantityOrdered).toBe("10.0000");
    expect(updated?.unitPrice).toBe("55.0000");
    expect(updated?.unitId).toBeNull();
    expect(updated?.unitCode).toBe("st");
  });

  it("rejects a unit the article does not have", async () => {
    const { order } = await makeOrder();
    const article = await articleService.createArticle({
      articleNumber: "PU-3",
      name: "PU-3",
      type: "purchased",
      isPhantom: false,
      active: true,
    });
    await expect(
      purchaseService.addRow(order.id, { articleId: article.id, quantity: 1, unitPrice: 1, unitId: kgId })
    ).rejects.toThrow(InvalidUnitError);
  });

  it("receives in the base unit and completes the order as before", async () => {
    const { order, user } = await makeOrder();
    const article = await makeKgArticle("PU-4");
    await purchaseService.addRow(order.id, { articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId });
    await purchaseService.confirm(order.id);
    const [row] = await purchaseService.listRows(order.id);

    const result = await purchaseService.receiveGoods(order.id, row!.id, { quantity: 100 }, user.id);
    expect(result.orderStatus).toBe("received");

    const balances = await stockService.balancesForArticles([article.id]);
    expect(Number(balances[0]?.quantityOnHand)).toBe(100);
  });
});

describe("purchase — inquiry rows in alternative units", () => {
  it("converts inquiry rows on create and carries the unit to the purchase order", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "ACME AB", active: true });
    const article = await makeKgArticle("IN-1");

    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId }] },
      user.id
    );

    const [row] = await purchaseService.listInquiryRows(inquiry.id);
    expect(row?.quantity).toBe("100.0000");
    expect(row?.unitPrice).toBe("60.0000");
    expect(row?.unitCode).toBe("kg");

    await purchaseService.sendInquiry(inquiry.id);
    await purchaseService.markInquiryAnswered(inquiry.id);
    const order = await purchaseService.convertInquiryToOrder(inquiry.id, user.id);

    const [orderRow] = await purchaseService.listRows(order!.id);
    expect(orderRow?.quantityOrdered).toBe("100.0000");
    expect(orderRow?.unitId).toBe(kgId);
    expect(Number(orderRow?.unitFactor)).toBe(5);
  });
});
