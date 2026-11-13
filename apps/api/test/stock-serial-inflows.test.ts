import {
  completeOperationSchema,
  createArticleSchema,
  createPurchaseOrderSchema,
  createStockLocationSchema,
  createStockTransferSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  receiveGoodsSchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, like, sql } from "drizzle-orm";
import { db, moReportSerials, moReports, numberSeries, purchaseReceipts, stockBatches, stockLocations, stockTransactions, systemSettings, type Tx } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService, MoReportStockMissingError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import {
  ArticleNotSerialTrackedError,
  BatchKindMismatchError,
  SerialAlreadyInStockError,
  SerialCountMismatchError,
  SerialNumbersRequiredError,
  SerialQuantityNotIntegerError,
} from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Serienummer (#8 etapp 2, steg 3) — the INFLOWS of a serienummerstyrd
// article and their Ångra: inleverans (one number per styck, required; one
// kvitto each, undone per number) and the TO's finished goods (numbers out of
// the series at the receipt, also in the terminal's path and Slutför; Ångra
// takes back exactly the report's numbers). The lock order order → serierad
// → artiklar → platser → serienummerrader, and how long 200 and 500 styck
// take. The REAL purchase ↔ manufacturing wiring.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const mfgRepository = createManufacturingRepository(db);
const mfgService = createManufacturingService(mfgRepository, testDocumentPdfService, testArticleService, {
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
const resetSeries = async () => {
  await db.delete(numberSeries).where(like(numberSeries.key, "serial\\_%"));
  await db.update(numberSeries).set({ prefix: "SN-", nextNumber: 1, digits: 6 }).where(eq(numberSeries.key, "serial"));
};

beforeEach(async () => {
  await db.execute(TABLES);
  await resetSetting();
  await resetSeries();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
});
afterAll(async () => {
  await db.execute(TABLES);
  await resetSetting();
  await resetSeries();
});

const makeUser = () => authRepo.create({ email: `serial-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Lager", role: "admin" });
async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  return (await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true })))!;
}
const sn = (i: number) => `SN-${String(i).padStart(6, "0")}`;

// The article's stock rows in the order they were booked (ties on the number): [type, delta, number | null].
async function movements(articleId: string) {
  const rows = await db
    .select({ type: stockTransactions.transactionType, delta: stockTransactions.quantityDelta, number: stockBatches.batchNumber, createdAt: stockTransactions.createdAt })
    .from(stockTransactions)
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(eq(stockTransactions.articleId, articleId))
    .orderBy(asc(stockTransactions.createdAt), asc(stockBatches.batchNumber));
  return rows.map((r) => [r.type, Number(r.delta), r.number]);
}
// The numbers that stand in stock now, "<place>/<number>", sorted.
async function inStock(articleId: string) {
  const rows = await db
    .select({ place: stockLocations.name, number: stockBatches.batchNumber, quantity: sql<string>`sum(${stockTransactions.quantityDelta})` })
    .from(stockTransactions)
    .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(eq(stockTransactions.articleId, articleId))
    .groupBy(stockLocations.name, stockBatches.batchNumber)
    .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`);
  return rows.map((r) => `${r.place}/${r.number ?? "Okänd"}${Number(r.quantity) === 1 ? "" : `=${Number(r.quantity)}`}`).sort();
}
const nextSerial = async () => (await db.select().from(numberSeries).where(eq(numberSeries.key, "serial")))[0]!.nextNumber;

// --- Inleverans -----------------------------------------------------------------

async function makeOrder(opts: { quantity?: number; article?: Record<string, unknown> } = {}) {
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "ACME AB", active: true }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `ART-${crypto.randomUUID()}`, name: "Motor", type: "purchased", active: true, tracking: "serial", ...opts.article })
  );
  const location = await makeLocation();
  const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), user.id);
  const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: opts.quantity ?? 10, unitPrice: 42 });
  await purchaseService.confirm(order.id);
  return { user, supplier, article, location, order, row };
}
type Order = Awaited<ReturnType<typeof makeOrder>>;
const receive = (o: Order, quantity: number, extra: Record<string, unknown> = {}) =>
  purchaseService.receiveGoods(o.order.id, o.row.id, parsed(receiveGoodsSchema, { locationId: o.location.id, quantity, ...extra }), o.user.id);

