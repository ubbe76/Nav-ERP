import {
  completeOperationSchema,
  consumeMaterialSchema,
  createArticleSchema,
  createCustomerSchema,
  createQuoteSchema,
  createStockAdjustmentSchema,
  createStockLocationSchema,
  createStockTransferSchema,
  createWorkCenterSchema,
  deliverBatchSchema,
  listStockTransactionsQuerySchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { articles, auditLog, db, deliveryRowLocations, deliveryRows, stockBatches, stockLocations, stockTransactions, systemSettings, type Tx } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { batchCellsForArticles } from "../src/modules/stock/repository/batch-balances.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { BatchInsufficientError, BatchNotTrackedError, StockBatchNotFoundError } from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { allocateOutflowLocations, lockArticlesForOutflow } from "../src/modules/stock/service/outflow-locations.js";
import { DuplicateStockCountRowError, InsufficientStockError, StockLocationBlockedError } from "../src/modules/stock/service/stock.errors.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Batch (#8), steg 2 — the outflows per cell (place, batch): the loader
// allocateOutflowLocations, utleverans and Ångra utleverans, the TO's
// material in the reports and Förbruka, flytt, a negative justering, the
// saldoimport's decrease and the inventering per batch. Okänd first, then
// the oldest batch; a chosen named batch never goes negative; an Ångra
// goes back into the same batch. An article that is not batchstyrd is
// covered, unchanged, by the files that were there before.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const countRepo = createStockCountRepository(db);
const authRepo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  createRegisterService(createRegisterRepository(db)),
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
const imports = createImportService(createImportRepository(db));

const TABLES = sql`TRUNCATE audit_log, stock_count_rows, stock_count_sessions, mo_reports, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));

let user: { id: string };
let warehouseId: string;

beforeEach(async () => {
  await db.execute(TABLES);
  await resetSetting();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  user = await authRepo.create({ email: `batch-out-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Lagerchef", role: "admin" });
  warehouseId = (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!.id;
});

afterAll(async () => {
  await db.execute(TABLES);
  await resetSetting();
});

// Every place in ONE warehouse, so the pick-list order is the place name.
const makeLocation = (name: string) => stockService.createLocation(parsed(createStockLocationSchema, { warehouseId, name, active: true }));

let n = 0;
async function makeArticle(patch: Record<string, unknown> = {}) {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `BO-${++n}-${crypto.randomUUID().slice(0, 6)}`, name: "Plåt", type: "purchased", active: true, batchTracked: true, ...patch })
  );
}

const adjust = (articleId: string, locationId: string, quantityDelta: number, batchNumber?: string) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment", batchNumber });

// A decrease booked on Okänd whatever batches the place holds.
const takeUnknown = (articleId: string, locationId: string, quantity: number) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta: -quantity, transactionType: "inventory_adjustment", batchId: null });

const DAY = 24 * 60 * 60 * 1000;
// Makes the batch `days` days old — batches booked in one test otherwise
// differ by milliseconds only.
const age = (batchNumber: string, days: number) =>
  db.update(stockBatches).set({ createdAt: new Date(Date.now() - days * DAY) }).where(eq(stockBatches.batchNumber, batchNumber));

async function batchId(articleId: string, batchNumber: string) {
  const [row] = await db.select().from(stockBatches).where(and(eq(stockBatches.articleId, articleId), eq(stockBatches.batchNumber, batchNumber)));
  return row!.id;
}

// "<place>/<batch | Okänd>=<quantity>" for every cell of the article, sorted.
async function cells(articleId: string) {
  const names = new Map((await db.select({ id: stockLocations.id, name: stockLocations.name }).from(stockLocations)).map((l) => [l.id, l.name]));
  return (await batchCellsForArticles(db, [articleId])).map((c) => `${names.get(c.locationId)}/${c.batchNumber ?? "Okänd"}=${c.quantity}`).sort();
}

// The article's rows of one type as "<place>/<batch | Okänd>:<delta>", sorted.
async function moves(articleId: string, type: (typeof stockTransactions.transactionType.enumValues)[number]) {
  const rows = await db
    .select({ delta: stockTransactions.quantityDelta, place: stockLocations.name, batchNumber: stockBatches.batchNumber })
    .from(stockTransactions)
    .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.transactionType, type)));
  return rows.map((r) => `${r.place}/${r.batchNumber ?? "Okänd"}:${Number(r.delta)}`).sort();
}

