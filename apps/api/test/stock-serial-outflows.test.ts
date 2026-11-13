import {
  addStockCountRowSchema,
  completeOperationSchema,
  consumeMaterialSchema,
  createArticleSchema,
  createCustomerSchema,
  createQuoteSchema,
  createStockAdjustmentSchema,
  createStockCountSchema,
  createStockLocationSchema,
  createStockTransferSchema,
  createWorkCenterSchema,
  deliverBatchSchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { db, deliveryRowSerials, deliveryRows, numberSeries, stockBatches, stockLocations, stockTransactions, systemSettings } from "@navet/db";
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
import { deliveredSerialsForOrderRows } from "../src/modules/sales/repository/delivered-batches.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import {
  ArticleNotSerialTrackedError,
  BatchInsufficientError,
  SerialAlreadyInStockError,
  SerialCountMismatchError,
  SerialCountNotUnitError,
  SerialNumberTakenError,
  SerialOnOtherLocationError,
  SerialQuantityNotIntegerError,
  StockBatchNotFoundError,
} from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { allocateOutflowLocations } from "../src/modules/stock/service/outflow-locations.js";
import { previewSerialNumbers } from "../src/modules/stock/service/serial-numbers.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Serienummer (#8 etapp 2, steg 4) — the OUTFLOWS of a serienummerstyrd
// article: the loader (whole styck, the chosen numbers or the oldest),
// utleverans and Ångra (an inflow that now has to prove the number is out of
// stock), the TO's material and Förbruka, flytt, a negative justering, the
// saldoimport's decrease, the inventering per number — and the numbers that
// are created VID UTLEVERANS (beslut 16–18): suggested without a
// reservation, drawn in the delivery, linked to the delivery row and burnt
// when the delivery is undone.

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
const resetSeries = async () => {
  await db.delete(numberSeries).where(like(numberSeries.key, "serial\\_%"));
  await db.update(numberSeries).set({ prefix: "SN-", nextNumber: 1, digits: 6 }).where(eq(numberSeries.key, "serial"));
};

let user: { id: string };
let warehouseId: string;

