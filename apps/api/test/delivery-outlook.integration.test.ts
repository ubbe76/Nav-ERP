import { createArticleSchema, createStockLocationSchema, createWeekScheduleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, purchaseOrderRows, purchaseOrders, salesOrderRows, salesOrders, suppliers } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createPlanningService, SalesOrderNotFoundError, type ManufacturingPlanReader } from "../src/modules/planning/service/planning.service.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Leveransläge (planeringsverktyget etapp 3) against Postgres: the kundorder
// row's outlook is the pegging's answer for the demand `so:<rowId>` — the
// same allocation the TO card's Går till shows from the other side — plus
// the customer's delivery days, Halvfabrikat sent and, for a configured row,
// its own linked TOs. "Today" is pinned to Monday 2030-03-04 like
// pegging.integration.test.ts.
const W1 = "2030-03-04";
const W4 = "2030-03-25";
const TODAY = W1;

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const stockService = createStockService(createStockRepository(db));

// The same late binding as app.ts.
const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
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
  undefined,
  {
    planNewOrderInTx: (tx, moId, given, opts) => planReaderRef.current!.planNewOrderInTx(tx, moId, given, opts),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
    componentLateOrders: (ids) => planReaderRef.current!.componentLateOrders!(ids),
  }
);
// Without a plan reader: its TOs are unplanned (ready on their due date) and
// its list/card never say Halvfabrikat sent.
const unplannedMfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
  isDateLocked: async () => false,
});
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: {
    createPurchaseOrder: async () => {
      throw new Error("not used");
    },
    addRow: async () => {},
    cancel: async () => {},
  },
  manufacturing: mfgService,
  requirementsCacheMs: 0,
  today: () => TODAY,
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE mo_operation_plan_days, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;
const CLEAR_FREIGHT = sql`DELETE FROM system_settings WHERE key = 'freight_article_id'`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(CLEAR_FREIGHT);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(CLEAR_FREIGHT);
});

// Two resources on a 40 h week; the product P (Ledtid 5 working days, Op 10
// on R2) is made of one halvfabrikat H (Op 10 on R1, 60 min/st) which is
// made of one raw material R (purchased).
async function seedWorld() {
  const user = await authRepo.create({
    email: `outlook-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Planerare",
    role: "admin",
  });
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule(parsed(createWeekScheduleSchema, {
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  }));
  const r1 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "101", name: "Kap", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const r2 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "201", name: "Montering", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const suffix = crypto.randomUUID().slice(0, 8);
  const raw = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `R-${suffix}`, name: "Råvara", type: "purchased", active: true }));
  const semi = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `H-${suffix}`, name: "Halvfabrikat", type: "manufactured", active: true }));
  const product = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `P-${suffix}`,
    name: "Produkt",
    type: "manufactured",
    active: true,
    manufacturingLeadTimeDays: 5,
  }));
  await mfgService.createRoutingOperation(semi.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  await articleService.addBomComponent(semi.id, { componentArticleId: raw.id, quantity: 1 });
  await articleService.addBomComponent(product.id, { componentArticleId: semi.id, quantity: 1 });
  return { user, r1, r2, raw, semi, product };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

const suffix = () => crypto.randomUUID().slice(0, 8);

async function customer(delivery: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db.insert(customers).values({ customerNumber: `K${suffix()}`, name: "Kund AB", ...delivery }).returning();
  return row!;
}

// A kundorder written straight into the tables (the outlook only reads).
type RowInput = { articleId: string; quantity: number; delivered?: number; date?: string | null; configuration?: unknown; setupFor?: string };
async function salesOrder(
  status: "quote" | "confirmed" | "in_production" | "delivered",
  headDate: string | null,
  rows: RowInput[],
  customerId?: string
) {
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-${suffix()}`, customerId: customerId ?? (await customer()).id, status, expectedDeliveryDate: headDate })
    .returning();
  const rowIds: string[] = [];
  for (const [i, row] of rows.entries()) {
    const [inserted] = await db
      .insert(salesOrderRows)
      .values({
        salesOrderId: order!.id,
        articleId: row.articleId,
        quantityOrdered: String(row.quantity),
        quantityDelivered: String(row.delivered ?? 0),
        unitPrice: "100",
        expectedDeliveryDate: row.date ?? null,
        configuration: row.configuration ?? null,
        setupForRowId: row.setupFor ?? null,
        // The card's row order is created_at, then id.
        createdAt: new Date(Date.UTC(2030, 0, 1, 12, 0, i)),
      })
      .returning();
    rowIds.push(inserted!.id);
  }
  return { ...order!, rowIds };
}

