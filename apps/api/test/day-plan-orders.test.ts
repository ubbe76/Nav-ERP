import { createArticleSchema, createStockLocationSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, customers, db, holidays, moOperations, purchaseOrderRows, purchaseOrders, salesOrderRows, salesOrders, suppliers, units } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createPlanningService, DayPlanDateOutOfRangeError, type ManufacturingPlanReader } from "../src/modules/planning/service/planning.service.js";
import {
  dayPlanArrivals,
  dayPlanOrderSpan,
  dayPlanShipments,
  onOrderSpan,
  type DayPlanArrivalLoad,
} from "../src/modules/planning/service/day-plan-orders.js";
import type { OutlookOrderHead, OutlookRow } from "../src/modules/planning/service/delivery-outlook.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Dagplanens Utleveranser och Inleveranser (GET /planning/day-plan/orders):
// the kundorder rows to ship and the inköpsorder rows to arrive ONE day.
// Nothing of its own — the ship date and the readiness are the
// Leveransläge's (delivery-outlook.integration.test.ts), the arrival date the
// effective one (effective-dates.ts). "Today" is pinned to Monday 2030-03-04.
const TODAY = "2030-03-04";

describe("the day's span (pure)", () => {
  const none = new Set<string>();

  it("is the day itself on a working day before another working day", () => {
    expect(dayPlanOrderSpan(TODAY, "2030-03-05", none)).toEqual({ today: TODAY, date: "2030-03-05", through: "2030-03-05" });
  });

  it("takes in the weekend on a Friday and a holiday the day before it", () => {
    expect(dayPlanOrderSpan(TODAY, "2030-03-08", none).through).toBe("2030-03-10");
    expect(dayPlanOrderSpan(TODAY, "2030-03-11", new Set(["2030-03-12"])).through).toBe("2030-03-12");
  });

  it("lists what has passed only on today's list, and never an undated row", () => {
    const today = dayPlanOrderSpan(TODAY, TODAY, none);
    const later = dayPlanOrderSpan(TODAY, "2030-03-06", none);
    expect(onOrderSpan("2030-02-20", today)).toBe(true);
    expect(onOrderSpan(TODAY, today)).toBe(true);
    expect(onOrderSpan("2030-03-05", today)).toBe(false);
    expect(onOrderSpan("2030-03-05", later)).toBe(false);
    expect(onOrderSpan("2030-03-06", later)).toBe(true);
    expect(onOrderSpan(null, today)).toBe(false);
  });

  const head = (orderNumber: string): OutlookOrderHead => ({
    salesOrderId: `id-${orderNumber}`,
    orderNumber,
    orderStatus: "confirmed",
    customerId: "c",
    customerName: "Kund AB",
    promisedDate: null,
  });
  const row = (id: string, shipDate: string | null): OutlookRow => ({
    salesOrderRowId: id,
    articleId: "a",
    articleNumber: "A-1",
    articleName: "Beslag",
    restQuantity: 2,
    configured: false,
    promisedDate: shipDate,
    promisedShipDate: shipDate,
    allocations: [],
    uncovered: 2,
    readyDate: null,
    estimatedShipDate: null,
    estimatedDeliveryDate: null,
    status: "uncovered",
    daysLate: 0,
    componentLate: false,
    overdue: false,
    atRisk: true,
  });

  it("sorts the shipments on the ship date, then the order number — an order's rows in the card's order", () => {
    const span = dayPlanOrderSpan(TODAY, TODAY, none);
    const list = dayPlanShipments(
      [
        { order: head("KO-2"), rows: [row("r3", TODAY), row("r4", "2030-03-01")] },
        { order: head("KO-1"), rows: [row("r2", TODAY), row("r1", TODAY), row("r5", "2030-03-05")] },
      ],
      span,
      new Map([["a", "st"]])
    );
    expect(list.map((s) => s.salesOrderRowId)).toEqual(["r4", "r2", "r1", "r3"]);
    expect(list.map((s) => s.overdue)).toEqual([true, false, false, false]);
    expect(list[0]).toMatchObject({ key: "so:r4", orderNumber: "KO-2", unit: "st", shipDate: "2030-03-01", status: "uncovered" });
  });

  const arrival = (over: Partial<DayPlanArrivalLoad>): DayPlanArrivalLoad => ({
    purchaseOrderId: "po",
    orderNumber: "IO-1",
    orderStatus: "confirmed",
    supplierName: "Leverantör AB",
    purchaseOrderRowId: "pr",
    articleId: "a",
    articleNumber: "A-1",
    articleName: "Beslag",
    unit: "st",
    quantityOrdered: 10,
    quantityReceived: 4,
    arrivalDate: TODAY,
    confirmed: true,
    lego: null,
    ...over,
  });

  it("gives the arrivals their rest and drops a row with nothing left", () => {
    const list = dayPlanArrivals(
      [
        arrival({ purchaseOrderRowId: "b", orderNumber: "IO-2" }),
        arrival({ purchaseOrderRowId: "a", orderNumber: "IO-1", arrivalDate: "2030-02-28" }),
        arrival({ purchaseOrderRowId: "c", quantityReceived: 10 }),
        arrival({ purchaseOrderRowId: "d", arrivalDate: "2030-03-05" }),
      ],
      dayPlanOrderSpan(TODAY, TODAY, none)
    );
    expect(list.map((a) => [a.key, a.restQuantity, a.overdue])).toEqual([
      ["po:a", 6, true],
      ["po:b", 6, false],
    ]);
  });
});