beforeEach(async () => {
  await db.execute(TABLES);
  await resetSetting();
  await resetSeries();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  user = await authRepo.create({ email: `serial-out-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Lagerchef", role: "admin" });
  warehouseId = (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!.id;
});
afterAll(async () => {
  await db.execute(TABLES);
  await resetSetting();
  await resetSeries();
});

const makeLocation = async (name: string) => (await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId, name, active: true })))!;
let n = 0;
const makeArticle = (patch: Record<string, unknown> = {}) =>
  articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `SO-${++n}-${crypto.randomUUID().slice(0, 6)}`, name: "Motor", type: "purchased", active: true, tracking: "serial", ...patch })
  );
const sn = (i: number) => `SN-${String(i).padStart(6, "0")}`;
const putSerial = (articleId: string, locationId: string, serialNumber: string) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta: 1, transactionType: "inventory_adjustment", batchNumber: serialNumber });
const DAY = 24 * 60 * 60 * 1000;
const age = (serialNumber: string, days: number) => db.update(stockBatches).set({ createdAt: new Date(Date.now() - days * DAY) }).where(eq(stockBatches.batchNumber, serialNumber));
async function idOf(articleId: string, serialNumber: string) {
  const [row] = await db.select().from(stockBatches).where(and(eq(stockBatches.articleId, articleId), eq(stockBatches.batchNumber, serialNumber)));
  return row!.id;
}
const idsOf = (articleId: string, ...numbers: string[]) => Promise.all(numbers.map((number) => idOf(articleId, number)));

// "<place>/<number | Okänd>[=<quantity>]" for what stands in stock, sorted.
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
// The rows of one type as "<place>/<number | Okänd>:<delta>", sorted.
async function moves(articleId: string, type: (typeof stockTransactions.transactionType.enumValues)[number]) {
  const rows = await db
    .select({ delta: stockTransactions.quantityDelta, place: stockLocations.name, number: stockBatches.batchNumber })
    .from(stockTransactions)
    .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.transactionType, type)));
  return rows.map((r) => `${r.place}/${r.number ?? "Okänd"}:${Number(r.delta)}`).sort();
}

// A1 (huvudplats): S-1 (oldest), S-2, S-3; B2: S-4, S-5 (youngest).
async function stocked(patch: Record<string, unknown> = {}) {
  const [a1, b2] = [await makeLocation("A1"), await makeLocation("B2")];
  const article = await makeArticle({ defaultLocationId: a1.id, ...patch });
  for (const [i, [place, number]] of ([[a1, "S-1"], [a1, "S-2"], [a1, "S-3"], [b2, "S-4"], [b2, "S-5"]] as const).entries()) {
    await putSerial(article.id, place.id, number);
    await age(number, 50 - i * 10);
  }
  return { article, a1, b2 };
}

async function allocate(articleId: string, quantity: number, locationId?: string, opts: Parameters<typeof allocateOutflowLocations>[4] = {}) {
  const parts = await db.transaction((tx) => allocateOutflowLocations(tx, articleId, quantity, locationId, opts));
  const [names, batches] = await Promise.all([
    db.select({ id: stockLocations.id, name: stockLocations.name }).from(stockLocations),
    db.select({ id: stockBatches.id, batchNumber: stockBatches.batchNumber }).from(stockBatches),
  ]);
  const place = new Map(names.map((l) => [l.id, l.name]));
  const batch = new Map(batches.map((b) => [b.id, b.batchNumber]));
  return parts.map((p) => `${place.get(p.locationId)}/${p.batchId == null ? "Okänd" : batch.get(p.batchId)}:${p.quantity}`);
}

describe("allocateOutflowLocations — a serienummerstyrd article", () => {
  it("Automatiskt takes the oldest numbers, one part per number; what is missing is Okänd on the article's place", async () => {
    const { article } = await stocked();
    expect(await allocate(article.id, 4)).toEqual(["A1/S-1:1", "A1/S-2:1", "A1/S-3:1", "B2/S-4:1"]);
    expect(await allocate(article.id, 7)).toEqual(["A1/S-1:1", "A1/S-2:1", "A1/S-3:1", "B2/S-4:1", "B2/S-5:1", "A1/Okänd:2"]);
  });

  it("the chosen numbers: exactly those, on whatever place; with a chosen place only there", async () => {
    const { article, a1, b2 } = await stocked();
    const [s2, s5] = await idsOf(article.id, "S-2", "S-5");
    expect((await allocate(article.id, 2, undefined, { serialIds: [s5!, s2!] })).sort()).toEqual(["A1/S-2:1", "B2/S-5:1"]);
    expect(await allocate(article.id, 1, b2.id, { serialIds: [s5!] })).toEqual(["B2/S-5:1"]);
    // A chosen number that is not on the chosen place, or on a blocked one.
    await expect(allocate(article.id, 1, a1.id, { serialIds: [s5!] })).rejects.toThrow(BatchInsufficientError);
    await stockService.blockLocation(b2.id, null, user.id);
    const blocked = await allocate(article.id, 1, undefined, { serialIds: [s5!] }).catch((e: unknown) => e);
    expect((blocked as Error).message).toBe("Serienummer S-5 finns inte i lager på en valbar plats");
  });

  it("whole styck; as many numbers as styck; distinct; the article's own serial numbers; never with a batch choice", async () => {
    const { article, a1 } = await stocked();
    // Another article with its own S-1 on the same place.
    const other = await makeArticle();
    await putSerial(other.id, a1.id, "S-1");
    const [s1, s2] = await idsOf(article.id, "S-1", "S-2");
    const [theirs] = await idsOf(other.id, "S-1");
    await expect(allocate(article.id, 1.5)).rejects.toThrow(SerialQuantityNotIntegerError);
    await expect(allocate(article.id, 2, undefined, { serialIds: [s1!] })).rejects.toThrow(SerialCountMismatchError);
    await expect(allocate(article.id, 2, undefined, { serialIds: [s1!, s1!] })).rejects.toThrow(SerialCountMismatchError);
    await expect(allocate(article.id, 1, undefined, { serialIds: [s1!], batchId: s2! })).rejects.toThrow(SerialCountMismatchError);
    await expect(allocate(article.id, 1, undefined, { serialIds: [theirs!] })).rejects.toThrow(StockBatchNotFoundError);
    await expect(allocate(article.id, 1, undefined, { serialIds: [crypto.randomUUID()] })).rejects.toThrow(StockBatchNotFoundError);
    // One number as a batch choice still works (the etapp 1 form): one styck.
    expect(await allocate(article.id, 1, undefined, { batchId: s2! })).toEqual(["A1/S-2:1"]);
    await expect(allocate(article.id, 2, undefined, { batchId: s2! })).rejects.toThrow(BatchInsufficientError);
  });

  it("serial numbers are refused on a batchstyrd article, an untracked one and one numbered vid utleverans", async () => {
    const a1 = await makeLocation("A1");
    for (const patch of [{ tracking: "batch" }, { tracking: "none" }, { serialAssignedAt: "delivery" }]) {
      const article = await makeArticle({ defaultLocationId: a1.id, ...patch });
      await expect(allocate(article.id, 1, undefined, { serialIds: [crypto.randomUUID()] })).rejects.toThrow(ArticleNotSerialTrackedError);
    }
    // Vid utleverans: the stock is untracked — any quantity, no numbers.
    const atDelivery = await makeArticle({ defaultLocationId: a1.id, serialAssignedAt: "delivery" });
    expect(await allocate(atDelivery.id, 2.5)).toEqual(["A1/Okänd:2.5"]);
  });
});

// --- Utleverans -------------------------------------------------------------------

async function makeOrder(articleId: string, quantity: number) {
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  const { order, rows } = await salesService.createQuote(parsed(createQuoteSchema, { customerId: customer.id, rows: [{ articleId, quantity, unitPrice: 10 }] }), user.id);
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);
  return { order, row: rows[0]! };
}
type DeliverRow = { rowId: string; quantity: number; locationId?: string; batchId?: string | null; serialIds?: (string | undefined)[]; serialNumbers?: string[] };
async function deliver(orderId: string, rows: DeliverRow[]) {
  const result = await salesService.deliverBatch(orderId, parsed(deliverBatchSchema, { rows: rows as never }), user.id);
  const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
  return { ...result, deliveryRowId: deliveryRow!.id };
}

describe("Utleverans av serienummer i lager", () => {
  it("Automatiskt delivers the oldest numbers; chosen ones exactly; the delivery's rows and the invoice's reader list them", async () => {
    const { article } = await stocked();
    const { order, row } = await makeOrder(article.id, 5);
    const auto = await deliver(order.id, [{ rowId: row.id, quantity: 2 }]);
    expect(await moves(article.id, "sales_delivery")).toEqual(["A1/S-1:-1", "A1/S-2:-1"]);
    const chosen = await deliver(order.id, [{ rowId: row.id, quantity: 2, serialIds: await idsOf(article.id, "S-5", "S-3") }]);
    expect(await inStock(article.id)).toEqual(["B2/S-4"]);

    const rows = await salesService.deliveryRows(auto.deliveryId);
    expect(rows.rows[0]!.serialNumbers).toEqual(["S-1", "S-2"]);
    expect(rows.rows[0]!.locations.map((l) => [l.batchNumber, l.batchKind, l.quantity])).toEqual([
      ["S-1", "serial", 1],
      ["S-2", "serial", 1],
    ]);
    expect((await salesService.deliveryRows(chosen.deliveryId)).rows[0]!.serialNumbers).toEqual(["S-3", "S-5"]);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toEqual(["S-1", "S-2", "S-3", "S-5"]);
    expect(auto.assignedSerials).toEqual([]);
  });

  it("is refused for a fraction, the wrong number of numbers and a number that is not in stock — nothing is delivered", async () => {
    const { article } = await stocked();
    const { order, row } = await makeOrder(article.id, 5);
    const [s1] = await idsOf(article.id, "S-1");
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1.5 }])).rejects.toThrow(SerialQuantityNotIntegerError);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 2, serialIds: [s1] }])).rejects.toThrow(SerialCountMismatchError);
    await deliver(order.id, [{ rowId: row.id, quantity: 1, serialIds: [s1] }]);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1, serialIds: [s1] }])).rejects.toThrow(BatchInsufficientError);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1, serialNumbers: ["X-1"] }])).rejects.toThrow(ArticleNotSerialTrackedError);
    expect(await inStock(article.id)).toEqual(["A1/S-2", "A1/S-3", "B2/S-4", "B2/S-5"]);
    expect(await db.select().from(deliveryRows)).toHaveLength(1);
  });

  it("Ångra puts exactly the numbers back where they stood — and is refused when one has come back into stock some other way", async () => {
    const { article, a1 } = await stocked();
    const { order, row } = await makeOrder(article.id, 5);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 2, serialIds: await idsOf(article.id, "S-2", "S-4") }]);
    expect(await inStock(article.id)).toEqual(["A1/S-1", "A1/S-3", "B2/S-5"]);
    // S-4 comes back as a return, counted in on A1.
    await putSerial(article.id, a1.id, "S-4");
    const err = await salesService.undoDeliveryRow(order.id, d.deliveryId, d.deliveryRowId, user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SerialAlreadyInStockError);
    expect((err as Error).message).toBe("Serienummer S-4 finns redan i lager (Huvudlager — A1)");
    expect(await inStock(article.id)).toEqual(["A1/S-1", "A1/S-3", "A1/S-4", "B2/S-5"]);
    // Taken out again, the undo goes through and each number is back on its own place.
    await stockService.recordTransaction(parsed(createStockAdjustmentSchema, { articleId: article.id, locationId: a1.id, quantityDelta: -1, batchId: await idOf(article.id, "S-4") }), user.id);
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.deliveryRowId, user.id);
    expect(await inStock(article.id)).toEqual(["A1/S-1", "A1/S-2", "A1/S-3", "B2/S-4", "B2/S-5"]);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toBeUndefined();
  });

  it("race: two deliveries of the same number at once — one is delivered, the other refused", async () => {
    const { article } = await stocked();
    const first = await makeOrder(article.id, 2);
    const second = await makeOrder(article.id, 2);
    const [s1] = await idsOf(article.id, "S-1");
    const outcomes = await Promise.allSettled([
      deliver(first.order.id, [{ rowId: first.row.id, quantity: 1, serialIds: [s1] }]),
      deliver(second.order.id, [{ rowId: second.row.id, quantity: 1, serialIds: [s1] }]),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(BatchInsufficientError);
    expect(await moves(article.id, "sales_delivery")).toEqual(["A1/S-1:-1"]);
  });
});

// --- Serienummer skapas vid utleverans ----------------------------------------------

describe("Serienummer skapas vid utleverans (beslut 16–18)", () => {
  // An untracked stock of 20 on A1.
  async function atDelivery(patch: Record<string, unknown> = {}) {
    const a1 = await makeLocation("A1");
    const article = await makeArticle({ defaultLocationId: a1.id, serialAssignedAt: "delivery", ...patch });
    await stockService.recordTransaction({ articleId: article.id, locationId: a1.id, quantityDelta: 20, transactionType: "inventory_adjustment" });
    return { article, a1 };
  }
  const serialsOf = async (articleId: string) =>
    (await db.select().from(stockBatches).where(eq(stockBatches.articleId, articleId)).orderBy(asc(stockBatches.batchNumber))).map((b) => [b.batchNumber, b.kind, b.origin]);
  const nextSerial = async () => (await db.select().from(numberSeries).where(eq(numberSeries.key, "serial")))[0]!.nextNumber;

  it("the suggestion shows the next numbers without drawing them; the delivery draws them and links them to its row", async () => {
    const { article } = await atDelivery();
    const { order, row } = await makeOrder(article.id, 10);
    expect(await salesService.serialSuggestions(article.id, 3)).toEqual({ serialNumbers: [sn(1), sn(2), sn(3)] });
    // A read: asked twice, the same answer, and the series has not moved.
    expect(await previewSerialNumbers(db, article.id, 3)).toEqual([sn(1), sn(2), sn(3)]);
    expect(await nextSerial()).toBe(1);

    const d = await deliver(order.id, [{ rowId: row.id, quantity: 3 }]);
    expect(d.assignedSerials).toEqual([{ rowId: row.id, serialNumbers: [sn(1), sn(2), sn(3)] }]);
    expect(await serialsOf(article.id)).toEqual([sn(1), sn(2), sn(3)].map((s) => [s, "serial", "delivery"]));
    // The stock is untracked: one row without a batch, no cells.
    expect(await moves(article.id, "sales_delivery")).toEqual(["A1/Okänd:-3"]);
    expect(await inStock(article.id)).toEqual(["A1/Okänd=17"]);
    expect(await db.select().from(deliveryRowSerials)).toHaveLength(3);
    // The readers the documents will use: per delivery row and per order row.
    expect((await salesService.deliveryRows(d.deliveryId)).rows[0]!.serialNumbers).toEqual([sn(1), sn(2), sn(3)]);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toEqual([sn(1), sn(2), sn(3)]);
    expect(await salesService.serialSuggestions(article.id, 2)).toEqual({ serialNumbers: [sn(4), sn(5)] });
  });

  it("a typed or scanned number wins: exactly one per styck, new to the article — and the series steps over it afterwards", async () => {
    const { article } = await atDelivery();
    const { order, row } = await makeOrder(article.id, 10);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 2, serialNumbers: [" MÄRK-77 ", sn(1)] }]);
    expect(d.assignedSerials).toEqual([{ rowId: row.id, serialNumbers: ["MÄRK-77", sn(1)] }]);
    expect(await nextSerial()).toBe(1);
    // Used once: the same number again (in any case) is refused, as is a wrong count or a number twice.
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1, serialNumbers: ["märk-77"] }])).rejects.toThrow(SerialNumberTakenError);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 2, serialNumbers: ["X-1"] }])).rejects.toThrow(SerialCountMismatchError);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 2, serialNumbers: ["X-1", "x-1"] }])).rejects.toThrow(SerialCountMismatchError);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1.5 }])).rejects.toThrow(SerialQuantityNotIntegerError);
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1, serialIds: [crypto.randomUUID()] }])).rejects.toThrow(ArticleNotSerialTrackedError);
    // A refused delivery burnt nothing; the series steps over the typed SN-000001.
    expect(await serialsOf(article.id)).toHaveLength(2);
    expect(await salesService.serialSuggestions(article.id, 2)).toEqual({ serialNumbers: [sn(2), sn(3)] });
    expect((await deliver(order.id, [{ rowId: row.id, quantity: 2 }])).assignedSerials[0]!.serialNumbers).toEqual([sn(2), sn(3)]);
  });

  it("Ångra utleverans burns the numbers: they stay on the undone row, are never listed as delivered and never given again", async () => {
    const { article } = await atDelivery();
    const { order, row } = await makeOrder(article.id, 10);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 2 }]);
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.deliveryRowId, user.id);
    expect(await inStock(article.id)).toEqual(["A1/Okänd=20"]);
    // The link and the numbers are still there — on a row that is undone.
    const undone = (await salesService.deliveryRows(d.deliveryId)).rows[0]!;
    expect([undone.undoneAt !== null, undone.serialNumbers]).toEqual([true, [sn(1), sn(2)]]);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toBeUndefined();
    // A new delivery gets NEW numbers; a burnt one cannot be typed either.
    expect(await salesService.serialSuggestions(article.id, 2)).toEqual({ serialNumbers: [sn(3), sn(4)] });
    await expect(deliver(order.id, [{ rowId: row.id, quantity: 1, serialNumbers: [sn(1)] }])).rejects.toThrow(SerialNumberTakenError);
    const again = await deliver(order.id, [{ rowId: row.id, quantity: 2 }]);
    expect(again.assignedSerials[0]!.serialNumbers).toEqual([sn(3), sn(4)]);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toEqual([sn(3), sn(4)]);
  });

  it("the article's own series; two deliveries at once never give the same number; one delivery with rows of both kinds", async () => {
    const own = await testSystemService.createArticleNumberSeries({ name: "Motorer", prefix: "MO-", nextNumber: 1, digits: 3, forSerials: true });
    const { article } = await atDelivery({ serialSeriesKey: own.key });
    const first = await makeOrder(article.id, 10);
    const second = await makeOrder(article.id, 10);
    const outcomes = await Promise.all([
      deliver(first.order.id, [{ rowId: first.row.id, quantity: 3 }]),
      deliver(second.order.id, [{ rowId: second.row.id, quantity: 3 }]),
      deliver(first.order.id, [{ rowId: first.row.id, quantity: 2 }]),
    ]);
    const numbers = outcomes.flatMap((o) => o.assignedSerials.flatMap((a) => a.serialNumbers));
    expect([...numbers].sort()).toEqual(["MO-001", "MO-002", "MO-003", "MO-004", "MO-005", "MO-006", "MO-007", "MO-008"]);
    expect(await nextSerial()).toBe(1);
  });
});

// --- TO-uttag -----------------------------------------------------------------------

async function makeManufacturingOrder() {
  const { article: component, a1, b2 } = await stocked();
  const parent = await makeArticle({ type: "manufactured", defaultLocationId: a1.id, tracking: "none" });
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Montering", active: true }));
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 1, routingOperationId: op10.id });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [first] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  const [material] = await mfgService.listMaterialConsumptions(order.id);
  return { component, parent, a1, b2, order, first: first!, material: material! };
}

describe("TO-uttag av serienummer", () => {
  it("a report (the terminal's path) draws the oldest numbers, one report line each, and Ångra returns exactly them", async () => {
    const mo = await makeManufacturingOrder();
    expect(mo.material.componentTracking).toBe("serial");
    await mfgService.reportOperationQuantities(mo.first.id, { quantityOk: 2, quantityScrapped: 0, markDone: false, createdBy: user.id, source: "terminal" });
    expect(await moves(mo.component.id, "mo_consumption")).toEqual(["A1/S-1:-1", "A1/S-2:-1"]);
    const [report] = await mfgService.listReports(mo.order.id);
    expect(report!.materials.map((m) => [m.batchNumber, m.batchKind, Number(m.quantity)]).sort()).toEqual([
      ["S-1", "serial", 1],
      ["S-2", "serial", 1],
    ]);
    await mfgService.undoReport(mo.order.id, report!.id, user.id);
    expect(await inStock(mo.component.id)).toEqual(["A1/S-1", "A1/S-2", "A1/S-3", "B2/S-4", "B2/S-5"]);
  });

  it("Förbruka with chosen numbers; the wrong count is refused; Ångra is refused when a number has come back in", async () => {
    const mo = await makeManufacturingOrder();
    const consume = (quantity: number, extra: Record<string, unknown> = {}) =>
      mfgService.consumeMaterial(mo.order.id, mo.material.id, parsed(consumeMaterialSchema, { quantity, ...extra }), user.id);
    await expect(consume(2, { serialIds: await idsOf(mo.component.id, "S-5") })).rejects.toThrow(SerialCountMismatchError);
    await expect(consume(0.5)).rejects.toThrow(SerialQuantityNotIntegerError);
    const drawn = await consume(2, { serialIds: await idsOf(mo.component.id, "S-5", "S-3") });
    expect(await moves(mo.component.id, "mo_consumption")).toEqual(["A1/S-3:-1", "B2/S-5:-1"]);
    // S-5 is found again and counted in elsewhere: the material cannot be returned twice.
    await putSerial(mo.component.id, mo.a1.id, "S-5");
    const err = await mfgService.undoReport(mo.order.id, drawn.reportId, user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SerialAlreadyInStockError);
    expect(await inStock(mo.component.id)).toEqual(["A1/S-1", "A1/S-2", "A1/S-5", "B2/S-4"]);
    expect(Number((await mfgService.listMaterialConsumptions(mo.order.id))[0]!.quantityConsumed)).toBe(2);
    // The rest of a report over what stock there is goes to Okänd, as for a batch.
    await mfgService.completeOperation(mo.first.id, parsed(completeOperationSchema, { quantityCompleted: 5 }), user.id);
    expect(await inStock(mo.component.id)).toEqual(["A1/S-5"]);
  });
});

// --- Flytt och justering ------------------------------------------------------------

describe("Lagerflytt och negativ justering av serienummer", () => {
  const transfer = (fromLocationId: string, toLocationId: string, rows: { articleId: string; quantity: number; serialIds?: string[] }[]) =>
    stockService.transferStock(parsed(createStockTransferSchema, { fromLocationId, toLocationId, rows }), user.id);
  const decrease = (articleId: string, locationId: string, quantity: number, extra: Record<string, unknown> = {}) =>
    stockService.recordTransaction(parsed(createStockAdjustmentSchema, { articleId, locationId, quantityDelta: -quantity, ...extra }), user.id);

  it("flytt: the chosen numbers or the source's oldest — a pair of legs per number, and the number is then on the other place", async () => {
    const { article, a1, b2 } = await stocked();
    await transfer(a1.id, b2.id, [{ articleId: article.id, quantity: 1, serialIds: await idsOf(article.id, "S-3") }]);
    await transfer(a1.id, b2.id, [{ articleId: article.id, quantity: 1 }]);
    expect(await inStock(article.id)).toEqual(["A1/S-2", "B2/S-1", "B2/S-3", "B2/S-4", "B2/S-5"]);
    expect(await moves(article.id, "stock_transfer")).toEqual(["A1/S-1:-1", "A1/S-3:-1", "B2/S-1:1", "B2/S-3:1"]);
    // A number that is not on the source, a fraction and the wrong count.
    await expect(transfer(a1.id, b2.id, [{ articleId: article.id, quantity: 1, serialIds: await idsOf(article.id, "S-5") }])).rejects.toThrow(BatchInsufficientError);
    await expect(transfer(a1.id, b2.id, [{ articleId: article.id, quantity: 0.5 }])).rejects.toThrow(SerialQuantityNotIntegerError);
    await expect(transfer(b2.id, a1.id, [{ articleId: article.id, quantity: 3, serialIds: await idsOf(article.id, "S-1") }])).rejects.toThrow(SerialCountMismatchError);
    expect(await inStock(article.id)).toEqual(["A1/S-2", "B2/S-1", "B2/S-3", "B2/S-4", "B2/S-5"]);
  });

  it("justering: one number (batchId), several (serialIds) or the place's oldest; only Okänd may be corrected by a fraction", async () => {
    const { article, a1, b2 } = await stocked();
    await stockService.recordTransaction({ articleId: article.id, locationId: a1.id, quantityDelta: 2.5, transactionType: "inventory_adjustment" });
    await decrease(article.id, a1.id, 1, { batchId: await idOf(article.id, "S-2") });
    await decrease(article.id, b2.id, 2, { serialIds: await idsOf(article.id, "S-4", "S-5") });
    expect(await inStock(article.id)).toEqual(["A1/Okänd=2.5", "A1/S-1", "A1/S-3"]);
    await expect(decrease(article.id, a1.id, 0.5)).rejects.toThrow(SerialQuantityNotIntegerError);
    await decrease(article.id, a1.id, 0.5, { batchId: null });
    // Automatiskt on the place: Okänd first (2), then the oldest number.
    await decrease(article.id, a1.id, 3);
    expect(await inStock(article.id)).toEqual(["A1/S-3"]);
    await expect(decrease(article.id, a1.id, 1, { serialIds: await idsOf(article.id, "S-1") })).rejects.toThrow(BatchInsufficientError);
    expect(createStockAdjustmentSchema.safeParse({ articleId: article.id, quantityDelta: 1, serialIds: [crypto.randomUUID()] }).success).toBe(false);
  });

  it("saldoimportens minskning utan Serienummer: whole styck, the place's oldest numbers first", async () => {
    const { article } = await stocked();
    const MAPPING = { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity" };
    const file = (antal: string) => ({ mapping: MAPPING, rows: [[article.articleNumber, "Huvudlager", "A1", antal]] });
    const refused = await imports.preview("stockBalances", file("1,5"));
    expect(refused.rows[0]!.errors[0]).toMatch(/är serienummerstyrd — saldot kan bara minska med hela styck \(1,5\)/);
    await imports.commit("stockBalances", file("1"));
    expect(await inStock(article.id)).toEqual(["A1/S-3", "B2/S-4", "B2/S-5"]);
  });
});

// --- Inventering ---------------------------------------------------------------------

describe("Inventering per serienummer", () => {
  it("freezes a row per number; counted 0 or 1; books each difference on its number; a found number gets its own row", async () => {
    const { article, a1 } = await stocked();
    const session = await countRepo.createSession(parsed(createStockCountSchema, { locationId: a1.id, blocksTransactions: true }), user.id);
    const frozen = (await countRepo.getSession(session.id))!;
    expect(frozen.rows.map((r) => [r.batchNumber, r.batchKind, Number(r.snapshotQuantity)])).toEqual([
      ["S-1", "serial", 1],
      ["S-2", "serial", 1],
      ["S-3", "serial", 1],
    ]);
    const rowOf = (number: string) => frozen.rows.find((r) => r.batchNumber === number)!;
    await expect(countRepo.updateRow(session.id, rowOf("S-1").id, { countedQuantity: 2 })).rejects.toThrow(SerialCountNotUnitError);
    await expect(countRepo.updateRow(session.id, rowOf("S-1").id, { countedQuantity: 0.5 })).rejects.toThrow(SerialCountNotUnitError);
    await countRepo.updateRow(session.id, rowOf("S-1").id, { countedQuantity: 1 });
    await countRepo.updateRow(session.id, rowOf("S-2").id, { countedQuantity: 0 });
    // S-3 is left uncounted — untouched. A number found on the shelf that nobody booked:
    const found = await countRepo.addRow(session.id, parsed(addStockCountRowSchema, { articleId: article.id, batchNumber: "S-HITTAD" }));
    expect(Number(found.snapshotQuantity)).toBe(0);
    await countRepo.updateRow(session.id, found.id, { countedQuantity: 1 });
    // The article's Okänd row takes any quantity.
    const unknown = await countRepo.addRow(session.id, parsed(addStockCountRowSchema, { articleId: article.id }));
    await countRepo.updateRow(session.id, unknown.id, { countedQuantity: 1.5 });

    const posted = await countRepo.postSession(session.id, user.id);
    expect(posted.adjustments).toBe(3);
    expect(await inStock(article.id)).toEqual(["A1/Okänd=1.5", "A1/S-1", "A1/S-3", "A1/S-HITTAD", "B2/S-4", "B2/S-5"]);
    expect((await db.select().from(stockBatches).where(eq(stockBatches.batchNumber, "S-HITTAD")))[0]).toMatchObject({ kind: "serial", origin: "manual" });
  });

  it("a number that stands on ANOTHER place cannot be added — 409 serial-on-other-location naming the place", async () => {
    const { article, a1 } = await stocked();
    const session = await countRepo.createSession(parsed(createStockCountSchema, { locationId: a1.id, blocksTransactions: true }), user.id);
    const err = await countRepo.addRow(session.id, parsed(addStockCountRowSchema, { articleId: article.id, batchNumber: "s-4" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SerialOnOtherLocationError);
    expect((err as Error).message).toBe("Serienummer S-4 står på Huvudlager — B2 — flytta det hit först");
  });

  it("the registration proves each number against the log NOW: counted in it must stand nowhere, counted out it must still stand here", async () => {
    const { article, a1, b2 } = await stocked();
    // A count that does not block: stock moves while it is open.
    const session = await countRepo.createSession(parsed(createStockCountSchema, { locationId: a1.id, blocksTransactions: false }), user.id);
    const frozen = (await countRepo.getSession(session.id))!;
    const s1 = frozen.rows.find((r) => r.batchNumber === "S-1")!;
    await countRepo.updateRow(session.id, s1.id, { countedQuantity: 0 });
    // S-1 is moved away before the count is registered: it is no longer here to take out.
    await stockService.transferStock(parsed(createStockTransferSchema, { fromLocationId: a1.id, toLocationId: b2.id, rows: [{ articleId: article.id, quantity: 1, serialIds: await idsOf(article.id, "S-1") }] }), user.id);
    await expect(countRepo.postSession(session.id, user.id)).rejects.toThrow(BatchInsufficientError);

    // Counted in: a number found here that meanwhile was booked in elsewhere.
    await countRepo.updateRow(session.id, s1.id, { countedQuantity: null });
    const found = await countRepo.addRow(session.id, parsed(addStockCountRowSchema, { articleId: article.id, batchNumber: "S-NY" }));
    await countRepo.updateRow(session.id, found.id, { countedQuantity: 1 });
    await putSerial(article.id, b2.id, "S-NY");
    await expect(countRepo.postSession(session.id, user.id)).rejects.toThrow(SerialAlreadyInStockError);
    expect(await inStock(article.id)).toEqual(["A1/S-2", "A1/S-3", "B2/S-1", "B2/S-4", "B2/S-5", "B2/S-NY"]);
  });
});
