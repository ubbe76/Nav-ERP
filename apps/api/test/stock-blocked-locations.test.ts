import { completeOperationSchema, createArticleSchema, createCustomerSchema, createPurchaseOrderSchema, createQuoteSchema, createSupplierSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { articles, auditLog, db, deliveryRows, stockLocations, stockTransactions, systemSettings } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { pdfText } from "./helpers/pdf.js";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService, DefaultLocationBlockedError } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService, MaterialShortageError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { manufacturingRoutes } from "../src/modules/manufacturing/routes/manufacturing.routes.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createScanRepository } from "../src/modules/scan/repository/scan.repository.js";
import { createScanService } from "../src/modules/scan/service/scan.service.js";
import { onHandByArticle } from "../src/modules/stock/repository/on-hand.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { deactivateEmptyLocation } from "../src/modules/stock/service/location-lifecycle.js";
import { allocateOutflowLocations, lockArticlesForOutflow, type BlockedChoice } from "../src/modules/stock/service/outflow-locations.js";
import { createStockCountService } from "../src/modules/stock/service/stock-count.service.js";
import {
  createStockService,
  FallbackLocationNotBlockableError,
  StockLocationAlreadyBlockedError,
  StockLocationNameReservedError,
  StockLocationBlockedError,
  StockLocationNotBlockedError,
  StockLocationNotFoundError,
} from "../src/modules/stock/service/stock.service.js";
import { createValuationService } from "../src/modules/stock/service/valuation.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";

// Spärrade lagerplatser (etapp 1, migration 0185): spärra/släpp as a
// whitelisted transition with audit, the flows against a blocked place
// (Automatiskt skips it, an inflow nobody placed never lands there, a chosen
// pure outflow is refused, the TO card's choice only takes the goods), the
// flows that stay allowed, the lock against a draw in progress, and the
// readers that mean usable stock.

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
const countRepo = createStockCountRepository(db);
const countService = createStockCountService({ repo: countRepo, audit: auditRepository });
const imports = createImportService(createImportRepository(db));
const valuationService = createValuationService({ db, pdf: testDocumentPdfService });
const alertsRepo = createAlertsRepository(db);
const scanService = createScanService(createScanRepository(db));

const TABLES = sql`TRUNCATE audit_log, stock_count_rows, stock_count_sessions, purchase_receipts, mo_report_materials, mo_reports,
  purchase_order_rows, purchase_orders, suppliers, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders,
  routing_operations, work_centers, production_groups, delivery_row_locations, delivery_rows, deliveries, sales_order_rows, sales_orders,
  customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;
const SHORTAGE_KEY = "manufacturing_material_shortage";

let user: { id: string };

beforeEach(async () => {
  warehouseId = null;
  await db.execute(TABLES);
  await db.delete(systemSettings).where(eq(systemSettings.key, SHORTAGE_KEY));
  user = await authRepo.create({ email: `sparr-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Lagerchef", role: "admin" });
});

afterAll(async () => {
  await db.execute(TABLES);
  await db.delete(systemSettings).where(eq(systemSettings.key, SHORTAGE_KEY));
});

// One Huvudlager per test (the saldoimport resolves the warehouse by name).
let warehouseId: string | null = null;
async function place(name: string, opts: { fixed?: boolean; blocked?: boolean; note?: string } = {}) {
  warehouseId ??= (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!.id;
  return stockService.createLocation({
    warehouseId,
    name,
    active: true,
    fixed: opts.fixed ?? true,
    blocked: opts.blocked ?? false,
    blockedNote: opts.note,
  });
}

async function article(number: string, defaultLocationId?: string, type: "purchased" | "manufactured" = "purchased") {
  return articleService.createArticle(parsed(createArticleSchema, { articleNumber: number, name: number, type, active: true, defaultLocationId }));
}

async function stock(articleId: string, locationId: string | undefined, quantityDelta: number) {
  return stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" }, user.id);
}

async function balance(articleId: string, locationId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(row!.q);
}

async function fallbackId() {
  const [row] = await db.select({ id: stockLocations.id }).from(stockLocations).where(eq(stockLocations.name, "***"));
  return row!.id;
}

async function locationRow(id: string) {
  const [row] = await db.select().from(stockLocations).where(eq(stockLocations.id, id));
  return row!;
}

async function salesOrder(articleId: string, quantity: number) {
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  const { order, rows } = await salesService.createQuote(parsed(createQuoteSchema, { customerId: customer.id, rows: [{ articleId, quantity, unitPrice: 10 }] }), user.id);
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);
  return { order, row: rows[0]! };
}