// --- Against Postgres -------------------------------------------------------

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const stockService = createStockService(createStockRepository(db));
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
const unplannedMfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
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

const TRUNCATE = sql`TRUNCATE mo_operation_plan_days, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const suffix = () => crypto.randomUUID().slice(0, 8);

async function article(type: "purchased" | "manufactured" | "service" = "purchased") {
  return articleService.createArticle(parsed(createArticleSchema, { articleNumber: `A-${suffix()}`, name: "Beslag", type, active: true }));
}
async function unitCodeOf(articleId: string) {
  const [row] = await db.select({ code: units.code }).from(articles).innerJoin(units, eq(units.id, articles.unitId)).where(eq(articles.id, articleId));
  return row!.code;
}
async function addStock(articleId: string, quantity: number) {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${suffix()}`, active: true });
  const place = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
  await stockService.recordTransaction({ articleId, locationId: place.id, quantityDelta: quantity, transactionType: "inventory_adjustment" });
}
async function customer(delivery: Partial<typeof customers.$inferInsert> = {}) {
  const [row] = await db.insert(customers).values({ customerNumber: `K${suffix()}`, name: "Kund AB", ...delivery }).returning();
  return row!;
}

type SalesRowInput = { articleId: string; quantity: number; delivered?: number; date?: string | null };
async function salesOrder(status: "quote" | "confirmed" | "in_production", headDate: string | null, rows: SalesRowInput[], customerId?: string) {
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
        createdAt: new Date(Date.UTC(2030, 0, 1, 12, 0, i)),
      })
      .returning();
    rowIds.push(inserted!.id);
  }
  return { ...order!, rowIds };
}

