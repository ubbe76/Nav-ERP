import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, manufacturingOrders, moOperations, moReports, purchaseReceipts, stockLocations, stockTransactions } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  MoReportFromPurchaseReceiptError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import {
  createPurchaseService,
  InvalidStatusTransitionError,
  PurchaseReceiptAlreadyUndoneError,
  PurchaseReceiptManufacturingOrderLockedError,
  PurchaseReceiptNotFoundError,
  PurchaseReceiptStockMissingError,
} from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Ångra inleverans: one receipt reversed — stock, the row's received
// quantity and the order status; on a lego row the TO report it made, in the
// same transaction. The REAL purchase ↔ manufacturing wiring (as app.ts).

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const purchaseRepo = createPurchaseRepository(db);
const purchaseService = createPurchaseService(
  purchaseRepo,
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  createAuditRepository(db)
);

const TABLES = sql`TRUNCATE audit_log, purchase_receipts, mo_reports, purchase_order_rows, purchase_orders, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
});

afterAll(async () => {
  await db.execute(TABLES);
});

async function makeUser() {
  return authRepo.create({
    email: `undo-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Inköpare",
    role: "admin",
  });
}

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name, active: true });
}

async function balanceAt(articleId: string, locationId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(row!.q);
}

// A confirmed IO with one ordinary row.
async function makeOrder(quantity = 10) {
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier({ name: "ACME AB", active: true });
  const article = await articleService.createArticle({
    articleNumber: `ART-${crypto.randomUUID()}`,
    name: "Plåt",
    type: "purchased",
    unit: "st",
    active: true,
  });
  const location = await makeLocation();
  const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
  const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity, unitPrice: 42 });
  await purchaseService.confirm(order.id);
  return { user, supplier, article, location, order, row };
}

async function receiptIds(orderId: string) {
  // listReceipts is newest first.
  return (await purchaseService.listReceipts(orderId)).map((r) => r.id);
}

describe("Ångra inleverans — ordinary row", () => {
  it("takes the goods out again, lowers the row and re-derives the order status per receipt", async () => {
    const { user, article, location, order, row } = await makeOrder(10);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);
    const [second, first] = await receiptIds(order.id);

    const undoneSecond = await purchaseService.undoReceipt(order.id, second!, user.id);
    expect(undoneSecond.orderStatus).toBe("partially_received");
    expect(undoneSecond.row.quantityReceived).toBe("6.0000");
    expect(await balanceAt(article.id, location.id)).toBe(6);

    // The reversal is a negative purchase_receipt on the same location,
    // unpriced (an outflow leaves at the moving average).
    const reversal = await db
      .select()
      .from(stockTransactions)
      .where(and(eq(stockTransactions.referenceId, order.id), sql`${stockTransactions.quantityDelta} < 0`));
    expect(reversal).toHaveLength(1);
    expect(reversal[0]).toMatchObject({ transactionType: "purchase_receipt", quantityDelta: "-4.0000", unitCost: null });

    await expect(purchaseService.undoReceipt(order.id, second!, user.id)).rejects.toThrow(PurchaseReceiptAlreadyUndoneError);

    const undoneFirst = await purchaseService.undoReceipt(order.id, first!, user.id);
    expect(undoneFirst.orderStatus).toBe("confirmed");
    expect(undoneFirst.row.quantityReceived).toBe("0.0000");
    expect(await balanceAt(article.id, location.id)).toBe(0);
    // The emptied location is cleaned up like after any other outflow.
    const [loc] = await db.select().from(stockLocations).where(eq(stockLocations.id, location.id));
    expect(loc!.active).toBe(false);

    const log = await purchaseService.listReceipts(order.id);
    expect(log.map((r) => [Number(r.quantity), r.undoneAt !== null, r.undoneByName])).toEqual([
      [4, true, "Inköpare"],
      [6, true, "Inköpare"],
    ]);
    expect(log[0]!.locationName).toBe("A1");

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "goods_receipt_undone")).limit(1);
    expect(audit?.entityId).toBe(order.orderNumber);
  });

  it("lets the row be received again and deleted once everything is undone", async () => {
    const { user, location, order, row } = await makeOrder(10);
    const articleB = await articleService.createArticle({
      articleNumber: `ART-${crypto.randomUUID()}`,
      name: "Skruv",
      type: "purchased",
      unit: "st",
      active: true,
    });
    await purchaseService.addRow(order.id, { articleId: articleB.id, quantity: 1, unitPrice: 1 });
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 10 }, user.id);
    const [receipt] = await receiptIds(order.id);
    await purchaseService.undoReceipt(order.id, receipt!, user.id);

    const again = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 3 }, user.id);
    expect(again.row.quantityReceived).toBe("3.0000");
    const [latest] = await receiptIds(order.id);
    await purchaseService.undoReceipt(order.id, latest!, user.id);

    // Nothing received ⇒ the row may go; its undone receipts go with it.
    await purchaseService.deleteRow(order.id, row.id, false);
    expect(await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.purchaseOrderRowId, row.id))).toHaveLength(0);
  });

  it("is refused when the goods are no longer at the location", async () => {
    const { user, article, location, order, row } = await makeOrder(10);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 5 }, user.id);
    await stockService.recordTransaction(
      { articleId: article.id, locationId: location.id, quantityDelta: -3, transactionType: "inventory_adjustment" },
      user.id
    );
    const [receipt] = await receiptIds(order.id);

    const err = await purchaseService.undoReceipt(order.id, receipt!, user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseReceiptStockMissingError);
    expect(err).toMatchObject({ available: 2, required: 5 });
    // Nothing moved.
    expect(await balanceAt(article.id, location.id)).toBe(2);
    expect((await purchaseService.listRows(order.id))[0]!.quantityReceived).toBe("5.0000");
  });

  it("is refused on a closed order and for a receipt of another order", async () => {
    const { user, location, order, row } = await makeOrder(10);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 10 }, user.id);
    const [receipt] = await receiptIds(order.id);

    const other = await makeOrder(1);
    await expect(purchaseService.undoReceipt(other.order.id, receipt!, user.id)).rejects.toThrow(PurchaseReceiptNotFoundError);

    await purchaseService.close(order.id);
    await expect(purchaseService.undoReceipt(order.id, receipt!, user.id)).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("keeps undone receipts out of the article's inleveranslogg", async () => {
    const { user, article, location, order, row } = await makeOrder(10);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);
    const [second] = await receiptIds(order.id);
    await purchaseService.undoReceipt(order.id, second!, user.id);

    const log = await purchaseService.listArticleGoodsReceipts(article.id, { limit: 50, offset: 0 });
    expect(log.rows.map((r) => Number(r.quantity))).toEqual([6]);
    expect(log.total).toBe(1);
  });
});