async function purchaseOrder(articleId: string, quantity: number, date: string | null, status: "draft" | "confirmed" = "confirmed") {
  const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L${suffix()}`, name: "Leverantör AB" }).returning();
  const [po] = await db
    .insert(purchaseOrders)
    .values({ orderNumber: `IO-${suffix()}`, supplierId: supplier!.id, status, expectedDeliveryDate: date })
    .returning();
  await db.insert(purchaseOrderRows).values({ purchaseOrderId: po!.id, articleId, quantityOrdered: String(quantity), quantityReceived: "0", unitPrice: "10" });
  return po!;
}

async function addStock(articleId: string, quantity: number, blocked = false) {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${suffix()}`, active: true });
  const place = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: blocked ? "Karantän" : "A1", active: true, blocked }));
  await stockService.recordTransaction({ articleId, locationId: place.id, quantityDelta: quantity, transactionType: "inventory_adjustment" });
}

const outlook = (salesOrderId: string) => planningService.getSalesOrderDeliveryOutlook(salesOrderId);

describe("a kundorder row covered by a TO", () => {
  it("gives the same answer as the TO card's Går till for the same allocation", async () => {
    const world = await seedWorld();
    // Promised Fri 2030-03-22, a customer without delivery settings ⇒ it
    // must leave that day. The TO is unplanned ⇒ ready on its due date, Wed
    // 2030-03-27: three working days late.
    const order = await salesOrder("confirmed", "2030-03-22", [{ articleId: world.product.id, quantity: 2 }]);
    const mo = await unplannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);

    const result = await outlook(order.id);
    expect(result).toMatchObject({
      salesOrderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: "confirmed",
      today: TODAY,
      status: "late",
      daysLate: 3,
      atRisk: true,
      promisedDate: "2030-03-22",
      // Late ⇒ the day the goods reach the customer when they leave on the ready day.
      estimatedDeliveryDate: "2030-03-27",
      counts: { late: 1, uncovered: 0, undated: 0, componentLate: 0 },
    });
    expect(result.rows).toEqual([
      {
        salesOrderRowId: order.rowIds[0],
        articleId: world.product.id,
        articleNumber: world.product.articleNumber,
        articleName: "Produkt",
        restQuantity: 2,
        configured: false,
        promisedDate: "2030-03-22",
        promisedShipDate: "2030-03-22",
        allocations: [
          { kind: "manufacturing_order", documentId: mo.id, documentNumber: mo.orderNumber, quantity: 2, readyDate: "2030-03-27", late: true, undated: false, daysLate: 3, isDraft: false, componentLate: false },
        ],
        uncovered: 0,
        readyDate: "2030-03-27",
        estimatedShipDate: "2030-03-27",
        estimatedDeliveryDate: "2030-03-27",
        status: "late",
        daysLate: 3,
        componentLate: false,
        overdue: false,
        atRisk: true,
      },
    ]);

    // The other side of the same allocation.
    const [goesTo] = (await planningService.getManufacturingOrderCoverage(mo.id)).goesTo;
    const [allocation] = result.rows[0]!.allocations;
    expect(goesTo).toMatchObject({ kind: "sales_order", documentId: order.id, documentNumber: order.orderNumber });
    expect({ needDate: result.rows[0]!.promisedShipDate, quantity: allocation!.quantity, late: allocation!.late, daysLate: allocation!.daysLate }).toEqual({
      needDate: goesTo!.needDate,
      quantity: goesTo!.quantity,
      late: goesTo!.late,
      daysLate: goesTo!.daysLate,
    });
    expect(await planningService.deliveryRiskOrderIds()).toEqual([order.id]);
  });

  it("is on time while the plan finishes it by the ship date; Flytta to a later day makes the row Sen", async () => {
    const world = await seedWorld();
    const order = await salesOrder("in_production", "2030-03-22", [{ articleId: world.product.id, quantity: 2 }]);
    // Planned today (free capacity) ⇒ ready 2030-03-04.
    const mo = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-20" }, world.user.id);
    const [op10] = await mfgService.listOperations(mo.id);
    expect(op10).toMatchObject({ plannedStartDate: W1, plannedEndDate: W1 });

    let result = await outlook(order.id);
    expect(result).toMatchObject({ status: "on_time", daysLate: 0, atRisk: false, estimatedDeliveryDate: "2030-03-22" });
    // On time ⇒ the promised dates, never an earlier one nobody promised (S17).
    expect(result.rows[0]).toMatchObject({ status: "on_time", readyDate: "2030-03-04", estimatedShipDate: "2030-03-22", estimatedDeliveryDate: "2030-03-22" });
    expect(await planningService.deliveryRiskOrderIds()).toEqual([]);

    // Monday of W4, 2030-03-25: one working day after the ship date.
    await planningService.moveOperation(op10!.id, { date: W4, moveFollowing: false }, world.user.id);
    result = await outlook(order.id);
    expect(result).toMatchObject({ status: "late", daysLate: 1, atRisk: true, estimatedDeliveryDate: "2030-03-25" });
    expect(result.rows[0]!.allocations[0]).toMatchObject({ documentId: mo.id, readyDate: "2030-03-25", late: true, daysLate: 1 });
    const [goesTo] = (await planningService.getManufacturingOrderCoverage(mo.id)).goesTo;
    expect(goesTo).toMatchObject({ documentId: order.id, late: true, daysLate: 1 });
  });

  it("ready ON the ship date is on time (S16), and a row without a promised date is never late", async () => {
    const world = await seedWorld();
    const dated = await salesOrder("confirmed", "2030-03-27", [{ articleId: world.product.id, quantity: 1 }]);
    const undatedOrder = await salesOrder("confirmed", null, [{ articleId: world.raw.id, quantity: 1 }]);
    await unplannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 1, dueDate: "2030-03-27" }, world.user.id);
    await purchaseOrder(world.raw.id, 1, "2030-06-28");

    expect((await outlook(dated.id)).rows[0]).toMatchObject({ status: "on_time", readyDate: "2030-03-27", daysLate: 0 });
    const undated = await outlook(undatedOrder.id);
    expect(undated).toMatchObject({ status: "on_time", atRisk: false, promisedDate: null, estimatedDeliveryDate: null });
    expect(undated.rows[0]).toMatchObject({ status: "on_time", promisedDate: null, promisedShipDate: null, readyDate: "2030-06-28", overdue: false });
  });

  it("Halvfabrikat sent on the covering TO puts the row at risk although it is on time", async () => {
    const world = await seedWorld();
    // The product TO is planned in W1 and due Fri W4 (its material is needed
    // on 2030-03-22); the halvfabrikat TO is unplanned and ready only on
    // 2030-03-27 — Halvfabrikat sent on the product TO.
    const order = await salesOrder("confirmed", "2030-03-29", [{ articleId: world.product.id, quantity: 2 }]);
    const parent = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    expect((await planningService.getManufacturingOrderCoverage(parent.id)).componentLate).toBe(true);

    const result = await outlook(order.id);
    expect(result).toMatchObject({ status: "on_time", daysLate: 0, atRisk: true, counts: { late: 0, uncovered: 0, undated: 0, componentLate: 1 } });
    expect(result.rows[0]).toMatchObject({ status: "on_time", componentLate: true, atRisk: true });
    expect(result.rows[0]!.allocations).toEqual([expect.objectContaining({ documentId: parent.id, late: false, componentLate: true })]);
    expect(await planningService.deliveryRiskOrderIds()).toEqual([order.id]);
  });
});