describe("Spärra och släppa", () => {
  it("blocks with a time and a note, refuses a second block, and releases clearing both", async () => {
    const k = await place("K1");
    const x = await article("X-1", k.id);
    await stock(x.id, k.id, 4);

    const blocked = await stockService.blockLocation(k.id, "Väntar på analys", user.id);
    expect(blocked.location).toMatchObject({ id: k.id, name: "K1", warehouseName: "Huvudlager", blocked: true, blockedNote: "Väntar på analys" });
    expect(blocked.location.blockedAt).toBeInstanceOf(Date);
    // What the spärr touches: X has stock there and has it as Lagerplats.
    expect([blocked.articlesWithStock, blocked.defaultForArticles]).toEqual([1, 1]);
    // A property of the place: no stock movement, the value is unchanged.
    expect(await db.select().from(stockTransactions)).toHaveLength(1);

    await expect(stockService.blockLocation(k.id, null, user.id)).rejects.toBeInstanceOf(StockLocationAlreadyBlockedError);

    const released = await stockService.unblockLocation(k.id, user.id);
    expect(released.location).toMatchObject({ blocked: false, blockedAt: null, blockedNote: null });
    await expect(stockService.unblockLocation(k.id, user.id)).rejects.toBeInstanceOf(StockLocationNotBlockedError);
    await expect(stockService.blockLocation(crypto.randomUUID(), null, user.id)).rejects.toBeInstanceOf(StockLocationNotFoundError);
    await expect(stockService.unblockLocation(crypto.randomUUID(), user.id)).rejects.toBeInstanceOf(StockLocationNotFoundError);

    // Released and blocked again — a plain whitelisted round trip.
    expect((await stockService.blockLocation(k.id, null, user.id)).location).toMatchObject({ blocked: true, blockedNote: null });
  });

  it("logs blocked and unblocked with the place, the note and the counts", async () => {
    const k = await place("K1");
    await stockService.blockLocation(k.id, "Reklamation AV-7", user.id);
    await stockService.unblockLocation(k.id, user.id);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityType, "stock_location")).orderBy(auditLog.createdAt);
    expect(rows.map((r) => [r.entityId, r.action, r.userId, r.detail])).toEqual([
      [k.id, "blocked", user.id, { name: "K1", warehouseName: "Huvudlager", note: "Reklamation AV-7", articlesWithStock: 0, defaultForArticles: 0 }],
      [k.id, "unblocked", user.id, { name: "K1", warehouseName: "Huvudlager", note: "Reklamation AV-7", articlesWithStock: 0, defaultForArticles: 0 }],
    ]);
  });

  it("creates a place blocked (logged as blocked); a note only with a blocked place", async () => {
    const k = await place("Karantän", { blocked: true, note: "Inkommande kontroll" });
    expect(k).toMatchObject({ blocked: true, blockedNote: "Inkommande kontroll" });
    expect(k.blockedAt).toBeInstanceOf(Date);
    const [logged] = await db.select().from(auditLog).where(eq(auditLog.entityId, k.id));
    expect(logged).toMatchObject({ action: "blocked", detail: expect.objectContaining({ note: "Inkommande kontroll" }) });

    const open = await place("A1", { note: "ignoreras" });
    expect(open).toMatchObject({ blocked: false, blockedAt: null, blockedNote: null });
  });

  // The name "***" is reserved (granskningen 2026-11-10): no second place
  // gets it — blocked or not — and the reservplats keeps it.
  it("never blocks the *** fallback, and reserves its name — not on create, not by renaming, not away from it", async () => {
    const x = await article("X-1");
    const fallback = await fallbackId();
    await expect(stockService.blockLocation(fallback, null, user.id)).rejects.toBeInstanceOf(FallbackLocationNotBlockableError);
    await expect(place("***", { blocked: true })).rejects.toBeInstanceOf(StockLocationNameReservedError);
    await expect(place("***")).rejects.toBeInstanceOf(StockLocationNameReservedError);
    const k = await place("K1", { blocked: true });
    await expect(stockService.updateLocation(k.id, { name: "***" })).rejects.toBeInstanceOf(StockLocationNameReservedError);
    const open = await place("K2");
    await expect(stockService.updateLocation(open.id, { name: " *** " })).rejects.toBeInstanceOf(StockLocationNameReservedError);
    await expect(stockService.updateLocation(fallback, { name: "Reserv" })).rejects.toBeInstanceOf(StockLocationNameReservedError);
    expect((await locationRow(k.id)).name).toBe("K1");
    expect((await locationRow(fallback)).name).toBe("***");
    // The reservplats may still be edited without changing its name.
    expect(await stockService.updateLocation(fallback, { name: "***" })).toMatchObject({ name: "***" });
    expect(x.id).toBeTruthy();
  });

  it("edits the note only on a blocked place", async () => {
    const open = await place("A1");
    await expect(stockService.updateLocation(open.id, { blockedNote: "x" })).rejects.toBeInstanceOf(StockLocationNotBlockedError);
    const k = await place("K1", { blocked: true, note: "gammal" });
    expect(await stockService.updateLocation(k.id, { blockedNote: "ny" })).toMatchObject({ blocked: true, blockedNote: "ny" });
    expect(await stockService.updateLocation(k.id, { blockedNote: null })).toMatchObject({ blocked: true, blockedNote: null });
  });

  it("two simultaneous blocks give one winner and one 409", async () => {
    const k = await place("K1");
    const results = await Promise.allSettled([stockService.blockLocation(k.id, "a", user.id), stockService.blockLocation(k.id, "b", user.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StockLocationAlreadyBlockedError);
    expect(await db.select().from(auditLog).where(eq(auditLog.entityId, k.id))).toHaveLength(1);
  });
});