type PurchaseRowInput = {
  articleId: string;
  quantity: number;
  received?: number;
  expected?: string | null;
  confirmed?: string | null;
  moOperationId?: string;
};
async function purchaseOrder(
  status: "draft" | "sent" | "confirmed" | "partially_received" | "cancelled",
  head: { expected?: string | null; confirmed?: string | null },
  rows: PurchaseRowInput[]
) {
  const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L${suffix()}`, name: "Leverantör AB" }).returning();
  const [po] = await db
    .insert(purchaseOrders)
    .values({
      orderNumber: `IO-${suffix()}`,
      supplierId: supplier!.id,
      status,
      expectedDeliveryDate: head.expected ?? null,
      confirmedDeliveryDate: head.confirmed ?? null,
    })
    .returning();
  const rowIds: string[] = [];
  for (const [i, row] of rows.entries()) {
    const [inserted] = await db
      .insert(purchaseOrderRows)
      .values({
        purchaseOrderId: po!.id,
        articleId: row.articleId,
        quantityOrdered: String(row.quantity),
        quantityReceived: String(row.received ?? 0),
        unitPrice: "10",
        expectedDeliveryDate: row.expected ?? null,
        confirmedDeliveryDate: row.confirmed ?? null,
        moOperationId: row.moOperationId ?? null,
        createdAt: new Date(Date.UTC(2030, 0, 1, 12, 0, i)),
      })
      .returning();
    rowIds.push(inserted!.id);
  }
  return { ...po!, rowIds };
}

const orders = (date?: string) => planningService.getDayPlanOrders(date ? { date } : {});

describe("Utleveranser", () => {
  it("lists today's rows and the passed ones with the Leveransläge's readiness", async () => {
    const item = await article();
    const unit = await unitCodeOf(item.id);
    // 3 st on the shelf: the passed row takes 2, today's row gets 1 and
    // misses 1 — the pegging's FIFO, the same answer as the KO card's.
    await addStock(item.id, 3);
    const late = await salesOrder("confirmed", "2030-03-01", [{ articleId: item.id, quantity: 2 }]);
    const due = await salesOrder("in_production", null, [
      { articleId: item.id, quantity: 2, date: TODAY },
      { articleId: item.id, quantity: 5, date: "2030-03-05" },
    ]);

    const result = await orders();
    expect(result).toMatchObject({ today: TODAY, date: TODAY, through: TODAY, previousDate: null, nextDate: "2030-03-05", isoWeek: 10, weekday: 1 });
    expect(result.shipments).toEqual([
      expect.objectContaining({
        key: `so:${late.rowIds[0]}`,
        salesOrderId: late.id,
        orderNumber: late.orderNumber,
        customerName: "Kund AB",
        articleNumber: item.articleNumber,
        unit,
        restQuantity: 2,
        promisedDate: "2030-03-01",
        shipDate: "2030-03-01",
        overdue: true,
        status: "on_time",
        uncovered: 0,
      }),
      expect.objectContaining({
        key: `so:${due.rowIds[0]}`,
        shipDate: TODAY,
        overdue: false,
        status: "uncovered",
        uncovered: 1,
        atRisk: true,
      }),
    ]);
    expect(result.shipments[0]!.allocations).toEqual([expect.objectContaining({ kind: "stock", quantity: 2 })]);

    // The same rows and statuses as the card's Leveransläge.
    const card = await planningService.getSalesOrderDeliveryOutlook(due.id);
    expect(card.rows[0]).toMatchObject({ status: result.shipments[1]!.status, uncovered: 1, promisedShipDate: TODAY });

    // Tomorrow: only tomorrow's row, never the passed one.
    const tomorrow = await orders("2030-03-05");
    expect(tomorrow.shipments.map((s) => s.key)).toEqual([`so:${due.rowIds[1]}`]);
    expect(tomorrow).toMatchObject({ previousDate: TODAY, nextDate: "2030-03-06" });
  });

  it("puts a row on its ship date — the customer's transit days back from the Leveransdatum", async () => {
    const item = await article();
    const twoDays = await customer({ deliveryDayMode: "arrival", transitDays: 2 });
    const order = await salesOrder("confirmed", "2030-03-06", [{ articleId: item.id, quantity: 1 }], twoDays.id);
    const result = await orders();
    expect(result.shipments).toEqual([expect.objectContaining({ key: `so:${order.rowIds[0]}`, promisedDate: "2030-03-06", shipDate: TODAY })]);
    expect((await orders("2030-03-06")).shipments).toEqual([]);
  });

  it("takes in the weekend on a Friday", async () => {
    const item = await article();
    const order = await salesOrder("confirmed", null, [
      { articleId: item.id, quantity: 1, date: "2030-03-09" },
      { articleId: item.id, quantity: 1, date: "2030-03-11" },
    ]);
    const friday = await orders("2030-03-08");
    expect(friday).toMatchObject({ through: "2030-03-10", previousDate: "2030-03-07", nextDate: "2030-03-11" });
    expect(friday.shipments.map((s) => s.key)).toEqual([`so:${order.rowIds[0]}`]);
  });

  it("never lists a quote, a delivered or undated row or a tjänst", async () => {
    const item = await article();
    const service = await article("service");
    await salesOrder("quote", TODAY, [{ articleId: item.id, quantity: 1 }]);
    await salesOrder("confirmed", null, [
      { articleId: item.id, quantity: 2, delivered: 2, date: TODAY },
      { articleId: item.id, quantity: 1, date: null },
      { articleId: service.id, quantity: 1, date: TODAY },
    ]);
    expect((await orders()).shipments).toEqual([]);
  });
});

describe("Inleveranser", () => {
  it("lists the open rows by their effective arrival date, with the supplier's confirmation and the status", async () => {
    const item = await article();
    const unit = await unitCodeOf(item.id);
    // Bekräftat on the row wins over Önskat on the order.
    const confirmed = await purchaseOrder("confirmed", { expected: "2030-03-07" }, [
      { articleId: item.id, quantity: 10, received: 4, confirmed: TODAY },
      { articleId: item.id, quantity: 5 },
    ]);
    // An Utkast is listed too (the list says so); its date passed.
    const draft = await purchaseOrder("draft", { expected: "2030-02-27" }, [{ articleId: item.id, quantity: 3 }]);
    await purchaseOrder("cancelled", { expected: TODAY }, [{ articleId: item.id, quantity: 3 }]);
    await purchaseOrder("partially_received", { expected: TODAY }, [{ articleId: item.id, quantity: 3, received: 3 }]);

    const result = await orders();
    expect(result.arrivals).toEqual([
      {
        key: `po:${draft.rowIds[0]}`,
        purchaseOrderId: draft.id,
        orderNumber: draft.orderNumber,
        orderStatus: "draft",
        supplierName: "Leverantör AB",
        purchaseOrderRowId: draft.rowIds[0],
        articleId: item.id,
        articleNumber: item.articleNumber,
        articleName: "Beslag",
        unit,
        restQuantity: 3,
        arrivalDate: "2030-02-27",
        overdue: true,
        confirmed: false,
        lego: null,
      },
      expect.objectContaining({ key: `po:${confirmed.rowIds[0]}`, restQuantity: 6, arrivalDate: TODAY, overdue: false, confirmed: true }),
    ]);
    const thursday = await orders("2030-03-07");
    expect(thursday.arrivals).toEqual([expect.objectContaining({ key: `po:${confirmed.rowIds[1]}`, confirmed: false })]);
  });

  it("names the TO operation a legorad comes back from, and never lists a tjänst", async () => {
    const product = await article("manufactured");
    const service = await article("service");
    const center = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "301", name: "Lack", capacityFactor: 1, active: true }));
    await mfgService.createRoutingOperation(product.id, { sequenceNo: 20, workCenterId: center.id, setupTime: 0, runTimePerUnit: 10 });
    const mo = await unplannedMfgService.createManufacturingOrder({ articleId: product.id, quantity: 4, dueDate: "2030-03-20" }, (await user()).id);
    const [op] = await db.select({ id: moOperations.id }).from(moOperations).where(eq(moOperations.manufacturingOrderId, mo.id));
    const po = await purchaseOrder("sent", { expected: TODAY }, [
      { articleId: product.id, quantity: 4, moOperationId: op!.id },
      { articleId: service.id, quantity: 1 },
    ]);
    expect((await orders()).arrivals).toEqual([
      expect.objectContaining({
        key: `po:${po.rowIds[0]}`,
        orderStatus: "sent",
        lego: { manufacturingOrderId: mo.id, orderNumber: mo.orderNumber, sequenceNo: 20 },
      }),
    ]);
  });

  it("takes a holiday into the day before it", async () => {
    const item = await article();
    await db.insert(holidays).values({ date: "2030-03-12", name: "Helgdag" });
    const po = await purchaseOrder("confirmed", { confirmed: "2030-03-12" }, [{ articleId: item.id, quantity: 1 }]);
    const monday = await orders("2030-03-11");
    expect(monday).toMatchObject({ through: "2030-03-12", nextDate: "2030-03-13" });
    expect(monday.arrivals.map((a) => a.key)).toEqual([`po:${po.rowIds[0]}`]);
  });
});

it("refuses a day outside today … today + 41, as the dagplan", async () => {
  await expect(orders("2030-03-01")).rejects.toBeInstanceOf(DayPlanDateOutOfRangeError);
  await expect(orders("2030-04-15")).rejects.toBeInstanceOf(DayPlanDateOutOfRangeError);
  await expect(orders("2030-04-14")).resolves.toMatchObject({ date: "2030-04-14", nextDate: null });
});

async function user() {
  return authRepo.create({ email: `dpo-${suffix()}@example.com`, passwordHash: "not-a-real-hash", name: "Planerare", role: "admin" });
}