// The parts of an allocation as "<place>/<batch | Okänd>:<quantity>", in the order drawn.
async function allocate(articleId: string, quantity: number, locationId?: string, opts: Parameters<typeof allocateOutflowLocations>[4] = {}) {
  const parts = await db.transaction((tx) => allocateOutflowLocations(tx, articleId, quantity, locationId, opts));
  // Read afterwards: the rest may have created "***".
  const [names, batches] = await Promise.all([
    db.select({ id: stockLocations.id, name: stockLocations.name }).from(stockLocations),
    db.select({ id: stockBatches.id, batchNumber: stockBatches.batchNumber }).from(stockBatches),
  ]);
  const place = new Map(names.map((l) => [l.id, l.name]));
  const batch = new Map(batches.map((b) => [b.id, b.batchNumber]));
  return parts.map((p) => `${place.get(p.locationId)}/${p.batchId === undefined ? "—" : p.batchId === null ? "Okänd" : batch.get(p.batchId)}:${p.quantity}`);
}

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

async function raceAgainst(held: ReturnType<typeof heldTransaction>, contender: () => Promise<unknown>): Promise<unknown> {
  await held.ready;
  let outcome!: Promise<unknown>;
  try {
    outcome = contender().then(
      (value) => value,
      (err: unknown) => err
    );
    await waitForLockWaiter();
  } finally {
    held.release();
    await held.done;
  }
  return outcome;
}

// The standard stock: huvudplats A1 with Okänd 2, GAMMAL 5 and NY 6; B2 with GAMMAL 4.
async function stocked(patch: Record<string, unknown> = {}) {
  const [a1, b2] = [await makeLocation("A1"), await makeLocation("B2")];
  const article = await makeArticle({ defaultLocationId: a1.id, ...patch });
  await adjust(article.id, a1.id, 2);
  await adjust(article.id, a1.id, 5, "GAMMAL");
  await adjust(article.id, a1.id, 6, "NY");
  await adjust(article.id, b2.id, 4, "GAMMAL");
  await age("GAMMAL", 30);
  await age("NY", 2);
  return { article, a1, b2 };
}

