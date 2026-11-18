import { createArticleSchema, createWeekScheduleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { db, holidays, moOperationPlanDays, moOperations, systemSettings } from "@navet/db";
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
  PlanDateInPastError,
  PlanDateNoCapacityError,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";
import { parsed } from "./helpers/parsed.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Produktionsplanering against Postgres: a new TO is planned in its own
// create transaction, Planera/Flytta/Lås upp write the allocations under the
// production_plan lock, and the matrix, the terminal, the TO list and
// Leveranstidskontrollen read the planned load. The plan's unit is the DAY
// (#18): an operation fills free days from its floor, and the next operation
// starts the next working day after the previous one is ready (+
// Standardkötid, 0 here unless a test sets it). "Today" is pinned to Monday
// 2030-03-04 unless a test moves it (the mid-week and Friday cases); W1–W4
// are the Mondays of that week and the ones after it.
const W1 = "2030-03-04";
const W2 = "2030-03-11";
const W3 = "2030-03-18";
const W4 = "2030-03-25";
let TODAY = W1;

// An allocation written out: `day("03-06", 240)` = 240 minutes on 2030-03-06,
// `full("03-04", "03-05")` = whole 8 h days, `week(W1)` = Mon–Fri full.
const day = (mmdd: string, minutes = 480) => ({ date: `2030-${mmdd}`, minutes });
const full = (...mmdd: string[]) => mmdd.map((d) => day(d));
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const week = (monday: string) => [0, 1, 2, 3, 4].map((i) => ({ date: addDays(monday, i), minutes: 480 }));

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
    planNewOrderInTx: (tx, moId, given, opts) => planReaderRef.current!.planNewOrderInTx(tx, moId, given, opts),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
  }
);
// A service WITHOUT a plan reader: its TOs are created unplanned (older
// orders, fixtures) and must count exactly as before the plan existed.
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
  audit: {
    async log(entry) {
      auditEntries.push({ entityType: entry.entityType, action: entry.action, detail: entry.detail });
    },
  },
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE mo_operation_plan_days, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  auditEntries.length = 0;
  TODAY = W1;
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

