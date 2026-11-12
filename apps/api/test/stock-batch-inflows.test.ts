import {
  completeOperationSchema,
  createArticleSchema,
  createPurchaseOrderSchema,
  createStockLocationSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  receiveGoodsSchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, moReportMaterials, moReports, purchaseOrderRows, stockBatches, stockTransactions, systemSettings } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService, MoReportStockMissingError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService, PurchaseReceiptStockMissingError } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { batchCellQuantity } from "../src/modules/stock/repository/batch-balances.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { BatchNotTrackedError, BatchNumberReservedError } from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { getOrCreateBatch } from "../src/modules/stock/service/batches.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";

// Batch (#8), steg 1 — the inflows that carry a batch and their Ångra:
// inleverans (the supplier's batch, empty = the IO number, a row split over
// batches = one receipt each) and the TO's finished goods (batch = the TO
// number). An Ångra takes the goods back out of the SAME batch, whatever the
// article's flag says by then. The REAL purchase ↔ manufacturing wiring.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  createAuditRepository(db)
);

const TABLES = sql`TRUNCATE audit_log, purchase_receipts, mo_reports, purchase_order_rows, purchase_orders, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));

beforeEach(async () => {
  await db.execute(TABLES);
  await resetSetting();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
});

afterAll(async () => {
  await db.execute(TABLES);
  await resetSetting();
});

async function makeUser() {
  return authRepo.create({ email: `batch-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Inköpare", role: "admin" });
}

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  return stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true }));
}

const setTracked = (articleId: string, batchTracked: boolean) => articleService.updateArticle(articleId, { batchTracked });

const adjust = (articleId: string, locationId: string, quantityDelta: number, batchNumber?: string) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment", batchNumber });

async function placeBalance(articleId: string, locationId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(row!.q);
}

// The article's stock rows in the order they were booked: [type, delta, batch number | null].
async function movements(articleId: string) {
  const rows = await db
    .select({ type: stockTransactions.transactionType, delta: stockTransactions.quantityDelta, batchNumber: stockBatches.batchNumber })
    .from(stockTransactions)
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(eq(stockTransactions.articleId, articleId))
    .orderBy(asc(stockTransactions.createdAt), asc(stockTransactions.id));
  return rows.map((r) => [r.type, Number(r.delta), r.batchNumber]);
}

async function batchesOf(articleId: string) {
  return db.select().from(stockBatches).where(eq(stockBatches.articleId, articleId)).orderBy(asc(stockBatches.batchNumber));
}

// --- Inleverans ---------------------------------------------------------------

// A confirmed IO with one row of a purchased article (batchstyrd unless told otherwise).
async function makeOrder(opts: { quantity?: number; batchTracked?: boolean } = {}) {
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "ACME AB", active: true }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, {
      articleNumber: `ART-${crypto.randomUUID()}`,
      name: "Plåt",
      type: "purchased",
      active: true,
      batchTracked: opts.batchTracked ?? true,
    })
  );
  const location = await makeLocation();
  const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), user.id);
  const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: opts.quantity ?? 10, unitPrice: 42 });
  await purchaseService.confirm(order.id);
  return { user, supplier, article, location, order, row };
}

type Order = Awaited<ReturnType<typeof makeOrder>>;

const receive = (o: Order, quantity: number, batchNumber?: string) =>
  purchaseService.receiveGoods(o.order.id, o.row.id, parsed(receiveGoodsSchema, { locationId: o.location.id, quantity, batchNumber }), o.user.id);