describe("Inleverans av en serienummerstyrd artikel", () => {
  it("one number per styck: N stock rows +1 and N kvitton of one styck, answered in the numbers' order", async () => {
    const o = await makeOrder();
    const received = await receive(o, 3, { serialNumbers: ["M-3", " M-1 ", "M-2"] });
    expect(received.serialNumbers).toEqual(["M-3", "M-1", "M-2"]);
    expect(received.receiptIds).toHaveLength(3);
    expect(received.receiptId).toBe(received.receiptIds[0]);
    expect(received.batchNumber).toBeNull();
    expect(received.row.quantityReceived).toBe("3.0000");
    expect(received.orderStatus).toBe("partially_received");

    expect(await movements(o.article.id)).toEqual([
      ["purchase_receipt", 1, "M-1"],
      ["purchase_receipt", 1, "M-2"],
      ["purchase_receipt", 1, "M-3"],
    ]);
    const rows = await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, o.article.id));
    expect(rows.every((r) => r.unitCost === "42.0000" && r.referenceId === o.order.id)).toBe(true);
    expect((await db.select().from(stockBatches)).map((b) => [b.kind, b.origin, b.purchaseOrderId])).toEqual(Array(3).fill(["serial", "purchase_receipt", o.order.id]));
    // The receipt log: a kvitto per number, each pointing at its own stock row.
    const receipts = await purchaseService.listReceipts(o.order.id);
    expect(receipts.map((r) => [Number(r.quantity), r.batchNumber, r.batchKind]).sort()).toEqual([
      [1, "M-1", "serial"],
      [1, "M-2", "serial"],
      [1, "M-3", "serial"],
    ]);
    const byId = new Map(receipts.map((r) => [r.id, r.batchNumber]));
    expect(received.receiptIds.map((id) => byId.get(id))).toEqual(["M-3", "M-1", "M-2"]);
  });

  it("is not booked without all its numbers: none, too few, a number twice, a decimal quantity, a batch — nothing is written", async () => {
    const o = await makeOrder();
    await expect(receive(o, 2)).rejects.toThrow(SerialNumbersRequiredError);
    await expect(receive(o, 2, { batchNumber: "L-1", serialNumbers: ["M-1", "M-2"] })).rejects.toThrow(SerialNumbersRequiredError);
    const tooFew = await receive(o, 3, { serialNumbers: ["M-1", "M-2"] }).catch((e: unknown) => e);
    expect(tooFew).toBeInstanceOf(SerialCountMismatchError);
    expect((tooFew as Error).message).toBe("Antalet serienummer (2) stämmer inte med antalet styck (3)");
    await expect(receive(o, 2, { serialNumbers: ["M-1", "m-1"] })).rejects.toThrow(SerialCountMismatchError);
    await expect(receive(o, 1.5, { serialNumbers: ["M-1", "M-2"] })).rejects.toThrow(SerialQuantityNotIntegerError);
    expect(receiveGoodsSchema.safeParse({ quantity: 1, serialNumbers: [] }).success).toBe(false);
    expect(receiveGoodsSchema.safeParse({ quantity: 1, serialNumbers: Array.from({ length: 1001 }, (_, i) => `M-${i}`) }).success).toBe(false);

    expect(await db.select().from(stockTransactions)).toEqual([]);
    expect(await db.select().from(stockBatches)).toEqual([]);
    expect(await db.select().from(purchaseReceipts)).toEqual([]);
    expect((await purchaseService.listRows(o.order.id))[0]!.quantityReceived).toBe("0.0000");
  });

  it("a number that already stands in stock is refused with where it stands — and one that is a batch on the article too", async () => {
    const o = await makeOrder();
    await receive(o, 2, { serialNumbers: ["M-1", "M-2"] });
    const err = await receive(o, 2, { serialNumbers: ["M-3", "m-2"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SerialAlreadyInStockError);
    expect((err as Error).message).toMatch(/^Serienummer M-2 finns redan i lager \(Lager .* — A1\)$/);
    expect(await inStock(o.article.id)).toEqual(["A1/M-1", "A1/M-2"]);
    expect((await purchaseService.listRows(o.order.id))[0]!.quantityReceived).toBe("2.0000");

    // Batch → Serienummer may always be switched (beslut 11): the old batch stays a batch.
    const batchFirst = await makeOrder({ article: { tracking: "batch" } });
    await receive(batchFirst, 4, { batchNumber: "L-1" });
    await articleService.updateArticle(batchFirst.article.id, { tracking: "serial" });
    await expect(receive(batchFirst, 1, { serialNumbers: ["l-1"] })).rejects.toThrow(BatchKindMismatchError);
    await receive(batchFirst, 1, { serialNumbers: ["M-1"] });
    expect(await inStock(batchFirst.article.id)).toEqual(["A1/L-1=4", "A1/M-1"]);
  });

  it("Ångra per number: one kvitto takes its own styck back; a number that came back out can be received again", async () => {
    const o = await makeOrder();
    const received = await receive(o, 3, { serialNumbers: ["M-1", "M-2", "M-3"] });
    const undone = await purchaseService.undoReceipt(o.order.id, received.receiptIds[1]!, o.user.id);
    expect(undone.row.quantityReceived).toBe("2.0000");
    expect(await inStock(o.article.id)).toEqual(["A1/M-1", "A1/M-3"]);
    expect((await movements(o.article.id)).at(-1)).toEqual(["purchase_receipt", -1, "M-2"]);
    // The other kvitton are untouched and still undoable; the number is free again.
    await receive(o, 1, { serialNumbers: ["M-2"] });
    await purchaseService.undoReceipt(o.order.id, received.receiptIds[0]!, o.user.id);
    expect(await inStock(o.article.id)).toEqual(["A1/M-2", "A1/M-3"]);
    expect(await db.select().from(stockBatches)).toHaveLength(3);
  });

  it("serial numbers are refused on every other article; Serienummer skapas: Vid utleverans is received without numbers, untracked", async () => {
    const batch = await makeOrder({ article: { tracking: "batch" } });
    await expect(receive(batch, 1, { serialNumbers: ["M-1"] })).rejects.toThrow(ArticleNotSerialTrackedError);
    const plain = await makeOrder({ article: { tracking: "none" } });
    await expect(receive(plain, 1, { serialNumbers: ["M-1"] })).rejects.toThrow(ArticleNotSerialTrackedError);

    const atDelivery = await makeOrder({ article: { tracking: "serial", serialAssignedAt: "delivery" } });
    await expect(receive(atDelivery, 1, { serialNumbers: ["M-1"] })).rejects.toThrow(ArticleNotSerialTrackedError);
    const received = await receive(atDelivery, 2.5);
    expect(received).toMatchObject({ serialNumbers: [], batchNumber: null });
    expect(received.receiptIds).toEqual([received.receiptId]);
    expect(await movements(atDelivery.article.id)).toEqual([["purchase_receipt", 2.5, null]]);
    expect(await db.select().from(stockBatches)).toEqual([]);
  });

  it("race: two inleveranser of the same number at once — one is booked, the other is 409 serial-already-in-stock", async () => {
    const o = await makeOrder();
    const second = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: o.supplier.id }), o.user.id);
    const secondRow = await purchaseService.addRow(second.id, { articleId: o.article.id, quantity: 5, unitPrice: 40 });
    await purchaseService.confirm(second.id);
    const other = () =>
      purchaseService.receiveGoods(second.id, secondRow.id, parsed(receiveGoodsSchema, { locationId: o.location.id, quantity: 2, serialNumbers: ["M-9", "M-1"] }), o.user.id);
    const outcomes = await Promise.allSettled([receive(o, 2, { serialNumbers: ["M-1", "M-9"] }), other()]);
    expect(outcomes.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = outcomes.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SerialAlreadyInStockError);
    expect(await inStock(o.article.id)).toEqual(["A1/M-1", "A1/M-9"]);
  });
});