describe("allocateOutflowLocations — a batchstyrd article", () => {
  it("Automatiskt: Okänd first, then the oldest batch over its places, then the next batch", async () => {
    const { article } = await stocked();
    expect(await allocate(article.id, 13)).toEqual(["A1/Okänd:2", "A1/GAMMAL:5", "B2/GAMMAL:4", "A1/NY:2"]);
  });

  it("the rest is Okänd on the article's place, merged with what was taken from Okänd there", async () => {
    const { article } = await stocked();
    expect(await allocate(article.id, 20)).toEqual(["A1/Okänd:5", "A1/GAMMAL:5", "B2/GAMMAL:4", "A1/NY:6"]);
    const empty = await makeArticle();
    // No stock at all: everything Okänd on "***".
    expect(await allocate(empty.id, 3)).toEqual(["***/Okänd:3"]);
  });

  it("the place ceiling: a place with a negative Okänd next to a batch gives no more than it holds", async () => {
    const a1 = await makeLocation("A1");
    const article = await makeArticle({ defaultLocationId: a1.id });
    await adjust(article.id, a1.id, 10, "X");
    await takeUnknown(article.id, a1.id, 3); // Okänd −3: 7 on the shelf
    expect(await allocate(article.id, 10)).toEqual(["A1/X:7", "A1/Okänd:3"]);
  });

  it("a chosen batch: only its cells; a named one that does not cover the quantity is refused, Okänd may go negative", async () => {
    const { article } = await stocked();
    const old = await batchId(article.id, "GAMMAL");
    expect(await allocate(article.id, 7, undefined, { batchId: old })).toEqual(["A1/GAMMAL:5", "B2/GAMMAL:2"]);
    const err = await allocate(article.id, 10, undefined, { batchId: old }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchInsufficientError);
    expect(err).toMatchObject({ batchNumber: "GAMMAL", available: 9, requested: 10 });
    expect(await allocate(article.id, 5, undefined, { batchId: null })).toEqual(["A1/Okänd:5"]);
  });

  it("a chosen place: its cells oldest first, the rest Okänd there; with a chosen batch the cell must cover it", async () => {
    const { article, a1, b2 } = await stocked();
    expect(await allocate(article.id, 9, a1.id)).toEqual(["A1/Okänd:2", "A1/GAMMAL:5", "A1/NY:2"]);
    expect(await allocate(article.id, 6, b2.id)).toEqual(["B2/GAMMAL:4", "B2/Okänd:2"]);
    const young = await batchId(article.id, "NY");
    expect(await allocate(article.id, 6, a1.id, { batchId: young })).toEqual(["A1/NY:6"]);
    await expect(allocate(article.id, 1, b2.id, { batchId: young })).rejects.toThrow(BatchInsufficientError);
    expect(await allocate(article.id, 5, b2.id, { batchId: null })).toEqual(["B2/Okänd:5"]);
  });

  it("a blocked place is skipped by Automatiskt and refused when chosen — or drawn automatically with the chosen batch", async () => {
    const { article, a1, b2 } = await stocked();
    await stockService.blockLocation(a1.id, null, user.id);
    expect(await allocate(article.id, 6)).toEqual(["B2/GAMMAL:4", "***/Okänd:2"]);
    await expect(allocate(article.id, 1, a1.id)).rejects.toThrow(StockLocationBlockedError);
    const old = await batchId(article.id, "GAMMAL");
    expect(await allocate(article.id, 3, a1.id, { blockedChoice: "automatic", batchId: old })).toEqual(["B2/GAMMAL:3"]);
    expect(b2.id).toBeTruthy();
  });

  it("a chosen batch must be the article's, and an article that is not batchstyrd takes no batch", async () => {
    const { article } = await stocked();
    const other = await makeArticle();
    const a1 = (await db.select().from(stockLocations).where(eq(stockLocations.name, "A1")))[0]!;
    await adjust(other.id, a1.id, 5, "ANNAN");
    await expect(allocate(article.id, 1, undefined, { batchId: await batchId(other.id, "ANNAN") })).rejects.toThrow(StockBatchNotFoundError);
    await expect(allocate(article.id, 1, undefined, { batchId: crypto.randomUUID() })).rejects.toThrow(StockBatchNotFoundError);

    const plain = await makeArticle({ batchTracked: false, defaultLocationId: a1.id });
    await adjust(plain.id, a1.id, 5);
    await expect(allocate(plain.id, 1, undefined, { batchId: await batchId(article.id, "NY") })).rejects.toThrow(BatchNotTrackedError);
    // Its parts carry no batch at all — the path of before.
    expect(await allocate(plain.id, 7)).toEqual(["A1/—:7"]);
    expect(await allocate(plain.id, 2, undefined, { batchId: null })).toEqual(["A1/—:2"]);
  });

  it("Batchstyrd switched off: the batches stay where they are and the draw is as before batches", async () => {
    const { article } = await stocked();
    await articleService.updateArticle(article.id, { batchTracked: false });
    expect(await allocate(article.id, 15)).toEqual(["A1/—:13", "B2/—:2"]);
  });

  it("race: two draws of one batchstyrd article never allocate the same cell twice", async () => {
    const { article } = await stocked();
    const draw = (quantity: number) => (tx: Tx) =>
      allocateOutflowLocations(tx, article.id, quantity).then(async (parts) => {
        for (const part of parts) {
          await tx.insert(stockTransactions).values({
            articleId: article.id,
            locationId: part.locationId,
            quantityDelta: String(-part.quantity),
            transactionType: "sales_delivery",
            batchId: part.batchId ?? null,
          });
        }
      });
    const held = heldTransaction(draw(6));
    const outcome = await raceAgainst(held, () => db.transaction(draw(6)));
    expect(outcome).toBeUndefined();
    // First: Okänd 2 + GAMMAL 4 on A1. Second waited and saw it: GAMMAL 1 on A1, GAMMAL 4 on B2, NY 1.
    expect(await moves(article.id, "sales_delivery")).toEqual(["A1/GAMMAL:-1", "A1/GAMMAL:-4", "A1/NY:-1", "A1/Okänd:-2", "B2/GAMMAL:-4"]);
    expect(await cells(article.id)).toEqual(["A1/NY=5"]);
  });
});

// --- Utleverans ----------------------------------------------------------------

// An order in production with one row of the article.
async function makeOrder(articleId: string, quantity: number) {
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  const { order, rows } = await salesService.createQuote(parsed(createQuoteSchema, { customerId: customer.id, rows: [{ articleId, quantity, unitPrice: 10 }] }), user.id);
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);
  return { order, row: rows[0]! };
}

async function deliver(orderId: string, rows: { rowId: string; quantity: number; locationId?: string; batchId?: string | null }[]) {
  const result = await salesService.deliverBatch(orderId, parsed(deliverBatchSchema, { rows }), user.id);
  const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
  return { ...result, deliveryRowId: deliveryRow!.id };
}

