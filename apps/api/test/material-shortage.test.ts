import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db,
  manufacturingOrders,
  moMaterialConsumptions,
  moOperations,
  moReports,
  stampSessions,
  stockTransactions,
  systemSettings,
  timeReports,
} from "@navet/db";
import type { ManufacturingMaterialShortage } from "@navet/shared";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService, MaterialShortageError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";

// Materialbrist vid rapportering: the system setting
// manufacturing_material_shortage (none | warn | block) × every path that
// draws component material — the TO card's Slutför operation / Slutför
// order / Förbruka, the terminal's stamp-out and the lego receipt. The REAL
// wiring as in app.ts: the manufacturing service reads the setting through
// testSystemService, purchase and timereport go through it.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  undefined,
  undefined,
  testSystemService
);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService
);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);

const TABLES = sql`TRUNCATE attendance_sessions, stamp_sessions, time_reports, employees, audit_log, purchase_receipts, mo_reports, purchase_order_rows, purchase_orders, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

// system_settings survives the TRUNCATE and is shared with every other
// suite — the key is removed before and after so nobody inherits a mode.
const SETTING_KEY = "manufacturing_material_shortage";

beforeEach(async () => {
  await db.execute(TABLES);
  await db.delete(systemSettings).where(eq(systemSettings.key, SETTING_KEY));
});

afterAll(async () => {
  await db.execute(TABLES);
  await db.delete(systemSettings).where(eq(systemSettings.key, SETTING_KEY));
});

async function setMode(mode: ManufacturingMaterialShortage) {
  await testSystemService.updateSettings({ manufacturingMaterialShortage: mode });
}

async function makeUser() {
  return authRepo.create({
    email: `ms-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Rapportör",
    role: "admin",
  });
}

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name, active: true });
}

async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({ articleId, locationId, quantityDelta: quantity, transactionType: "inventory_adjustment" });
}

async function totalBalance(articleId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(eq(stockTransactions.articleId, articleId));
  return Number(row!.q);
}

async function consumedFor(orderId: string, articleId: string) {
  const rows = await mfgService.listMaterialConsumptions(orderId);
  return rows.filter((r) => r.componentArticleId === articleId).reduce((sum, r) => sum + Number(r.quantityConsumed), 0);
}

async function liveReports(orderId: string) {
  return db.select().from(moReports).where(eq(moReports.manufacturingOrderId, orderId));
}

async function makeComponent(name: string, type: "purchased" | "service" = "purchased") {
  return articleService.createArticle({
    articleNumber: `${name}-${crypto.randomUUID().slice(0, 8)}`,
    name,
    type,
    unit: "st",
    active: true,
  });
}

