import {
  completeOperationSchema,
  createArticleSchema,
  createCustomerSchema,
  createPurchaseOrderSchema,
  createQuoteSchema,
  createStockAdjustmentSchema,
  createSupplierSchema,
  createWorkCenterSchema,
} from "@navet/shared";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  deliveryRowLocations,
  deliveryRows,
  manufacturingOrders,
  moReportMaterials,
  purchaseOrders,
  salesOrderRows,
  salesOrders,
  stockLocations,
  stockTransactions,
} from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createWorkInProgressRepository } from "../src/modules/costing/repository/work-in-progress.repository.js";
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
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { deactivateEmptyLocation } from "../src/modules/stock/service/location-lifecycle.js";
import { lockArticlesForOutflow } from "../src/modules/stock/service/outflow-locations.js";
import { createStockCountService } from "../src/modules/stock/service/stock-count.service.js";
import {
  createStockService,
  InsufficientStockError,
  ServiceArticleNotStockedError,
  StockLocationNotFoundError,
} from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";

// Lagergranskningen 2026-11-10: the races and float edges the two reviews
// of the stock module found, and "tjänster lagerförs inte" (the user's
// decision): a service article is bought, sold and consumed on a TO without
// ever being written to stock.

const auditRepository = createAuditRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db), auditRepository);
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
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
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  auditRepository,
  undefined,
  undefined,
  testSystemService
);
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
const countService = createStockCountService({ repo: createStockCountRepository(db), audit: auditRepository });

const TABLES = sql`TRUNCATE audit_log, stock_count_rows, stock_count_sessions, purchase_receipts, mo_report_materials, mo_reports,
  purchase_order_rows, purchase_orders, suppliers, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders,
  routing_operations, work_centers, production_groups, delivery_row_locations, delivery_rows, deliveries, sales_order_rows, sales_orders,
  customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

let user: { id: string };
let warehouseId: string | null = null;

beforeEach(async () => {
  warehouseId = null;
  await db.execute(TABLES);
  user = await authRepo.create({ email: `lager-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Lagerchef", role: "admin" });
});
afterAll(async () => {
  await db.execute(TABLES);
});

async function place(name: string, opts: { fixed?: boolean } = {}) {
  warehouseId ??= (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!.id;
  return stockService.createLocation({ warehouseId, name, active: true, fixed: opts.fixed ?? true, blocked: false });
}

async function article(number: string, type: "purchased" | "manufactured" | "service" = "purchased", defaultLocationId?: string) {
  return articleService.createArticle(parsed(createArticleSchema, { articleNumber: number, name: number, type, active: true, defaultLocationId }));
}

async function stock(articleId: string, locationId: string, quantityDelta: number) {
  return stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" }, user.id);
}

async function balance(articleId: string, locationId?: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(locationId ? and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)) : eq(stockTransactions.articleId, articleId));
  return Number(row!.q);
}

async function stockRows(articleId: string) {
  return db.select().from(stockTransactions).where(eq(stockTransactions.articleId, articleId));
}

async function purchaseOrder(rows: { articleId: string; quantity: number }[]) {
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "Leverantör AB", active: true }));
  const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), user.id);
  const added = [];
  for (const r of rows) added.push(await purchaseService.addRow(order.id, { articleId: r.articleId, quantity: r.quantity, unitPrice: 10 }));
  await purchaseService.confirm(order.id);
  return { order, rows: added };
}

async function salesOrder(rows: { articleId: string; quantity: number }[]) {
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  const created = await salesService.createQuote(
    parsed(createQuoteSchema, { customerId: customer.id, rows: rows.map((r) => ({ ...r, unitPrice: 10 })) }),
    user.id
  );
  await salesService.confirm(created.order.id);
  await salesService.startProduction(created.order.id);
  return created;
}

