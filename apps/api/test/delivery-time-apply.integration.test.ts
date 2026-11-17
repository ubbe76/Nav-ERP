import { createArticleSchema, createCustomerSchema, createWeekScheduleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, manufacturingOrders, moOperationPlanDays, salesOrders } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import {
  createPlanningService,
  DeliveryTimeChangedError,
  NothingToReserveError,
  SalesOrderNotOpenError,
  type ManufacturingOrderCreator,
  type SalesOrderDateWriter,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";
import { parsed } from "./helpers/parsed.js";

// Reservationen (POST /delivery-time-check/apply) against Postgres: the
// check run again under the production_plan lock, a TO per shortage batch
// (children before parents) planned on exactly the days the check booked,
// the KO's Förväntat leveransdatum set and the row I tillverkning — all in
// one transaction. "Today" is pinned to Monday 2030-03-04 as in
// production-plan.integration.test.ts.
const W1 = "2030-03-04";
const W2 = "2030-03-11";
const W3 = "2030-03-18";
const W4 = "2030-03-25";
const TODAY = W1;
// The plan counts in days (#18): 10 h on a free 8 h resource is today and two
// hours of tomorrow, and an operation is ready the day its last minute is
// placed — not on the Friday of that week, as before.
const TEN_HOURS_FROM_TODAY = [
  { date: "2030-03-04", minutes: 480 },
  { date: "2030-03-05", minutes: 120 },
];
const CHILD_READY = "2030-03-05";
// The parent starts on the day its material is ready (R1 is free): Tuesday
// and two hours of Wednesday.
const PARENT_DAYS = [
  { date: "2030-03-05", minutes: 480 },
  { date: "2030-03-06", minutes: 120 },
];
const PARENT_READY = "2030-03-06";
// Shipped the working day after the last ready date; delivered the same day.
const DELIVERY = "2030-03-07";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const stockService = createStockService(createStockRepository(db));
const salesRepository = createSalesRepository(db);
const auditEntries: { entityType: string; entityId: string | null; action: string; detail?: unknown }[] = [];

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
  }
);
// Built after the manufacturing service so listRows carries the row's
// I tillverkning (the coverage reader), as app.ts wires it.
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  undefined,
  mfgService
);
const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
  isDateLocked: async () => false,
});

function buildPlanning(manufacturing: ManufacturingOrderCreator = mfgService, salesOrderDates: SalesOrderDateWriter = salesService) {
  return createPlanningService(createPlanningRepository(db), {
    purchase: {
      createPurchaseOrder: async () => {
        throw new Error("not used");
      },
      addRow: async () => {},
      cancel: async () => {},
    },
    manufacturing,
    requirementsCacheMs: 0,
    today: () => TODAY,
    audit: {
      async log(entry) {
        auditEntries.push({ entityType: entry.entityType, entityId: entry.entityId, action: entry.action, detail: entry.detail });
      },
    },
    salesOrderDates,
  });
}
const planningService = buildPlanning();
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE mo_operation_plan_days, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, sales_order_rows, sales_orders, customers, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  auditEntries.length = 0;
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function planRows(opId: string) {
  const rows = await db
    .select({ date: moOperationPlanDays.planDate, minutes: moOperationPlanDays.minutes })
    .from(moOperationPlanDays)
    .where(eq(moOperationPlanDays.moOperationId, opId))
    .orderBy(moOperationPlanDays.planDate);
  return rows.map((r) => ({ date: r.date, minutes: Number(r.minutes) }));
}

async function allPlanRows() {
  return db.select({ id: moOperationPlanDays.id }).from(moOperationPlanDays);
}

async function allManufacturingOrders() {
  return db.select({ id: manufacturingOrders.id }).from(manufacturingOrders);
}

async function salesOrderRow(id: string) {
  const [row] = await db
    .select({ status: salesOrders.status, expectedDeliveryDate: salesOrders.expectedDeliveryDate, revision: salesOrders.revision })
    .from(salesOrders)
    .where(eq(salesOrders.id, id));
  return row!;
}