// --- TO-inleverans ---------------------------------------------------------------

// A released TO for `quantity` st with two operations; the component (2 per
// unit) is linked to operation 10 unless `linked` is false (then it follows
// the finished goods). Component and finished goods share the location.
async function makeManufacturingOrder(opts: { quantity?: number; article?: Record<string, unknown>; component?: { id: string }; linked?: boolean | "last" } = {}) {
  const user = await makeUser();
  const location = await makeLocation();
  const component =
    opts.component ??
    (await articleService.createArticle(
      parsed(createArticleSchema, { articleNumber: `C-${crypto.randomUUID()}`, name: "Komponent", type: "purchased", defaultLocationId: location.id, active: true })
    ));
  const parent = await articleService.createArticle(
    parsed(createArticleSchema, {
      articleNumber: `P-${crypto.randomUUID()}`,
      name: "Pump",
      type: "manufactured",
      defaultLocationId: location.id,
      active: true,
      standardCost: 80,
      tracking: "serial",
      ...opts.article,
    })
  );
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: String(100 + Math.floor(Math.random() * 899)), name: `Montering ${crypto.randomUUID().slice(0, 4)}`, active: true }));
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const op20 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, {
    componentArticleId: component.id,
    quantity: 2,
    ...(opts.linked === false ? {} : { routingOperationId: opts.linked === "last" ? op20.id : op10.id }),
  });
  await stockService.recordTransaction({ articleId: component.id, locationId: location.id, quantityDelta: 5000, transactionType: "inventory_adjustment" });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: opts.quantity ?? 5 }, user.id);
  const [first, last] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { user, location, component, parent, order, first: first!, last: last! };
}
type Mo = Awaited<ReturnType<typeof makeManufacturingOrder>>;
const reportLast = (mo: Mo, quantity: number) =>
  mfgService.completeOperation(mo.last.id, parsed(completeOperationSchema, { quantityCompleted: quantity }), mo.user.id);