describe("what covers the row, in the pegging's order", () => {
  it("stock first, then the inköpsorder, then the TO; a draft IO is marked; what nothing covers is Saknar täckning", async () => {
    const world = await seedWorld();
    await addStock(world.semi.id, 2);
    const po = await purchaseOrder(world.semi.id, 3, "2030-03-11", "draft");
    const mo = await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 5, dueDate: "2030-03-15" }, world.user.id);
    const order = await salesOrder("confirmed", "2030-03-22", [{ articleId: world.semi.id, quantity: 12 }]);

    const result = await outlook(order.id);
    expect(result).toMatchObject({ status: "uncovered", atRisk: true, estimatedDeliveryDate: null, counts: { late: 0, uncovered: 1, undated: 0, componentLate: 0 } });
    const [row] = result.rows;
    expect(row).toMatchObject({ restQuantity: 12, uncovered: 2, status: "uncovered", readyDate: null, estimatedShipDate: null, estimatedDeliveryDate: null, atRisk: true });
    expect(row!.allocations).toEqual([
      { kind: "stock", documentId: null, documentNumber: null, quantity: 2, readyDate: TODAY, late: false, undated: false, daysLate: 0, isDraft: false, componentLate: false },
      { kind: "purchase_order", documentId: po.id, documentNumber: po.orderNumber, quantity: 3, readyDate: "2030-03-11", late: false, undated: false, daysLate: 0, isDraft: true, componentLate: false },
      { kind: "manufacturing_order", documentId: mo.id, documentNumber: mo.orderNumber, quantity: 5, readyDate: "2030-03-15", late: false, undated: false, daysLate: 0, isDraft: false, componentLate: false },
    ]);
  });

  it("a fully covered row is on time, a partly delivered row asks only for its rest, and an undated IO is Tillgång utan datum — not at risk", async () => {
    const world = await seedWorld();
    await addStock(world.raw.id, 6);
    const po = await purchaseOrder(world.semi.id, 4, null);
    const order = await salesOrder("confirmed", "2030-03-22", [
      { articleId: world.raw.id, quantity: 10, delivered: 4 },
      { articleId: world.semi.id, quantity: 4 },
    ]);

    const result = await outlook(order.id);
    expect(result).toMatchObject({ status: "undated", atRisk: false, estimatedDeliveryDate: null, counts: { late: 0, uncovered: 0, undated: 1, componentLate: 0 } });
    expect(result.rows.map((r) => r.salesOrderRowId)).toEqual(order.rowIds);
    expect(result.rows[0]).toMatchObject({ restQuantity: 6, status: "on_time", readyDate: TODAY, uncovered: 0, estimatedDeliveryDate: "2030-03-22" });
    expect(result.rows[1]).toMatchObject({ status: "undated", readyDate: null, atRisk: false });
    expect(result.rows[1]!.allocations).toEqual([expect.objectContaining({ kind: "purchase_order", documentId: po.id, readyDate: null, undated: true, late: false })]);
    expect(await planningService.deliveryRiskOrderIds()).toEqual([]);
  });

  it("stock on a Spärrad lagerplats covers nothing", async () => {
    const world = await seedWorld();
    await addStock(world.raw.id, 10, true);
    const order = await salesOrder("confirmed", "2030-03-22", [{ articleId: world.raw.id, quantity: 3 }]);
    expect((await outlook(order.id)).rows[0]).toMatchObject({ status: "uncovered", uncovered: 3, allocations: [] });
  });

  it("two orders share the supply first come, first served — in one read", async () => {
    const world = await seedWorld();
    await addStock(world.raw.id, 5);
    const early = await salesOrder("confirmed", "2030-03-11", [{ articleId: world.raw.id, quantity: 4 }]);
    const late = await salesOrder("confirmed", "2030-03-18", [{ articleId: world.raw.id, quantity: 4 }]);
    const all = await planningService.deliveryOutlooks("open");
    expect(all.get(early.id)!.outlook.status).toBe("on_time");
    expect(all.get(late.id)!.rows[0]).toMatchObject({ status: "uncovered", uncovered: 3 });
    expect(all.get(late.id)!.order).toEqual({
      salesOrderId: late.id,
      orderNumber: late.orderNumber,
      orderStatus: "confirmed",
      customerId: late.customerId,
      customerName: "Kund AB",
      promisedDate: "2030-03-18",
    });
    expect(await planningService.deliveryRiskOrderIds()).toEqual([late.id]);
    // By id the answer is the same, and an unknown id is simply absent.
    const some = await planningService.deliveryOutlooks([late.id, crypto.randomUUID()]);
    expect([...some.keys()]).toEqual([late.id]);
    expect(some.get(late.id)).toEqual(all.get(late.id));
  });
});