describe("Utleverans per batch", () => {
  it("Automatiskt splits the row over batches and places — one movement and one part each — and Ångra returns every part to its batch", async () => {
    const { article } = await stocked();
    const { order, row } = await makeOrder(article.id, 20);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 13 }]);

    expect(await moves(article.id, "sales_delivery")).toEqual(["A1/GAMMAL:-5", "A1/NY:-2", "A1/Okänd:-2", "B2/GAMMAL:-4"]);
    expect(await cells(article.id)).toEqual(["A1/NY=4"]);
    // The parts carry no batch of their own — it is read through the stock row.
    const parts = await db.select().from(deliveryRowLocations).where(eq(deliveryRowLocations.deliveryRowId, d.deliveryRowId));
    expect(parts).toHaveLength(4);
    const view = await salesService.deliveryRows(d.deliveryId);
    expect(view.rows[0]!.locations.map((l) => `${l.locationName}/${l.batchNumber ?? "Okänd"}:${l.quantity}`)).toEqual([
      "A1/Okänd:2",
      "A1/GAMMAL:5",
      "A1/NY:2",
      "B2/GAMMAL:4",
    ]);

    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.deliveryRowId, user.id);
    expect(await cells(article.id)).toEqual(["A1/GAMMAL=5", "A1/NY=6", "A1/Okänd=2", "B2/GAMMAL=4"]);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "delivery_row_undone"));
    expect((log!.detail as { locations: { quantity: number; batchNumber: string | null }[] }).locations.map((l) => [l.quantity, l.batchNumber])).toEqual([
      [2, null],
      [5, "GAMMAL"],
      [2, "NY"],
      [4, "GAMMAL"],
    ]);
  });

  it("a chosen batch is the row's whole quantity — taken over the batch's places, refused when it does not cover it", async () => {
    const { article } = await stocked();
    const { order, row } = await makeOrder(article.id, 20);
    const young = await batchId(article.id, "NY");
    const old = await batchId(article.id, "GAMMAL");

    await expect(deliver(order.id, [{ rowId: row.id, quantity: 7, batchId: young }])).rejects.toThrow(BatchInsufficientError);
    // Nothing was booked — neither the row nor a följesedel.
    expect(await moves(article.id, "sales_delivery")).toEqual([]);
    expect(await db.select().from(deliveryRows)).toEqual([]);

    await deliver(order.id, [{ rowId: row.id, quantity: 7, batchId: old }]);
    await deliver(order.id, [{ rowId: row.id, quantity: 6, batchId: young }]);
    await deliver(order.id, [{ rowId: row.id, quantity: 3, batchId: null }]);
    expect(await moves(article.id, "sales_delivery")).toEqual(["A1/GAMMAL:-5", "A1/NY:-6", "A1/Okänd:-3", "B2/GAMMAL:-2"]);
    expect(await cells(article.id)).toEqual(["A1/Okänd=-1", "B2/GAMMAL=2"]);
  });

  it("a chosen place with and without a chosen batch", async () => {
    const { article, b2 } = await stocked();
    const { order, row } = await makeOrder(article.id, 20);
    await deliver(order.id, [{ rowId: row.id, quantity: 3, locationId: b2.id }]);
    await deliver(order.id, [{ rowId: row.id, quantity: 1, locationId: b2.id, batchId: await batchId(article.id, "GAMMAL") }]);
    expect(await moves(article.id, "sales_delivery")).toEqual(["B2/GAMMAL:-1", "B2/GAMMAL:-3"]);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1, locationId: b2.id, batchId: await batchId(article.id, "NY") }])).rejects.toThrow(
      BatchInsufficientError
    );
  });

  it("Ångra after Batchstyrd was switched off still returns the goods to their batches", async () => {
    const { article } = await stocked();
    const { order, row } = await makeOrder(article.id, 20);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 9 }]);
    await articleService.updateArticle(article.id, { batchTracked: false });
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.deliveryRowId, user.id);
    await articleService.updateArticle(article.id, { batchTracked: true });
    expect(await cells(article.id)).toEqual(["A1/GAMMAL=5", "A1/NY=6", "A1/Okänd=2", "B2/GAMMAL=4"]);
  });

  it("a batch for an article that is not batchstyrd is refused", async () => {
    const { article, a1 } = await stocked();
    const plain = await makeArticle({ batchTracked: false, defaultLocationId: a1.id });
    await adjust(plain.id, a1.id, 5);
    const { order, row } = await makeOrder(plain.id, 5);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1, batchId: await batchId(article.id, "NY") }])).rejects.toThrow(BatchNotTrackedError);
    await deliver(order.id, [{ rowId: row.id, quantity: 1 }]);
    expect(await moves(plain.id, "sales_delivery")).toEqual(["A1/Okänd:-1"]);
  });

  it("the pick list's cells come in the order Automatiskt draws, blocked places flagged", async () => {
    const { article, a1, b2 } = await stocked();
    const plain = await makeArticle({ batchTracked: false });
    await adjust(plain.id, a1.id, 5);
    const list = await stockService.pickBatchCellsForArticles([article.id, plain.id]);
    expect(list.map((c) => `${c.locationName}/${c.batchNumber ?? "Okänd"}:${c.quantity}`)).toEqual([
      "A1/Okänd:2.0000",
      "A1/GAMMAL:5.0000",
      "B2/GAMMAL:4.0000",
      "A1/NY:6.0000",
    ]);
    expect(list[0]).toMatchObject({ articleId: article.id, locationId: a1.id, warehouseName: "Huvudlager", blocked: false, preference: 0, batchId: null });
    await stockService.blockLocation(b2.id, null, user.id);
    const onB2 = await stockService.pickBatchCellsForArticles([article.id], { locationId: b2.id });
    expect(onB2.map((c) => [c.locationName, c.batchNumber, c.blocked])).toEqual([["B2", "GAMMAL", true]]);
  });
});