const reportsOf = async (mo: Mo) => (await mfgService.listReports(mo.order.id)).reverse();

describe("TO-inleverans av en serienummerstyrd artikel", () => {
  it("every received styck gets the next number of the series — per delinleverans, in the terminal's path and at Slutför order", async () => {
    const mo = await makeManufacturingOrder();
    const first = await reportLast(mo, 2);
    expect(first.receivedSerialNumbers).toEqual([sn(1), sn(2)]);
    // The terminal's stamp-out goes through the same report (source terminal).
    const terminal = await mfgService.reportOperationQuantities(mo.last.id, { quantityOk: 1, quantityScrapped: 0, markDone: false, createdBy: mo.user.id, source: "terminal" });
    expect(terminal.receivedSerialNumbers).toEqual([sn(3)]);
    const done = await mfgService.complete(mo.order.id, { quantity: 2 }, mo.user.id);
    expect(done.receivedSerialNumbers).toEqual([sn(4), sn(5)]);

    expect(await movements(mo.parent.id)).toEqual([1, 2, 3, 4, 5].map((i) => ["mo_receipt", 1, sn(i)]));
    const rows = await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, mo.parent.id));
    expect(rows.every((r) => r.unitCost === "80.0000" && r.referenceId === mo.order.id)).toBe(true);
    expect((await db.select().from(stockBatches).where(eq(stockBatches.articleId, mo.parent.id))).map((b) => [b.kind, b.origin, b.manufacturingOrderId])).toEqual(
      Array(5).fill(["serial", "manufacturing_order", mo.order.id])
    );
    // The report log keeps exactly its numbers; receipt_batch_id stays null.
    const reports = await reportsOf(mo);
    expect(reports.map((r) => [r.kind, Number(r.quantityReceived), r.receiptSerialNumbers, r.receiptBatchNumber])).toEqual([
      ["operation", 2, [sn(1), sn(2)], null],
      ["operation", 1, [sn(3)], null],
      ["completion", 2, [sn(4), sn(5)], null],
    ]);
    expect((await db.select().from(moReports)).every((r) => r.receiptBatchId === null)).toBe(true);
    expect(await db.select().from(moReportSerials)).toHaveLength(5);
    expect((await mfgService.getManufacturingOrder(mo.order.id))!.status).toBe("done");
  });

  it("a report that is not on the last operation, a dry run and a refused report take no numbers", async () => {
    const mo = await makeManufacturingOrder();
    const early = await mfgService.completeOperation(mo.first.id, parsed(completeOperationSchema, { quantityCompleted: 3 }), mo.user.id);
    expect(early.receivedSerialNumbers).toEqual([]);
    await mfgRepository.dryRunOperationReport(mo.last.id, { quantityOk: 3, quantityScrapped: 0, markDone: false, createdBy: mo.user.id, source: "terminal" });
    // A decimal quantity of a serienummerstyrd article is refused, with everything it booked.
    await expect(reportLast(mo, 1.5)).rejects.toThrow(SerialQuantityNotIntegerError);
    expect(await nextSerial()).toBe(1);
    expect(await db.select().from(stockBatches).where(eq(stockBatches.articleId, mo.parent.id))).toEqual([]);
    expect(await movements(mo.parent.id)).toEqual([]);
    expect((await reportLast(mo, 1)).receivedSerialNumbers).toEqual([sn(1)]);
  });

  it("the article's own series; Hållbarhet gives every number its utgångsdatum; Vid utleverans gives no numbers at all", async () => {
    const own = await testSystemService.createArticleNumberSeries({ name: "Pumpar", prefix: "PU-", nextNumber: 7, digits: 3, forSerials: true });
    const mo = await makeManufacturingOrder({ article: { serialSeriesKey: own.key, shelfLifeDays: 30 } });
    expect((await reportLast(mo, 2)).receivedSerialNumbers).toEqual(["PU-007", "PU-008"]);
    expect(await nextSerial()).toBe(1);
    const dated = await db.select().from(stockBatches).where(eq(stockBatches.articleId, mo.parent.id));
    expect(dated.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.expiresOn ?? ""))).toBe(true);

    const atDelivery = await makeManufacturingOrder({ article: { serialAssignedAt: "delivery" } });
    const report = await reportLast(atDelivery, 2.5);
    expect(report.receivedSerialNumbers).toEqual([]);
    expect(await movements(atDelivery.parent.id)).toEqual([["mo_receipt", 2.5, null]]);
    expect(await db.select().from(stockBatches).where(eq(stockBatches.articleId, atDelivery.parent.id))).toEqual([]);
  });
});