// (operation, day) pairs with more than one row — the unique index makes
// this impossible, so it is always [] (the assertion documents the invariant).
async function duplicateAllocations() {
  return db
    .select({ moOperationId: moOperationPlanDays.moOperationId, planDate: moOperationPlanDays.planDate, n: count() })
    .from(moOperationPlanDays)
    .groupBy(moOperationPlanDays.moOperationId, moOperationPlanDays.planDate)
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
      plannedStartDate: moOperations.plannedStartDate,
      plannedEndDate: moOperations.plannedEndDate,
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
  const week = await scheduleService.createWeekSchedule(parsed(createWeekScheduleSchema, {
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  }));
  const r1 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "101", name: "Kap", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const r2 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "201", name: "Svets", weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const article = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `PLAN-${crypto.randomUUID().slice(0, 8)}`,
    name: "Planeringsartikel",
    type: "manufactured",
    active: true,
  }));
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  // A second article with the same route — load on the resources that is
  // not supply of the first article (Leveranstidskontrollen).
  const other = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `ANNAN-${crypto.randomUUID().slice(0, 8)}`,
    name: "Annan artikel",
    type: "manufactured",
    active: true,
  }));
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
    // 20 h on R1 = Monday, Tuesday and half of Wednesday; Op 20 starts the
    // next working day after Op 10 is ready (Thursday), not the same week.
    expect(await planRows(a.op10.id)).toEqual([...full("03-04", "03-05"), day("03-06", 240)]);
    expect(await planRows(a.op20.id)).toEqual([...full("03-07", "03-08"), day("03-11", 240)]);
    expect(a.op10).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-06", planLocked: false });
    expect(a.op10.plannedAt).not.toBeNull();
    expect(a.order.releaseWarnings).toEqual([]);

    // The second TO sees the first: R1 is free from Wednesday afternoon; Op
    // 20 then starts the day after Op 10 is ready, on R2's free days.
    const b = await createOrder(world, 40, W4);
    expect(await planRows(b.op10.id)).toEqual([day("03-06", 240), ...full("03-07", "03-08", "03-11", "03-12"), day("03-13", 240)]);
    expect(await planRows(b.op20.id)).toEqual(full("03-14", "03-15", "03-18", "03-19", "03-20"));
    expect(b.op10).toMatchObject({ plannedStartDate: "2030-03-06", plannedEndDate: "2030-03-13" });

    // The week cells are the sums of their days.
    const capacity = await planningService.getCapacity({ weeks: 3 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks.map((w) => w.loadHours)).toEqual([40, 20, 0]);
    expect(r1.weeks[0]!.loadPercent).toBe(100);
    expect(r1.weeks[0]!.orders.map((o) => [o.orderNumber, o.hoursInWeek, o.planned, o.plannedStartDate, o.plannedEndDate])).toEqual([
      [a.order.orderNumber, 20, true, "2030-03-04", "2030-03-06"],
      [b.order.orderNumber, 20, true, "2030-03-06", "2030-03-13"],
    ]);
    expect(r1.weeks[1]!.orders[0]).toMatchObject({ moOperationId: b.op10.id, hoursInWeek: 20, remainingHours: 40, late: false });
    expect(capacity.summary).toMatchObject({ overloadedCells: 0, lateOrders: [], unplannedOrders: [] });
    expect(capacity.summary.plannedAt).not.toBeNull();
  });

  it("warns in releaseWarnings when the plan finishes after the due date, and never refuses", async () => {
    const world = await seedWorld();
    // 80 h on R1 = ten working days; due tomorrow.
    const late = await createOrder(world, 80, "2030-03-05");
    expect(late.order.releaseWarnings).toEqual([expect.stringContaining("efter färdigdatumet 2030-03-05")]);
    expect(late.op10).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-15" });
    const capacity = await planningService.getCapacity({ weeks: 3 });
    // Op 20 starts on Monday 03-18 (the working day after Op 10 is ready) and
    // takes ten days — the finish is the plan's last DAY, not a week's Friday
    // (2030-03-22 when Op 20 could share Op 10's last week).
    expect(capacity.summary.lateOrders).toEqual([
      { manufacturingOrderId: late.order.id, orderNumber: late.order.orderNumber, dueDate: "2030-03-05", plannedFinish: "2030-03-29" },
    ]);
  });

  it("warns for orimligt mycket tid in releaseWarnings, against the system setting's limit", async () => {
    const world = await seedWorld();
    const setLimit = (value: string) =>
      db.insert(systemSettings).values({ key: "planning_long_operation_weeks", value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    try {
      // Default 4 weeks: 50 h on a 40 h week is fine.
      expect((await createOrder(world, 50)).order.releaseWarnings).toEqual([]);
      await setLimit("1");
      const long = await createOrder(world, 50);
      expect(long.order.releaseWarnings).toEqual([
        "Op 10 på 101 (" + world.article.articleNumber + " Planeringsartikel) har orimligt mycket tid: 50 h kvar, motsvarar 1,3 veckors kapacitet på resursen (40 h/vecka); ställtid 0 min, stycktid 60 min/st, antal 50 st — kontrollera operationens tider och orderns antal",
        expect.stringContaining("Op 20 på 201"),
      ]);
      // Planned anyway.
      expect(long.op10.plannedStartDate).not.toBeNull();
      await setLimit("0");
      expect((await createOrder(world, 500)).order.releaseWarnings).toEqual([]);
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, "planning_long_operation_weeks"));
    }
  });

  it("leaves a TO created without the plan reader unplanned — its load counts on the due date as before", async () => {
    const world = await seedWorld();
    const old = await unplannedMfgService.createManufacturingOrder({ articleId: world.article.id, quantity: 10, dueDate: W3 }, world.user.id);
    const ops = await mfgService.listOperations(old.id);
    expect(ops.map((o) => [o.plannedStartDate, o.plannedEndDate, o.planLocked])).toEqual([
      [null, null, false],
      [null, null, false],
    ]);
    expect(await planRows(ops[0]!.id)).toEqual([]);
    const capacity = await planningService.getCapacity({ weeks: 4 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks.map((w) => w.loadHours)).toEqual([0, 0, 10, 0]);
    expect(r1.weeks[2]!.orders[0]).toMatchObject({ planned: false, plannedStartDate: null, hoursInWeek: 10, remainingHours: 10 });
    expect(capacity.summary).toMatchObject({ plannedAt: null, unplannedOrders: [{ manufacturingOrderId: old.id, orderNumber: old.orderNumber }] });
  });

  it("counts Standardkötid between the operations — read at every run, never cached", async () => {
    const world = await seedWorld();
    const setQueue = (value: string) =>
      db.insert(systemSettings).values({ key: "planning_queue_time_days", value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    try {
      await setQueue("2");
      const a = await createOrder(world, 20, W4);
      expect(await planRows(a.op10.id)).toEqual([...full("03-04", "03-05"), day("03-06", 240)]);
      // Ready Wednesday; the next working day is Thursday, plus two days' queue ⇒ Monday.
      expect(await planRows(a.op20.id)).toEqual([...full("03-11", "03-12"), day("03-13", 240)]);
      // The setting changed: the next Planera counts with the new value.
      await setQueue("0");
      await planningService.planProductionRun(world.user.id);
      expect(await planRows(a.op20.id)).toEqual([...full("03-07", "03-08"), day("03-11", 240)]);
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, "planning_queue_time_days"));
    }
  });
});

describe("today in the middle of the week and on a Friday", () => {
  it("a Wednesday: the plan starts today, a day earlier in the week has passed", async () => {
    const world = await seedWorld();
    TODAY = "2030-03-06";
    const a = await createOrder(world, 20, W4);
    expect(await planRows(a.op10.id)).toEqual([...full("03-06", "03-07"), day("03-08", 240)]);
    // Ready on Friday ⇒ Op 20 starts on Monday.
    expect(await planRows(a.op20.id)).toEqual([...full("03-11", "03-12"), day("03-13", 240)]);
    // Monday of the same week is in the past — the week is not what counts.
    await expect(planningService.moveOperation(a.op10.id, { date: "2030-03-04", moveFollowing: true }, world.user.id)).rejects.toBeInstanceOf(
      PlanDateInPastError
    );
    // Today itself is fine.
    const moved = await planningService.moveOperation(a.op20.id, { date: "2030-03-06", moveFollowing: true }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartDate: "2030-03-06", plannedEndDate: "2030-03-08", planLocked: true });
  });

  it("a Friday: what is ready on the Friday continues on Monday", async () => {
    const world = await seedWorld();
    TODAY = "2030-03-08";
    // Four hours, ready the same Friday: the next operation starts on Monday.
    const c = await createOrder(world, 4, W4);
    expect(await planRows(c.op10.id)).toEqual([day("03-08", 240)]);
    expect(await planRows(c.op20.id)).toEqual([day("03-11", 240)]);
    // Twelve hours: the rest of the Friday, then Monday; Op 20 from Tuesday.
    const a = await createOrder(world, 12, W4);
    expect(await planRows(a.op10.id)).toEqual([day("03-08", 240), day("03-11")]);
    expect(await planRows(a.op20.id)).toEqual([day("03-12"), day("03-13", 240)]);
  });
});