// Parent P with one component C at `perUnit`, linked to operation 10 when
// `linked`; a TO of `quantity`.
async function manufacturingOrder(opts: { component: { id: string }; perUnit: number; quantity: number; linked?: boolean }) {
  const p = await article(`P-${crypto.randomUUID().slice(0, 6)}`, "manufactured");
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: String(100 + Math.floor(Math.random() * 800)), name: "Svets", active: true }));
  const op10 = await mfgService.createRoutingOperation(p.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 0, runTimePerUnit: 1 });
  await mfgService.createRoutingOperation(p.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 0, runTimePerUnit: 1 });
  await articleService.addBomComponent(p.id, {
    componentArticleId: opts.component.id,
    quantity: opts.perUnit,
    ...(opts.linked ? { routingOperationId: op10.id } : {}),
  });
  const order = await mfgService.createManufacturingOrder({ articleId: p.id, quantity: opts.quantity }, user.id);
  const [first] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  const [material] = await mfgService.listMaterialConsumptions(order.id);
  return { order, first: first!, material: material! };
}

describe("lagergranskningen — decimals", () => {
  it("Förbruka takes the exact remainder 0.1 + 0.2 of a planned 0.3", async () => {
    const a1 = await place("A1");
    const c = await article("C-1", "purchased", a1.id);
    await stock(c.id, a1.id, 10);
    const f = await manufacturingOrder({ component: c, perUnit: 0.3, quantity: 1 });
    await mfgService.consumeMaterial(f.order.id, f.material.id, { quantity: 0.1 }, user.id);
    await mfgService.consumeMaterial(f.order.id, f.material.id, { quantity: 0.2 }, user.id);
    expect(await balance(c.id, a1.id)).toBe(9.7);
  });

  it("a report that tops up nothing writes no stock row of float noise", async () => {
    const a1 = await place("A1");
    const c = await article("C-1", "purchased", a1.id);
    await stock(c.id, a1.id, 10);
    const f = await manufacturingOrder({ component: c, perUnit: 0.1, quantity: 10, linked: true });
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 3 }), user.id);
    const before = (await stockRows(c.id)).length;
    // 0.1 × 3 − 0.3 is 5.6e-17 in floats: nothing more to draw.
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 0 }), user.id);
    expect((await stockRows(c.id)).length).toBe(before);
    expect(await balance(c.id, a1.id)).toBe(9.7);
  });
});