// Parent with operations 10 and 20 (the last). `linked` is drawn by reports
// on op 10 (componentPerUnit each), `unlinked` (1/st) follows the finished
// goods — Slutför order, or OK on op 20.
async function makeOrder(opts: { quantity?: number; componentPerUnit?: number; stock?: number; linkedType?: "purchased" | "service" } = {}) {
  const { quantity = 4, componentPerUnit = 2, stock = 3, linkedType = "purchased" } = opts;
  const user = await makeUser();
  const location = await makeLocation();
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID().slice(0, 8)}`,
    name: "Parent",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const linked = await makeComponent("Plåt 2 mm", linkedType);
  const unlinked = await makeComponent("Skruv");
  const workCenter = await mfgService.createWorkCenter({ code: String(100 + Math.floor(Math.random() * 800)), name: "Svets", active: true });
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: linked.id, quantity: componentPerUnit, routingOperationId: op10.id });
  await articleService.addBomComponent(parent.id, { componentArticleId: unlinked.id, quantity: 1 });
  if (stock > 0) await seedStock(linked.id, location.id, stock);
  if (stock > 0) await seedStock(unlinked.id, location.id, stock);

  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity }, user.id);
  const operations = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { user, location, parent, linked, unlinked, order, op10: operations[0]!, op20: operations[1]! };
}

describe("Materialbrist — TO card Slutför operation", () => {
  it("none: draws into negative stock exactly as before (no check)", async () => {
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    await mfgService.completeOperation(f.op10.id, { quantityCompleted: 4 }, f.user.id);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(8);
    expect(await totalBalance(f.linked.id)).toBe(-5);
  });

  it("warn: refuses with overridable shortages and books NOTHING", async () => {
    await setMode("warn");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    const err = await mfgService.completeOperation(f.op10.id, { quantityCompleted: 4 }, f.user.id).catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.overridable).toBe(true);
    expect(err.shortages).toEqual([
      {
        articleId: f.linked.id,
        articleNumber: f.linked.articleNumber,
        articleName: "Plåt 2 mm",
        unitCode: "st",
        required: 8,
        available: 3,
      },
    ]);
    expect(err.message).toBe("Det finns inte tillräckligt med ingående delar: Plåt 2 mm (behöver 8 st, tillgängligt 3 st)");

    // The transaction rolled back: no draw, no report row, operation untouched.
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(0);
    expect(await totalBalance(f.linked.id)).toBe(3);
    expect(await liveReports(f.order.id)).toHaveLength(0);
    const [op] = await db.select().from(moOperations).where(eq(moOperations.id, f.op10.id));
    expect(Number(op!.quantityCompleted ?? 0)).toBe(0);
    expect(op!.status).toBe("pending");
  });

  it("warn: proceeds with allowMaterialShortage", async () => {
    await setMode("warn");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    await mfgService.completeOperation(f.op10.id, { quantityCompleted: 4, allowMaterialShortage: true }, f.user.id);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(8);
    expect(await totalBalance(f.linked.id)).toBe(-5);
    expect(await liveReports(f.order.id)).toHaveLength(1);
  });

  it("block: refuses, not overridable, and the flag is ignored", async () => {
    await setMode("block");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    const err = await mfgService.completeOperation(f.op10.id, { quantityCompleted: 4 }, f.user.id).catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.overridable).toBe(false);

    await expect(
      mfgService.completeOperation(f.op10.id, { quantityCompleted: 4, allowMaterialShortage: true }, f.user.id)
    ).rejects.toThrow(MaterialShortageError);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(0);
    expect(await totalBalance(f.linked.id)).toBe(3);
  });

  it("passes when the draw is exactly covered and when it is covered by another location", async () => {
    await setMode("block");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 2 });
    // 2 on A1 + 6 on B2 = 8 = the draw. Total stock counts, not the location.
    const other = await makeLocation("B2");
    await seedStock(f.linked.id, other.id, 6);
    await mfgService.completeOperation(f.op10.id, { quantityCompleted: 4, locationId: f.location.id }, f.user.id);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(8);
    expect(await totalBalance(f.linked.id)).toBe(0);
  });

  it("scrapped units draw too and count towards the shortage", async () => {
    await setMode("block");
    // 2/st × (3 OK + 1 scrapped) = 8 > 7 in stock.
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 7 });
    const err = await mfgService
      .completeOperation(f.op10.id, { quantityCompleted: 3, quantityScrapped: 1, scrapReason: "Repa" }, f.user.id)
      .catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.shortages[0]).toMatchObject({ required: 8, available: 7 });
    // The scrap row rolled back with the rest.
    expect(await mfgService.listScrapForOrder(f.order.id)).toHaveLength(0);
  });

  it("adds up two material rows of the same component in one report", async () => {
    await setMode("warn");
    // A single-operation parent: the report on it draws the linked row AND
    // receives the goods, which draws the unlinked rows. A second row of
    // the same component, unlinked (a BOM holds a component once, so it is
    // inserted directly): 2/st + 1/st = 3/st × 4 = 12 > 10 in stock.
    const user = await makeUser();
    const location = await makeLocation();
    const parent = await articleService.createArticle({
      articleNumber: `ONE-${crypto.randomUUID().slice(0, 8)}`,
      name: "Parent",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const component = await makeComponent("Plåt 2 mm");
    const wc = await mfgService.createWorkCenter({ code: "150", name: "Svets", active: true });
    const op = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1 });
    await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, routingOperationId: op.id });
    await seedStock(component.id, location.id, 10);
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, user.id);
    await db.insert(moMaterialConsumptions).values({
      manufacturingOrderId: order.id,
      componentArticleId: component.id,
      moOperationId: null,
      quantityPlanned: "4",
    });
    const [moOp] = await mfgService.listOperations(order.id);

    const err = await mfgService.completeOperation(moOp!.id, { quantityCompleted: 4 }, user.id).catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.shortages).toHaveLength(1);
    expect(err.shortages[0]).toMatchObject({ articleId: component.id, required: 12, available: 10 });
    expect(await consumedFor(order.id, component.id)).toBe(0);
    expect(await totalBalance(component.id)).toBe(10);
    expect(await totalBalance(parent.id)).toBe(0);
  });

  it("never checks a component of type service", async () => {
    await setMode("block");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 0, linkedType: "service" });
    await mfgService.completeOperation(f.op10.id, { quantityCompleted: 4 }, f.user.id);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(8);
    expect(await totalBalance(f.linked.id)).toBe(-8);
  });

  it("a re-report that draws nothing more passes even with negative stock", async () => {
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    // Drawn into negative while unchecked …
    await mfgService.completeOperation(f.op10.id, { quantityCompleted: 4 }, f.user.id);
    await setMode("block");
    // … a later report of 0 more tops up nothing, so there is nothing to refuse.
    await mfgService.completeOperation(f.op10.id, { quantityCompleted: 0 }, f.user.id);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(8);
  });

  it("serializes two reports drawing the same component — one passes, one is refused, no deadlock", async () => {
    await setMode("block");
    const a = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 10 });
    // A second TO on the same component article (its own parent).
    const parentB = await articleService.createArticle({
      articleNumber: `PARENT-B-${crypto.randomUUID().slice(0, 8)}`,
      name: "Parent B",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const wc = await mfgService.createWorkCenter({ code: "999", name: "Press", active: true });
    const opB = await mfgService.createRoutingOperation(parentB.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(parentB.id, { sequenceNo: 20, workCenterId: wc.id, setupTime: 1, runTimePerUnit: 1 });
    await articleService.addBomComponent(parentB.id, { componentArticleId: a.linked.id, quantity: 2, routingOperationId: opB.id });
    const orderB = await mfgService.createManufacturingOrder({ articleId: parentB.id, quantity: 4 }, a.user.id);
    const op10B = (await mfgService.listOperations(orderB.id)).find((op) => op.sequenceNo === 10)!;

    // 10 in stock, each report draws 8.
    const results = await Promise.allSettled([
      mfgService.completeOperation(a.op10.id, { quantityCompleted: 4 }, a.user.id),
      mfgService.completeOperation(op10B.id, { quantityCompleted: 4 }, a.user.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(MaterialShortageError);
    expect(await totalBalance(a.linked.id)).toBe(2);
  });
});

describe("Materialbrist — TO card Slutför order", () => {
  it("warn: refuses the unlinked draw at receipt, books nothing, order stays open", async () => {
    await setMode("warn");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 1, stock: 3 });
    await seedStock(f.linked.id, f.location.id, 10);
    const err = await mfgService.complete(f.order.id, { locationId: f.location.id }, f.user.id).catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.overridable).toBe(true);
    expect(err.shortages[0]).toMatchObject({ articleId: f.unlinked.id, articleName: "Skruv", required: 4, available: 3 });

    const [order] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, f.order.id));
    expect(order!.status).toBe("released");
    expect(order!.quantityReceived).toBe("0.0000");
    expect(await totalBalance(f.parent.id)).toBe(0);
    expect(await consumedFor(f.order.id, f.unlinked.id)).toBe(0);
    expect(await liveReports(f.order.id)).toHaveLength(0);

    const done = await mfgService.complete(f.order.id, { locationId: f.location.id, allowMaterialShortage: true }, f.user.id);
    expect(done.status).toBe("done");
    expect(await totalBalance(f.unlinked.id)).toBe(-1);
  });

  it("block: refuses regardless of the flag; none: proceeds", async () => {
    await setMode("block");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 1, stock: 3 });
    await seedStock(f.linked.id, f.location.id, 10);
    await expect(
      mfgService.complete(f.order.id, { locationId: f.location.id, allowMaterialShortage: true }, f.user.id)
    ).rejects.toThrow(MaterialShortageError);
    expect(await totalBalance(f.parent.id)).toBe(0);

    await setMode("none");
    const done = await mfgService.complete(f.order.id, { locationId: f.location.id }, f.user.id);
    expect(done.status).toBe("done");
    expect(await totalBalance(f.unlinked.id)).toBe(-1);
  });
});

describe("Materialbrist — TO card Förbruka (manual)", () => {
  it("warn without flag refuses and books nothing; with flag draws; block ignores the flag", async () => {
    await setMode("warn");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    const row = (await mfgService.listMaterialConsumptions(f.order.id)).find((r) => r.componentArticleId === f.linked.id)!;

    const err = await mfgService.consumeMaterial(f.order.id, row.id, { locationId: f.location.id, quantity: 5 }, f.user.id).catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.overridable).toBe(true);
    expect(err.shortages).toEqual([
      { articleId: f.linked.id, articleNumber: f.linked.articleNumber, articleName: "Plåt 2 mm", unitCode: "st", required: 5, available: 3 },
    ]);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(0);
    expect(await totalBalance(f.linked.id)).toBe(3);
    expect(await liveReports(f.order.id)).toHaveLength(0);

    await mfgService.consumeMaterial(f.order.id, row.id, { locationId: f.location.id, quantity: 5, allowMaterialShortage: true }, f.user.id);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(5);
    expect(await totalBalance(f.linked.id)).toBe(-2);

    await setMode("block");
    await expect(
      mfgService.consumeMaterial(f.order.id, row.id, { locationId: f.location.id, quantity: 1, allowMaterialShortage: true }, f.user.id)
    ).rejects.toThrow(MaterialShortageError);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(5);
  });

  it("none: draws into negative as before", async () => {
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    const row = (await mfgService.listMaterialConsumptions(f.order.id)).find((r) => r.componentArticleId === f.linked.id)!;
    await mfgService.consumeMaterial(f.order.id, row.id, { locationId: f.location.id, quantity: 5 }, f.user.id);
    expect(await totalBalance(f.linked.id)).toBe(-2);
  });
});

describe("Materialbrist — terminal stamp-out", () => {
  async function stampedIn(f: Awaited<ReturnType<typeof makeOrder>>) {
    const employee = await timeReportService.createEmployee({ employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`, name: "Stämplare", active: true });
    const session = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: f.op10.id }, f.user.id);
    return { employee, session };
  }

  async function sessionState(sessionId: string) {
    const [session] = await db.select().from(stampSessions).where(eq(stampSessions.id, sessionId));
    const reports = await db.select().from(timeReports);
    return { stoppedAt: session!.stoppedAt, timeReports: reports.length };
  }

  it("warn: a refused stamp-out leaves the session OPEN with no time report and nothing reported", async () => {
    await setMode("warn");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    const { session } = await stampedIn(f);
    // The dry run resolves draw locations (creating *** when needed) and
    // books inside a transaction that is always rolled back — nothing of it
    // may survive.
    const footprint = async () =>
      (
        await db.execute<{ locations: number; movements: number }>(
          sql`SELECT (SELECT count(*)::int FROM stock_locations) AS locations, (SELECT count(*)::int FROM stock_transactions) AS movements`
        )
      )[0];
    const before = await footprint();

    const err = await timeReportService.stampOut(session.id, { quantityOk: 4, quantityScrapped: 0 }, f.user.id).catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.overridable).toBe(true);
    expect(await footprint()).toEqual(before);
    expect(err.shortages[0]).toMatchObject({ articleName: "Plåt 2 mm", required: 8, available: 3 });

    expect(await sessionState(session.id)).toEqual({ stoppedAt: null, timeReports: 0 });
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(0);
    expect(await totalBalance(f.linked.id)).toBe(3);
    expect(await liveReports(f.order.id)).toHaveLength(0);
    const [op] = await db.select().from(moOperations).where(eq(moOperations.id, f.op10.id));
    expect(Number(op!.quantityCompleted ?? 0)).toBe(0);

    // Rapportera ändå: the same stamp-out with the flag goes through.
    const out = await timeReportService.stampOut(session.id, { quantityOk: 4, quantityScrapped: 0, allowMaterialShortage: true }, f.user.id);
    expect(out.session.stoppedAt).not.toBeNull();
    expect(await sessionState(session.id)).toMatchObject({ timeReports: 1 });
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(8);
    expect(await totalBalance(f.linked.id)).toBe(-5);
    const [report] = await liveReports(f.order.id);
    expect(report!.timeReportId).toBe(out.timeReport.id);
  });

  it("block: refused before anything is written, flag ignored", async () => {
    await setMode("block");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    const { session } = await stampedIn(f);
    const err = await timeReportService
      .stampOut(session.id, { quantityOk: 4, quantityScrapped: 0, allowMaterialShortage: true }, f.user.id)
      .catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.overridable).toBe(false);
    expect(await sessionState(session.id)).toEqual({ stoppedAt: null, timeReports: 0 });
    expect(await totalBalance(f.linked.id)).toBe(3);
  });

  it("block: a stamp-out that draws nothing (0/0, or covered) is never refused", async () => {
    await setMode("block");
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 0 });
    const { session } = await stampedIn(f);
    const out = await timeReportService.stampOut(session.id, { quantityOk: 0, quantityScrapped: 0 }, f.user.id);
    expect(out.session.stoppedAt).not.toBeNull();
    expect(await liveReports(f.order.id)).toHaveLength(1);

    await seedStock(f.linked.id, f.location.id, 8);
    const { session: second } = await stampedIn(f);
    await timeReportService.stampOut(second.id, { quantityOk: 4, quantityScrapped: 0, markOperationDone: true }, f.user.id);
    expect(await consumedFor(f.order.id, f.linked.id)).toBe(8);
    const [op] = await db.select().from(moOperations).where(eq(moOperations.id, f.op10.id));
    expect(op!.status).toBe("done");
  });

  it("none: identical to today — the stamp-out draws into negative stock", async () => {
    const f = await makeOrder({ quantity: 4, componentPerUnit: 2, stock: 3 });
    const { session } = await stampedIn(f);
    await timeReportService.stampOut(session.id, { quantityOk: 4, quantityScrapped: 0 }, f.user.id);
    expect(await totalBalance(f.linked.id)).toBe(-5);
    expect(await sessionState(session.id)).toMatchObject({ timeReports: 1 });
  });
});