describe("Inleverans with a batch", () => {
  it("books the goods in the supplier's batch, created on its first inflow, and says so", async () => {
    const o = await makeOrder();
    const received = await receive(o, 6, " L-2291 ");
    expect(received.batchNumber).toBe("L-2291");

    const [batch] = await batchesOf(o.article.id);
    expect(batch).toMatchObject({ batchNumber: "L-2291", origin: "purchase_receipt", purchaseOrderId: o.order.id, manufacturingOrderId: null, createdBy: o.user.id });
    expect(await movements(o.article.id)).toEqual([["purchase_receipt", 6, "L-2291"]]);
    // Still priced as an inleverans.
    const [row] = await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, o.article.id));
    expect(row).toMatchObject({ unitCost: "42.0000", batchId: batch!.id, referenceId: o.order.id });
    // The receipt log reads the batch through its own stock row.
    expect((await purchaseService.listReceipts(o.order.id)).map((r) => [Number(r.quantity), r.batchNumber])).toEqual([[6, "L-2291"]]);
  });

  it("an empty batch is the IO number — one batch per order, shared by its receipts", async () => {
    const o = await makeOrder();
    expect((await receive(o, 4)).batchNumber).toBe(o.order.orderNumber);
    expect((await receive(o, 3, "")).batchNumber).toBe(o.order.orderNumber);
    expect((await batchesOf(o.article.id)).map((b) => b.batchNumber)).toEqual([o.order.orderNumber]);
    expect(await batchCellQuantity(db, o.article.id, o.location.id, (await batchesOf(o.article.id))[0]!.id)).toBe(7);
  });

  it("a row split over two batches is two receipts, and Ångra takes one of them back out of its own batch", async () => {
    const o = await makeOrder();
    const first = await receive(o, 6, "L-1");
    const second = await receive(o, 4, "L-2");
    const [l1, l2] = await batchesOf(o.article.id);
    expect([l1!.batchNumber, l2!.batchNumber]).toEqual(["L-1", "L-2"]);
    expect((await purchaseService.listRows(o.order.id))[0]!.quantityReceived).toBe("10.0000");

    const undone = await purchaseService.undoReceipt(o.order.id, first.receiptId, o.user.id);
    expect(undone.row.quantityReceived).toBe("4.0000");
    expect(await movements(o.article.id)).toEqual([
      ["purchase_receipt", 6, "L-1"],
      ["purchase_receipt", 4, "L-2"],
      ["purchase_receipt", -6, "L-1"],
    ]);
    expect(await batchCellQuantity(db, o.article.id, o.location.id, l1!.id)).toBe(0);
    expect(await batchCellQuantity(db, o.article.id, o.location.id, l2!.id)).toBe(4);
    // The other receipt is untouched and still undoable.
    await purchaseService.undoReceipt(o.order.id, second.receiptId, o.user.id);
    expect(await placeBalance(o.article.id, o.location.id)).toBe(0);
    // The batches stay — the log refers to them.
    expect(await batchesOf(o.article.id)).toHaveLength(2);
  });

  it("the same supplier batch on a later order is the same batch, with the first order as its origin", async () => {
    const o = await makeOrder();
    await receive(o, 5, "L-1");
    const later = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: o.supplier.id }), o.user.id);
    const laterRow = await purchaseService.addRow(later.id, { articleId: o.article.id, quantity: 6, unitPrice: 40 });
    await purchaseService.confirm(later.id);
    await purchaseService.receiveGoods(later.id, laterRow.id, parsed(receiveGoodsSchema, { locationId: o.location.id, quantity: 5, batchNumber: "l-1" }), o.user.id);
    // …and without a number each order is its own batch.
    await purchaseService.receiveGoods(later.id, laterRow.id, parsed(receiveGoodsSchema, { locationId: o.location.id, quantity: 1 }), o.user.id);

    const batches = await batchesOf(o.article.id);
    expect(batches.map((b) => [b.batchNumber, b.purchaseOrderId]).sort()).toEqual(
      [
        ["L-1", o.order.id],
        [later.orderNumber, later.id],
      ].sort()
    );
  });

  it("refuses a batch on an article that is not batchstyrd and the reserved name — nothing is booked", async () => {
    const plain = await makeOrder({ batchTracked: false });
    await expect(receive(plain, 5, "L-1")).rejects.toThrow(BatchNotTrackedError);
    const tracked = await makeOrder();
    await expect(receive(tracked, 5, "Okänd")).rejects.toThrow(BatchNumberReservedError);

    expect(await db.select().from(stockTransactions)).toEqual([]);
    expect(await db.select().from(stockBatches)).toEqual([]);
    const rows = await db.select({ received: purchaseOrderRows.quantityReceived }).from(purchaseOrderRows);
    expect(rows.map((r) => r.received)).toEqual(["0.0000", "0.0000"]);
  });

  it("an article that is not batchstyrd is received exactly as before", async () => {
    const o = await makeOrder({ batchTracked: false });
    const received = await receive(o, 5);
    expect(received.batchNumber).toBeNull();
    expect(await movements(o.article.id)).toEqual([["purchase_receipt", 5, null]]);
    expect((await purchaseService.listReceipts(o.order.id))[0]!.batchNumber).toBeNull();
    await purchaseService.undoReceipt(o.order.id, received.receiptId, o.user.id);
    expect(await movements(o.article.id)).toEqual([
      ["purchase_receipt", 5, null],
      ["purchase_receipt", -5, null],
    ]);
    expect(await db.select().from(stockBatches)).toEqual([]);
  });
});