describe("lagergranskningen — status and stock races", () => {
  it("Makulera does not overwrite a receipt that committed meanwhile", async () => {
    const x = await article("X-1");
    const { order } = await purchaseOrder([{ articleId: x.id, quantity: 5 }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Resolved once the holder has its locks: the contender starts only then
    // (started together, the contender could win the race and nothing waits).
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    // A receipt in flight: the order locked and turned partially_received.
    const receipt = db.transaction(async (tx) => {
      await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, order.id)).for("update");
      await tx.update(purchaseOrders).set({ status: "partially_received" }).where(eq(purchaseOrders.id, order.id));
      held();
      await gate;
    });
    await Promise.race([holding, receipt]);
    const cancelling = purchaseService.cancel(order.id, user.id);
    // Handled at once: it can reject while the test still awaits the holder
    // (Vitest reports that as an unhandled rejection); the expect below reads it.
    cancelling.catch(() => {});
    try {
      await waitForLockWaiter();
    } finally {
      release(); // never leave the holder's locks behind a failed wait
    }
    await receipt;
    await expect(cancelling).rejects.toThrow(/received/);
    const [row] = await db.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, order.id));
    expect(row!.status).toBe("partially_received");
  });

  it("a receipt re-checks the status under the order lock and never lands on a cancelled order", async () => {
    const a1 = await place("A1");
    const x = await article("X-1", "purchased", a1.id);
    const { order, rows } = await purchaseOrder([{ articleId: x.id, quantity: 5 }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Resolved once the holder has its locks: the contender starts only then
    // (started together, the contender could win the race and nothing waits).
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const cancel = db.transaction(async (tx) => {
      await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, order.id)).for("update");
      await tx.update(purchaseOrders).set({ status: "cancelled" }).where(eq(purchaseOrders.id, order.id));
      held();
      await gate;
    });
    await Promise.race([holding, cancel]);
    const receiving = purchaseService.receiveGoods(order.id, rows[0]!.id, { quantity: 5 }, user.id);
    // Handled at once: it can reject while the test still awaits the holder
    // (Vitest reports that as an unhandled rejection); the expect below reads it.
    receiving.catch(() => {});
    try {
      await waitForLockWaiter();
    } finally {
      release(); // never leave the holder's locks behind a failed wait
    }
    await cancel;
    await expect(receiving).rejects.toThrow();
    expect(await balance(x.id)).toBe(0);
  });

  it("a transfer waits for a draw of the same article and refuses what the draw took", async () => {
    const l1 = await place("L1");
    const l2 = await place("L2");
    // Not its huvudplats: a follower was already locked; this one was not.
    const x = await article("X-1");
    await stock(x.id, l1.id, 10);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Resolved once the holder has its locks: the contender starts only then
    // (started together, the contender could win the race and nothing waits).
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const draw = db.transaction(async (tx) => {
      await lockArticlesForOutflow(tx, [x.id]);
      await tx.insert(stockTransactions).values({ articleId: x.id, locationId: l1.id, quantityDelta: "-10", transactionType: "sales_delivery" });
      held();
      await gate;
    });
    await Promise.race([holding, draw]);
    const moving = stockService.transferStock({ fromLocationId: l1.id, toLocationId: l2.id, rows: [{ articleId: x.id, quantity: 10 }] }, user.id);
    // Handled at once: it can reject while the test still awaits the holder
    // (Vitest reports that as an unhandled rejection); the expect below reads it.
    moving.catch(() => {});
    try {
      await waitForLockWaiter();
    } finally {
      release(); // never leave the holder's locks behind a failed wait
    }
    await draw;
    await expect(moving).rejects.toBeInstanceOf(InsufficientStockError);
    expect([await balance(x.id, l1.id), await balance(x.id, l2.id)]).toEqual([0, 0]);
  });

  it("two deliveries of different rows at once leave the order Levererad", async () => {
    const a1 = await place("A1");
    const x = await article("X-1", "purchased", a1.id);
    const y = await article("Y-1", "purchased", a1.id);
    await stock(x.id, a1.id, 5);
    await stock(y.id, a1.id, 5);
    const { order, rows } = await salesOrder([
      { articleId: x.id, quantity: 5 },
      { articleId: y.id, quantity: 5 },
    ]);
    await Promise.all([
      salesService.deliverBatch(order.id, { rows: [{ rowId: rows[0]!.id, quantity: 5 }] }, user.id),
      salesService.deliverBatch(order.id, { rows: [{ rowId: rows[1]!.id, quantity: 5 }] }, user.id),
    ]);
    const [header] = await db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, order.id));
    expect(header!.status).toBe("delivered");
  });

  it("Stäng order does not overtake a change of status in flight", async () => {
    const c = await article("C-1");
    const f = await manufacturingOrder({ component: c, perUnit: 1, quantity: 1 });
    await db.update(manufacturingOrders).set({ status: "done" }).where(eq(manufacturingOrders.id, f.order.id));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Resolved once the holder has its locks: the contender starts only then
    // (started together, the contender could win the race and nothing waits).
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    // E.g. an Ångra that reopens the order, holding it FOR UPDATE.
    const reopen = db.transaction(async (tx) => {
      await tx.select({ id: manufacturingOrders.id }).from(manufacturingOrders).where(eq(manufacturingOrders.id, f.order.id)).for("update");
      await tx.update(manufacturingOrders).set({ status: "in_progress" }).where(eq(manufacturingOrders.id, f.order.id));
      held();
      await gate;
    });
    await Promise.race([holding, reopen]);
    // The outcome caught right away: the close can reject while the test
    // still awaits `reopen`, which Vitest reports as an unhandled rejection.
    const closing = mfgService.close(f.order.id, user.id).then(
      () => null,
      (error: unknown) => error
    );
    try {
      await waitForLockWaiter();
    } finally {
      release(); // never leave the holder's locks behind a failed wait
    }
    await reopen;
    expect(await closing).toBeInstanceOf(Error);
    expect(((await closing) as Error).message).toMatch(/no longer done/);
    const [row] = await db.select({ status: manufacturingOrders.status }).from(manufacturingOrders).where(eq(manufacturingOrders.id, f.order.id));
    expect(row!.status).toBe("in_progress");
  });

  it("Ångra inleverans waits for a draw of the goods and then refuses", async () => {
    const a1 = await place("A1");
    const x = await article("X-1", "purchased", a1.id);
    const { order, rows } = await purchaseOrder([{ articleId: x.id, quantity: 10 }]);
    await purchaseService.receiveGoods(order.id, rows[0]!.id, { locationId: a1.id, quantity: 10 }, user.id);
    const [receipt] = await purchaseService.listReceipts(order.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Resolved once the holder has its locks: the contender starts only then
    // (started together, the contender could win the race and nothing waits).
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const draw = db.transaction(async (tx) => {
      await lockArticlesForOutflow(tx, [x.id]);
      await tx.insert(stockTransactions).values({ articleId: x.id, locationId: a1.id, quantityDelta: "-10", transactionType: "sales_delivery" });
      held();
      await gate;
    });
    await Promise.race([holding, draw]);
    const undoing = purchaseService.undoReceipt(order.id, receipt!.id, user.id);
    // Handled at once: it can reject while the test still awaits the holder
    // (Vitest reports that as an unhandled rejection); the expect below reads it.
    undoing.catch(() => {});
    try {
      await waitForLockWaiter();
    } finally {
      release(); // never leave the holder's locks behind a failed wait
    }
    await draw;
    await expect(undoing).rejects.toThrow();
    expect(await balance(x.id, a1.id)).toBe(0);
  });

  it("an inflow onto a temporary place being retired revives it (trigger 0202)", async () => {
    const t = await place("T1", { fixed: false });
    const a = await article("A-1", "purchased", t.id);
    const b = await article("B-1");
    await stock(a.id, t.id, 5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Resolved once the holder has its locks: the contender starts only then
    // (started together, the contender could win the race and nothing waits).
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    // The draw signals once it holds the retirement — waiting on pg_locks
    // (any transaction in the whole cluster) let another test worker's
    // transaction satisfy the wait before this one had locked anything.
    let retired!: () => void;
    const atGate = new Promise<void>((resolve) => (retired = resolve));
    // The draw that empties T and retires it, still uncommitted.
    const draw = db.transaction(async (tx) => {
      await lockArticlesForOutflow(tx, [a.id]);
      await tx.insert(stockTransactions).values({ articleId: a.id, locationId: t.id, quantityDelta: "-5", transactionType: "sales_delivery" });
      expect(await deactivateEmptyLocation(tx, t.id)).toBe(true);
      retired();
      held();
      await gate;
    });
    await Promise.race([holding, draw]);
    await atGate;
    // B arrives on T: its FK check waits for the retirement, then the
    // trigger revives the place for it.
    const inflow = stock(b.id, t.id, 10);
    try {
      await waitForLockWaiter();
    } finally {
      release(); // never leave the holder's locks behind a failed wait
    }
    await draw;
    await inflow;
    const [row] = await db.select({ active: stockLocations.active }).from(stockLocations).where(eq(stockLocations.id, t.id));
    expect(row!.active).toBe(true);
    expect(await balance(b.id, t.id)).toBe(10);
  });

  it("a retirement waits for an inflow onto the place and keeps it active", async () => {
    const t = await place("T1", { fixed: false });
    const a = await article("A-1", "purchased", t.id);
    const b = await article("B-1");
    await stock(a.id, t.id, 5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Resolved once the holder has its locks: the contender starts only then
    // (started together, the contender could win the race and nothing waits).
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const inflow = db.transaction(async (tx) => {
      await tx.insert(stockTransactions).values({ articleId: b.id, locationId: t.id, quantityDelta: "10", transactionType: "inventory_adjustment" });
      held();
      await gate;
    });
    await Promise.race([holding, inflow]);
    await waitForCondition(async () => (await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, b.id))).length === 0);
    const draw = db.transaction(async (tx) => {
      await lockArticlesForOutflow(tx, [a.id]);
      await tx.insert(stockTransactions).values({ articleId: a.id, locationId: t.id, quantityDelta: "-5", transactionType: "sales_delivery" });
      return deactivateEmptyLocation(tx, t.id);
    });
    try {
      await waitForLockWaiter();
    } finally {
      release(); // never leave the holder's locks behind a failed wait
    }
    await inflow;
    expect(await draw).toBe(false);
    const [row] = await db.select({ active: stockLocations.active }).from(stockLocations).where(eq(stockLocations.id, t.id));
    expect(row!.active).toBe(true);
  });
});

