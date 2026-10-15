import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
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

const TRUNCATE = sql`TRUNCATE inquiry_rows, inquiries, purchase_order_rows, purchase_orders, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `log-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Logger",
    role: "admin",
  });
}

async function makeArticle(articleNumber: string) {
  return articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", active: true });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

describe("per-article goods receipt log", () => {
  it("returns receipts joined to the IO/supplier/price/location", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "Lev AB", active: true });
    const article = await makeArticle(`ART-R-${crypto.randomUUID()}`);
    const location = await makeLocation();
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 10, unitPrice: 42 });
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);

    const log = await purchaseService.listArticleGoodsReceipts(article.id, {
      articleId: article.id,
      limit: 50,
      offset: 0,
    });
    expect(log.total).toBe(1);
    const r = log.rows[0]!;
    expect(r.orderNumber).toBe(order.orderNumber);
    expect(r.supplierName).toBe("Lev AB");
    expect(Number(r.unitPrice)).toBe(42);
    expect(Number(r.quantity)).toBe(6);
    expect(r.locationName).toBe("A1");
  });

  it("is empty for an article with no receipts", async () => {
    const article = await makeArticle(`ART-EMPTY-${crypto.randomUUID()}`);
    const log = await purchaseService.listArticleGoodsReceipts(article.id, {
      articleId: article.id,
      limit: 50,
      offset: 0,
    });
    expect(log.total).toBe(0);
    expect(log.rows).toHaveLength(0);
  });
});

describe("per-article price history log", () => {
  it("returns rows across live orders, excludes draft/cancelled, newest first", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "Lev AB", active: true });
    const article = await makeArticle(`ART-P-${crypto.randomUUID()}`);

    // Draft order — excluded.
    const draft = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(draft.id, { articleId: article.id, quantity: 1, unitPrice: 10 });

    // Confirmed order — included.
    const confirmed = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(confirmed.id, { articleId: article.id, quantity: 5, unitPrice: 20 });
    await purchaseService.confirm(confirmed.id);

    // Cancelled order — excluded.
    const cancelled = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(cancelled.id, { articleId: article.id, quantity: 1, unitPrice: 99 });
    await purchaseService.cancel(cancelled.id);

    const history = await purchaseService.listArticlePriceHistory(article.id, {
      articleId: article.id,
      limit: 50,
      offset: 0,
    });
    expect(history.total).toBe(1);
    expect(history.rows[0]!.orderNumber).toBe(confirmed.orderNumber);
    expect(Number(history.rows[0]!.unitPrice)).toBe(20);
    expect(Number(history.rows[0]!.quantity)).toBe(5);
  });
});
