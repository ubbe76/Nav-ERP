import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { db, moOperationPlanWeeks, moOperations } from "@navet/db";
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
import {
  createPlanningService,
  OperationNotFoundError,
  OperationNotPlannableError,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";

// Produktionsplanering against Postgres: a new TO is planned in its own
// create transaction, Planera/Flytta/Lås upp write the allocations under the
// production_plan lock, and the matrix, the terminal, the TO list and
// Leveranstidskontrollen read the planned load. "Today" is pinned to Monday
// 2030-03-04 so every week has its full capacity whatever day the suite
// runs; the weeks below are that week (W1) and the ones after it.
const W1 = "2030-03-04";
const W2 = "2030-03-11";
const W3 = "2030-03-18";
const W4 = "2030-03-25";
const TODAY = W1;

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const auditEntries: { entityType: string; action: string; detail?: unknown }[] = [];

// The same late binding as app.ts: manufacturing plans a new TO through the
// planning service, which is built after it.
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
    planNewOrderInTx: (tx, moId, given) => planReaderRef.current!.planNewOrderInTx(tx, moId, given),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
  }
);
// A service WITHOUT a plan reader: its TOs are created unplanned (older
// orders, fixtures) and must count exactly as before the plan existed.
const unplannedMfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
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
  audit: {
    async log(entry) {
      auditEntries.push({ entityType: entry.entityType, action: entry.action, detail: entry.detail });
    },
  },
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  auditEntries.length = 0;
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function planRows(opId: string) {
  const rows = await db
    .select({ monday: moOperationPlanWeeks.weekMonday, minutes: moOperationPlanWeeks.minutes })
    .from(moOperationPlanWeeks)
    .where(eq(moOperationPlanWeeks.moOperationId, opId))
    .orderBy(moOperationPlanWeeks.weekMonday);
  return rows.map((r) => ({ monday: r.monday, minutes: Number(r.minutes) }));
}

// (operation, week) pairs with more than one row — the unique index makes
// this impossible, so it is always [] (the assertion documents the invariant).
async function duplicateAllocations() {
  return db
    .select({ moOperationId: moOperationPlanWeeks.moOperationId, weekMonday: moOperationPlanWeeks.weekMonday, n: count() })
    .from(moOperationPlanWeeks)
    .groupBy(moOperationPlanWeeks.moOperationId, moOperationPlanWeeks.weekMonday)
    .having(gt(count(), 1));
}

// Drizzle wraps a refused statement in "Failed query: …" with the driver's
// error as `cause` — the constraint name lives there.
async function expectConstraint(promise: Promise<unknown>, constraint: string) {
  await expect(promise.catch((err: unknown) => Promise.reject(String((err as { cause?: unknown }).cause ?? err)))).rejects.toMatch(
    constraint
  );
}

async function opRow(opId: string) {
  const [row] = await db
    .select({
      plannedStartWeek: moOperations.plannedStartWeek,
      plannedEndWeek: moOperations.plannedEndWeek,
      planLocked: moOperations.planLocked,
      plannedAt: moOperations.plannedAt,
    })
    .from(moOperations)
    .where(eq(moOperations.id, opId));
  return row!;
}