describe("Planera", () => {
  it("replans in due-date order, warns Sen, clears done operations and stamps plannedAt", async () => {
    const world = await seedWorld();
    // Created first, so creation planned it first — but it is due later.
    const later = await createOrder(world, 40, W4);
    const sooner = await createOrder(world, 40, "2030-03-05");
    expect(await planRows(later.op10.id)).toEqual(week(W1));
    expect(await planRows(sooner.op10.id)).toEqual(week(W2));

    const run = await planningService.planProductionRun(world.user.id);
    expect(run).toMatchObject({ orders: 2, operations: 4 });
    // Op 20 starts the working day after Op 10's week — the sooner TO is
    // ready on Friday of week 2 (2030-03-08 when both operations shared week 1).
    expect(run.warnings).toEqual([
      expect.objectContaining({ kind: "late", manufacturingOrderId: sooner.order.id, dueDate: "2030-03-05", plannedFinish: "2030-03-15" }),
    ]);
    // Priority: the sooner TO takes week 1 on R1 and week 2 on R2, the later
    // one follows a week behind on each.
    expect(await planRows(sooner.op10.id)).toEqual(week(W1));
    expect(await planRows(sooner.op20.id)).toEqual(week(W2));
    expect(await planRows(later.op10.id)).toEqual(week(W2));
    expect(await planRows(later.op20.id)).toEqual(week(W3));
    const row = await opRow(later.op10.id);
    expect(row).toMatchObject({ plannedStartDate: "2030-03-11", plannedEndDate: "2030-03-15", planLocked: false });
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
    expect(await opRow(sooner.op10.id)).toMatchObject({ plannedStartDate: null, plannedEndDate: null });
    // Week 1 on R1 is free again, so the later TO's Op 10 moves up.
    expect(await planRows(later.op10.id)).toEqual(week(W1));
    // Determinism: a run on its own output changes nothing.
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(later.op10.id)).toEqual(week(W1));
    expect(await planRows(sooner.op20.id)).toEqual(week(W1));
    expect(await planRows(later.op20.id)).toEqual(week(W2));
  });

  it("reads the plan it wrote: a reported quantity shrinks the load from the front, never the plan rows", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 60, W4);
    const written = [...week(W1), ...full("03-11", "03-12"), day("03-13", 240)];
    expect(await planRows(a.op10.id)).toEqual(written);
    await mfgService.reportOperationQuantities(a.op10.id, { quantityOk: 30, quantityScrapped: 0, markDone: false, createdBy: world.user.id });
    // 30 h left: filled from the back — 03-13 … 03-08 and two hours of
    // 03-07, i.e. 20 h in week 2 and 10 h in week 1; the rows untouched.
    expect(await planRows(a.op10.id)).toEqual(written);
    const capacity = await planningService.getCapacity({ weeks: 2 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks.map((w) => w.loadHours)).toEqual([10, 20]);
  });
});