describe("the lock between Spärra and a draw", () => {
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  it("a block waits for a draw that read the place as open, then counts what the draw left", async () => {
    const l = await place("L1");
    const x = await article("X-1", l.id);
    await stock(x.id, l.id, 5);
    const drawn = gate();
    const release = gate();

    const draw = db.transaction(async (tx) => {
      const parts = await allocateOutflowLocations(tx, x.id, 5);
      for (const part of parts) {
        await tx.insert(stockTransactions).values({ articleId: x.id, locationId: part.locationId, quantityDelta: String(-part.quantity), transactionType: "sales_delivery" });
      }
      drawn.open();
      await release.promise;
      return parts;
    });
    await drawn.promise;
    const block = stockService.blockLocation(l.id, null, user.id);
    // Released even when the wait fails, so the open transaction never hangs the file.
    await waitForLockWaiter().finally(release.open);

    expect(await draw).toEqual([{ locationId: l.id, quantity: 5 }]);
    // Read after the draw committed: nothing of X is left on L1.
    expect(await block).toMatchObject({ articlesWithStock: 0, defaultForArticles: 1 });
  });

  it("a draw waits for a block in progress and then never takes from the place", async () => {
    const own = await place("A1");
    const l = await place("L1");
    const x = await article("X-1", own.id);
    await stock(x.id, own.id, 2);
    await stock(x.id, l.id, 10);
    const blocked = gate();
    const release = gate();

    // The same row lock Spärra takes (one UPDATE of the place), held open.
    const block = db.transaction(async (tx) => {
      await tx.update(stockLocations).set({ blocked: true, blockedAt: new Date() }).where(eq(stockLocations.id, l.id));
      blocked.open();
      await release.promise;
    });
    await blocked.promise;
    const draw = db.transaction((tx) => allocateOutflowLocations(tx, x.id, 5));
    await waitForLockWaiter().finally(release.open);
    await block;

    // 2 from A1, the remaining 3 negative there too — none from L1.
    expect(await draw).toEqual([{ locationId: own.id, quantity: 5 }]);
  });
});

describe("inflows", () => {
  it("an inflow without a place skips a blocked Lagerplats for ***; a chosen blocked place takes the goods", async () => {
    const k = await place("K1");
    const x = await article("X-1", k.id);
    await stockService.blockLocation(k.id, null, user.id);

    await stock(x.id, undefined, 3);
    expect(await balance(x.id, await fallbackId())).toBe(3);
    expect(await balance(x.id, k.id)).toBe(0);

    await stock(x.id, k.id, 4);
    expect(await balance(x.id, k.id)).toBe(4);
  });

  it("a purchase receipt into a blocked place lands there, and Ångra takes it back out", async () => {
    const k = await place("Karantän", { blocked: true });
    const x = await article("X-1");
    const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "Leverantör AB", active: true }));
    const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), user.id);
    const row = await purchaseService.addRow(order.id, { articleId: x.id, quantity: 5, unitPrice: 10 });
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: k.id, quantity: 5 }, user.id);
    expect(await balance(x.id, k.id)).toBe(5);

    const [receipt] = await purchaseService.listReceipts(order.id);
    await purchaseService.undoReceipt(order.id, receipt!.id, user.id);
    expect(await balance(x.id, k.id)).toBe(0);
  });

  it("a temporary blocked place is deactivated when emptied, keeps its spärr, and comes back blocked", async () => {
    const t = await place("T1", { fixed: false });
    const x = await article("X-1", t.id);
    await stock(x.id, t.id, 5);
    await stockService.blockLocation(t.id, "Tillfällig karantän", user.id);

    await stock(x.id, t.id, -5);
    expect(await locationRow(t.id)).toMatchObject({ active: false, blocked: true, blockedNote: "Tillfällig karantän" });

    await stock(x.id, t.id, 2);
    expect(await locationRow(t.id)).toMatchObject({ active: true, blocked: true });
  });
});

describe("Automatiskt and a chosen place in the outflows", () => {
  it("utleverans with Automatiskt skips the blocked place; the remainder goes negative on the Lagerplats", async () => {
    const own = await place("A1");
    const k = await place("K1");
    const b = await place("B2");
    const x = await article("X-1", own.id);
    await stock(x.id, own.id, 3);
    await stock(x.id, k.id, 10);
    await stock(x.id, b.id, 2);
    await stockService.blockLocation(k.id, null, user.id);
    const { order, row } = await salesOrder(x.id, 7);

    await salesService.deliverBatch(order.id, { rows: [{ rowId: row.id, quantity: 7 }] }, user.id);
    expect([await balance(x.id, own.id), await balance(x.id, b.id), await balance(x.id, k.id)]).toEqual([-2, 0, 10]);
  });

  it("…and on *** when the Lagerplats itself is blocked — never on the blocked place", async () => {
    const k = await place("K1");
    const b = await place("B2");
    const x = await article("X-1", k.id);
    await stock(x.id, k.id, 5);
    await stock(x.id, b.id, 2);
    await stockService.blockLocation(k.id, null, user.id);
    const { order, row } = await salesOrder(x.id, 4);

    await salesService.deliverBatch(order.id, { rows: [{ rowId: row.id, quantity: 4 }] }, user.id);
    expect([await balance(x.id, b.id), await balance(x.id, await fallbackId()), await balance(x.id, k.id)]).toEqual([0, -2, 5]);
  });

  it("refuses a chosen blocked place in utleverans and in the order card's Leverera, writing nothing", async () => {
    const k = await place("K1");
    const x = await article("X-1");
    await stock(x.id, k.id, 10);
    await stockService.blockLocation(k.id, null, user.id);
    const { order, row } = await salesOrder(x.id, 5);

    const batch = await salesService.deliverBatch(order.id, { rows: [{ rowId: row.id, quantity: 2, locationId: k.id }] }, user.id).catch((e: unknown) => e);
    expect(batch).toBeInstanceOf(StockLocationBlockedError);
    expect((batch as Error).message).toContain("Huvudlager — K1");
    await expect(salesService.deliverBatch(order.id, { locationId: k.id, rows: [{ rowId: row.id, quantity: 2 }] }, user.id)).rejects.toBeInstanceOf(
      StockLocationBlockedError
    );
    await expect(salesService.deliverGoods(order.id, row.id, { locationId: k.id, quantity: 2 }, user.id)).rejects.toBeInstanceOf(StockLocationBlockedError);
    expect(await balance(x.id, k.id)).toBe(10);
    const [orderRow] = await salesService.listRows(order.id);
    expect(Number(orderRow!.quantityDelivered)).toBe(0);
  });

  it("Ångra utleverans puts the goods back on a place that was blocked since", async () => {
    const b = await place("B2");
    const x = await article("X-1");
    await stock(x.id, b.id, 5);
    const { order, row } = await salesOrder(x.id, 5);
    const delivered = await salesService.deliverBatch(order.id, { rows: [{ rowId: row.id, quantity: 5, locationId: b.id }] }, user.id);
    await stockService.blockLocation(b.id, null, user.id);

    const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, delivered.deliveryId));
    await salesService.undoDeliveryRow(order.id, delivered.deliveryId, deliveryRow!.id, user.id);
    expect(await balance(x.id, b.id)).toBe(5);
  });

  it("the pick list leaves out a blocked place, as Automatiskt does", async () => {
    const own = await place("A1");
    const k = await place("Karantänhylla");
    const x = await article("X-1", own.id);
    await stock(x.id, own.id, 3);
    await stock(x.id, k.id, 10);
    await stockService.blockLocation(k.id, null, user.id);
    const { order } = await salesOrder(x.id, 2);

    const text = pdfText((await salesService.getPickListPdf(order.id)).content);
    expect(text).toContain("Huvudlager — A1: 3");
    expect(text).not.toContain("Karantänhylla");
    // The reader itself is physical and says which row is blocked.
    expect((await stockService.balancesForArticles([x.id])).map((r) => [r.locationName, r.blocked])).toEqual([
      ["A1", false],
      ["Karantänhylla", true],
    ]);
  });
});