// --- TO-uttag -------------------------------------------------------------------

// A released TO for 5 st; the batchstyrd component (2 per unit) is linked to operation 10.
async function makeManufacturingOrder() {
  const { article: component, a1, b2 } = await stocked();
  const parent = await makeArticle({ type: "manufactured", defaultLocationId: a1.id, batchTracked: false });
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, routingOperationId: op10.id });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [first] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  const [material] = await mfgService.listMaterialConsumptions(order.id);
  return { component, parent, a1, b2, order, first: first!, material: material! };
}

describe("TO-uttag per batch", () => {
  it("a report draws its linked material per batch, logs each part with its batch, and Ångra returns each to its batch", async () => {
    const mo = await makeManufacturingOrder();
    expect(mo.material.componentBatchTracked).toBe(true);
    // 4 OK × 2 = 8: Okänd 2, GAMMAL 5 on A1, GAMMAL 1 on B2.
    await mfgService.completeOperation(mo.first.id, parsed(completeOperationSchema, { quantityCompleted: 4 }), user.id);
    expect(await moves(mo.component.id, "mo_consumption")).toEqual(["A1/GAMMAL:-5", "A1/Okänd:-2", "B2/GAMMAL:-1"]);
    const [report] = await mfgService.listReports(mo.order.id);
    expect(report!.materials.map((m) => `${m.locationName}/${m.batchNumber ?? "Okänd"}:${Number(m.quantity)}`).sort()).toEqual([
      "A1/GAMMAL:5",
      "A1/Okänd:2",
      "B2/GAMMAL:1",
    ]);

    await mfgService.undoReport(mo.order.id, report!.id, user.id);
    expect(await cells(mo.component.id)).toEqual(["A1/GAMMAL=5", "A1/NY=6", "A1/Okänd=2", "B2/GAMMAL=4"]);
  });

  it("Förbruka with a chosen batch, with Okänd, and Automatiskt — and a batch that does not cover the quantity is refused", async () => {
    const mo = await makeManufacturingOrder();
    const young = await batchId(mo.component.id, "NY");
    const consume = (quantity: number, extra: Record<string, unknown> = {}) =>
      mfgService.consumeMaterial(mo.order.id, mo.material.id, parsed(consumeMaterialSchema, { quantity, ...extra }), user.id);

    await consume(3, { batchId: young });
    await consume(1, { batchId: null });
    await consume(2); // Okänd 1 left, then GAMMAL 1
    expect(await moves(mo.component.id, "mo_consumption")).toEqual(["A1/GAMMAL:-1", "A1/NY:-3", "A1/Okänd:-1", "A1/Okänd:-1"]);
    await expect(consume(4, { batchId: young })).rejects.toThrow(BatchInsufficientError);
    // The refused draw left the material row as it was.
    expect(Number((await mfgService.listMaterialConsumptions(mo.order.id))[0]!.quantityConsumed)).toBe(6);

    const drawn = await consume(3, { batchId: young });
    await mfgService.undoReport(mo.order.id, drawn.reportId, user.id);
    expect(await cells(mo.component.id)).toEqual(["A1/GAMMAL=4", "A1/NY=3", "B2/GAMMAL=4"]);
  });
});

