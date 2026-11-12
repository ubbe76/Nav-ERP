import {
  completeOperationSchema,
  createArticleSchema,
  createCustomerSchema,
  createPurchaseOrderSchema,
  createQuoteSchema,
  createStockLocationSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  deliverBatchSchema,
  listStockBatchesQuerySchema,
  receiveGoodsSchema,
  updateSystemSettingsSchema,
  type BackwardTraceNode,
  type ForwardTraceNode,
} from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, deliveryRows, permissionGroups, stockBatches, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { StockBatchNotFoundError } from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Spårbarhet (#8) against Postgres: an inköpt batch → a halvfabrikat's TO →
// the slutprodukt's TO → an utleverans, traced backward from the finished
// batch and forward from the supplier's. Okänd is a leaf, an undone draw
// and an undone utleverans are not there. The tree itself (cycle, ceiling)
// is batch-trace.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
const registerService = createRegisterService(createRegisterRepository(db));
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  articleService,
  testSystemService,
  (query) => resolvePrice(db, query),
  auditRepository
);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  auditRepository
);

const TABLES = sql`TRUNCATE audit_log, purchase_receipts, purchase_order_rows, purchase_orders, suppliers, mo_reports, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, user_settings, users CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'SPR%'`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
  await resetSetting();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  user = await authRepo.create({ email: `trace-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Lagerchef", role: "admin" });
});

afterAll(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
  await resetSetting();
});

async function batchOf(articleId: string, batchNumber: string) {
  const [row] = await db.select().from(stockBatches).where(and(eq(stockBatches.articleId, articleId), eq(stockBatches.batchNumber, batchNumber)));
  return row!;
}

// RAW (köpt): Okänd 3 + L-1 20 from an IO. HALF (tillverkad, 2 RAW per st):
// a TO of 5 draws Okänd 3 + L-1 7. FINAL (tillverkad, 1 HALF per st): a TO of
// 4. Three FINAL delivered to Kund AB; one more delivered and undone. A
// second HALF-TO reported and undone, and one L-1 scrapped.
async function fixture() {
  const warehouse = (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!;
  const a1 = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse.id, name: "A1", active: true }));
  const article = (articleNumber: string, type: "purchased" | "manufactured") =>
    articleService.createArticle(parsed(createArticleSchema, { articleNumber, name: articleNumber, type, active: true, batchTracked: true, defaultLocationId: a1.id }));
  const raw = await article("RAW", "purchased");
  const half = await article("HALF", "manufactured");
  const final = await article("FINAL", "manufactured");

  // One operation each, the component linked to it: reporting it draws the
  // material and receives the finished goods.
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
  const routed = async (parentId: string, componentId: string, quantity: number) => {
    const op = await mfgService.createRoutingOperation(parentId, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 0, runTimePerUnit: 1 });
    await articleService.addBomComponent(parentId, { componentArticleId: componentId, quantity, routingOperationId: op.id });
  };
  await routed(half.id, raw.id, 2);
  await routed(final.id, half.id, 1);

  await stockService.recordTransaction({ articleId: raw.id, locationId: a1.id, quantityDelta: 3, transactionType: "inventory_adjustment" });
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "ACME AB", active: true }));
  const purchaseOrder = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), user.id);
  const purchaseRow = await purchaseService.addRow(purchaseOrder.id, { articleId: raw.id, quantity: 30, unitPrice: 5 });
  await purchaseService.confirm(purchaseOrder.id);
  await purchaseService.receiveGoods(purchaseOrder.id, purchaseRow.id, parsed(receiveGoodsSchema, { locationId: a1.id, quantity: 20, batchNumber: "L-1" }), user.id);

  const produce = async (articleId: string, quantity: number) => {
    const order = await mfgService.createManufacturingOrder({ articleId, quantity }, user.id);
    const [operation] = await mfgService.listOperations(order.id);
    await mfgService.completeOperation(operation!.id, parsed(completeOperationSchema, { quantityCompleted: quantity }), user.id);
    return order;
  };
  const halfOrder = await produce(half.id, 5);
  const finalOrder = await produce(final.id, 4);

  // A HALF-TO that was reported and undone: its draw and its receipt net to nothing.
  const undoneOrder = await produce(half.id, 1);
  const [undoneReport] = await mfgService.listReports(undoneOrder.id);
  await mfgService.undoReport(undoneOrder.id, undoneReport!.id, user.id);

  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  const { order: salesOrder, rows } = await salesService.createQuote(
    parsed(createQuoteSchema, { customerId: customer.id, rows: [{ articleId: final.id, quantity: 4, unitPrice: 100 }] }),
    user.id
  );
  await salesService.confirm(salesOrder.id);
  await salesService.startProduction(salesOrder.id);
  const deliver = async (quantity: number) => {
    const result = await salesService.deliverBatch(salesOrder.id, parsed(deliverBatchSchema, { rows: [{ rowId: rows[0]!.id, quantity }] }), user.id);
    const [row] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
    return { ...result, deliveryRowId: row!.id };
  };
  const delivery = await deliver(3);
  const undone = await deliver(1);
  await salesService.undoDeliveryRow(salesOrder.id, undone.deliveryId, undone.deliveryRowId, user.id);

  const rawBatch = await batchOf(raw.id, "L-1");
  // Kassation: one of L-1.
  await stockService.recordTransaction({ articleId: raw.id, locationId: a1.id, quantityDelta: -1, transactionType: "inventory_adjustment", batchId: rawBatch.id, note: "Kassation" });

  return {
    a1,
    raw,
    half,
    final,
    supplier,
    purchaseOrder,
    halfOrder,
    finalOrder,
    undoneOrder,
    customer,
    salesOrder,
    delivery,
    rawBatch,
    halfBatch: await batchOf(half.id, halfOrder.orderNumber),
    finalBatch: await batchOf(final.id, finalOrder.orderNumber),
  };
}

const backText = (node: BackwardTraceNode): string => {
  const name = `${node.batch.articleNumber}/${node.batch.batchNumber ?? "Okänd"}${node.quantity === null ? "" : `:${node.quantity}`}${node.stop ? `!${node.stop}` : ""}`;
  const orders = node.manufacturingOrders.map((mo) => `${mo.orderNumber}:${mo.quantity}(${mo.materials.map(backText).join(",")})`);
  return orders.length > 0 ? `${name}[${orders.join(";")}]` : name;
};
const forwardText = (node: ForwardTraceNode): string => {
  const name = `${node.batch.articleNumber}/${node.batch.batchNumber ?? "Okänd"}${node.quantity === null ? "" : `:${node.quantity}`}${node.stop ? `!${node.stop}` : ""}`;
  const orders = node.consumedBy.map((mo) => `${mo.orderNumber}:${mo.quantity}(${mo.produced.map(forwardText).join(",")})`);
  return orders.length > 0 ? `${name}[${orders.join(";")}]` : name;
};

describe("traceBatch against the log", () => {
  it("backward from the finished batch: its TO, the halvfabrikat's batch and TO, and the material — Okänd as a leaf, the supplier's batch with its inleverans", async () => {
    const f = await fixture();
    const trace = await stockService.traceBatch(f.finalBatch.id);
    expect(trace.truncated).toBe(false);
    expect(trace.batch).toMatchObject({
      batchId: f.finalBatch.id,
      batchNumber: f.finalOrder.orderNumber,
      articleId: f.final.id,
      articleNumber: "FINAL",
      unitCode: "st",
      batchTracked: true,
      origin: "manufacturing_order",
    });
    const h = f.halfOrder.orderNumber;
    const t = f.finalOrder.orderNumber;
    expect(backText(trace.backward)).toBe(`FINAL/${t}[${t}:4(HALF/${h}:4[${h}:5(RAW/Okänd:3!unknown,RAW/L-1:7)])]`);

    const rawNode = trace.backward.manufacturingOrders[0]!.materials[0]!.manufacturingOrders[0]!.materials[1]!;
    expect(rawNode.batch).toMatchObject({ batchId: f.rawBatch.id, origin: "purchase_receipt" });
    expect(rawNode.receipts).toHaveLength(1);
    expect(rawNode.receipts[0]).toMatchObject({
      purchaseOrderId: f.purchaseOrder.id,
      orderNumber: f.purchaseOrder.orderNumber,
      supplierId: f.supplier.id,
      supplierName: "ACME AB",
      quantity: 20,
    });
    expect(new Date(rawNode.receipts[0]!.receivedAt).getTime()).toBeGreaterThan(0);
    // The kassation is not a source.
    expect(rawNode.events).toEqual([]);
  });

  it("forward from the supplier's batch: the TO that drew it, the halvfabrikat's batch, the slutprodukt's and its utleverans — nothing of what was undone", async () => {
    const f = await fixture();
    const trace = await stockService.traceBatch(f.rawBatch.id);
    const h = f.halfOrder.orderNumber;
    const t = f.finalOrder.orderNumber;
    // The undone HALF-TO is not there, and the undone utleverans neither.
    expect(forwardText(trace.forward)).toBe(`RAW/L-1[${h}:7(HALF/${h}:5[${t}:4(FINAL/${t}:4)])]`);
    expect(trace.forward.consumedBy[0]).toMatchObject({ manufacturingOrderId: f.halfOrder.id, articleId: f.half.id, articleNumber: "HALF" });

    // 20 in, 7 drawn, 1 scrapped.
    expect(trace.forward.onHand).toEqual([{ locationId: f.a1.id, warehouseName: "Huvudlager", locationName: "A1", blocked: false, quantity: 12 }]);
    expect(trace.forward.events).toMatchObject([{ kind: "adjustment", stockCountId: null, quantity: -1, note: "Kassation" }]);
    expect(trace.forward.deliveries).toEqual([]);

    const halfNode = trace.forward.consumedBy[0]!.produced[0]!;
    expect(halfNode.onHand.map((p) => p.quantity)).toEqual([1]);
    const finalNode = halfNode.consumedBy[0]!.produced[0]!;
    expect(finalNode.deliveries).toHaveLength(1);
    expect(finalNode.deliveries[0]).toMatchObject({
      deliveryId: f.delivery.deliveryId,
      salesOrderId: f.salesOrder.id,
      customerId: f.customer.id,
      customerName: "Kund AB",
      quantity: 3,
    });
    expect(finalNode.deliveries[0]!.deliveryNumber).toMatch(/^FS/);
    // The order's number as it is now (KO — the quote's OF number is history).
    expect(finalNode.deliveries[0]!.orderNumber).toMatch(/^KO/);
    expect(finalNode.onHand.map((p) => p.quantity)).toEqual([1]);

    // The supplier's batch has its inleverans behind it and nothing else.
    expect(backText(trace.backward)).toBe("RAW/L-1");
    expect(trace.backward.receipts).toHaveLength(1);
  });

  it("the ceiling reaches the real reader, and an unknown batch is refused", async () => {
    const f = await fixture();
    const cut = await stockService.traceBatch(f.finalBatch.id, { maxDepth: 1 });
    expect(cut.truncated).toBe(true);
    const h = f.halfOrder.orderNumber;
    const t = f.finalOrder.orderNumber;
    expect(backText(cut.backward)).toBe(`FINAL/${t}[${t}:4(HALF/${h}:4[${h}:5(RAW/Okänd:3!unknown,RAW/L-1:7!limit)])]`);
    await expect(stockService.traceBatch(crypto.randomUUID())).rejects.toThrow(StockBatchNotFoundError);
  });

  it("the batch register: search on the batch number or the article, one article, pages and the balance", async () => {
    const f = await fixture();
    const list = (query: Record<string, unknown>) => stockService.listBatches(parsed(listStockBatchesQuerySchema, query));

    const all = await list({});
    // L-1, the two HALF-TOs' batches (the undone one keeps its batch, empty) and FINAL's.
    expect(all.total).toBe(4);
    expect(all.rows.find((r) => r.id === f.rawBatch.id)).toMatchObject({
      batchNumber: "L-1",
      articleId: f.raw.id,
      articleNumber: "RAW",
      articleName: "RAW",
      unitCode: "st",
      origin: "purchase_receipt",
      quantity: 12,
    });
    expect(all.rows.find((r) => r.batchNumber === f.undoneOrder.orderNumber)!.quantity).toBe(0);

    expect((await list({ search: "l-1" })).rows.map((r) => r.batchNumber)).toEqual(["L-1"]);
    expect((await list({ search: "HALF" })).total).toBe(2);
    expect((await list({ articleId: f.final.id })).rows.map((r) => [r.batchNumber, r.quantity])).toEqual([[f.finalOrder.orderNumber, 1]]);
    const page = await list({ limit: 1, offset: 1 });
    expect([page.rows.length, page.total]).toEqual([1, 4]);
    expect((await list({ search: "finns-inte" })).total).toBe(0);
  });
});

// Through the real app: the stock module's read rule (office), the id guard
// and the 404 — and readable whatever the setting says.
describe("the Spårbarhet routes", () => {
  const authService = createAuthService(authRepo, "unused", auditRepository);
  const PASSWORD = "correcthorsebattery";
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  async function userCookie(permissions: string[], readOnly = false) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `SPR${crypto.randomUUID().slice(0, 6)}`, name: "Spårbarhet", permissions })
      .returning();
    const email = `trace-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }
  const get = (cookie: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

  it("GET /stock/batches and /stock/batches/:id/trace: office reads (a read-only account too), the terminal alone is refused; 404 and 400", async () => {
    const f = await fixture();

    const buyer = await userCookie(["inkop"]);
    const listed = await get(buyer, "/stock/batches?search=L-1");
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ total: 1, rows: [{ id: f.rawBatch.id, batchNumber: "L-1", quantity: 12 }] });
    expect(typeof listed.json().rows[0].createdAt).toBe("string");

    const traced = await get(buyer, `/stock/batches/${f.finalBatch.id}/trace`);
    expect(traced.statusCode).toBe(200);
    expect(traced.json()).toMatchObject({ truncated: false, batch: { batchId: f.finalBatch.id }, backward: { stop: null }, forward: { stop: null } });
    expect(traced.json().forward.deliveries[0]).toMatchObject({ customerName: "Kund AB", quantity: 3 });

    const readOnly = await userCookie(["lager"], true);
    expect((await get(readOnly, `/stock/batches/${f.rawBatch.id}/trace`)).statusCode).toBe(200);
    expect((await get(readOnly, "/stock/batches")).json().total).toBe(4);

    const terminal = await userCookie(["terminal"]);
    expect((await get(terminal, "/stock/batches")).statusCode).toBe(403);
    expect((await get(terminal, `/stock/batches/${f.rawBatch.id}/trace`)).statusCode).toBe(403);

    const missing = await get(buyer, `/stock/batches/${crypto.randomUUID()}/trace`);
    expect([missing.statusCode, missing.json().code]).toEqual([404, "stock-batch-not-found"]);
    const malformed = await get(buyer, "/stock/batches/inte-ett-id/trace");
    expect([malformed.statusCode, malformed.json().code]).toEqual([400, "validation-failed"]);
    expect((await get(buyer, "/stock/batches?limit=0")).statusCode).toBe(400);

    // Readable with the setting off: every flag off first, then the setting.
    for (const article of [f.raw, f.half, f.final]) await articleService.updateArticle(article.id, { batchTracked: false });
    await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: false }));
    expect((await get(buyer, "/stock/batches")).json().total).toBe(4);
    expect((await get(buyer, `/stock/batches/${f.rawBatch.id}/trace`)).statusCode).toBe(200);
  });
});