// Two resources on a 40 h week; a parent article (Op 10 on R1, 60 min/st)
// made of one child each (Op 10 on R2, 60 min/st) — a KO on the parent is
// a shortage on both levels. `other` loads R1 without being supply.
async function seedWorld() {
  const user = await authRepo.create({
    email: `reserve-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Säljare",
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
  const r2 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "201", name: "Svets", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const child = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `BARN-${crypto.randomUUID().slice(0, 8)}`,
    name: "Halvfabrikat",
    type: "manufactured",
    active: true,
  }));
  await mfgService.createRoutingOperation(child.id, { sequenceNo: 10, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  const parent = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `FAR-${crypto.randomUUID().slice(0, 8)}`,
    name: "Slutprodukt",
    type: "manufactured",
    active: true,
  }));
  await articleService.addBomComponent(parent.id, { componentArticleId: child.id, quantity: 1 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  const other = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `ANNAN-${crypto.randomUUID().slice(0, 8)}`,
    name: "Annan artikel",
    type: "manufactured",
    active: true,
  }));
  await mfgService.createRoutingOperation(other.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  const bought = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `KOP-${crypto.randomUUID().slice(0, 8)}`,
    name: "Köpt artikel",
    type: "purchased",
    active: true,
  }));
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  return { user, r1, r2, child, parent, other, bought, customer };
}

async function confirmedOrder(world: Awaited<ReturnType<typeof seedWorld>>, articleId: string, quantity: number, confirm = true) {
  const { order, rows } = await salesService.createQuote(
    { customerId: world.customer.id, confirm, rows: [{ articleId, quantity, unitPrice: 100 }] },
    world.user.id
  );
  return { order, row: rows[0]! };
}

describe("reservationen — Skapa tillverkningsordrar för det som saknas", () => {
  it("creates the tree children before parents on the check's days, links level 1 to the row, sets the KO date and logs it", async () => {
    const world = await seedWorld();
    const { order, row } = await confirmedOrder(world, world.parent.id, 10);
    const before = await salesOrderRow(order.id);
    expect(before).toMatchObject({ status: "confirmed", expectedDeliveryDate: null });
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.deliveryDate).not.toBeNull();
    // 10 h on R2 from today for the child (ready Tuesday), then 10 h on R1
    // for the parent once its material is there — ready Wednesday, shipped
    // and delivered on Thursday. (Before #18: ready on the Fridays of week
    // 1 and 2, delivered Monday 2030-03-18.)
    expect(check.batches.map((b) => [b.level, b.articleNumber, b.quantity, b.readyDate])).toEqual([
      [2, world.child.articleNumber, 10, CHILD_READY],
      [1, world.parent.articleNumber, 10, PARENT_READY],
    ]);
    const [childBatch, parentBatch] = check.batches;
    expect(childBatch!.operations.map((o) => o.days)).toEqual([TEN_HOURS_FROM_TODAY]);
    expect(parentBatch!.operations.map((o) => o.days)).toEqual([PARENT_DAYS]);
    expect(check.deliveryDate).toBe(DELIVERY);

    const applied = await planningService.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate! }, world.user.id);
    const [childMo, parentMo] = applied.manufacturingOrders;
    // The parent's release warns of the child shortage (its TO has not
    // delivered yet) — a warning, never a refusal.
    expect(applied).toEqual({
      deliveryDate: DELIVERY,
      shipDate: DELIVERY,
      // No operation has an alternative (#15): the ordinarie run.
      usesAlternatives: false,
      manufacturingOrders: [
        expect.objectContaining({ articleNumber: world.child.articleNumber, quantity: 10, level: 2, salesOrderRowId: null }),
        expect.objectContaining({ articleNumber: world.parent.articleNumber, quantity: 10, level: 1, salesOrderRowId: row.id }),
      ],
      warnings: [`${parentMo!.orderNumber}: Halvfabrikat: behöver 10, tillgängligt 0`],
    });
    // Created in that order: the child's number comes first.
    expect(childMo!.orderNumber < parentMo!.orderNumber).toBe(true);

    const childOrder = (await mfgService.getManufacturingOrder(childMo!.id))!;
    expect(childOrder).toMatchObject({
      status: "released",
      salesOrderRowId: null,
      dueDate: CHILD_READY,
      note: `Skapad från leveranstidskontroll för ${order.orderNumber}`,
    });
    const parentOrder = (await mfgService.getManufacturingOrder(parentMo!.id))!;
    expect(parentOrder).toMatchObject({ status: "released", salesOrderRowId: row.id, dueDate: PARENT_READY, note: null });
    expect(parentOrder.salesOrder).toMatchObject({ id: order.id, orderNumber: order.orderNumber });

    // The plan is the check's allocation, written as given — not re-planned.
    const childOps = await mfgService.listOperations(childMo!.id);
    const parentOps = await mfgService.listOperations(parentMo!.id);
    expect(await planRows(childOps[0]!.id)).toEqual(TEN_HOURS_FROM_TODAY);
    expect(await planRows(parentOps[0]!.id)).toEqual(parentBatch!.operations[0]!.days);
    // The promised days are locked (plan_locked): Planera keeps them.
    expect(childOps[0]).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: CHILD_READY, planLocked: true });
    // The parent starts on the day the child is ready.
    expect(parentOps[0]).toMatchObject({ plannedStartDate: CHILD_READY, plannedEndDate: PARENT_READY, planLocked: true });

    // The KO: the date set without a revision bump, the row I tillverkning.
    expect(await salesOrderRow(order.id)).toEqual({ status: "in_production", expectedDeliveryDate: DELIVERY, revision: before.revision });
    const coverage = await mfgService.coverageForSalesOrderRows([row.id]);
    expect(coverage.get(row.id)?.quantity).toBe(10);
    const rows = await salesService.listRows(order.id);
    expect(rows[0]).toMatchObject({ quantityInProduction: 10 });

    // Each new TO: `created` (article, quantity, date, the KO for level 1), then `released`.
    expect(auditEntries).toEqual([
      {
        entityType: "manufacturing_order",
        entityId: childMo!.orderNumber,
        action: "created",
        detail: { articleNumber: world.child.articleNumber, quantity: 10, dueDate: childOrder.dueDate },
      },
      { entityType: "manufacturing_order", entityId: childMo!.orderNumber, action: "released", detail: undefined },
      {
        entityType: "manufacturing_order",
        entityId: parentMo!.orderNumber,
        action: "created",
        detail: { articleNumber: world.parent.articleNumber, quantity: 10, dueDate: PARENT_READY, salesOrderNumber: order.orderNumber },
      },
      { entityType: "manufacturing_order", entityId: parentMo!.orderNumber, action: "released", detail: undefined },
      {
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "delivery_time_applied",
        detail: {
          deliveryDate: DELIVERY,
          shipDate: DELIVERY,
          previousDeliveryDate: null,
          manufacturingOrders: [
            { orderNumber: childMo!.orderNumber, articleNumber: world.child.articleNumber, quantity: 10, level: 2 },
            { orderNumber: parentMo!.orderNumber, articleNumber: world.parent.articleNumber, quantity: 10, level: 1 },
          ],
          warnings: [`${parentMo!.orderNumber}: Halvfabrikat: behöver 10, tillgängligt 0`],
        },
      },
    ]);

    // The TOs now cover the row: the same date, nothing left to reserve.
    const again = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(again.deliveryDate).toBe(DELIVERY);
    expect(again.batches).toEqual([]);
    await expect(planningService.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: DELIVERY }, world.user.id)).rejects.toBeInstanceOf(
      NothingToReserveError
    );
    expect(await allManufacturingOrders()).toHaveLength(2);

    // Planera after the reservation: the engine would start the parent
    // today (R1 is free and it knows nothing of the child's material) — the
    // lock keeps the promised days.
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(childOps[0]!.id)).toEqual(TEN_HOURS_FROM_TODAY);
    expect(await planRows(parentOps[0]!.id)).toEqual(PARENT_DAYS);
    const afterPlan = await mfgService.listOperations(parentMo!.id);
    expect(afterPlan[0]).toMatchObject({ plannedEndDate: PARENT_READY, planLocked: true });
    // Lås upp + Planera: the parent is pulled to today — the lock was what
    // held it.
    await planningService.unlockOperation(afterPlan[0]!.id, world.user.id);
    await planningService.planProductionRun(world.user.id);
    expect((await mfgService.listOperations(parentMo!.id))[0]).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-05", planLocked: false });
  });

  it("refuses with delivery-time-changed when the number of TOs is not the one the client showed (expectedOrders)", async () => {
    const world = await seedWorld();
    const { order } = await confirmedOrder(world, world.parent.id, 10);
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.batches).toHaveLength(2);
    // The dialog showed one TO (say the child's TO was created in between
    // and the client's result is stale the other way round): refused with
    // the new result, nothing written.
    const failure = await planningService
      .applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate!, expectedOrders: 1 }, world.user.id)
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(DeliveryTimeChangedError);
    const changed = failure as DeliveryTimeChangedError;
    expect(changed.orders).toEqual({ expected: 1, actual: 2 });
    expect(changed.message).toBe("Läget har ändrats sedan kontrollen — det skapas nu 2 tillverkningsordrar i stället för 1");
    expect(changed.result.batches).toHaveLength(2);
    expect(await allManufacturingOrders()).toEqual([]);
    expect(await salesOrderRow(order.id)).toMatchObject({ status: "confirmed", expectedDeliveryDate: null });

    // The right count goes through; without the field only the date counts.
    const applied = await planningService.applyDeliveryTime(
      { salesOrderId: order.id, deliveryDate: check.deliveryDate!, expectedOrders: 2 },
      world.user.id
    );
    expect(applied.manufacturingOrders).toHaveLength(2);
  });

  it("refuses with delivery-time-changed when a TO created in between moved the date — nothing is written", async () => {
    const world = await seedWorld();
    const { order } = await confirmedOrder(world, world.parent.id, 10);
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.deliveryDate).toBe(DELIVERY);
    // Fills R1 this week and the next: the parent's operation now starts on
    // Monday of week 3 (ready Tuesday, delivered Wednesday 03-20).
    await mfgService.createManufacturingOrder({ articleId: world.other.id, quantity: 80, dueDate: "2030-04-30" }, world.user.id);
    const LATER = "2030-03-20";

    const failure = await planningService
      .applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate! }, world.user.id)
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(DeliveryTimeChangedError);
    const changed = failure as DeliveryTimeChangedError;
    expect(changed.deliveryDate).toBe(LATER);
    expect(changed.result.deliveryDate).toBe(LATER);
    expect(changed.result.batches).toHaveLength(2);
    expect(changed.message).toContain(LATER);

    expect(await allManufacturingOrders()).toHaveLength(1);
    expect(await salesOrderRow(order.id)).toMatchObject({ status: "confirmed", expectedDeliveryDate: null });
    expect(auditEntries).toEqual([]);

    // The new date is accepted, with the new result's days.
    const applied = await planningService.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: LATER }, world.user.id);
    expect(applied.manufacturingOrders).toHaveLength(2);
    const parentOps = await mfgService.listOperations(applied.manufacturingOrders[1]!.id);
    expect(await planRows(parentOps[0]!.id)).toEqual(changed.result.batches[1]!.operations[0]!.days);
    expect(parentOps[0]).toMatchObject({ plannedStartDate: W3, plannedEndDate: "2030-03-19" });
    expect(await salesOrderRow(order.id)).toMatchObject({ status: "in_production", expectedDeliveryDate: LATER });
  });

  it("is all or nothing: a failure on the second TO (the parent) leaves no TO, no plan rows and no date", async () => {
    const world = await seedWorld();
    const { order } = await confirmedOrder(world, world.parent.id, 10);
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    let calls = 0;
    const failing = buildPlanning({
      ...mfgService,
      createManufacturingOrderInTx: async (tx, input, createdBy, opts) => {
        calls += 1;
        if (calls === 2) throw new Error("nivå 1 sprack");
        return mfgService.createManufacturingOrderInTx(tx, input, createdBy, opts);
      },
    });
    await expect(failing.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate! }, world.user.id)).rejects.toThrow("nivå 1 sprack");
    expect(calls).toBe(2);
    expect(await allManufacturingOrders()).toEqual([]);
    expect(await allPlanRows()).toEqual([]);
    expect(await salesOrderRow(order.id)).toMatchObject({ status: "confirmed", expectedDeliveryDate: null });
    expect(auditEntries).toEqual([]);

    // The same when the last step — the KO date — fails.
    const dateFails = buildPlanning(mfgService, {
      lockRowsInTx: salesService.lockRowsInTx,
      async setExpectedDeliveryDateInTx() {
        throw new Error("datumet sprack");
      },
    });
    await expect(dateFails.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate! }, world.user.id)).rejects.toThrow("datumet sprack");
    expect(await allManufacturingOrders()).toEqual([]);
    expect(await allPlanRows()).toEqual([]);
    expect(await salesOrderRow(order.id)).toMatchObject({ status: "confirmed", expectedDeliveryDate: null });
  });

  it("refuses nothing-to-reserve when the shortage is bought, and refuses a quote or a cancelled order", async () => {
    const world = await seedWorld();
    const { order } = await confirmedOrder(world, world.bought.id, 5);
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.batches).toEqual([]);
    expect(check.deliveryDate).not.toBeNull();
    await expect(planningService.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate! }, world.user.id)).rejects.toBeInstanceOf(
      NothingToReserveError
    );
    expect(await salesOrderRow(order.id)).toMatchObject({ expectedDeliveryDate: null });

    // A quote can be checked but not reserved against (Skapa TO needs a
    // confirmed order); the message says so.
    const quote = await confirmedOrder(world, world.parent.id, 10, false);
    expect((await planningService.checkDeliveryTime({ salesOrderId: quote.order.id })).batches).toHaveLength(2);
    await expect(planningService.applyDeliveryTime({ salesOrderId: quote.order.id, deliveryDate: W2 }, world.user.id)).rejects.toMatchObject({
      name: "SalesOrderNotOpenError",
      status: "quote",
      message: expect.stringContaining("inte bekräftad"),
    });
    await salesService.cancel(quote.order.id, world.user.id);
    await expect(planningService.applyDeliveryTime({ salesOrderId: quote.order.id, deliveryDate: W2 }, world.user.id)).rejects.toBeInstanceOf(
      SalesOrderNotOpenError
    );
    await expect(planningService.applyDeliveryTime({ salesOrderId: crypto.randomUUID(), deliveryDate: W2 }, world.user.id)).rejects.toMatchObject({
      name: "SalesOrderNotFoundError",
    });
    expect(await allManufacturingOrders()).toEqual([]);
  });

  it("plans the TO by the engine with a warning when the given days do not match its operations (template changed)", async () => {
    const world = await seedWorld();
    const created = await db.transaction((tx) =>
      mfgService.createManufacturingOrderInTx(tx, { articleId: world.parent.id, quantity: 10, dueDate: W2 }, world.user.id, {
        plannedDays: [{ sequenceNo: 99, days: [{ date: W2, minutes: 600 }] }],
      })
    );
    expect(created.releaseWarnings).toEqual([
      "Halvfabrikat: behöver 10, tillgängligt 0",
      expect.stringContaining("stämmer inte med leveranstidskontrollens"),
    ]);
    const ops = await mfgService.listOperations(created.id);
    // The engine's own plan: from today, on free capacity.
    expect(await planRows(ops[0]!.id)).toEqual(TEN_HOURS_FROM_TODAY);
  });
});