describe("the TO card: a chosen blocked place only takes the finished goods", () => {
  // Parent P (5 st) with operations 10 and 20; component C (2/unit) linked
  // to 10, U (1/unit) unlinked. Everything lives on A1; K1 is blocked and
  // holds 10 of C.
  async function fixture() {
    const a1 = await place("A1");
    const k = await place("K1");
    const c = await article("C-1", a1.id);
    const u = await article("U-1", a1.id);
    const p = await article("P-1", a1.id, "manufactured");
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    const op10 = await mfgService.createRoutingOperation(p.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.createRoutingOperation(p.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
    await articleService.addBomComponent(p.id, { componentArticleId: c.id, quantity: 2, routingOperationId: op10.id });
    await articleService.addBomComponent(p.id, { componentArticleId: u.id, quantity: 1 });
    await stock(c.id, a1.id, 100);
    await stock(c.id, k.id, 10);
    await stock(u.id, a1.id, 50);
    await stockService.blockLocation(k.id, "Kontroll", user.id);
    const order = await mfgService.createManufacturingOrder({ articleId: p.id, quantity: 5 }, user.id);
    const [first, last] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
    return { a1, k, c, u, p, order, first: first!, last: last! };
  }

  it("Slutför operation: the material by Automatiskt, the last operation's goods onto the blocked place", async () => {
    const f = await fixture();
    await mfgService.completeOperation(f.first.id, parsed(completeOperationSchema, { quantityCompleted: 5, locationId: f.k.id }), user.id);
    expect([await balance(f.c.id, f.a1.id), await balance(f.c.id, f.k.id)]).toEqual([90, 10]);

    await mfgService.completeOperation(f.last.id, parsed(completeOperationSchema, { quantityCompleted: 5, locationId: f.k.id }), user.id);
    expect(await balance(f.p.id, f.k.id)).toBe(5);
    expect(await balance(f.p.id, f.a1.id)).toBe(0);
    expect([await balance(f.u.id, f.a1.id), await balance(f.u.id, f.k.id)]).toEqual([45, 0]);

    // Ångra rapportering takes the goods back from the blocked place.
    const lastReport = (await mfgService.listReports(f.order.id)).find((r) => r.sequenceNo === 20)!;
    await mfgService.undoReport(f.order.id, lastReport.id, user.id);
    expect([await balance(f.p.id, f.k.id), await balance(f.u.id, f.a1.id)]).toEqual([0, 50]);
  });

  it("Slutför order: the goods onto the blocked place, the unlinked material by Automatiskt", async () => {
    const f = await fixture();
    await mfgService.complete(f.order.id, { locationId: f.k.id, quantity: 5 }, user.id);
    expect(await balance(f.p.id, f.k.id)).toBe(5);
    expect([await balance(f.u.id, f.a1.id), await balance(f.u.id, f.k.id)]).toEqual([45, 0]);
  });

  it("an open place chosen on the card takes the material and, on the last operation, the goods", async () => {
    const f = await fixture();
    const b = await place("B2");
    await mfgService.completeOperation(f.last.id, parsed(completeOperationSchema, { quantityCompleted: 5, locationId: b.id }), user.id);
    expect(await balance(f.p.id, b.id)).toBe(5);
    // The unlinked material follows the receipt there, as with Slutför order.
    expect(await balance(f.u.id, b.id)).toBe(-5);
  });

  it("Förbruka refuses a chosen blocked place and draws nothing", async () => {
    const f = await fixture();
    const [material] = (await mfgService.listMaterialConsumptions(f.order.id)).filter((m) => m.componentArticleId === f.c.id);
    await expect(mfgService.consumeMaterial(f.order.id, material!.id, { locationId: f.k.id, quantity: 2 }, user.id)).rejects.toBeInstanceOf(
      StockLocationBlockedError
    );
    expect(await balance(f.c.id, f.k.id)).toBe(10);
    const [after] = (await mfgService.listMaterialConsumptions(f.order.id)).filter((m) => m.componentArticleId === f.c.id);
    expect(Number(after!.quantityConsumed)).toBe(0);
  });
});

describe("the 409 on the routes", () => {
  function routesApp() {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { id: user.id, role: "admin", permissions: [] };
    });
    app.register(salesRoutes, { service: salesService });
    app.register(manufacturingRoutes, { service: mfgService });
    return app;
  }

  it("answers 409 stock-location-blocked on Utleverans, Leverera and Förbruka", async () => {
    const app = routesApp();
    const k = await place("K1", { blocked: true });
    const x = await article("X-1");
    const { order, row } = await salesOrder(x.id, 5);
    const batch = await app.inject({ method: "POST", url: `/sales-orders/${order.id}/deliver`, payload: { rows: [{ rowId: row.id, quantity: 1, locationId: k.id }] } });
    expect([batch.statusCode, batch.json().code]).toEqual([409, "stock-location-blocked"]);
    expect(batch.json().error).toContain("Huvudlager — K1");
    const single = await app.inject({ method: "POST", url: `/sales-orders/${order.id}/rows/${row.id}/deliver`, payload: { quantity: 1, locationId: k.id } });
    expect([single.statusCode, single.json().code]).toEqual([409, "stock-location-blocked"]);

    const c = await article("C-1");
    const p = await article("P-1", undefined, "manufactured");
    await articleService.addBomComponent(p.id, { componentArticleId: c.id, quantity: 1 });
    const mo = await mfgService.createManufacturingOrder({ articleId: p.id, quantity: 2 }, user.id);
    const [material] = await mfgService.listMaterialConsumptions(mo.id);
    const consume = await app.inject({ method: "POST", url: `/manufacturing-orders/${mo.id}/materials/${material!.id}/consume`, payload: { quantity: 1, locationId: k.id } });
    expect([consume.statusCode, consume.json().code]).toEqual([409, "stock-location-blocked"]);
    await app.close();
  });
});