describe("the customer's fixed delivery days", () => {
  it("move the ship date (shipDateFor) and the estimated delivery (deliveryFromShipDate)", async () => {
    const world = await seedWorld();
    // Receives on Fridays, two transport days: promised Fri 2030-03-22 ⇒
    // must leave Wed 2030-03-20.
    const k = await customer({ deliveryDayMode: "arrival", transitDays: 2, deliveryWeekdays: [5] });
    const order = await salesOrder("confirmed", "2030-03-22", [{ articleId: world.product.id, quantity: 2 }], k.id);
    // Ready Thu 2030-03-21: before the promised date, but one working day
    // after the ship date.
    const mo = await unplannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-21" }, world.user.id);

    const result = await outlook(order.id);
    const [row] = result.rows;
    expect(row).toMatchObject({ promisedDate: "2030-03-22", promisedShipDate: "2030-03-20", status: "late", daysLate: 1, readyDate: "2030-03-21", estimatedShipDate: "2030-03-21" });
    // Leaves Thu 21 + two transport days = Mon 25 ⇒ the next Friday.
    expect(row!.estimatedDeliveryDate).toBe("2030-03-29");
    expect(result).toMatchObject({ status: "late", daysLate: 1, promisedDate: "2030-03-22", estimatedDeliveryDate: "2030-03-29" });
    // Går till reads the same ship date as its need date.
    expect((await planningService.getManufacturingOrderCoverage(mo.id)).goesTo[0]).toMatchObject({ needDate: "2030-03-20", late: true, daysLate: 1 });
  });

  it("a customer without delivery settings: a late row leaves and arrives on the ready day's next working day", async () => {
    const world = await seedWorld();
    const order = await salesOrder("confirmed", "2030-03-20", [{ articleId: world.raw.id, quantity: 1 }]);
    // Arrives Sat 2030-03-23 — the Leveranstidskontroll's last step for a
    // customer without settings is the next working day.
    await purchaseOrder(world.raw.id, 1, "2030-03-23");
    expect((await outlook(order.id)).rows[0]).toMatchObject({ status: "late", readyDate: "2030-03-23", daysLate: 2, estimatedShipDate: "2030-03-23", estimatedDeliveryDate: "2030-03-25" });
  });
});