describe("lagergranskningen — the manual routes", () => {
  it("an unknown chosen place is StockLocationNotFoundError, not a foreign-key 500", async () => {
    const x = await article("X-1");
    await expect(stock(x.id, crypto.randomUUID(), 1)).rejects.toBeInstanceOf(StockLocationNotFoundError);
  });

  it("POST /stock/transactions books adjustments only", () => {
    const base = { articleId: crypto.randomUUID(), quantityDelta: 1 };
    expect(createStockAdjustmentSchema.parse(base).transactionType).toBe("inventory_adjustment");
    expect(createStockAdjustmentSchema.safeParse({ ...base, transactionType: "inventory_adjustment" }).success).toBe(true);
    for (const transactionType of ["purchase_receipt", "sales_delivery", "mo_consumption", "mo_receipt", "stock_transfer"]) {
      expect([transactionType, createStockAdjustmentSchema.safeParse({ ...base, transactionType }).success]).toEqual([transactionType, false]);
    }
  });
});

describe("tjänster lagerförs inte", () => {
  it("a service row is received and undone without a stock movement", async () => {
    const a1 = await place("A1");
    const s = await article("S-1", "service");
    const { order, rows } = await purchaseOrder([{ articleId: s.id, quantity: 3 }]);
    const received = await purchaseService.receiveGoods(order.id, rows[0]!.id, { locationId: a1.id, quantity: 3 }, user.id);
    expect(Number(received.row.quantityReceived)).toBe(3);
    expect(await stockRows(s.id)).toEqual([]);
    const [receipt] = await purchaseService.listReceipts(order.id);
    expect(receipt).toMatchObject({ quantity: "3.0000" });
    await purchaseService.undoReceipt(order.id, receipt!.id, user.id);
    expect(await stockRows(s.id)).toEqual([]);
  });

  it("a service row is delivered and undone without a stock movement or parts", async () => {
    const a1 = await place("A1");
    const x = await article("X-1", "purchased", a1.id);
    const s = await article("S-1", "service");
    await stock(x.id, a1.id, 2);
    const { order, rows } = await salesOrder([
      { articleId: x.id, quantity: 2 },
      { articleId: s.id, quantity: 4 },
    ]);
    const delivered = await salesService.deliverBatch(order.id, { rows: [{ rowId: rows[1]!.id, quantity: 4 }] }, user.id);
    expect(await stockRows(s.id)).toEqual([]);
    expect(await db.select().from(deliveryRowLocations)).toEqual([]);
    const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, delivered.deliveryId));
    await salesService.undoDeliveryRow(order.id, delivered.deliveryId, deliveryRow!.id, user.id);
    expect(await stockRows(s.id)).toEqual([]);
    const [row] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, rows[1]!.id));
    expect(Number(row!.quantityDelivered)).toBe(0);
  });

  it("a service component is consumed on the TO, logged without a place, counted in PIA, and undone — never stocked", async () => {
    const s = await article("S-1", "service");
    const f = await manufacturingOrder({ component: s, perUnit: 2, quantity: 1 });
    const consumed = await mfgService.consumeMaterial(f.order.id, f.material.id, { quantity: 2 }, user.id);
    expect(Number(consumed.quantityConsumed)).toBe(2);
    expect(await stockRows(s.id)).toEqual([]);
    const [line] = await db.select().from(moReportMaterials).where(isNull(moReportMaterials.locationId));
    expect(Number(line!.quantity)).toBe(2);
    const reports = await mfgService.listReports(f.order.id);
    expect(reports[0]!.materials).toEqual([{ materialConsumptionId: expect.any(String), articleNumber: "S-1", quantity: "2.0000", locationName: null, batchNumber: null, batchKind: null }]);
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
    const net = await createWorkInProgressRepository(db).listMaterialNet(today);
    expect(net.map((r) => [r.manufacturingOrderId, r.articleId, Number(r.quantity)])).toEqual([[f.order.id, s.id, 2]]);

    await mfgService.undoReport(f.order.id, consumed.reportId, user.id);
    expect(Number((await mfgService.listMaterialConsumptions(f.order.id))[0]!.quantityConsumed)).toBe(0);
    expect(await stockRows(s.id)).toEqual([]);
    expect(await createWorkInProgressRepository(db).listMaterialNet(today)).toEqual([]);
  });

  it("refuses a service in Lagerjustering, Lagerflytt and an inventering, and leaves it out of the count", async () => {
    const a1 = await place("A1");
    const a2 = await place("A2");
    const s = await article("S-1", "service");
    const x = await article("X-1", "purchased", a1.id);
    await expect(stock(s.id, a1.id, 1)).rejects.toBeInstanceOf(ServiceArticleNotStockedError);
    await expect(
      stockService.transferStock({ fromLocationId: a1.id, toLocationId: a2.id, rows: [{ articleId: s.id, quantity: 1 }] }, user.id)
    ).rejects.toBeInstanceOf(ServiceArticleNotStockedError);
    // A balance a service got before the rule is history: never seeded.
    await db.insert(stockTransactions).values({ articleId: s.id, locationId: a1.id, quantityDelta: "-3", transactionType: "mo_consumption" });
    await stock(x.id, a1.id, 4);
    const session = await countService.createSession({ locationId: a1.id, blocksTransactions: false }, user.id);
    const detail = await countService.getSession(session.id);
    expect(detail.rows.map((r) => r.articleId)).toEqual([x.id]);
    await expect(countService.addRow(session.id, { articleId: s.id })).rejects.toBeInstanceOf(ServiceArticleNotStockedError);
  });
});