describe("flows that stay allowed on a blocked place", () => {
  it("transfers both ways, adjusts up and down, counts and imports", async () => {
    const a1 = await place("A1");
    const k = await place("K1", { blocked: true });
    const x = await article("X-1", a1.id);
    await stock(x.id, a1.id, 10);

    await stockService.transferStock({ fromLocationId: a1.id, toLocationId: k.id, rows: [{ articleId: x.id, quantity: 6 }] }, user.id);
    await stockService.transferStock({ fromLocationId: k.id, toLocationId: a1.id, rows: [{ articleId: x.id, quantity: 2 }] }, user.id);
    expect([await balance(x.id, a1.id), await balance(x.id, k.id)]).toEqual([6, 4]);

    // Kassation is a negative justering on the blocked place.
    await stock(x.id, k.id, -1);
    await stock(x.id, k.id, 2);
    expect(await balance(x.id, k.id)).toBe(5);

    const session = await countService.createSession({ locationId: k.id, blocksTransactions: false }, user.id);
    const detail = await countService.getSession(session.id);
    await countService.updateRow(session.id, detail.rows[0]!.id, { countedQuantity: 3 });
    await countService.postSession(session.id, user.id);
    expect(await balance(x.id, k.id)).toBe(3);

    await imports.commit("stockBalances", {
      mapping: { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity" },
      rows: [["X-1", "Huvudlager", "K1", "8"]],
    });
    expect(await balance(x.id, k.id)).toBe(8);
  });

  it("an emptied temporary place's articles do not follow a transfer into a blocked place", async () => {
    const t = await place("T1", { fixed: false });
    const k = await place("K1", { blocked: true });
    const x = await article("X-1", t.id);
    await stock(x.id, t.id, 4);
    const moved = await stockService.transferStock({ fromLocationId: t.id, toLocationId: k.id, rows: [{ articleId: x.id, quantity: 4 }] }, user.id);
    expect(moved.deactivatedSourceLocation).toBe(true);
    const [row] = await db.select({ defaultLocationId: articles.defaultLocationId }).from(articles).where(eq(articles.id, x.id));
    expect(row!.defaultLocationId).toBeNull();
  });
});

describe("the article's Lagerplats", () => {
  it("refuses a blocked place as a new Lagerplats, lets an unchanged one through", async () => {
    const a1 = await place("A1");
    const k = await place("K1", { blocked: true });
    await expect(article("X-1", k.id)).rejects.toBeInstanceOf(DefaultLocationBlockedError);

    const x = await article("X-2", a1.id);
    await expect(articleService.updateArticle(x.id, { defaultLocationId: k.id })).rejects.toBeInstanceOf(DefaultLocationBlockedError);

    // Blocked after it was chosen: Allmänt sends the unchanged value along.
    await stockService.blockLocation(a1.id, null, user.id);
    const saved = await articleService.updateArticle(x.id, { name: "Nytt namn", defaultLocationId: a1.id });
    expect(saved).toMatchObject({ name: "Nytt namn", defaultLocationId: a1.id, defaultLocationBlocked: true });
  });
});

describe("readers", () => {
  it("onHandByArticle splits usable and blocked in one read", async () => {
    const a1 = await place("A1");
    const k = await place("K1");
    const x = await article("X-1", a1.id);
    const y = await article("Y-1", a1.id);
    await stock(x.id, a1.id, 3);
    await stock(x.id, k.id, 10);
    await stock(y.id, k.id, 2);
    await stockService.blockLocation(k.id, null, user.id);

    const all = await onHandByArticle(db);
    expect(all.get(x.id)).toEqual({ usable: 3, blocked: 10 });
    expect(all.get(y.id)).toEqual({ usable: 0, blocked: 2 });
    expect([...(await onHandByArticle(db, [y.id])).keys()]).toEqual([y.id]);
    expect((await onHandByArticle(db, [])).size).toBe(0);
  });

  it("a minus on a blocked place is carried by the usable stock, never shown as blocked", async () => {
    const a1 = await place("A1");
    const k1 = await place("K1");
    const k2 = await place("K2");
    const x = await article("X-1", a1.id);
    const y = await article("Y-1", a1.id);
    // X: Automatiskt's remainder left K1 at −3 before it was blocked; K2 holds 4.
    await stock(x.id, a1.id, 10);
    await stock(x.id, k1.id, -3);
    await stock(x.id, k2.id, 4);
    // Y: a kassation of 8 from a blocked place that held 5.
    await stock(y.id, a1.id, 10);
    await stock(y.id, k1.id, 5);
    await stockService.blockLocation(k1.id, null, user.id);
    await stockService.blockLocation(k2.id, null, user.id);
    await stock(y.id, k1.id, -8);

    const onHand = await onHandByArticle(db, [x.id, y.id]);
    // Physically 11 and 7; usable + blocked is still the physical balance.
    expect(onHand.get(x.id)).toEqual({ usable: 7, blocked: 4 });
    expect(onHand.get(y.id)).toEqual({ usable: 7, blocked: 0 });
  });

  it("Saldon: each row says whether its place is blocked, and filters on it", async () => {
    const a1 = await place("A1");
    const k = await place("K1");
    const x = await article("X-1", a1.id);
    await stock(x.id, a1.id, 3);
    await stock(x.id, k.id, 10);
    await stockService.blockLocation(k.id, "Analys", user.id);

    const all = await stockService.getBalances({ limit: 50, offset: 0 });
    expect(all.rows.map((r) => [r.locationName, r.locationBlocked])).toEqual([
      ["A1", false],
      ["K1", true],
    ]);
    const only = await stockService.getBalances({ limit: 50, offset: 0, blocked: true });
    expect([only.total, only.rows.map((r) => r.locationName)]).toEqual([1, ["K1"]]);
    const without = await stockService.getBalances({ limit: 50, offset: 0, blocked: false });
    expect([without.total, without.rows.map((r) => r.locationName)]).toEqual([1, ["A1"]]);

    const [listed] = (await stockService.listLocations()).filter((l) => l.id === k.id);
    expect(listed).toMatchObject({ blocked: true, blockedNote: "Analys", labelCode: expect.stringMatching(/^LP\d{4,}$/) });
    expect(listed!.blockedAt).toBeInstanceOf(Date);

    const scan = await scanService.resolve(listed!.labelCode);
    expect(scan.matches[0]).toMatchObject({ kind: "location", id: k.id, blocked: true });
  });

  it("values the blocked balance as usual, and Negativt saldo stays physical", async () => {
    const a1 = await place("A1");
    const k = await place("K1");
    const x = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "X-1", name: "X-1", type: "purchased", active: true, standardCost: 10, defaultLocationId: a1.id }));
    await stock(x.id, k.id, 10);
    await stock(x.id, a1.id, -4);
    await stockService.blockLocation(k.id, null, user.id);

    const valuation = await valuationService.getValuation({ method: "standard" });
    const row = valuation.groups.flatMap((g) => g.rows).find((r) => r.articleId === x.id)!;
    expect([row.quantity, row.value]).toEqual([6, 60]);
    // Usable −4, but 6 in total: no bookkeeping error, so no alert.
    expect((await alertsRepo.negativeStock()).map((r) => r.articleId)).not.toContain(x.id);
  });

  it("Materialbrist counts only usable stock: 5 on A1, 10 blocked, a report of 8 is refused", async () => {
    await testSystemService.updateSettings({ manufacturingMaterialShortage: "block" });
    const a1 = await place("A1");
    const k = await place("K1");
    const c = await article("C-1", a1.id);
    const p = await article("P-1", a1.id, "manufactured");
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    const op10 = await mfgService.createRoutingOperation(p.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
    await articleService.addBomComponent(p.id, { componentArticleId: c.id, quantity: 2, routingOperationId: op10.id });
    await stock(c.id, a1.id, 5);
    await stock(c.id, k.id, 10);
    await stockService.blockLocation(k.id, null, user.id);

    // The release's warning reads the same usable balance.
    const order = await mfgService.createManufacturingOrder({ articleId: p.id, quantity: 5 }, user.id);
    expect(order.releaseWarnings).toEqual(["C-1: behöver 10, tillgängligt 5"]);
    const [op] = await mfgService.listOperations(order.id);

    const err = await mfgService.completeOperation(op!.id, parsed(completeOperationSchema, { quantityCompleted: 4 }), user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect((err as MaterialShortageError).shortages).toMatchObject([{ articleId: c.id, required: 8, available: 5 }]);
    // Rolled back: nothing drawn anywhere.
    expect([await balance(c.id, a1.id), await balance(c.id, k.id)]).toEqual([5, 10]);

    // Ändra material: the same basis.
    const x = await article("X-1", a1.id);
    await stock(x.id, k.id, 7);
    const added = await mfgService.addMaterial(order.id, { componentArticleId: x.id, quantity: 3 }, user.id);
    expect(added.warnings).toEqual(["X-1: behöver 3, tillgängligt 0"]);
  });

  it("the saldoimport's preview follows the resolver past a blocked Lagerplats", async () => {
    const k = await place("K1");
    const x = await article("X-1", k.id);
    await stock(x.id, k.id, 4);
    await stockService.blockLocation(k.id, null, user.id);
    const input = { mapping: { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity" }, rows: [["X-1", "", "", "10"]] };

    const preview = await imports.preview("stockBalances", input);
    expect(preview.rows[0]!.values).toMatchObject({ currentQuantity: 0, change: 10 });
    await imports.commit("stockBalances", input);
    expect([await balance(x.id, await fallbackId()), await balance(x.id, k.id)]).toEqual([10, 4]);
  });
});

// Lock order on a TEMPORARY place (fixed = false), where a draw that empties
// the place deactivates it and clears the Lagerplats of its articles. Every
// draw locks the article before the place, and deactivateEmptyLocation takes
// the Lagerplats articles and the place only when the place looks empty — so
// none of these meet in a deadlock (40P01), and the end state is right.
describe("lock order on a temporary place", () => {
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }

  // One draw as drawMaterial/deliverBatch book it, the place cleanup held
  // back until `go` opens: the transaction keeps its locks meanwhile.
  function heldDraw(
    articleId: string,
    quantity: number,
    opts: { locationId?: string; blockedChoice?: BlockedChoice; lockFirst?: boolean } = {}
  ) {
    const drawn = gate();
    const go = gate();
    const done = db.transaction(async (tx) => {
      if (opts.lockFirst) await lockArticlesForOutflow(tx, [articleId]);
      const parts = await allocateOutflowLocations(tx, articleId, quantity, opts.locationId, { blockedChoice: opts.blockedChoice });
      for (const part of parts) {
        await tx.insert(stockTransactions).values({ articleId, locationId: part.locationId, quantityDelta: String(-part.quantity), transactionType: "mo_consumption" });
      }
      drawn.open();
      await go.promise;
      const deactivated: boolean[] = [];
      for (const part of parts) deactivated.push(await deactivateEmptyLocation(tx, part.locationId));
      return { parts, deactivated };
    });
    // A failure before `drawn` must not leave the test waiting for it.
    done.catch(() => drawn.open());
    return { drawn: drawn.promise, go: go.open, done };
  }

  // "ok", or the Postgres code behind a failed query (40P01 = deadlock).
  function outcome(result: PromiseSettledResult<unknown>) {
    if (result.status === "fulfilled") return "ok";
    const reason = result.reason as { code?: string; cause?: { code?: string } };
    return reason.cause?.code ?? reason.code ?? String(result.reason);
  }

  async function defaultOf(articleId: string) {
    const [row] = await db.select({ defaultLocationId: articles.defaultLocationId }).from(articles).where(eq(articles.id, articleId));
    return row!.defaultLocationId;
  }

  // P (5 st) with one operation and one unlinked component, 2 per unit.
  async function orderFor(componentId: string, perUnit = 2) {
    const p = await article(`P-${crypto.randomUUID().slice(0, 6)}`, undefined, "manufactured");
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    await mfgService.createRoutingOperation(p.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
    await articleService.addBomComponent(p.id, { componentArticleId: componentId, quantity: perUnit });
    const order = await mfgService.createManufacturingOrder({ articleId: p.id, quantity: 5 }, user.id);
    const [material] = await mfgService.listMaterialConsumptions(order.id);
    return { p, order, material: material! };
  }

  it("two draws of different articles from their shared Lagerplats do not deadlock; the last one out deactivates it", async () => {
    const l = await place("L1", { fixed: false });
    const x = await article("X-1", l.id);
    const y = await article("Y-1", l.id);
    await stock(x.id, l.id, 5);
    await stock(y.id, l.id, 5);

    // Each holds its own article; X's part of L1 is emptied, Y leaves 2.
    const first = heldDraw(x.id, 5);
    const second = heldDraw(y.id, 3);
    await Promise.all([first.drawn, second.drawn]);
    first.go();
    second.go();
    const results = await Promise.allSettled([first.done, second.done]);
    expect(results.map(outcome)).toEqual(["ok", "ok"]);
    // Something is left on L1, so neither cleanup took a lock or deactivated.
    expect(results.map((r) => (r as PromiseFulfilledResult<{ deactivated: boolean[] }>).value.deactivated)).toEqual([[false], [false]]);
    expect(await locationRow(l.id)).toMatchObject({ active: true });
    expect([await defaultOf(x.id), await defaultOf(y.id)]).toEqual([l.id, l.id]);

    // The last 2 of Y out: L1 is retired once and both lose it as Lagerplats.
    const { order, row } = await salesOrder(y.id, 2);
    await salesService.deliverBatch(order.id, { rows: [{ rowId: row.id, quantity: 2 }] }, user.id);
    expect([await balance(x.id, l.id), await balance(y.id, l.id)]).toEqual([0, 0]);
    expect(await locationRow(l.id)).toMatchObject({ active: false });
    expect([await defaultOf(x.id), await defaultOf(y.id)]).toEqual([null, null]);
  });

  it("an emptying draw waits for the other article's draw to commit, then sees its minus and keeps the place", async () => {
    const l = await place("L1", { fixed: false });
    const m = await place("M1");
    const x = await article("X-1", l.id);
    const y = await article("Y-1", l.id);
    await stock(x.id, l.id, 5);
    await stock(y.id, m.id, 2);

    // X empties L1; Y takes its 2 on M1 and the remaining 3 as a minus on L1.
    const first = heldDraw(x.id, 5);
    const second = heldDraw(y.id, 5);
    await Promise.all([first.drawn, second.drawn]);
    first.go();
    second.go();
    const results = await Promise.allSettled([first.done, second.done]);
    expect(results.map(outcome)).toEqual(["ok", "ok"]);
    expect([await balance(x.id, l.id), await balance(y.id, l.id), await balance(y.id, m.id)]).toEqual([0, -3, 0]);
    // A place with a balance stays active, and nobody lost their Lagerplats.
    expect(await locationRow(l.id)).toMatchObject({ active: true });
    expect([await defaultOf(x.id), await defaultOf(y.id)]).toEqual([l.id, l.id]);
  });

  it("Förbruka from the place waits for a report's Automatiskt draw that empties it", async () => {
    const l = await place("L1", { fixed: false });
    const c = await article("C-1", l.id);
    await stock(c.id, l.id, 10);
    const { order, material } = await orderFor(c.id);

    // The report: holds C, takes all 10 from L1.
    const report = heldDraw(c.id, 10, { lockFirst: true });
    await report.drawn;
    const forbruka = mfgService.consumeMaterial(order.id, material.id, { locationId: l.id, quantity: 4 }, user.id);
    await waitForLockWaiter().finally(report.go);
    const results = await Promise.allSettled([report.done, forbruka]);
    expect(results.map(outcome)).toEqual(["ok", "ok"]);

    // The report retired L1 (once) and cleared C's Lagerplats; Förbruka then
    // woke L1 again for its 4, which is now a minus there.
    expect((results[0] as PromiseFulfilledResult<{ deactivated: boolean[] }>).value.deactivated).toEqual([true]);
    expect(await balance(c.id, l.id)).toBe(-4);
    expect(await locationRow(l.id)).toMatchObject({ active: true });
    expect(await defaultOf(c.id)).toBeNull();
    const [after] = await mfgService.listMaterialConsumptions(order.id);
    expect(Number(after!.quantityConsumed)).toBe(4);
  });

  it("two Förbruka from the place, each of its full balance, run one after the other", async () => {
    const l = await place("L1", { fixed: false });
    const c = await article("C-1", l.id);
    await stock(c.id, l.id, 5);
    const { order, material } = await orderFor(c.id);

    const first = heldDraw(c.id, 5, { locationId: l.id, blockedChoice: "refuse" });
    await first.drawn;
    const second = mfgService.consumeMaterial(order.id, material.id, { locationId: l.id, quantity: 5 }, user.id);
    await waitForLockWaiter().finally(first.go);
    const results = await Promise.allSettled([first.done, second]);
    expect(results.map(outcome)).toEqual(["ok", "ok"]);

    expect((results[0] as PromiseFulfilledResult<{ deactivated: boolean[] }>).value.deactivated).toEqual([true]);
    expect(await balance(c.id, l.id)).toBe(-5);
    expect(await locationRow(l.id)).toMatchObject({ active: true });
    expect(await defaultOf(c.id)).toBeNull();
  });

  it("Slutför order locks its components before its receipt wakes the chosen place", async () => {
    const a1 = await place("A1");
    const l = await place("L1", { fixed: false });
    const u = await article("U-1", a1.id);
    // L1 was used and emptied — retired.
    await stock(u.id, l.id, 1);
    await stock(u.id, l.id, -1);
    expect(await locationRow(l.id)).toMatchObject({ active: false });
    const { p, order } = await orderFor(u.id, 1);

    // A Förbruka of U from L1 that holds U before it wakes L1.
    const held = gate();
    const go = gate();
    const draw = db.transaction(async (tx) => {
      await lockArticlesForOutflow(tx, [u.id]);
      held.open();
      await go.promise;
      const parts = await allocateOutflowLocations(tx, u.id, 1, l.id, { blockedChoice: "refuse" });
      for (const part of parts) {
        await tx.insert(stockTransactions).values({ articleId: u.id, locationId: part.locationId, quantityDelta: String(-part.quantity), transactionType: "mo_consumption" });
        await deactivateEmptyLocation(tx, part.locationId);
      }
    });
    draw.catch(() => held.open());
    await held.promise;
    // Slutför onto L1 waits for U before its receipt wakes L1 — the other
    // way round it would hold L1 and wait for U while the draw waits for L1.
    const slutfor = mfgService.complete(order.id, { locationId: l.id, quantity: 5 }, user.id);
    await waitForLockWaiter().finally(go.open);
    const results = await Promise.allSettled([draw, slutfor]);
    expect(results.map(outcome)).toEqual(["ok", "ok"]);
    // The goods on L1, the unlinked material (5) drawn there after the 1.
    expect([await balance(p.id, l.id), await balance(u.id, l.id)]).toEqual([5, -6]);
    expect(await locationRow(l.id)).toMatchObject({ active: true });
  });
});