// Manufactured article whose LAST operation is a lego operation: the lego
// receipt reports it, draws the linked component and receives the finished
// goods into stock — all of which Ångra inleverans must reverse.
async function makeLegoOrder(quantity = 4) {
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier({ name: "Lego AB", active: true });
  const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
  const lego = await mfgService.createWorkCenter({
    code: "900",
    name: "Ytbehandling AB",
    type: "subcontract",
    supplierId: supplier.id,
    active: true,
  });
  const parent = await articleService.createArticle({
    articleNumber: `LEGO-${crypto.randomUUID()}`,
    name: "Legodetalj",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const component = await articleService.createArticle({
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Komponent",
    type: "purchased",
    unit: "st",
    active: true,
  });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
  const legoRouting = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    unitPrice: 100,
  });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, routingOperationId: legoRouting.id });
  const location = await makeLocation("L1");
  await stockService.recordTransaction(
    { articleId: component.id, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" },
    user.id
  );

  const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity }, user.id);
  const legoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;
  const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
  const row = await purchaseService.addRow(order.id, { articleId: parent.id, quantity, unitPrice: 100, moOperationId: legoOp.id });
  await purchaseService.confirm(order.id);
  return { user, parent, component, location, mo, legoOp, order, row };
}

describe("Ångra inleverans — lego row", () => {
  it("undoes the TO report the receipt made in the same go", async () => {
    const f = await makeLegoOrder(4);
    const received = await purchaseService.receiveGoods(f.order.id, f.row.id, { locationId: f.location.id, quantity: 4 }, f.user.id);
    expect(received.operationReport).toEqual({ ok: true });
    const [receipt] = await purchaseService.listReceipts(f.order.id);
    expect(receipt!.moReportId).not.toBeNull();
    expect(receipt!.locationName).toBeNull();
    // The TO card refuses it — it belongs to the IO.
    await expect(mfgService.undoReport(f.mo.id, receipt!.moReportId!, f.user.id)).rejects.toThrow(MoReportFromPurchaseReceiptError);

    const [moBefore] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, f.mo.id));
    expect(moBefore!.status).toBe("done");

    const result = await purchaseService.undoReceipt(f.order.id, receipt!.id, f.user.id);
    expect(result.orderStatus).toBe("confirmed");
    expect(result.row.quantityReceived).toBe("0.0000");

    const [op] = await db.select().from(moOperations).where(eq(moOperations.id, f.legoOp.id));
    expect(Number(op!.quantityCompleted ?? 0)).toBe(0);
    expect(op!.status).toBe("pending");
    const [mo] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, f.mo.id));
    expect(mo!.quantityReceived).toBe("0.0000");
    expect(mo!.status).not.toBe("done");
    const [report] = await db.select().from(moReports).where(eq(moReports.id, receipt!.moReportId!));
    expect(report!.undoneAt).not.toBeNull();
    // The component drawn by the report is back, and the finished goods out.
    expect(await balanceAt(f.component.id, f.location.id)).toBe(100);
    const goods = await db
      .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
      .from(stockTransactions)
      .where(eq(stockTransactions.articleId, f.parent.id));
    expect(Number(goods[0]!.q)).toBe(0);
  });

  it("rolls everything back when the TO is closed", async () => {
    const f = await makeLegoOrder(4);
    await purchaseService.receiveGoods(f.order.id, f.row.id, { locationId: f.location.id, quantity: 4 }, f.user.id);
    await mfgService.close(f.mo.id, f.user.id);
    const [receipt] = await purchaseService.listReceipts(f.order.id);

    await expect(purchaseService.undoReceipt(f.order.id, receipt!.id, f.user.id)).rejects.toThrow(
      PurchaseReceiptManufacturingOrderLockedError
    );
    expect((await purchaseService.listRows(f.order.id))[0]!.quantityReceived).toBe("4.0000");
    const [stillLive] = await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, receipt!.id));
    expect(stillLive!.undoneAt).toBeNull();
  });
});