describe("Flytta and Lås upp", () => {
  it("starts on the chosen day — full or not — continues on free capacity, locks and moves the following operations", async () => {
    const world = await seedWorld();
    const blocker = await createOrder(world, 40, "2030-04-15"); // fills W1 on R1
    const a = await createOrder(world, 60, "2030-04-30"); // 7.5 days from 03-11 on R1
    const original = [...week(W2), ...full("03-18", "03-19"), day("03-20", 240)];
    expect(await planRows(a.op10.id)).toEqual(original);
    expect(await planRows(a.op20.id)).toEqual([...full("03-21", "03-22"), ...week(W4), day("04-01", 240)]);

    // Onto the full Monday 03-04: the whole DAY's capacity is taken there
    // (overload allowed), the rest continues on free capacity — the rest of
    // week 1 is the blocker's, so from 03-11.
    const moved = await planningService.moveOperation(a.op10.id, { date: "2030-03-04", moveFollowing: true }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-19", planLocked: true });
    const movedRows = [day("03-04"), ...week(W2), day("03-18"), day("03-19", 240)];
    expect(await planRows(a.op10.id)).toEqual(movedRows);
    // Op 20 followed: from the working day after the new finish day.
    expect(moved.following).toEqual([{ moOperationId: a.op20.id, sequenceNo: 20, plannedStartDate: "2030-03-20", plannedEndDate: "2030-03-29" }]);
    expect(await planRows(a.op20.id)).toEqual([...full("03-20", "03-21", "03-22"), ...full("03-25", "03-26", "03-27", "03-28"), day("03-29", 240)]);
    expect(moved.warnings).toEqual([]);
    expect(await opRow(a.op20.id)).toMatchObject({ planLocked: false });
    // The blocker was existing load — untouched.
    expect(await planRows(blocker.op10.id)).toEqual(week(W1));
    // The week is the sum of its days: 40 h + the moved day's 8 h.
    const capacity = await planningService.getCapacity({ weeks: 2 });
    const r1 = capacity.groups[0]!.resources.find((r) => r.workCenterId === world.r1.id)!;
    expect(r1.weeks[0]).toMatchObject({ loadHours: 48, loadPercent: 120 });
    expect(capacity.summary.overloadedCells).toBe(1);
    expect(r1.weeks[0]!.orders.find((o) => o.moOperationId === a.op10.id)).toMatchObject({ planLocked: true, hoursInWeek: 8 });
    expect(auditEntries.at(-1)).toMatchObject({
      entityType: "manufacturing_order",
      action: "operation_moved",
      detail: expect.objectContaining({
        moOperationId: a.op10.id,
        fromDate: "2030-03-11",
        toDate: "2030-03-04",
        plannedStartDate: "2030-03-04",
        plannedEndDate: "2030-03-19",
        moveFollowing: true,
      }),
    });

    // Planera keeps the locked operation where it is and plans the rest
    // around it: the blocker (due sooner) is placed on the days the locked
    // load leaves free — Tuesday–Friday of week 1 and what is left of 03-19
    // and 03-20.
    const run = await planningService.planProductionRun(world.user.id);
    expect(await planRows(a.op10.id)).toEqual(movedRows);
    expect(await opRow(a.op10.id)).toMatchObject({ planLocked: true });
    expect(await planRows(blocker.op10.id)).toEqual([...full("03-05", "03-06", "03-07", "03-08"), day("03-19", 240), day("03-20", 240)]);
    expect(run.warnings).toEqual([]);

    // Lås upp: the days stay until the next Planera, which moves it back.
    const unlocked = await planningService.unlockOperation(a.op10.id, world.user.id);
    expect(unlocked.operation).toEqual({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-19", planLocked: false });
    expect(await planRows(a.op10.id)).toEqual(movedRows);
    expect(auditEntries.at(-1)).toMatchObject({ action: "operation_unlocked" });
    // Idempotent.
    expect((await planningService.unlockOperation(a.op10.id, world.user.id)).operation.planLocked).toBe(false);
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(blocker.op10.id)).toEqual(week(W1));
    expect(await planRows(a.op10.id)).toEqual(original);
  });

  it("the status flow on day level: Flytta → Lås upp → Planera → reported done ⇒ the plan and the lock are cleared", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 8, W4);
    expect(await planRows(a.op10.id)).toEqual([day("03-04")]);
    expect(await planRows(a.op20.id)).toEqual([day("03-05")]);

    // Flytta to Thursday: locked there, Op 20 follows to Friday.
    const moved = await planningService.moveOperation(a.op10.id, { date: "2030-03-07", moveFollowing: true }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartDate: "2030-03-07", plannedEndDate: "2030-03-07", planLocked: true });
    expect(moved.following).toEqual([{ moOperationId: a.op20.id, sequenceNo: 20, plannedStartDate: "2030-03-08", plannedEndDate: "2030-03-08" }]);
    // Planera leaves a locked day alone.
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(a.op10.id)).toEqual([day("03-07")]);
    expect(await planRows(a.op20.id)).toEqual([day("03-08")]);

    // Lås upp: nothing moves until Planera, which then takes it back to today.
    expect((await planningService.unlockOperation(a.op10.id, world.user.id)).operation).toEqual({
      plannedStartDate: "2030-03-07",
      plannedEndDate: "2030-03-07",
      planLocked: false,
    });
    expect(await planRows(a.op10.id)).toEqual([day("03-07")]);
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(a.op10.id)).toEqual([day("03-04")]);
    expect(await planRows(a.op20.id)).toEqual([day("03-05")]);

    // Locked again, then reported done: a done operation cannot be moved,
    // and the next Planera clears its days AND its lock (CHECK: no lock
    // without a plan) — Op 20 is now the first pending one, from today.
    await planningService.moveOperation(a.op10.id, { date: "2030-03-06", moveFollowing: true }, world.user.id);
    expect(await opRow(a.op10.id)).toMatchObject({ plannedStartDate: "2030-03-06", planLocked: true });
    await mfgService.reportOperationQuantities(a.op10.id, { quantityOk: 8, quantityScrapped: 0, markDone: true, createdBy: world.user.id });
    await expect(planningService.moveOperation(a.op10.id, { date: "2030-03-08", moveFollowing: true }, world.user.id)).rejects.toMatchObject({
      name: "OperationNotPlannableError",
      reason: "done",
    });
    await planningService.planProductionRun(world.user.id);
    expect(await planRows(a.op10.id)).toEqual([]);
    expect(await opRow(a.op10.id)).toMatchObject({ plannedStartDate: null, plannedEndDate: null, planLocked: false });
    expect(await planRows(a.op20.id)).toEqual([day("03-04")]);
  });

  it("without moveFollowing the later operations keep their days, and a move before the previous one is ready warns of a sequence break", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4); // 03-04…03-06 / 03-07…03-11
    const moved = await planningService.moveOperation(a.op10.id, { date: W3, moveFollowing: false }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartDate: "2030-03-18", plannedEndDate: "2030-03-20", planLocked: true });
    expect(moved.following).toEqual([]);
    expect(await planRows(a.op20.id)).toEqual([...full("03-07", "03-08"), day("03-11", 240)]);
    expect(await opRow(a.op20.id)).toMatchObject({ plannedStartDate: "2030-03-07", planLocked: false });
    // Op 20 (kept on 03-07) now starts before Op 10 is ready (03-20): a
    // sequence break, reported — never a refusal.
    expect(moved.warnings).toEqual([expect.objectContaining({ kind: "sequence", sequenceNo: 20, workCenterCode: "201" })]);

    // Moving Op 20 explicitly to 03-11 is still before Op 10 is ready.
    const second = await planningService.moveOperation(a.op20.id, { date: W2, moveFollowing: true }, world.user.id);
    expect(second.operation).toEqual({ plannedStartDate: "2030-03-11", plannedEndDate: "2030-03-13", planLocked: true });
    expect(second.warnings).toEqual([
      expect.objectContaining({ kind: "sequence", sequenceNo: 20, workCenterCode: "201" }),
    ]);
    // Planera reports the break too, and leaves both locked operations alone.
    const run = await planningService.planProductionRun(world.user.id);
    expect(run.warnings.map((w) => w.kind)).toEqual(["sequence"]);
    expect(await planRows(a.op10.id)).toEqual([...full("03-18", "03-19"), day("03-20", 240)]);
    expect(await planRows(a.op20.id)).toEqual([...full("03-11", "03-12"), day("03-13", 240)]);
  });

  it("a lego operation before the moved one keeps its place in the chain: Flytta and the next Planera count the same gaps, and a move to before the lego is back warns", async () => {
    const world = await seedWorld();
    const lego = await mfgService.createWorkCenter(
      parsed(createWorkCenterSchema, { code: "901", name: "Lack AB", type: "subcontract", leadTimeDays: 2, active: true })
    );
    const article = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `LEGO-${crypto.randomUUID().slice(0, 8)}`,
      name: "Lackerad först",
      type: "manufactured",
      active: true,
    }));
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: world.r1.id, setupTime: 0, runTimePerUnit: 60 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 30, workCenterId: world.r2.id, setupTime: 0, runTimePerUnit: 60 });
    // Standardkötid 0.5: rounded up on the accumulated sum, so the gap
    // before the SECOND operation in the chain waits a day and the gap
    // before the third none — the gap's ordinal decides the day.
    await db.insert(systemSettings).values({ key: "planning_queue_time_days", value: "0.5" });
    try {
      const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 4 }, world.user.id);
      const ops = await mfgService.listOperations(mo.id);
      const op20 = ops.find((o) => o.sequenceNo === 20)!;
      const op30 = ops.find((o) => o.sequenceNo === 30)!;
      // Sent today, back Wednesday 03-06; Op 20 after the first gap (a day's
      // queue): Friday 03-08; Op 30 after the second (none): Monday 03-11.
      expect(await planRows(op20.id)).toEqual([day("03-08", 240)]);
      expect(await planRows(op30.id)).toEqual([day("03-11", 240)]);

      // Op 20 to Tuesday 03-12 with the following: Op 30 is the THIRD in the
      // chain — the working day after, no queue day (Wednesday 03-13). With
      // the lego left out of the walk it was counted as the second (03-14).
      const moved = await planningService.moveOperation(op20.id, { date: "2030-03-12", moveFollowing: true }, world.user.id);
      expect(moved.warnings).toEqual([]);
      expect(moved.following).toEqual([expect.objectContaining({ sequenceNo: 30, plannedStartDate: "2030-03-13", plannedEndDate: "2030-03-13" })]);
      expect(await planRows(op30.id)).toEqual([day("03-13", 240)]);
      // … and the next Planera agrees: nothing moves.
      const run = await planningService.planProductionRun(world.user.id);
      expect(run.warnings).toEqual([]);
      expect(await planRows(op20.id)).toEqual([day("03-12", 240)]);
      expect(await planRows(op30.id)).toEqual([day("03-13", 240)]);

      // Op 20 to Tuesday 03-05 — before the lego is back (03-06): a sequence
      // break, reported by Flytta as by Planera.
      const early = await planningService.moveOperation(op20.id, { date: "2030-03-05", moveFollowing: false }, world.user.id);
      expect(early.operation).toEqual({ plannedStartDate: "2030-03-05", plannedEndDate: "2030-03-05", planLocked: true });
      expect(early.warnings).toEqual([expect.objectContaining({ kind: "sequence", sequenceNo: 20, workCenterCode: "101" })]);
      expect(await planRows(op30.id)).toEqual([day("03-13", 240)]);
      const again = await planningService.planProductionRun(world.user.id);
      expect(again.warnings).toEqual([expect.objectContaining({ kind: "sequence", sequenceNo: 20, workCenterCode: "101" })]);
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, "planning_queue_time_days"));
    }
  });

  it("refuses a day before today (400 plan-date-in-past), writing nothing", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4);
    await expect(planningService.moveOperation(a.op10.id, { date: "2030-03-01", moveFollowing: true }, world.user.id)).rejects.toBeInstanceOf(
      PlanDateInPastError
    );
    expect(await planRows(a.op10.id)).toEqual([...full("03-04", "03-05"), day("03-06", 240)]);
    expect(await opRow(a.op10.id)).toMatchObject({ plannedStartDate: "2030-03-04", planLocked: false });
    expect(auditEntries.some((e) => e.action === "operation_moved")).toBe(false);
  });

  it("refuses a day without capacity — a weekend, a röd dag — (409 plan-date-no-capacity), writing nothing", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4);
    const before = { op10: await planRows(a.op10.id), op20: await planRows(a.op20.id) };
    await db.insert(holidays).values({ date: "2030-03-13", name: "Röd dag" });
    for (const date of ["2030-03-09", "2030-03-10", "2030-03-13"]) {
      const refused = planningService.moveOperation(a.op10.id, { date, moveFollowing: true }, world.user.id);
      await expect(refused).rejects.toBeInstanceOf(PlanDateNoCapacityError);
      await expect(refused).rejects.toMatchObject({ date, workCenterCode: "101" });
    }
    expect(await planRows(a.op10.id)).toEqual(before.op10);
    expect(await planRows(a.op20.id)).toEqual(before.op20);
    expect(await opRow(a.op10.id)).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-06", planLocked: false });
    expect(auditEntries.some((e) => e.action === "operation_moved")).toBe(false);

    // The day before the röd dag has capacity: it starts there and goes on
    // past the holiday.
    const moved = await planningService.moveOperation(a.op10.id, { date: "2030-03-12", moveFollowing: true }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartDate: "2030-03-12", plannedEndDate: "2030-03-15", planLocked: true });
    expect(await planRows(a.op10.id)).toEqual([day("03-12"), day("03-14"), day("03-15", 240)]);
  });

  it("refuses what cannot be planned", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4);
    await expect(planningService.moveOperation(crypto.randomUUID(), { date: W2, moveFollowing: true }, world.user.id)).rejects.toBeInstanceOf(
      OperationNotFoundError
    );
    await expect(planningService.unlockOperation(crypto.randomUUID(), world.user.id)).rejects.toBeInstanceOf(OperationNotFoundError);
    await mfgService.reportOperationQuantities(a.op10.id, { quantityOk: 20, quantityScrapped: 0, markDone: true, createdBy: world.user.id });
    await expect(planningService.moveOperation(a.op10.id, { date: W2, moveFollowing: true }, world.user.id)).rejects.toMatchObject({
      name: "OperationNotPlannableError",
      reason: "done",
    });
    // A cancelled order's operation.
    const b = await createOrder(world, 20, W4);
    await mfgService.cancel(b.order.id);
    await expect(planningService.moveOperation(b.op10.id, { date: W2, moveFollowing: true }, world.user.id)).rejects.toBeInstanceOf(
      OperationNotPlannableError
    );
  });
});