describe("Materialbrist — lego purchase receipt", () => {
  // Parent whose LAST operation is bought (lego); the component is linked to
  // it, so the receipt's report draws 2/st and receives the goods.
  async function makeLegoOrder(opts: { quantity?: number; stock?: number } = {}) {
    const { quantity = 4, stock = 3 } = opts;
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "Lego AB", active: true });
    const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
    const lego = await mfgService.createWorkCenter({ code: "900", name: "Ytbehandling AB", type: "subcontract", supplierId: supplier.id, active: true });
    const parent = await articleService.createArticle({
      articleNumber: `LEGO-${crypto.randomUUID().slice(0, 8)}`,
      name: "Legodetalj",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const component = await makeComponent("Plåt 2 mm");
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
    const legoRouting = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0, unitPrice: 100 });
    await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, routingOperationId: legoRouting.id });
    const location = await makeLocation("L1");
    if (stock > 0) await seedStock(component.id, location.id, stock);

    const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity }, user.id);
    const legoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const row = await purchaseService.addRow(order.id, { articleId: parent.id, quantity, unitPrice: 100, moOperationId: legoOp.id });
    await purchaseService.confirm(order.id);
    return { user, parent, component, location, mo, legoOp, order, row };
  }

  async function rowReceived(orderId: string) {
    return Number((await purchaseService.listRows(orderId))[0]!.quantityReceived);
  }

  it("warn: the preflight refuses BEFORE the receipt — nothing is booked", async () => {
    await setMode("warn");
    const f = await makeLegoOrder({ quantity: 4, stock: 3 });
    const err = await purchaseService.receiveGoods(f.order.id, f.row.id, { locationId: f.location.id, quantity: 4 }, f.user.id).catch((e) => e);
    expect(err).toBeInstanceOf(MaterialShortageError);
    expect(err.overridable).toBe(true);
    expect(err.shortages).toEqual([
      { articleId: f.component.id, articleNumber: f.component.articleNumber, articleName: "Plåt 2 mm", unitCode: "st", required: 8, available: 3 },
    ]);

    expect(await rowReceived(f.order.id)).toBe(0);
    expect(await purchaseService.listReceipts(f.order.id)).toHaveLength(0);
    expect(await totalBalance(f.parent.id)).toBe(0);
    expect(await totalBalance(f.component.id)).toBe(3);
    expect(await liveReports(f.mo.id)).toHaveLength(0);
    const [op] = await db.select().from(moOperations).where(eq(moOperations.id, f.legoOp.id));
    expect(Number(op!.quantityCompleted ?? 0)).toBe(0);
  });

  it("warn: with the flag the receipt and the report go through", async () => {
    await setMode("warn");
    const f = await makeLegoOrder({ quantity: 4, stock: 3 });
    const result = await purchaseService.receiveGoods(
      f.order.id,
      f.row.id,
      { locationId: f.location.id, quantity: 4, allowMaterialShortage: true },
      f.user.id
    );
    expect(result.operationReport).toEqual({ ok: true });
    expect(await rowReceived(f.order.id)).toBe(4);
    expect(await totalBalance(f.component.id)).toBe(-5);
    const [receipt] = await purchaseService.listReceipts(f.order.id);
    expect(receipt!.moReportId).not.toBeNull();
  });

  it("warn: a receipt the stock covers passes the preflight and reports", async () => {
    await setMode("warn");
    const f = await makeLegoOrder({ quantity: 4, stock: 8 });
    const result = await purchaseService.receiveGoods(f.order.id, f.row.id, { locationId: f.location.id, quantity: 4 }, f.user.id);
    expect(result.operationReport).toEqual({ ok: true });
    expect(await totalBalance(f.component.id)).toBe(0);
  });

  it("block: no preflight — the receipt stands and the refused report is the operationReport warning", async () => {
    await setMode("block");
    const f = await makeLegoOrder({ quantity: 4, stock: 3 });
    const result = await purchaseService.receiveGoods(
      f.order.id,
      f.row.id,
      { locationId: f.location.id, quantity: 4, allowMaterialShortage: true },
      f.user.id
    );
    expect(result.operationReport).toEqual({
      ok: false,
      message: "Det finns inte tillräckligt med ingående delar: Plåt 2 mm (behöver 8 st, tillgängligt 3 st)",
    });
    expect(await rowReceived(f.order.id)).toBe(4);
    expect(result.orderStatus).toBe("received");
    // The TO side is untouched and the receipt has no report to undo.
    expect(await totalBalance(f.component.id)).toBe(3);
    expect(await liveReports(f.mo.id)).toHaveLength(0);
    const [receipt] = await purchaseService.listReceipts(f.order.id);
    expect(receipt!.moReportId).toBeNull();
  });

  it("none: identical to today — receipt and report, stock goes negative", async () => {
    const f = await makeLegoOrder({ quantity: 4, stock: 3 });
    const result = await purchaseService.receiveGoods(f.order.id, f.row.id, { locationId: f.location.id, quantity: 4 }, f.user.id);
    expect(result.operationReport).toEqual({ ok: true });
    expect(await totalBalance(f.component.id)).toBe(-5);
  });
});