// --- Flytt, justering, saldoimport ------------------------------------------------

describe("Lagerflytt per batch", () => {
  const transfer = (fromLocationId: string, toLocationId: string, rows: { articleId: string; quantity: number; batchId?: string | null }[]) =>
    stockService.transferStock(parsed(createStockTransferSchema, { fromLocationId, toLocationId, rows }), user.id);

  it("Automatiskt moves the source's batches oldest first, one pair of legs per batch — the batch follows the goods", async () => {
    const { article, a1 } = await stocked();
    const c3 = await makeLocation("C3");
    await transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 9 }]);
    expect(await moves(article.id, "stock_transfer")).toEqual([
      "A1/GAMMAL:-5",
      "A1/NY:-2",
      "A1/Okänd:-2",
      "C3/GAMMAL:5",
      "C3/NY:2",
      "C3/Okänd:2",
    ]);
    expect(await cells(article.id)).toEqual(["A1/NY=4", "B2/GAMMAL=4", "C3/GAMMAL=5", "C3/NY=2", "C3/Okänd=2"]);
    // Every leg of the move shares one reference.
    const refs = await db.selectDistinct({ ref: stockTransactions.referenceId }).from(stockTransactions).where(eq(stockTransactions.transactionType, "stock_transfer"));
    expect(refs).toHaveLength(1);
  });

  it("a chosen batch is the row's whole quantity; two chosen batches are two rows; a cell is never left negative", async () => {
    const { article, a1 } = await stocked();
    const c3 = await makeLocation("C3");
    const [old, young] = [await batchId(article.id, "GAMMAL"), await batchId(article.id, "NY")];
    await expect(transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 6, batchId: old }])).rejects.toThrow(BatchInsufficientError);
    const okand = await transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 3, batchId: null }]).catch((e: unknown) => e);
    expect(okand).toBeInstanceOf(InsufficientStockError);
    expect(okand).toMatchObject({ available: "2", requested: 3 });
    // The place as a whole is still the first check.
    await expect(transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 14 }])).rejects.toThrow(InsufficientStockError);
    expect(await moves(article.id, "stock_transfer")).toEqual([]);

    await transfer(a1.id, c3.id, [
      { articleId: article.id, quantity: 5, batchId: old },
      { articleId: article.id, quantity: 1, batchId: young },
      { articleId: article.id, quantity: 2, batchId: null },
    ]);
    expect(await cells(article.id)).toEqual(["A1/NY=5", "B2/GAMMAL=4", "C3/GAMMAL=5", "C3/NY=1", "C3/Okänd=2"]);
  });

  it("with a negative Okänd on the source the move never takes more than the place holds", async () => {
    const a1 = await makeLocation("A1");
    const c3 = await makeLocation("C3");
    const article = await makeArticle();
    await adjust(article.id, a1.id, 10, "X");
    await takeUnknown(article.id, a1.id, 3);
    await expect(transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 8 }])).rejects.toThrow(InsufficientStockError);
    await transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 7 }]);
    expect(await cells(article.id)).toEqual(["A1/Okänd=-3", "A1/X=3", "C3/X=7"]);
  });

  it("an article that is not batchstyrd moves as one pair without a batch, and takes none", async () => {
    const [a1, c3] = [await makeLocation("A1"), await makeLocation("C3")];
    const article = await makeArticle({ batchTracked: false });
    await adjust(article.id, a1.id, 5);
    await transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 1 }]);
    expect(await moves(article.id, "stock_transfer")).toEqual(["A1/Okänd:-1", "C3/Okänd:1"]);
    const tracked = await makeArticle();
    await adjust(tracked.id, a1.id, 1, "T");
    await expect(transfer(a1.id, c3.id, [{ articleId: article.id, quantity: 1, batchId: await batchId(tracked.id, "T") }])).rejects.toThrow(BatchNotTrackedError);
  });
});