// Two resources on a 40 h week (480-minute days, Mon–Fri, factor 1) and an
// article whose route is Op 10 on R1 then Op 20 on R2, 60 min/st each —
// a TO of n units needs n hours on each resource.
async function seedWorld() {
  const user = await authRepo.create({
    email: `plan-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Planerare",
    role: "admin",
  });
  const day = await scheduleService.createDaySchedule({
    code: "D8",
    name: "Dagtid 8h",
    startTime: "07:00",
    endTime: "15:00",
    breaks: [],
    active: true,
  });
  const week = await scheduleService.createWeekSchedule({
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  });
  const r1 = await mfgService.createWorkCenter({ code: "101", name: "Kap", weekScheduleId: week.id, capacityFactor: 1, active: true });
  const r2 = await mfgService.createWorkCenter({ code: "201", name: "Svets", weekScheduleId: week.id, capacityFactor: 1, active: true });
  const article = await articleService.createArticle({
    articleNumber: `PLAN-${crypto.randomUUID().slice(0, 8)}`,
    name: "Planeringsartikel",
    type: "manufactured",
    active: true,
  });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  // A second article with the same route — load on the resources that is
  // not supply of the first article (Leveranstidskontrollen).
  const other = await articleService.createArticle({
    articleNumber: `ANNAN-${crypto.randomUUID().slice(0, 8)}`,
    name: "Annan artikel",
    type: "manufactured",
    active: true,
  });
  await mfgService.createRoutingOperation(other.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(other.id, { sequenceNo: 20, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  return { user, r1, r2, article, other };
}

async function createOrder(world: Awaited<ReturnType<typeof seedWorld>>, quantity: number, dueDate?: string) {
  const order = await mfgService.createManufacturingOrder({ articleId: world.article.id, quantity, dueDate }, world.user.id);
  const ops = await mfgService.listOperations(order.id);
  return { order, op10: ops.find((o) => o.sequenceNo === 10)!, op20: ops.find((o) => o.sequenceNo === 20)! };
}

describe("a new TO is planned in its create transaction", () => {
  it("places the operations in sequence on free capacity against the other open load", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W3);
    // 20 h on R1 this week, Op 20 may use what is left of the same week on R2.
    expect(await planRows(a.op10.id)).toEqual([{ monday: W1, minutes: 1200 }]);
    expect(await planRows(a.op20.id)).toEqual([{ monday: W1, minutes: 1200 }]);
    expect(a.op10).toMatchObject({ plannedStartWeek: W1, plannedEndWeek: W1, planLocked: false });
    expect(a.op10.plannedAt).not.toBeNull();
    expect(a.order.releaseWarnings).toEqual([]);

    // The second TO sees the first: R1 has 20 h left this week, the rest
    // goes next week; Op 20 then starts in week 2.
    const b = await createOrder(world, 40, W4);
    expect(await planRows(b.op10.id)).toEqual([
      { monday: W1, minutes: 1200 },
      { monday: W2, minutes: 1200 },
    ]);
    expect(await planRows(b.op20.id)).toEqual([{ monday: W2, minutes: 2400 }]);
    expect(b.op10).toMatchObject({ plannedStartWeek: W1, plannedEndWeek: W2 });

    const capacity = await planningService.getCapacity({ weeks: 3 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks.map((w) => w.loadHours)).toEqual([40, 20, 0]);
    expect(r1.weeks[0]!.loadPercent).toBe(100);
    expect(r1.weeks[0]!.orders.map((o) => [o.orderNumber, o.hoursInWeek, o.planned, o.plannedStartWeek, o.plannedEndWeek])).toEqual([
      [a.order.orderNumber, 20, true, W1, W1],
      [b.order.orderNumber, 20, true, W1, W2],
    ]);
    expect(r1.weeks[1]!.orders[0]).toMatchObject({ moOperationId: b.op10.id, hoursInWeek: 20, remainingHours: 40, late: false });
    expect(capacity.summary).toMatchObject({ overloadedCells: 0, lateOrders: [], unplannedOrders: [] });
    expect(capacity.summary.plannedAt).not.toBeNull();
  });

  it("warns in releaseWarnings when the plan finishes after the due date, and never refuses", async () => {
    const world = await seedWorld();
    // 80 h on R1 = two full weeks; due tomorrow.
    const late = await createOrder(world, 80, "2030-03-05");
    expect(late.order.releaseWarnings).toEqual([expect.stringContaining("efter färdigdatumet 2030-03-05")]);
    expect(late.op10).toMatchObject({ plannedStartWeek: W1, plannedEndWeek: W2 });
    const capacity = await planningService.getCapacity({ weeks: 3 });
    expect(capacity.summary.lateOrders).toEqual([
      { manufacturingOrderId: late.order.id, orderNumber: late.order.orderNumber, dueDate: "2030-03-05", plannedFinish: "2030-03-22" },
    ]);
  });

  it("leaves a TO created without the plan reader unplanned — its load counts in the due date's week as before", async () => {
    const world = await seedWorld();
    const old = await unplannedMfgService.createManufacturingOrder({ articleId: world.article.id, quantity: 10, dueDate: W3 }, world.user.id);
    const ops = await mfgService.listOperations(old.id);
    expect(ops.map((o) => [o.plannedStartWeek, o.plannedEndWeek, o.planLocked])).toEqual([
      [null, null, false],
      [null, null, false],
    ]);
    expect(await planRows(ops[0]!.id)).toEqual([]);
    const capacity = await planningService.getCapacity({ weeks: 4 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks.map((w) => w.loadHours)).toEqual([0, 0, 10, 0]);
    expect(r1.weeks[2]!.orders[0]).toMatchObject({ planned: false, plannedStartWeek: null, hoursInWeek: 10, remainingHours: 10 });
    expect(capacity.summary).toMatchObject({ plannedAt: null, unplannedOrders: [{ manufacturingOrderId: old.id, orderNumber: old.orderNumber }] });
  });
});

describe("Planera", () => {
  it("replans in due-date order, warns Sen, clears done operations and stamps plannedAt", async () => {
    const world = await seedWorld();
    // Created first, so creation planned it first — but it is due later.
    const later = await createOrder(world, 40, W4);
    const sooner = await createOrder(world, 40, "2030-03-05");
    expect(await planRows(later.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    expect(await planRows(sooner.op10.id)).toEqual([{ monday: W2, minutes: 2400 }]);

    const run = await planningService.planProductionRun(world.user.id);
    expect(run).toMatchObject({ orders: 2, operations: 4 });
    expect(run.warnings).toEqual([
      expect.objectContaining({ kind: "late", manufacturingOrderId: sooner.order.id, dueDate: "2030-03-05", plannedFinish: "2030-03-08" }),
    ]);
    // Priority: the sooner TO takes week 1 on both resources, the later one
    // moves to week 2.
    expect(await planRows(sooner.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    expect(await planRows(sooner.op20.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    expect(await planRows(later.op10.id)).toEqual([{ monday: W2, minutes: 2400 }]);
    expect(await planRows(later.op20.id)).toEqual([{ monday: W2, minutes: 2400 }]);
    const row = await opRow(later.op10.id);
    expect(row).toMatchObject({ plannedStartWeek: W2, plannedEndWeek: W2, planLocked: false });
    expect(row.plannedAt!.toISOString()).toBe(run.plannedAt);
    expect(auditEntries).toEqual([
      { entityType: "production_plan", action: "planned", detail: { orders: 2, operations: 4, warnings: run.warnings } },
    ]);

    const capacity = await planningService.getCapacity({ weeks: 3 });
    expect(capacity.summary.plannedAt).toBe(run.plannedAt);
    expect(capacity.summary.lateOrders.map((o) => o.orderNumber)).toEqual([sooner.order.orderNumber]);

    // A done operation loses its allocation on the next run (and the plan
    // moves on: the sooner TO's Op 20 is now its first pending operation).
    await mfgService.reportOperationQuantities(sooner.op10.id, { quantityOk: 40, quantityScrapped: 0, markDone: true, createdBy: world.user.id });
    const again = await planningService.planProductionRun(world.user.id);
    expect(again.operations).toBe(3);
    expect(await planRows(sooner.op10.id)).toEqual([]);
    expect(await opRow(sooner.op10.id)).toMatchObject({ plannedStartWeek: null, plannedEndWeek: null });
    // Week 1 on R1 is free again, so the later TO's Op 10 moves up.
    expect(await planRows(later.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    // Determinism: a run on its own output changes nothing.
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(later.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    expect(await planRows(sooner.op20.id)).toEqual([{ monday: W1, minutes: 2400 }]);
  });

  it("reads the plan it wrote: a reported quantity shrinks the load from the front, never the plan rows", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 60, W4);
    expect(await planRows(a.op10.id)).toEqual([
      { monday: W1, minutes: 2400 },
      { monday: W2, minutes: 1200 },
    ]);
    await mfgService.reportOperationQuantities(a.op10.id, { quantityOk: 30, quantityScrapped: 0, markDone: false, createdBy: world.user.id });
    // 30 h left: filled from the back — W2: 20 h, W1: 10 h; the rows untouched.
    expect(await planRows(a.op10.id)).toEqual([
      { monday: W1, minutes: 2400 },
      { monday: W2, minutes: 1200 },
    ]);
    const capacity = await planningService.getCapacity({ weeks: 2 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks.map((w) => w.loadHours)).toEqual([10, 20]);
  });
});

describe("Flytta and Lås upp", () => {
  it("starts in the chosen week — full or not — continues on free capacity, locks and moves the following operations", async () => {
    const world = await seedWorld();
    const blocker = await createOrder(world, 40, W4); // fills W1 on R1
    const a = await createOrder(world, 60, "2030-04-30"); // W2 + half of W3 on R1
    expect(await planRows(a.op10.id)).toEqual([
      { monday: W2, minutes: 2400 },
      { monday: W3, minutes: 1200 },
    ]);
    expect(await planRows(a.op20.id)).toEqual([
      { monday: W3, minutes: 2400 },
      { monday: W4, minutes: 1200 },
    ]);

    // Into the full week 1: the whole week's capacity is taken there
    // (overload allowed), the rest continues on free capacity in week 2.
    const moved = await planningService.moveOperation(a.op10.id, { weekMonday: W1, moveFollowing: true }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartWeek: W1, plannedEndWeek: W2, planLocked: true });
    expect(await planRows(a.op10.id)).toEqual([
      { monday: W1, minutes: 2400 },
      { monday: W2, minutes: 1200 },
    ]);
    // Op 20 followed: from the new finish week.
    expect(moved.following).toEqual([{ moOperationId: a.op20.id, sequenceNo: 20, plannedStartWeek: W2, plannedEndWeek: W3 }]);
    expect(await planRows(a.op20.id)).toEqual([
      { monday: W2, minutes: 2400 },
      { monday: W3, minutes: 1200 },
    ]);
    expect(moved.warnings).toEqual([]);
    expect(await opRow(a.op20.id)).toMatchObject({ planLocked: false });
    // The blocker was existing load — untouched.
    expect(await planRows(blocker.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    const capacity = await planningService.getCapacity({ weeks: 2 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks[0]).toMatchObject({ loadHours: 80, loadPercent: 200 });
    expect(capacity.summary.overloadedCells).toBe(1);
    expect(r1.weeks[0]!.orders.find((o) => o.moOperationId === a.op10.id)).toMatchObject({ planLocked: true, hoursInWeek: 40 });
    expect(auditEntries.at(-1)).toMatchObject({
      entityType: "manufacturing_order",
      action: "operation_moved",
      detail: expect.objectContaining({ moOperationId: a.op10.id, fromWeek: W2, toWeek: W1, moveFollowing: true }),
    });

    // Planera keeps the locked operation where it is and plans the rest
    // around it: the blocker (due the same day, lower order number) is
    // placed after the locked load.
    const run = await planningService.planProductionRun(world.user.id);
    expect(await planRows(a.op10.id)).toEqual([
      { monday: W1, minutes: 2400 },
      { monday: W2, minutes: 1200 },
    ]);
    expect(await opRow(a.op10.id)).toMatchObject({ planLocked: true });
    expect(await planRows(blocker.op10.id)).toEqual([{ monday: W2, minutes: 1200 }, { monday: W3, minutes: 1200 }]);
    expect(run.warnings).toEqual([]);

    // Lås upp: the weeks stay until the next Planera, which moves it back.
    const unlocked = await planningService.unlockOperation(a.op10.id, world.user.id);
    expect(unlocked.operation).toEqual({ plannedStartWeek: W1, plannedEndWeek: W2, planLocked: false });
    expect(await planRows(a.op10.id)).toEqual([
      { monday: W1, minutes: 2400 },
      { monday: W2, minutes: 1200 },
    ]);
    expect(auditEntries.at(-1)).toMatchObject({ action: "operation_unlocked" });
    // Idempotent.
    expect((await planningService.unlockOperation(a.op10.id, world.user.id)).operation.planLocked).toBe(false);
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(blocker.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    expect(await planRows(a.op10.id)).toEqual([
      { monday: W2, minutes: 2400 },
      { monday: W3, minutes: 1200 },
    ]);
  });

  it("without moveFollowing the later operations keep their weeks, and a move before the previous one warns of a sequence break", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4); // W1 / W1
    const moved = await planningService.moveOperation(a.op10.id, { weekMonday: W3, moveFollowing: false }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartWeek: W3, plannedEndWeek: W3, planLocked: true });
    expect(moved.following).toEqual([]);
    expect(await planRows(a.op20.id)).toEqual([{ monday: W1, minutes: 1200 }]);
    expect(await opRow(a.op20.id)).toMatchObject({ plannedStartWeek: W1, planLocked: false });
    // Op 20 (kept in week 1) now starts before Op 10 finishes: a sequence
    // break, reported — never a refusal.
    expect(moved.warnings).toEqual([expect.objectContaining({ kind: "sequence", sequenceNo: 20, workCenterCode: "201" })]);

    // Moving Op 20 explicitly to week 2 is still before Op 10's week 3.
    const second = await planningService.moveOperation(a.op20.id, { weekMonday: W2, moveFollowing: true }, world.user.id);
    expect(second.operation).toEqual({ plannedStartWeek: W2, plannedEndWeek: W2, planLocked: true });
    expect(second.warnings).toEqual([
      expect.objectContaining({ kind: "sequence", sequenceNo: 20, workCenterCode: "201" }),
    ]);
    // Planera reports the break too, and leaves both locked operations alone.
    const run = await planningService.planProductionRun(world.user.id);
    expect(run.warnings.map((w) => w.kind)).toEqual(["sequence"]);
    expect(await planRows(a.op10.id)).toEqual([{ monday: W3, minutes: 1200 }]);
    expect(await planRows(a.op20.id)).toEqual([{ monday: W2, minutes: 1200 }]);
  });

  it("refuses what cannot be planned", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4);
    await expect(planningService.moveOperation(crypto.randomUUID(), { weekMonday: W2, moveFollowing: true }, world.user.id)).rejects.toBeInstanceOf(
      OperationNotFoundError
    );
    await expect(planningService.unlockOperation(crypto.randomUUID(), world.user.id)).rejects.toBeInstanceOf(OperationNotFoundError);
    await mfgService.reportOperationQuantities(a.op10.id, { quantityOk: 20, quantityScrapped: 0, markDone: true, createdBy: world.user.id });
    await expect(planningService.moveOperation(a.op10.id, { weekMonday: W2, moveFollowing: true }, world.user.id)).rejects.toMatchObject({
      name: "OperationNotPlannableError",
      reason: "done",
    });
    // A cancelled order's operation.
    const b = await createOrder(world, 20, W4);
    await mfgService.cancel(b.order.id);
    await expect(planningService.moveOperation(b.op10.id, { weekMonday: W2, moveFollowing: true }, world.user.id)).rejects.toBeInstanceOf(
      OperationNotPlannableError
    );
  });
});

describe("concurrency", () => {
  it("two Planera at once give the same plan and never a duplicate allocation", async () => {
    const world = await seedWorld();
    const orders = [await createOrder(world, 40, W4), await createOrder(world, 40, "2030-03-05"), await createOrder(world, 30, W3)];
    const [first, second] = await Promise.all([
      planningService.planProductionRun(world.user.id),
      planningService.planProductionRun(world.user.id),
    ]);
    expect(first.operations).toBe(6);
    expect(second.operations).toBe(6);
    expect(first.warnings.map((w) => [w.kind, w.orderNumber])).toEqual(second.warnings.map((w) => [w.kind, w.orderNumber]));
    expect(await duplicateAllocations()).toEqual([]);
    // The second run saw the first's result and kept it: priority order.
    expect(await planRows(orders[1]!.op10.id)).toEqual([{ monday: W1, minutes: 2400 }]);
    expect(await planRows(orders[2]!.op10.id)).toEqual([{ monday: W2, minutes: 1800 }]);
    expect(await planRows(orders[0]!.op10.id)).toEqual([
      { monday: W2, minutes: 600 },
      { monday: W3, minutes: 1800 },
    ]);
  });

  it.each([["plan first"], ["create first"]])("Planera and a new TO at once (%s): the TO is planned exactly once", async (order) => {
    const world = await seedWorld();
    await createOrder(world, 40, W4);
    const plan = () => planningService.planProductionRun(world.user.id);
    const create = () => mfgService.createManufacturingOrder({ articleId: world.article.id, quantity: 20, dueDate: W3 }, world.user.id);
    const results = order === "plan first" ? await Promise.all([plan(), create()]) : await Promise.all([create(), plan()]);
    const created = results.find((r): r is Awaited<ReturnType<typeof create>> => "orderNumber" in r)!;
    const ops = await mfgService.listOperations(created.id);
    for (const op of ops) {
      const rows = await planRows(op.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((sum, r) => sum + r.minutes, 0)).toBe(1200);
      expect(op.plannedStartWeek).not.toBeNull();
    }
    expect(await duplicateAllocations()).toEqual([]);
    // Either order: the new TO was planned against the existing one (week 1
    // full on R1 ⇒ week 2), never in between. Planera then re-prioritises:
    // the new TO is due sooner and takes week 1.
    expect(await Promise.all(ops.map((op) => planRows(op.id)))).toEqual([[{ monday: W2, minutes: 1200 }], [{ monday: W2, minutes: 1200 }]]);
    await planningService.planProductionRun(world.user.id);
    expect(await Promise.all(ops.map((op) => planRows(op.id)))).toEqual([[{ monday: W1, minutes: 1200 }], [{ monday: W1, minutes: 1200 }]]);
  });
});

describe("readers of the plan", () => {
  it("the terminal, the TO list and the operations list carry the planned weeks", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 60, "2030-03-05"); // W1–W2 / W2–W3, late
    const old = await unplannedMfgService.createManufacturingOrder({ articleId: world.article.id, quantity: 5, dueDate: W4 }, world.user.id);

    const { rows } = await mfgService.listTerminalOperations({});
    expect(rows.find((r) => r.operationId === a.op10.id)).toMatchObject({ plannedStartWeek: W1, plannedEndWeek: W2 });
    expect(rows.find((r) => r.operationId === a.op20.id)).toMatchObject({ plannedStartWeek: W2, plannedEndWeek: W3 });
    expect(rows.filter((r) => r.manufacturingOrderId === old.id).map((r) => r.plannedStartWeek)).toEqual([null, null]);

    const list = await mfgService.listManufacturingOrders({ limit: 50, offset: 0 });
    expect(list.rows.find((r) => r.id === a.order.id)).toMatchObject({ plannedStartWeek: W1, plannedEndWeek: W3, late: true });
    expect(list.rows.find((r) => r.id === old.id)).toMatchObject({ plannedStartWeek: null, plannedEndWeek: null, late: false });

    const ops = await mfgService.listOperations(a.order.id);
    expect(ops.map((o) => [o.sequenceNo, o.plannedStartWeek, o.plannedEndWeek, o.planLocked])).toEqual([
      [10, W1, W2, false],
      [20, W2, W3, false],
    ]);
  });

  it("Leveranstidskontrollen counts the planned load in its planned weeks", async () => {
    const world = await seedWorld();
    // A planned TO (on another article — the same article's TO would be
    // supply) fills R1 in week 1 even though it is due in week 4; an
    // unplanned one counts in week 4 and leaves week 1 free.
    await mfgService.createManufacturingOrder({ articleId: world.other.id, quantity: 40, dueDate: W4 }, world.user.id);
    const planned = await planningService.checkDeliveryTime({ rows: [{ articleId: world.article.id, quantity: 20 }] });
    const steps = planned.rows[0]!.chain.filter((s) => s.kind === "operation");
    expect(steps.map((s) => (s.kind === "operation" ? [s.sequenceNo, s.fromWeek, s.toWeek] : null))).toEqual([
      [10, W2, W2],
      [20, W2, W2],
    ]);
    expect(planned.rows[0]!.readyDate).toBe("2030-03-15");
    expect(planned.batches[0]!.operations.map((o) => o.weeks)).toEqual([[{ monday: W2, minutes: 1200 }], [{ monday: W2, minutes: 1200 }]]);

    await db.execute(TRUNCATE);
    const world2 = await seedWorld();
    await unplannedMfgService.createManufacturingOrder({ articleId: world2.other.id, quantity: 40, dueDate: W4 }, world2.user.id);
    const unplanned = await planningService.checkDeliveryTime({ rows: [{ articleId: world2.article.id, quantity: 20 }] });
    const step = unplanned.rows[0]!.chain.find((s) => s.kind === "operation");
    expect(step && step.kind === "operation" ? step.fromWeek : null).toBe(W1);
  });
});

describe("migration 0124", () => {
  it("enforces Mondays, positive minutes, one row per week and no lock without a plan", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4);
    await expectConstraint(
      db.insert(moOperationPlanWeeks).values({ moOperationId: a.op10.id, weekMonday: "2030-03-05", minutes: "10" }),
      "mo_operation_plan_weeks_monday"
    );
    await expectConstraint(
      db.insert(moOperationPlanWeeks).values({ moOperationId: a.op10.id, weekMonday: W3, minutes: "0" }),
      "mo_operation_plan_weeks_minutes"
    );
    await expectConstraint(
      db.insert(moOperationPlanWeeks).values({ moOperationId: a.op10.id, weekMonday: W1, minutes: "5" }),
      "mo_operation_plan_weeks_operation_week"
    );
    await expectConstraint(
      db.update(moOperations).set({ plannedStartWeek: W2, plannedEndWeek: W1 }).where(eq(moOperations.id, a.op10.id)),
      "mo_operations_plan_weeks"
    );
    await expectConstraint(
      db.update(moOperations).set({ plannedStartWeek: null, plannedEndWeek: null, planLocked: true }).where(eq(moOperations.id, a.op10.id)),
      "mo_operations_plan_locked"
    );
    // Deleting the operation's order takes the plan rows with it.
    await db.execute(sql`delete from manufacturing_orders where id = ${a.order.id}`);
    expect(
      await db.select().from(moOperationPlanWeeks).where(and(eq(moOperationPlanWeeks.moOperationId, a.op10.id)))
    ).toEqual([]);
  });
});