describe("Ångra inleverans and the batch", () => {
  it("the goods must still be in the batch's cell — enough on the place in other batches does not help", async () => {
    const o = await makeOrder();
    const received = await receive(o, 10, "L-1");
    const [batch] = await batchesOf(o.article.id);
    // 6 of the batch have left (as a draw will book it), and 20 without a batch came in.
    await db.insert(stockTransactions).values({ articleId: o.article.id, locationId: o.location.id, quantityDelta: "-6", transactionType: "mo_consumption", batchId: batch!.id });
    await adjust(o.article.id, o.location.id, 20);
    expect(await placeBalance(o.article.id, o.location.id)).toBe(24);

    const err = await purchaseService.undoReceipt(o.order.id, received.receiptId, o.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseReceiptStockMissingError);
    expect(err).toMatchObject({ available: 4, required: 10 });
    expect(await placeBalance(o.article.id, o.location.id)).toBe(24);
  });

  it("…and the place must still hold them: the batch intact but the place drawn below it is refused too", async () => {
    const o = await makeOrder();
    const received = await receive(o, 10, "L-1");
    // A decrease is Okänd for now: L-1 +10, Okänd −7 — physically 3 there.
    await adjust(o.article.id, o.location.id, -7);

    const err = await purchaseService.undoReceipt(o.order.id, received.receiptId, o.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseReceiptStockMissingError);
    expect(err).toMatchObject({ available: 3, required: 10 });
  });

  it("Batchstyrd switched off after the receipt: Ångra still takes the goods out of the receipt's batch", async () => {
    const o = await makeOrder();
    const received = await receive(o, 10, "L-1");
    await setTracked(o.article.id, false);

    await purchaseService.undoReceipt(o.order.id, received.receiptId, o.user.id);
    expect(await movements(o.article.id)).toEqual([
      ["purchase_receipt", 10, "L-1"],
      ["purchase_receipt", -10, "L-1"],
    ]);
  });

  it("Batchstyrd switched on after the receipt: the goods were Okänd, go back out as Okänd, and must still be Okänd there", async () => {
    const o = await makeOrder({ batchTracked: false });
    const received = await receive(o, 10);
    await setTracked(o.article.id, true);
    // 4 of the Okänd goods are gone and 4 came in under a batch: 10 on the place, 6 Okänd.
    await adjust(o.article.id, o.location.id, -4);
    await adjust(o.article.id, o.location.id, 4, "L-9");

    const err = await purchaseService.undoReceipt(o.order.id, received.receiptId, o.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PurchaseReceiptStockMissingError);
    expect(err).toMatchObject({ available: 6, required: 10 });

    await adjust(o.article.id, o.location.id, 4);
    await purchaseService.undoReceipt(o.order.id, received.receiptId, o.user.id);
    expect((await movements(o.article.id)).at(-1)).toEqual(["purchase_receipt", -10, null]);
    expect(await batchCellQuantity(db, o.article.id, o.location.id, null)).toBe(0);
  });
});

// --- TO-inleverans -------------------------------------------------------------