describe("Negativ justering per batch", () => {
  const decrease = (articleId: string, locationId: string, quantity: number, extra: Record<string, unknown> = {}) =>
    stockService.recordTransaction(parsed(createStockAdjustmentSchema, { articleId, locationId, quantityDelta: -quantity, ...extra }), user.id);

  it("without a batch: the place's batches oldest first, the rest Okänd — one row per batch, the first row answered with `parts`", async () => {
    const { article, a1 } = await stocked();
    const result = await decrease(article.id, a1.id, 9);
    expect(await moves(article.id, "inventory_adjustment")).toEqual(
      ["A1/GAMMAL:-5", "A1/GAMMAL:5", "A1/NY:-2", "A1/NY:6", "A1/Okänd:-2", "A1/Okänd:2", "B2/GAMMAL:4"].sort()
    );
    expect(result).toMatchObject({ articleId: article.id, quantityDelta: "-2.0000", batchId: null, unitCost: null });
    expect((result as { parts: { quantityDelta: string; batchNumber: string | null }[] }).parts.map((p) => [p.quantityDelta, p.batchNumber])).toEqual([
      ["-2.0000", null],
      ["-5.0000", "GAMMAL"],
      ["-2.0000", "NY"],
    ]);
    // More than the place holds: the rest goes negative on Okänd, never on a batch.
    await decrease(article.id, a1.id, 6);
    expect(await cells(article.id)).toEqual(["A1/Okänd=-2", "B2/GAMMAL=4"]);
  });

  it("a chosen batch must cover the quantity; Okänd may go negative; the schema takes batchId only on a decrease", async () => {
    const { article, a1 } = await stocked();
    const old = await batchId(article.id, "GAMMAL");
    await expect(decrease(article.id, a1.id, 6, { batchId: old })).rejects.toThrow(BatchInsufficientError);
    const taken = await decrease(article.id, a1.id, 5, { batchId: old });
    expect((taken as { parts: unknown[] }).parts).toEqual([{ id: taken!.id, quantityDelta: "-5.0000", batchId: old, batchNumber: "GAMMAL" }]);
    await decrease(article.id, a1.id, 3, { batchId: null });
    expect(await cells(article.id)).toEqual(["A1/NY=6", "A1/Okänd=-1", "B2/GAMMAL=4"]);

    expect(createStockAdjustmentSchema.safeParse({ articleId: article.id, quantityDelta: 1, batchId: old }).success).toBe(false);
    expect(createStockAdjustmentSchema.safeParse({ articleId: article.id, quantityDelta: -1, batchId: null }).success).toBe(true);
    const plain = await makeArticle({ batchTracked: false });
    await expect(decrease(plain.id, a1.id, 1, { batchId: old })).rejects.toThrow(BatchNotTrackedError);
    // Not batchstyrd: one row, no `parts`, as before.
    expect(await decrease(plain.id, a1.id, 1)).not.toHaveProperty("parts");
  });

  it("race: a decrease waits for a draw of the same article and takes what the draw left", async () => {
    const { article, a1 } = await stocked();
    const held = heldTransaction(async (tx) => {
      for (const part of await allocateOutflowLocations(tx, article.id, 7)) {
        await tx.insert(stockTransactions).values({
          articleId: article.id,
          locationId: part.locationId,
          quantityDelta: String(-part.quantity),
          transactionType: "mo_consumption",
          batchId: part.batchId ?? null,
        });
      }
    });
    await raceAgainst(held, () => decrease(article.id, a1.id, 4));
    // The draw took Okänd 2 and GAMMAL 5 on A1; the decrease then found only NY there.
    expect((await moves(article.id, "inventory_adjustment")).filter((m) => m.includes(":-"))).toEqual(["A1/NY:-4"]);
  });
});