describe("the written allocation", () => {
  // Routes whose times do not come out in whole hundredths of a minute: a
  // rest under 0.01 min used to become a row the CHECK (minutes > 0, two
  // decimals) refused — a 500 in Planera, Flytta and every TO creation.
  async function tinyArticle(world: Awaited<ReturnType<typeof seedWorld>>, runTimePerUnit: number) {
    const article = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `TINY-${crypto.randomUUID().slice(0, 8)}`,
      name: "Små minuter",
      type: "manufactured",
      active: true,
    }));
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: world.r1.id, setupTime: 0, runTimePerUnit });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: world.r2.id, setupTime: 0, runTimePerUnit });
    return article;
  }

  it("never writes a row under 0.01 min: a tiny rest joins the last whole piece, a tiny operation is cleared", async () => {
    const world = await seedWorld();
    // 40 h + 0.004 min on each resource: five rows of 480.00, not a sixth
    // day of 0.00.
    const nearlyWhole = await tinyArticle(world, 60.0001);
    const a = await mfgService.createManufacturingOrder({ articleId: nearlyWhole.id, quantity: 40, dueDate: W4 }, world.user.id);
    const aOps = await mfgService.listOperations(a.id);
    expect(a.releaseWarnings).toEqual([]);
    // Op 10 fills week 1, Op 20 (the working day after) week 2.
    expect(await planRows(aOps[0]!.id)).toEqual(week(W1));
    expect(await opRow(aOps[0]!.id)).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-08" });
    expect(await planRows(aOps[1]!.id)).toEqual(week(W2));
    expect(await opRow(aOps[1]!.id)).toMatchObject({ plannedStartDate: "2030-03-11", plannedEndDate: "2030-03-15" });
    // 3 × 0.0001 = 0.0003 min: nothing to plan — no row, no mirror, no error.
    const tiny = await tinyArticle(world, 0.0001);
    const b = await mfgService.createManufacturingOrder({ articleId: tiny.id, quantity: 3, dueDate: W4 }, world.user.id);
    const bOps = await mfgService.listOperations(b.id);
    expect(b.releaseWarnings).toEqual([]);
    for (const op of bOps) {
      expect(await planRows(op.id)).toEqual([]);
      expect(await opRow(op.id)).toMatchObject({ plannedStartDate: null, plannedEndDate: null, planLocked: false });
    }
    // Planera and Flytta on the same load go through too; the 0.0003-minute
    // operation is not plannable by hand (no time).
    const run = await planningService.planProductionRun(world.user.id);
    expect(run.warnings).toEqual([]);
    expect(await planRows(aOps[0]!.id)).toEqual(week(W1));
    const moved = await planningService.moveOperation(aOps[0]!.id, { date: W2, moveFollowing: true }, world.user.id);
    expect(moved.operation).toEqual({ plannedStartDate: "2030-03-11", plannedEndDate: "2030-03-15", planLocked: true });
    expect(await planRows(aOps[0]!.id)).toEqual(week(W2));
    await expect(planningService.moveOperation(bOps[0]!.id, { date: W2, moveFollowing: true }, world.user.id)).rejects.toMatchObject({
      name: "OperationNotPlannableError",
      reason: "no_time",
    });
    expect(await duplicateAllocations()).toEqual([]);
  });

  it("mirrors start/end from the written rows and stamps one plannedAt for the whole run", async () => {
    const world = await seedWorld();
    const orders = [await createOrder(world, 50, W4), await createOrder(world, 30, "2030-03-05"), await createOrder(world, 45, W3)];
    const run = await planningService.planProductionRun(world.user.id);
    expect(run.operations).toBe(6);
    const stamps = new Set<string>();
    for (const o of orders) {
      for (const op of [o.op10, o.op20]) {
        const rows = await planRows(op.id);
        const row = await opRow(op.id);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.minutes >= 0.01)).toBe(true);
        expect([row.plannedStartDate, row.plannedEndDate]).toEqual([rows[0]!.date, rows[rows.length - 1]!.date]);
        stamps.add(row.plannedAt!.toISOString());
      }
    }
    expect(stamps.size).toBe(1);
    expect([...stamps][0]).toBe(run.plannedAt);
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
    expect(await planRows(orders[1]!.op10.id)).toEqual(week(W1));
    expect(await planRows(orders[2]!.op10.id)).toEqual([...full("03-11", "03-12", "03-13"), day("03-14", 360)]);
    expect(await planRows(orders[0]!.op10.id)).toEqual([day("03-14", 120), day("03-15"), ...full("03-18", "03-19", "03-20"), day("03-21", 360)]);
  });

  it.each([["plan first"], ["create first"]])("Planera and a new TO at once (%s): the TO is planned exactly once", async (order) => {
    const world = await seedWorld();
    await createOrder(world, 40, W4);
    const plan = () => planningService.planProductionRun(world.user.id);
    const create = () => mfgService.createManufacturingOrder({ articleId: world.article.id, quantity: 20, dueDate: W3 }, world.user.id);
    // The order is made deterministic: a holder takes the plan lock, the
    // first contender queues on it, then the second, and the lock is
    // released — Postgres grants it in queue order. (Started together, the
    // creation sometimes beat Planera in "plan first", and Planera then
    // re-prioritised the new TO — week 1 where the test expected week 2.)
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('production_plan'))`);
      held();
      await gate;
    });
    await Promise.race([holding, holder]);
    const [startFirst, startSecond] = order === "plan first" ? [plan, create] : [create, plan];
    const first = startFirst();
    first.catch(() => {});
    let second: ReturnType<typeof startSecond> | undefined;
    try {
      await waitForLockWaiter();
      second = startSecond();
      second.catch(() => {});
      await waitForLockWaiter(10_000, 2);
    } finally {
      release();
    }
    await holder;
    const results = await Promise.all([first, second!]);
    const created = results.find((r): r is Awaited<ReturnType<typeof create>> => "orderNumber" in r)!;
    const ops = await mfgService.listOperations(created.id);
    for (const op of ops) {
      const rows = await planRows(op.id);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.reduce((sum, r) => sum + r.minutes, 0)).toBe(1200);
      expect(op.plannedStartDate).not.toBeNull();
    }
    expect(await duplicateAllocations()).toEqual([]);
    // Plan first: Planera never saw the new TO, which was then planned
    // against the existing one (week 1 full on R1 ⇒ from 03-11; week 2 full
    // on R2 ⇒ from 03-18). Create first: the TO was planned there and
    // Planera, right after, re-prioritised it — due sooner, it starts today.
    // Never planned twice either way.
    const behind = [[...full("03-11", "03-12"), day("03-13", 240)], [...full("03-18", "03-19"), day("03-20", 240)]];
    const first10 = [[...full("03-04", "03-05"), day("03-06", 240)], [...full("03-07", "03-08"), day("03-11", 240)]];
    expect(await Promise.all(ops.map((op) => planRows(op.id)))).toEqual(order === "plan first" ? behind : first10);
    await planningService.planProductionRun(world.user.id);
    expect(await Promise.all(ops.map((op) => planRows(op.id)))).toEqual(first10);
  });
});

describe("readers of the plan", () => {
  it("the terminal, the TO list and the operations list carry the planned days", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 60, "2030-03-05"); // 03-04…03-13 / 03-14…03-25, late
    const old = await unplannedMfgService.createManufacturingOrder({ articleId: world.article.id, quantity: 5, dueDate: W4 }, world.user.id);

    const { rows } = await mfgService.listTerminalOperations({});
    expect(rows.find((r) => r.operationId === a.op10.id)).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-13" });
    expect(rows.find((r) => r.operationId === a.op20.id)).toMatchObject({ plannedStartDate: "2030-03-14", plannedEndDate: "2030-03-25" });
    expect(rows.filter((r) => r.manufacturingOrderId === old.id).map((r) => r.plannedStartDate)).toEqual([null, null]);

    const list = await mfgService.listManufacturingOrders({ limit: 50, offset: 0 });
    expect(list.rows.find((r) => r.id === a.order.id)).toMatchObject({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-25", late: true });
    expect(list.rows.find((r) => r.id === old.id)).toMatchObject({ plannedStartDate: null, plannedEndDate: null, late: false });

    const ops = await mfgService.listOperations(a.order.id);
    expect(ops.map((o) => [o.sequenceNo, o.plannedStartDate, o.plannedEndDate, o.planLocked])).toEqual([
      [10, "2030-03-04", "2030-03-13", false],
      [20, "2030-03-14", "2030-03-25", false],
    ]);
  });

  it("a lego operation after an own one is back Ledtid + Kötid after the next working day (+ Standardkötid) — the same finish for the new TO, Sen and the matrix", async () => {
    const world = await seedWorld();
    const lego = await mfgService.createWorkCenter(
      parsed(createWorkCenterSchema, { code: "901", name: "Lack AB", type: "subcontract", leadTimeDays: 2, queueTimeDays: 1, active: true })
    );
    const article = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `LEGO-${crypto.randomUUID().slice(0, 8)}`,
      name: "Lackerad",
      type: "manufactured",
      active: true,
    }));
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: world.r1.id, setupTime: 0, runTimePerUnit: 60 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0 });
    // 8 h on R1 today; sent on Tuesday and back 2 + 1 working days later:
    // Friday 03-08 — exactly the due date, so not late.
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 8, dueDate: "2030-03-08" }, world.user.id);
    expect(mo.releaseWarnings.filter((w) => w.includes("efter färdigdatumet"))).toEqual([]);
    const summary = async () => (await planningService.orderPlanSummaries([mo.id])).get(mo.id);
    expect(await summary()).toEqual({ plannedStartDate: "2030-03-04", plannedEndDate: "2030-03-04", late: false, plannedFinish: "2030-03-08" });
    expect((await planningService.getCapacity({ weeks: 2 })).summary.lateOrders).toEqual([]);

    // One day of Standardkötid before the lego operation: sent Wednesday,
    // back Monday 03-11 — Sen, read with the setting of each read.
    await db.insert(systemSettings).values({ key: "planning_queue_time_days", value: "1" });
    try {
      expect(await summary()).toMatchObject({ late: true, plannedFinish: "2030-03-11" });
      expect((await planningService.getCapacity({ weeks: 2 })).summary.lateOrders).toEqual([
        { manufacturingOrderId: mo.id, orderNumber: mo.orderNumber, dueDate: "2030-03-08", plannedFinish: "2030-03-11" },
      ]);
      const run = await planningService.planProductionRun(world.user.id);
      expect(run.warnings).toEqual([expect.objectContaining({ kind: "late", manufacturingOrderId: mo.id, plannedFinish: "2030-03-11" })]);
    } finally {
      await db.delete(systemSettings).where(eq(systemSettings.key, "planning_queue_time_days"));
    }
  });

  it("Leveranstidskontrollen counts the planned load on its planned days", async () => {
    const world = await seedWorld();
    // A planned TO (on another article — the same article's TO would be
    // supply) fills R1 in week 1 and R2 in week 2 even though it is due in
    // week 4; an unplanned one counts on its due date and leaves week 1 free.
    await mfgService.createManufacturingOrder({ articleId: world.other.id, quantity: 40, dueDate: W4 }, world.user.id);
    const planned = await planningService.checkDeliveryTime({ rows: [{ articleId: world.article.id, quantity: 20 }] });
    const steps = planned.rows[0]!.chain.filter((s) => s.kind === "operation");
    // Op 10 after R1's full week; Op 20 the working day after it is ready,
    // but R2 is full that week ⇒ from Monday 03-18. Ready the day the last
    // minute is placed (2030-03-15, the week's Friday, before #18).
    expect(steps.map((s) => (s.kind === "operation" ? [s.sequenceNo, s.fromDate, s.toDate] : null))).toEqual([
      [10, "2030-03-11", "2030-03-13"],
      [20, "2030-03-18", "2030-03-20"],
    ]);
    expect(planned.rows[0]!.readyDate).toBe("2030-03-20");
    expect(planned.batches[0]!.operations.map((o) => o.days)).toEqual([
      [...full("03-11", "03-12"), day("03-13", 240)],
      [...full("03-18", "03-19"), day("03-20", 240)],
    ]);

    await db.execute(TRUNCATE);
    const world2 = await seedWorld();
    await unplannedMfgService.createManufacturingOrder({ articleId: world2.other.id, quantity: 40, dueDate: W4 }, world2.user.id);
    const unplanned = await planningService.checkDeliveryTime({ rows: [{ articleId: world2.article.id, quantity: 20 }] });
    const step = unplanned.rows[0]!.chain.find((s) => s.kind === "operation");
    expect(step && step.kind === "operation" ? step.fromDate : null).toBe(W1);
  });
});

describe("migration 0229", () => {
  it("enforces positive minutes, one row per day, start ≤ end, no lock and no run position without a plan — any weekday is allowed", async () => {
    const world = await seedWorld();
    const a = await createOrder(world, 20, W4);
    await expectConstraint(
      db.insert(moOperationPlanDays).values({ moOperationId: a.op10.id, planDate: W3, minutes: "0" }),
      "mo_operation_plan_days_minutes"
    );
    await expectConstraint(
      db.insert(moOperationPlanDays).values({ moOperationId: a.op10.id, planDate: W1, minutes: "5" }),
      "mo_operation_plan_days_operation_date"
    );
    await expectConstraint(
      db.update(moOperations).set({ plannedStartDate: W2, plannedEndDate: W1 }).where(eq(moOperations.id, a.op10.id)),
      "mo_operations_plan_dates"
    );
    await expectConstraint(
      db.update(moOperations).set({ plannedStartDate: W2, plannedEndDate: null }).where(eq(moOperations.id, a.op10.id)),
      "mo_operations_plan_dates"
    );
    await expectConstraint(
      db.update(moOperations).set({ plannedStartDate: null, plannedEndDate: null, planLocked: true }).where(eq(moOperations.id, a.op10.id)),
      "mo_operations_plan_locked"
    );
    await expectConstraint(db.update(moOperations).set({ runPosition: 0 }).where(eq(moOperations.id, a.op10.id)), "mo_operations_run_position");
    await expectConstraint(
      db.update(moOperations).set({ plannedStartDate: null, plannedEndDate: null, runPosition: 1 }).where(eq(moOperations.id, a.op10.id)),
      "mo_operations_run_position"
    );
    // No CHECK on the weekday: the resource's calendar decides.
    await db.insert(moOperationPlanDays).values({ moOperationId: a.op10.id, planDate: "2030-03-09", minutes: "10" });
    // The writer drops a run position when the start day changes, keeps it
    // when the operation lands on the same day again, and clears it with
    // the plan.
    await db.update(moOperations).set({ runPosition: 2 }).where(eq(moOperations.id, a.op10.id));
    await db.delete(moOperationPlanDays).where(and(eq(moOperationPlanDays.moOperationId, a.op10.id), eq(moOperationPlanDays.planDate, "2030-03-09")));
    const position = async () => (await db.select({ p: moOperations.runPosition }).from(moOperations).where(eq(moOperations.id, a.op10.id)))[0]!.p;
    await planningService.planProductionRun(world.user.id);
    expect(await position()).toBe(2);
    await planningService.moveOperation(a.op10.id, { date: W2, moveFollowing: true }, world.user.id);
    expect(await position()).toBeNull();
    // Deleting the operation's order takes the plan rows with it.
    await db.execute(sql`delete from manufacturing_orders where id = ${a.order.id}`);
    expect(await db.select().from(moOperationPlanDays).where(eq(moOperationPlanDays.moOperationId, a.op10.id))).toEqual([]);
  });
});