// A released TO for 5 st with two operations; the component (2 per unit) is
// linked to operation 10. Component and finished goods share the location.
async function makeManufacturingOrder(opts: { batchTracked?: boolean } = {}) {
  const user = await makeUser();
  const location = await makeLocation();
  const component = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `C-${crypto.randomUUID()}`, name: "Komponent", type: "purchased", defaultLocationId: location.id, active: true })
  );
  const parent = await articleService.createArticle(
    parsed(createArticleSchema, {
      articleNumber: `P-${crypto.randomUUID()}`,
      name: "Produkt",
      type: "manufactured",
      defaultLocationId: location.id,
      active: true,
      standardCost: 80,
      batchTracked: opts.batchTracked ?? true,
    })
  );
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, routingOperationId: op10.id });
  await adjust(component.id, location.id, 100);
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [first, last] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { user, location, component, parent, order, first: first!, last: last! };
}

type Mo = Awaited<ReturnType<typeof makeManufacturingOrder>>;

// A delinleverans: the last operation reported for `quantity` more.
const reportLast = (mo: Mo, quantity: number) =>
  mfgService.completeOperation(mo.last.id, parsed(completeOperationSchema, { quantityCompleted: quantity }), mo.user.id);

async function reportsOf(mo: Mo) {
  // Oldest first.
  return (await mfgService.listReports(mo.order.id)).reverse();
}

describe("TO-inleverans with a batch", () => {
  it("the finished goods of a batchstyrd article get the TO number as batch — every delinleverans the same one", async () => {
    const mo = await makeManufacturingOrder();
    await reportLast(mo, 2);
    await reportLast(mo, 1);
    await mfgService.complete(mo.order.id, { quantity: 2 }, mo.user.id);

    const [batch] = await batchesOf(mo.parent.id);
    expect(await batchesOf(mo.parent.id)).toHaveLength(1);
    expect(batch).toMatchObject({ batchNumber: mo.order.orderNumber, origin: "manufacturing_order", manufacturingOrderId: mo.order.id, purchaseOrderId: null });
    expect(await movements(mo.parent.id)).toEqual([
      ["mo_receipt", 2, mo.order.orderNumber],
      ["mo_receipt", 1, mo.order.orderNumber],
      ["mo_receipt", 2, mo.order.orderNumber],
    ]);
    // Priced as before, and the report log keeps the batch for Ångra.
    const [row] = await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, mo.parent.id)).limit(1);
    expect(row!.unitCost).toBe("80.0000");
    const reports = await reportsOf(mo);
    expect(reports.map((r) => [r.kind, Number(r.quantityReceived), r.receiptBatchNumber])).toEqual([
      ["operation", 2, mo.order.orderNumber],
      ["operation", 1, mo.order.orderNumber],
      ["completion", 2, mo.order.orderNumber],
    ]);
    const logged = await db.select({ receiptBatchId: moReports.receiptBatchId }).from(moReports);
    expect(logged.every((r) => r.receiptBatchId === batch!.id)).toBe(true);
  });

  it("an article that is not batchstyrd is received exactly as before", async () => {
    const mo = await makeManufacturingOrder({ batchTracked: false });
    await reportLast(mo, 2);
    expect(await movements(mo.parent.id)).toEqual([["mo_receipt", 2, null]]);
    const [report] = await reportsOf(mo);
    expect(report!.receiptBatchNumber).toBeNull();
    await mfgService.undoReport(mo.order.id, report!.id, mo.user.id);
    expect(await movements(mo.parent.id)).toEqual([
      ["mo_receipt", 2, null],
      ["mo_receipt", -2, null],
    ]);
    expect(await db.select().from(stockBatches)).toEqual([]);
  });

  it("the material a report draws is logged without a batch (Okänd) and comes back so", async () => {
    const mo = await makeManufacturingOrder();
    await mfgService.completeOperation(mo.first.id, parsed(completeOperationSchema, { quantityCompleted: 2 }), mo.user.id);
    const [report] = await reportsOf(mo);
    expect(report!.materials.map((m) => [Number(m.quantity), m.batchNumber ?? null])).toEqual([[4, null]]);
    await mfgService.undoReport(mo.order.id, report!.id, mo.user.id);
    expect((await movements(mo.component.id)).slice(1)).toEqual([
      ["mo_consumption", -4, null],
      ["mo_consumption", 4, null],
    ]);
  });
});