describe("migration 0204 — tjänsternas gamla saldon nollas", () => {
  const statements = readFileSync(new URL("../../../packages/db/drizzle/0204_tjanster_nollade_saldon.sql", import.meta.url), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const migrate = () => db.transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });

  it("zeroes every (service, place) with an adjustment, leaves goods alone, and puts an emptied inactive place back", async () => {
    const a1 = await place("A1");
    const t = await place("T1", { fixed: false });
    const s = await article("S-1", "service");
    const x = await article("X-1", "purchased", a1.id);
    // The shape before the rule: a receipt of the service into A1 and a TO
    // draw that took it negative on T, which was then retired.
    await db.insert(stockTransactions).values([
      { articleId: s.id, locationId: a1.id, quantityDelta: "5", transactionType: "purchase_receipt", unitCost: "100" },
      { articleId: s.id, locationId: t.id, quantityDelta: "-3", transactionType: "mo_consumption" },
    ]);
    await db.update(stockLocations).set({ active: false }).where(eq(stockLocations.id, t.id));
    await stock(x.id, a1.id, 7);

    await migrate();

    expect([await balance(s.id, a1.id), await balance(s.id, t.id), await balance(x.id, a1.id)]).toEqual([0, 0, 7]);
    const added = (await stockRows(s.id)).filter((r) => r.transactionType === "inventory_adjustment");
    expect(added.map((r) => [r.locationId, Number(r.quantityDelta), r.unitCost, r.note]).sort()).toEqual(
      [
        [a1.id, -5, null, "Tjänster lagerförs inte — saldot nollat vid uppdateringen (0204)"],
        [t.id, 3, null, "Tjänster lagerförs inte — saldot nollat vid uppdateringen (0204)"],
      ].sort()
    );
    const [place1] = await db.select({ active: stockLocations.active }).from(stockLocations).where(eq(stockLocations.id, t.id));
    expect(place1!.active).toBe(false);
    const [placeA] = await db.select({ active: stockLocations.active }).from(stockLocations).where(eq(stockLocations.id, a1.id));
    expect(placeA!.active).toBe(true);

    // Run again: nothing left to zero.
    const before = (await db.select().from(stockTransactions)).length;
    await migrate();
    expect((await db.select().from(stockTransactions)).length).toBe(before);
  });
});

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never held");
}