describe("Ångra rapportering av serienummer", () => {
  it("takes back EXACTLY the report's numbers — and they are spent: the next report gets new ones", async () => {
    const mo = await makeManufacturingOrder();
    await reportLast(mo, 2);
    await reportLast(mo, 1);
    const [first] = await reportsOf(mo);
    await mfgService.undoReport(mo.order.id, first!.id, mo.user.id);
    expect(await inStock(mo.parent.id)).toEqual([`A1/${sn(3)}`]);
    expect((await movements(mo.parent.id)).slice(-2)).toEqual([
      ["mo_receipt", -1, sn(1)],
      ["mo_receipt", -1, sn(2)],
    ]);
    expect(Number((await mfgService.getManufacturingOrder(mo.order.id))!.quantityReceived)).toBe(1);
    expect((await reportLast(mo, 2)).receivedSerialNumbers).toEqual([sn(4), sn(5)]);
    expect(await inStock(mo.parent.id)).toEqual([sn(3), sn(4), sn(5)].map((s) => `A1/${s}`));
  });

  it("is refused when one of its numbers no longer stands where the report put it — naming the number", async () => {
    const mo = await makeManufacturingOrder();
    await reportLast(mo, 3);
    const [report] = await reportsOf(mo);
    const elsewhere = await makeLocation("B2");
    const [moved] = await db.select().from(stockBatches).where(eq(stockBatches.batchNumber, sn(2)));
    await stockService.transferStock(
      parsed(createStockTransferSchema, { fromLocationId: mo.location.id, toLocationId: elsewhere.id, rows: [{ articleId: mo.parent.id, quantity: 1, batchId: moved!.id }] }),
      mo.user.id
    );
    const err = await mfgService.undoReport(mo.order.id, report!.id, mo.user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoReportStockMissingError);
    expect(err).toMatchObject({ serialNumbers: [sn(2)], required: 3, available: 2 });
    expect((err as Error).message).toContain(`Serienummer ${sn(2)} finns inte kvar på lagerplatsen`);
    expect(await inStock(mo.parent.id)).toEqual([`A1/${sn(1)}`, `A1/${sn(3)}`, `B2/${sn(2)}`]);
    // Moved back, the undo goes through.
    await stockService.transferStock(
      parsed(createStockTransferSchema, { fromLocationId: elsewhere.id, toLocationId: mo.location.id, rows: [{ articleId: mo.parent.id, quantity: 1, batchId: moved!.id }] }),
      mo.user.id
    );
    await mfgService.undoReport(mo.order.id, report!.id, mo.user.id);
    expect(await inStock(mo.parent.id)).toEqual([]);
  });
});

// --- Låsordningen ------------------------------------------------------------------

function heldTransaction(work: (tx: Tx) => Promise<void>) {
  let begun!: () => void;
  const ready = new Promise<void>((resolve) => (begun = resolve));
  let release!: () => void;
  const mayCommit = new Promise<void>((resolve) => (release = resolve));
  const done = db.transaction(async (tx) => {
    await work(tx);
    begun();
    await mayCommit;
  });
  return { ready, release, done };
}