describe("Saldoimportens minskning utan Batch", () => {
  const MAPPING = { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity" };

  it("takes the decrease from the place's batches oldest first, the rest stays", async () => {
    const { article } = await stocked();
    // A1 holds 13 (Okänd 2, GAMMAL 5, NY 6): down to 4.
    await imports.commit("stockBalances", { mapping: MAPPING, rows: [[article.articleNumber, "Huvudlager", "A1", "4"]] });
    expect(await cells(article.id)).toEqual(["A1/NY=4", "B2/GAMMAL=4"]);
    // …and to 0: the place is emptied.
    await imports.commit("stockBalances", { mapping: MAPPING, rows: [[article.articleNumber, "Huvudlager", "A1", "0"]] });
    expect(await cells(article.id)).toEqual(["B2/GAMMAL=4"]);
  });
});

// --- Inventering ------------------------------------------------------------------

describe("Inventering per batch", () => {
  it("freezes one row per cell for a batchstyrd article, books each difference in its batch, and counts a new batch", async () => {
    const { article, a1 } = await stocked();
    const plain = await makeArticle({ batchTracked: false, articleNumber: "ZZ-PLAIN" });
    await adjust(plain.id, a1.id, 8);
    const session = await countRepo.createSession({ locationId: a1.id, blocksTransactions: false }, user.id);
    expect(session.rowCount).toBe(4);

    const view = (await countRepo.getSession(session.id))!;
    expect(view.rows.map((r) => [r.articleNumber === "ZZ-PLAIN" ? "plain" : "batch", r.batchNumber, r.snapshotQuantity, r.batchTracked])).toEqual([
      ["batch", null, "2.0000", true],
      ["batch", "GAMMAL", "5.0000", true],
      ["batch", "NY", "6.0000", true],
      ["plain", null, "8.0000", false],
    ]);

    // A batch found on the shelf that nobody booked, and the rules of Lägg till.
    const found = await countRepo.addRow(session.id, { articleId: article.id, batchNumber: "HITTAD" });
    expect(found.snapshotQuantity).toBe("0.0000");
    await expect(countRepo.addRow(session.id, { articleId: article.id, batchNumber: "gammal" })).rejects.toThrow(DuplicateStockCountRowError);
    await expect(countRepo.addRow(session.id, { articleId: article.id })).rejects.toThrow(DuplicateStockCountRowError);
    await expect(countRepo.addRow(session.id, { articleId: plain.id, batchNumber: "X" })).rejects.toThrow(BatchNotTrackedError);

    const rowOf = (batchNumber: string | null) => view.rows.find((r) => r.articleId === article.id && r.batchNumber === batchNumber)!.id;
    await countRepo.updateRow(session.id, rowOf(null), { countedQuantity: 0 });
    await countRepo.updateRow(session.id, rowOf("GAMMAL"), { countedQuantity: 7 });
    await countRepo.updateRow(session.id, rowOf("NY"), { countedQuantity: 6 });
    await countRepo.updateRow(session.id, found.id, { countedQuantity: 3 });

    const posted = await countRepo.postSession(session.id, user.id, "today");
    expect(posted).toMatchObject({ adjustments: 3, counted: 4, skipped: 1 });
    expect(await cells(article.id)).toEqual(["A1/GAMMAL=7", "A1/HITTAD=3", "A1/NY=6", "B2/GAMMAL=4"]);
    const booked = await db
      .select({ delta: stockTransactions.quantityDelta, batchNumber: stockBatches.batchNumber })
      .from(stockTransactions)
      .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
      .where(eq(stockTransactions.referenceId, session.id))
      .orderBy(asc(stockTransactions.quantityDelta));
    expect(booked.map((b) => [Number(b.delta), b.batchNumber])).toEqual([
      [-2, null],
      [2, "GAMMAL"],
      [3, "HITTAD"],
    ]);
  });

  it("a row added without a batch for a batchstyrd article is its Okänd cell, not the whole place", async () => {
    const a1 = await makeLocation("A1");
    const article = await makeArticle();
    const other = await makeArticle();
    await adjust(other.id, a1.id, 1);
    const session = await countRepo.createSession({ locationId: a1.id, blocksTransactions: false }, user.id);
    // Booked after the freeze: 5 in a batch.
    await adjust(article.id, a1.id, 5, "L-1");
    const row = await countRepo.addRow(session.id, { articleId: article.id });
    expect(row).toMatchObject({ batchId: null, snapshotQuantity: "0.0000" });
    const named = await countRepo.addRow(session.id, { articleId: article.id, batchNumber: "L-1" });
    expect(named.snapshotQuantity).toBe("5.0000");
  });
});

describe("Lagerloggen", () => {
  it("carries the batch number per row and filters on a batch", async () => {
    const { article } = await stocked();
    const old = await batchId(article.id, "GAMMAL");
    const all = await stockService.listTransactions(parsed(listStockTransactionsQuerySchema, { articleId: article.id }));
    expect(all.rows.map((r) => r.batchNumber).sort()).toEqual(["GAMMAL", "GAMMAL", "NY", null].sort());
    const filtered = await stockService.listTransactions(parsed(listStockTransactionsQuerySchema, { batchId: old }));
    expect(filtered.total).toBe(2);
    expect(filtered.rows.every((r) => r.batchNumber === "GAMMAL")).toBe(true);
  });
});

// Kept for the type import above (articles is only used through the services).
void articles;
void lockArticlesForOutflow;