describe("a configured row (beställningsvara)", () => {
  const CONFIGURATION = { key: "k1", selection: [], labels: [] };
  // A TO linked to the row, moved to the given state (the outlook only reads).
  async function linkedOrder(world: World, rowId: string, quantity: number, dueDate: string, state: { status?: string; received?: number } = {}) {
    const mo = await unplannedMfgService.createManufacturingOrder({ articleId: world.product.id, quantity, dueDate }, world.user.id);
    await db.execute(
      sql`UPDATE manufacturing_orders SET sales_order_row_id = ${rowId}, status = ${state.status ?? "released"}::manufacturing_order_status, quantity_received = ${state.received ?? 0} WHERE id = ${mo.id}`
    );
    return mo;
  }

  it("reads its own linked TOs — finished units are there now, the open TO covers the rest, the remainder is uncovered", async () => {
    const world = await seedWorld();
    // Stock and a free TO of the template article are other configurations'.
    await addStock(world.product.id, 50);
    const order = await salesOrder("in_production", "2030-03-22", [{ articleId: world.product.id, quantity: 5, delivered: 1, configuration: CONFIGURATION }]);
    await linkedOrder(world, order.rowIds[0]!, 2, "2030-03-01", { status: "done", received: 2 });
    const open = await linkedOrder(world, order.rowIds[0]!, 2, "2030-03-27");
    await linkedOrder(world, order.rowIds[0]!, 9, "2030-03-08", { status: "cancelled" });

    const result = await outlook(order.id);
    const [row] = result.rows;
    // Rest 4: one finished and not yet delivered, two on the open TO (three
    // working days after the ship date), one that nothing makes.
    expect(row).toMatchObject({ configured: true, restQuantity: 4, uncovered: 1, status: "uncovered", daysLate: 3, readyDate: null, atRisk: true });
    expect(row!.allocations).toEqual([
      { kind: "stock", documentId: null, documentNumber: null, quantity: 1, readyDate: TODAY, late: false, undated: false, daysLate: 0, isDraft: false, componentLate: false },
      { kind: "manufacturing_order", documentId: open.id, documentNumber: open.orderNumber, quantity: 2, readyDate: "2030-03-27", late: true, undated: false, daysLate: 3, isDraft: false, componentLate: false },
    ]);
    expect(result).toMatchObject({ status: "uncovered", atRisk: true });
  });

  it("is on time on its TO's planned finish, Sen when the TO is ready after the customer's ship date, and carries Halvfabrikat sent", async () => {
    const world = await seedWorld();
    const k = await customer({ deliveryDayMode: "arrival", transitDays: 1 });
    const order = await salesOrder(
      "in_production",
      "2030-03-29",
      [
        { articleId: world.product.id, quantity: 2, configuration: CONFIGURATION },
        { articleId: world.product.id, quantity: 1, date: "2030-03-22", configuration: CONFIGURATION },
      ],
      k.id
    );
    // Row 1: a planned TO (W1) due on the promised day, with a late
    // halvfabrikat TO under it.
    const planned = await mfgService.createManufacturingOrder({ articleId: world.product.id, quantity: 2, dueDate: "2030-03-29" }, world.user.id);
    await db.execute(sql`UPDATE manufacturing_orders SET sales_order_row_id = ${order.rowIds[0]!} WHERE id = ${planned.id}`);
    await unplannedMfgService.createManufacturingOrder({ articleId: world.semi.id, quantity: 2, dueDate: "2030-03-27" }, world.user.id);
    // Row 2: promised Fri 22 ⇒ must leave Thu 21; its TO is ready Fri 22
    // (and waits for the same late halvfabrikat TO).
    const lateOrder = await linkedOrder(world, order.rowIds[1]!, 1, "2030-03-22");

    const result = await outlook(order.id);
    expect(result.rows[0]).toMatchObject({ configured: true, promisedShipDate: "2030-03-28", status: "on_time", readyDate: W1, componentLate: true, atRisk: true, estimatedDeliveryDate: "2030-03-29" });
    expect(result.rows[0]!.allocations).toEqual([expect.objectContaining({ documentId: planned.id, quantity: 2, readyDate: W1, late: false, componentLate: true })]);
    expect(result.rows[1]).toMatchObject({ promisedDate: "2030-03-22", promisedShipDate: "2030-03-21", status: "late", daysLate: 1, readyDate: "2030-03-22", estimatedDeliveryDate: "2030-03-25" });
    expect(result.rows[1]!.allocations).toEqual([expect.objectContaining({ documentId: lateOrder.id, late: true, daysLate: 1 })]);
    expect(result).toMatchObject({ status: "late", daysLate: 1, atRisk: true, estimatedDeliveryDate: "2030-03-29", counts: { late: 1, uncovered: 0, undated: 0, componentLate: 2 } });
  });
});