describe("låsordningen: order → serierad → artiklar → platser → serienummerrader", () => {
  // While the series row is held by someone else, a writer that waits for it
  // must not yet hold any of its component articles — on BOTH paths.
  async function componentFreeWhileWaitingForSeries(mo: Mo, start: () => Promise<unknown>) {
    const held = heldTransaction(async (tx) => {
      await tx.select().from(numberSeries).where(eq(numberSeries.key, "serial")).for("update");
    });
    await held.ready;
    let outcome!: Promise<unknown>;
    try {
      outcome = start().then(
        (value) => value,
        (err: unknown) => err
      );
      await waitForLockWaiter();
      // NOWAIT: an error here means the waiting writer already holds the component.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select id from articles where id = ${mo.component.id} for no key update nowait`);
      });
    } finally {
      held.release();
      await held.done;
    }
    const result = await outcome;
    expect(result).not.toBeInstanceOf(Error);
  }

  it("the report on the last operation takes the series before its components", async () => {
    // The component is linked to the LAST operation: the report draws it and receives goods.
    const mo = await makeManufacturingOrder({ linked: "last" });
    await componentFreeWhileWaitingForSeries(mo, () => reportLast(mo, 2));
    // …and it did draw the component it then locked.
    expect(await inStock(mo.component.id)).toEqual(["A1/Okänd=4996"]);
    expect(await inStock(mo.parent.id)).toEqual([`A1/${sn(1)}`, `A1/${sn(2)}`]);
  });

  it("Slutför order takes the series before its components", async () => {
    const mo = await makeManufacturingOrder({ linked: false });
    await componentFreeWhileWaitingForSeries(mo, () => mfgService.complete(mo.order.id, { quantity: 2 }, mo.user.id));
    expect(await inStock(mo.parent.id)).toEqual([`A1/${sn(1)}`, `A1/${sn(2)}`]);
  });

  it("a report and a Slutför on two TOs with the same series and a shared component, again and again: no deadlock, no number twice", async () => {
    const a = await makeManufacturingOrder({ quantity: 40, linked: false });
    const b = await makeManufacturingOrder({ quantity: 40, component: a.component, linked: false });
    for (let round = 0; round < 6; round++) {
      const outcomes = await Promise.allSettled([reportLast(a, 2), reportLast(b, 3), reportLast(a, 1)]);
      expect(outcomes.map((o) => (o.status === "rejected" ? String(o.reason) : "ok"))).toEqual(["ok", "ok", "ok"]);
    }
    const outcomes = await Promise.allSettled([mfgService.complete(a.order.id, {}, a.user.id), reportLast(b, 2), mfgService.complete(b.order.id, { quantity: 1 }, b.user.id)]);
    expect(outcomes.filter((o) => o.status === "rejected" && /deadlock|40P01/i.test(String((o as PromiseRejectedResult).reason)))).toEqual([]);
    const numbers = (await db.select().from(stockBatches)).map((s) => `${s.articleId}/${s.batchNumber}`);
    expect(new Set(numbers).size).toBe(numbers.length);
    // Every number of the common series was issued once across both articles.
    expect(new Set((await db.select().from(stockBatches)).map((s) => s.batchNumber)).size).toBe(numbers.length);
  });
});

// --- Tiderna --------------------------------------------------------------------------

describe("mätning: många nummer i en rörelse", () => {
  it("a TO report of 200 styck and an inleverans of 500 numbers", async () => {
    const mo = await makeManufacturingOrder({ quantity: 200 });
    let started = performance.now();
    const report = await reportLast(mo, 200);
    const reportMs = performance.now() - started;
    expect(report.receivedSerialNumbers).toHaveLength(200);

    const o = await makeOrder({ quantity: 500 });
    const numbers = Array.from({ length: 500 }, (_, i) => `IN-${String(i + 1).padStart(4, "0")}`);
    started = performance.now();
    const received = await receive(o, 500, { serialNumbers: numbers });
    const receiveMs = performance.now() - started;
    expect(received.receiptIds).toHaveLength(500);
    expect(await db.select({ id: purchaseReceipts.id }).from(purchaseReceipts)).toHaveLength(500);

    started = performance.now();
    const [log] = await reportsOf(mo);
    await mfgService.undoReport(mo.order.id, log!.id, mo.user.id);
    const undoMs = performance.now() - started;
    // eslint-disable-next-line no-console
    console.log(`SERIAL-TIMING report200=${reportMs.toFixed(0)}ms receive500=${receiveMs.toFixed(0)}ms undoReport200=${undoMs.toFixed(0)}ms`);
    // Generous ceilings — the point is the order of magnitude (the guard is a
    // row trigger; the writers insert in one statement).
    expect(reportMs).toBeLessThan(15_000);
    expect(receiveMs).toBeLessThan(15_000);
  }, 60_000);

  it("more than 1 000 styck in one TO report is refused", async () => {
    const mo = await makeManufacturingOrder({ quantity: 1500 });
    await expect(reportLast(mo, 1001)).rejects.toMatchObject({ name: "SerialNumbersTooManyError" });
    expect(await nextSerial()).toBe(1);
  });
});