describe("Ångra rapportering and the batch", () => {
  it("takes the finished goods back out of the TO's batch", async () => {
    const mo = await makeManufacturingOrder();
    await reportLast(mo, 2);
    await reportLast(mo, 1);
    const [, second] = await reportsOf(mo);
    const [batch] = await batchesOf(mo.parent.id);

    await mfgService.undoReport(mo.order.id, second!.id, mo.user.id);
    expect(await movements(mo.parent.id)).toEqual([
      ["mo_receipt", 2, mo.order.orderNumber],
      ["mo_receipt", 1, mo.order.orderNumber],
      ["mo_receipt", -1, mo.order.orderNumber],
    ]);
    expect(await batchCellQuantity(db, mo.parent.id, mo.location.id, batch!.id)).toBe(2);
  });

  it("mirrors what the report booked across a flag change, in both directions", async () => {
    // Off when reported, on when undone: the goods were Okänd and leave as Okänd.
    const off = await makeManufacturingOrder({ batchTracked: false });
    await reportLast(off, 2);
    await setTracked(off.parent.id, true);
    await reportLast(off, 1); // now in the TO's batch
    const [first, second] = await reportsOf(off);
    expect([first!.receiptBatchNumber, second!.receiptBatchNumber]).toEqual([null, off.order.orderNumber]);
    await mfgService.undoReport(off.order.id, first!.id, off.user.id);
    expect((await movements(off.parent.id)).at(-1)).toEqual(["mo_receipt", -2, null]);

    // On when reported, off when undone: still out of the batch.
    await db.execute(TABLES);
    const on = await makeManufacturingOrder();
    await reportLast(on, 2);
    await setTracked(on.parent.id, false);
    const [report] = await reportsOf(on);
    await mfgService.undoReport(on.order.id, report!.id, on.user.id);
    expect((await movements(on.parent.id)).at(-1)).toEqual(["mo_receipt", -2, on.order.orderNumber]);
  });

  it("the goods must still be in the batch's cell, not just on the place", async () => {
    const mo = await makeManufacturingOrder();
    await reportLast(mo, 3);
    const [batch] = await batchesOf(mo.parent.id);
    // 2 of the batch have left (as a draw will book it), 10 without a batch came in.
    await db.insert(stockTransactions).values({ articleId: mo.parent.id, locationId: mo.location.id, quantityDelta: "-2", transactionType: "sales_delivery", batchId: batch!.id });
    await adjust(mo.parent.id, mo.location.id, 10);
    const [report] = await reportsOf(mo);

    const err = await mfgService.undoReport(mo.order.id, report!.id, mo.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoReportStockMissingError);
    expect(err).toMatchObject({ available: 1, required: 3 });
    expect(await placeBalance(mo.parent.id, mo.location.id)).toBe(11);
  });

  it("returns drawn material to the batch its report line names", async () => {
    const mo = await makeManufacturingOrder();
    await mfgService.completeOperation(mo.first.id, parsed(completeOperationSchema, { quantityCompleted: 2 }), mo.user.id);
    const [report] = await reportsOf(mo);
    // The line as a draw per batch will log it (the draws allocate per batch in the next step).
    const batch = await getOrCreateBatch(db, { articleId: mo.component.id, batchNumber: "L-7", origin: "manual" });
    await db.update(moReportMaterials).set({ batchId: batch.id }).where(eq(moReportMaterials.moReportId, report!.id));
    expect((await reportsOf(mo))[0]!.materials.map((m) => m.batchNumber)).toEqual(["L-7"]);

    await mfgService.undoReport(mo.order.id, report!.id, mo.user.id);
    expect((await movements(mo.component.id)).at(-1)).toEqual(["mo_consumption", 4, "L-7"]);
  });
});