describe("what has no outlook", () => {
  it("a quote and a delivered order answer none without rows; an unknown order is 404", async () => {
    const world = await seedWorld();
    const quote = await salesOrder("quote", "2030-03-22", [{ articleId: world.product.id, quantity: 2 }]);
    const delivered = await salesOrder("delivered", "2030-03-22", [{ articleId: world.product.id, quantity: 2, delivered: 2 }]);
    for (const order of [quote, delivered]) {
      expect(await outlook(order.id)).toEqual({
        salesOrderId: order.id,
        orderNumber: order.orderNumber,
        orderStatus: order.status,
        today: TODAY,
        status: "none",
        daysLate: 0,
        atRisk: false,
        promisedDate: "2030-03-22",
        estimatedDeliveryDate: null,
        counts: { late: 0, uncovered: 0, undated: 0, componentLate: 0 },
        rows: [],
      });
    }
    // A quote is no demand: nothing is at risk and "open" does not list it.
    expect(await planningService.deliveryRiskOrderIds()).toEqual([]);
    expect((await planningService.deliveryOutlooks("open")).size).toBe(0);
    await expect(outlook(crypto.randomUUID())).rejects.toBeInstanceOf(SalesOrderNotFoundError);
  });

  it("a delivered row, a tjänsteartikel, the freight row and a ställkostnad row have no outlook", async () => {
    const world = await seedWorld();
    const article = (number: string, type: "service" | "purchased") =>
      articleService.createArticle(parsed(createArticleSchema, { articleNumber: `${number}-${suffix()}`, name: number, type, active: true }));
    const service = await article("TJANST", "service");
    const freight = await article("FRAKT", "purchased");
    const setup = await article("STALL", "purchased");
    await db.execute(sql`INSERT INTO system_settings (key, value) VALUES ('freight_article_id', ${freight.id})`);
    await addStock(world.raw.id, 5);
    const order = await salesOrder("confirmed", "2030-03-22", [
      { articleId: world.raw.id, quantity: 2 },
      { articleId: world.raw.id, quantity: 3, delivered: 3 },
      { articleId: service.id, quantity: 1 },
      { articleId: freight.id, quantity: 1 },
    ]);
    await db.insert(salesOrderRows).values({ salesOrderId: order.id, articleId: setup.id, quantityOrdered: "1", unitPrice: "500", setupForRowId: order.rowIds[0]! });

    const result = await outlook(order.id);
    expect(result.rows.map((r) => r.salesOrderRowId)).toEqual([order.rowIds[0]]);
    expect(result).toMatchObject({ status: "on_time", atRisk: false });
  });
});
