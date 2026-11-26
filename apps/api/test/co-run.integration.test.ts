import { createArticleSchema, createWeekScheduleSchema, createWorkCenterSchema, coRunSchema, type CoRunInput } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, moOperations } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { lockProductionPlan } from "../src/modules/planning/repository/plan-lock.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import {
  CoRunChangedError,
  createPlanningService,
  OperationNotFoundError,
  OperationNotPlannableError,
  PlanDateInPastError,
  PlanDateNoCapacityError,
  RunPlanSubcontractResourceError,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Samkör against Postgres (spec 2026-11-26, etapp 2, step 2c): the selected
// operations are moved to ONE day with Flytta's rule, locked and laid next
// to each other after the day's already ordered ones — in one transaction
// under the production_plan lock — and the preview answers the same thing
// without writing. "Today" is pinned to Monday 2030-03-04, as in
// production-plan.integration.test.ts.
const MON = "2030-03-04";
const TUE = "2030-03-05";
const WED = "2030-03-06";
const THU = "2030-03-07";
const SAT = "2030-03-09";
let TODAY = MON;

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const auditEntries: { entityType: string; entityId: string | null | undefined; action: string; detail?: unknown }[] = [];

// The same late binding as app.ts: a new TO is planned in its own create
// transaction through the planning service, which is built after it.
const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  unwiredSalesOrderLinks,
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
      auditEntries.push({ entityType: entry.entityType, entityId: entry.entityId, action: entry.action, detail: entry.detail });
    },
  },
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  auditEntries.length = 0;
  TODAY = MON;
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function opRow(opId: string) {
  const [row] = await db
    .select({
      plannedStartDate: moOperations.plannedStartDate,
      plannedEndDate: moOperations.plannedEndDate,
      planLocked: moOperations.planLocked,
      runPosition: moOperations.runPosition,
    })
    .from(moOperations)
    .where(eq(moOperations.id, opId));
  return row!;
}

// Everything a co-run could write: the allocations, and the mirror columns,
// the lock, the place and planned_at of every operation.
async function planSnapshot() {
  const days = await db.execute(sql`SELECT mo_operation_id, plan_date::text, minutes::text FROM mo_operation_plan_days ORDER BY mo_operation_id, plan_date`);
  const mirror = await db.execute(
    sql`SELECT id, work_center_id, status, planned_start_date::text, planned_end_date::text, plan_locked, run_position, planned_at::text FROM mo_operations ORDER BY id`
  );
  return { days: [...days], mirror: [...mirror] };
}

// Two resources on a 40 h week (480-minute days, Mon–Fri) and a legoresurs.
// The article's route is Op 10 on 101, then Op 20 on 201, 60 min/st each,
// with one PURCHASED material (1 per st) linked to Op 10. Four TO:s of 4 st
// are planned as they are created, two a day on each resource:
//   A, B  Op 10 Monday,  Op 20 Tuesday
//   C, D  Op 10 Tuesday, Op 20 Wednesday
async function seedWorld() {
  const user = await authRepo.create({ email: `corun-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Planerare", role: "admin" });
  const daySchedule = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule(
    parsed(createWeekScheduleSchema, {
      code: "VS40",
      name: "Veckoschema 40h",
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: daySchedule.id })),
      active: true,
    })
  );
  const wc = (code: string, name: string) =>
    mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code, name, weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const r1 = await wc("101", "Kap");
  const r2 = await wc("201", "Svets");
  const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling AB", type: "subcontract", active: true }));
  const suffix = crypto.randomUUID().slice(0, 8);
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `SAMKOR-${suffix}`, name: "Samkörningsartikel", type: "manufactured", active: true })
  );
  const material = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `PLAT-${suffix}`, name: "Plåt 2 mm", type: "purchased", active: true })
  );
  const r10 = await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: r1.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: r2.id, setupTime: 0, runTimePerUnit: 60 });
  await articleService.addBomComponent(article.id, { componentArticleId: material.id, quantity: 1, routingOperationId: r10.id });

  const order = async () => {
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 4, dueDate: "2030-03-29" }, user.id);
    const ops = await mfgService.listOperations(mo.id);
    return { id: mo.id, orderNumber: mo.orderNumber, op10: ops.find((o) => o.sequenceNo === 10)!.id, op20: ops.find((o) => o.sequenceNo === 20)!.id };
  };
  const a = await order();
  const b = await order();
  const c = await order();
  const d = await order();
  expect(await Promise.all([a, b, c, d].map(async (o) => [(await opRow(o.op10)).plannedStartDate, (await opRow(o.op20)).plannedStartDate]))).toEqual([
    [MON, TUE],
    [MON, TUE],
    [TUE, WED],
    [TUE, WED],
  ]);
  return { user, r1, r2, lego, article, material, a, b, c, d };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

// A, C and B on Tuesday — C lies there already.
const tuesdayInput = (w: World) =>
  parsed(coRunSchema, {
    workCenterId: w.r1.id,
    date: TUE,
    operations: [
      { moOperationId: w.a.op10, plannedStartDate: MON },
      { moOperationId: w.c.op10, plannedStartDate: TUE },
      { moOperationId: w.b.op10, plannedStartDate: MON },
    ],
  });

describe("Samkör — skrivningen", () => {
  it("writes what the preview answered: the days, the locks and the block after the day's ordered operations", async () => {
    const w = await seedWorld();
    // The day is ordered by hand already: D first, then C. And the
    // operations that will follow have places on their own day.
    await planningService.setRunPlanOrder({ workCenterId: w.r1.id, date: TUE, moOperationIds: [w.d.op10, w.c.op10] }, w.user.id);
    await planningService.setRunPlanOrder({ workCenterId: w.r2.id, date: TUE, moOperationIds: [w.b.op20, w.a.op20] }, w.user.id);
    auditEntries.length = 0;
    const input = tuesdayInput(w);

    const before = await planSnapshot();
    const preview = (await planningService.previewCoRun(input))!;
    // The preview writes nothing and logs nothing.
    expect(await planSnapshot()).toEqual(before);
    expect(auditEntries).toEqual([]);

    expect(preview.workCenter).toEqual({ id: w.r1.id, code: "101", name: "Kap" });
    expect(preview.date).toBe(TUE);
    // In the order they were sent; the forced operations take the day whole.
    expect(preview.operations).toEqual([
      { moOperationId: w.a.op10, manufacturingOrderId: w.a.id, orderNumber: w.a.orderNumber, sequenceNo: 10, fromDate: MON, plannedStartDate: TUE, plannedEndDate: TUE, outcome: "moved" },
      { moOperationId: w.c.op10, manufacturingOrderId: w.c.id, orderNumber: w.c.orderNumber, sequenceNo: 10, fromDate: TUE, plannedStartDate: TUE, plannedEndDate: TUE, outcome: "already_on_day" },
      { moOperationId: w.b.op10, manufacturingOrderId: w.b.id, orderNumber: w.b.orderNumber, sequenceNo: 10, fromDate: MON, plannedStartDate: TUE, plannedEndDate: TUE, outcome: "moved" },
    ]);
    // Flyttas också: the moved orders' Op 20 leave Tuesday (the day after
    // their Op 10 is ready, on what 201 has free) — C's and D's are untouched.
    expect(preview.following.map((f) => [f.moOperationId, f.orderNumber, f.sequenceNo, f.workCenterCode, f.fromStartDate])).toEqual([
      [w.a.op20, w.a.orderNumber, 20, "201", TUE],
      [w.b.op20, w.b.orderNumber, 20, "201", TUE],
    ]);
    for (const f of preview.following) expect(f.plannedStartDate! > TUE).toBe(true);
    // Dagens last: C and D before (8 h of 8), all four afterwards.
    expect(preview.dayLoad).toEqual({
      before: { date: TUE, loadHours: 8, availableHours: 8, overloaded: false },
      after: { date: TUE, loadHours: 16, availableHours: 8, overloaded: true },
    });
    expect(preview.lateOrders).toEqual([]);
    // The three operations draw the same sheet: one group, summed (nothing in stock).
    expect(preview.materials).toEqual([
      {
        articleId: w.material.id,
        articleNumber: w.material.articleNumber,
        articleName: "Plåt 2 mm",
        unit: expect.anything(),
        totalRemainingQuantity: 12,
        usableOnHand: 0,
        short: true,
        rowKeys: [w.a.op10, w.c.op10, w.b.op10],
      },
    ]);
    // D keeps its first place; then the block in the order it was sent.
    expect(preview.runOrder).toEqual([
      { moOperationId: w.d.op10, orderNumber: w.d.orderNumber, sequenceNo: 10, selected: false },
      { moOperationId: w.a.op10, orderNumber: w.a.orderNumber, sequenceNo: 10, selected: true },
      { moOperationId: w.c.op10, orderNumber: w.c.orderNumber, sequenceNo: 10, selected: true },
      { moOperationId: w.b.op10, orderNumber: w.b.orderNumber, sequenceNo: 10, selected: true },
    ]);

    const result = (await planningService.coRun(input, w.user.id))!;
    expect(result).toEqual(preview);

    // The days are the ones the preview answered — also the following ones.
    for (const op of result.operations) {
      expect(await opRow(op.moOperationId)).toMatchObject({ plannedStartDate: op.plannedStartDate, plannedEndDate: op.plannedEndDate, planLocked: true });
    }
    for (const f of result.following) {
      // They lost their old place with their old day, and are not locked.
      expect(await opRow(f.moOperationId)).toEqual({ plannedStartDate: f.plannedStartDate, plannedEndDate: f.plannedEndDate, planLocked: false, runPosition: null });
    }
    // The one that already lay on the day kept its days — and stands in the block.
    expect(before.days.filter((r) => r.mo_operation_id === w.c.op10)).toEqual((await planSnapshot()).days.filter((r) => r.mo_operation_id === w.c.op10));
    expect(await Promise.all([w.d, w.a, w.c, w.b].map(async (o) => (await opRow(o.op10)).runPosition))).toEqual([1, 2, 3, 4]);
    // D was not selected: on the day, in its place, not locked.
    expect(await opRow(w.d.op10)).toMatchObject({ plannedStartDate: TUE, planLocked: false });
    // The körplan reads the block in order.
    const runPlan = (await planningService.getRunPlan({ workCenterId: w.r1.id, toDate: TUE }))!;
    expect(runPlan.rows.map((r) => [r.moOperationId, r.runPosition, r.planLocked])).toEqual([
      [w.d.op10, 1, false],
      [w.a.op10, 2, true],
      [w.c.op10, 3, true],
      [w.b.op10, 4, true],
    ]);

    // Händelseloggen: Flytta's event per MOVED operation, marked as a
    // co-run — none for the one already on the day — and one for the co-run.
    expect(auditEntries.filter((e) => e.action === "operation_moved")).toEqual(
      [w.a, w.b].map((o) => ({
        entityType: "manufacturing_order",
        entityId: o.orderNumber,
        action: "operation_moved",
        detail: {
          moOperationId: o.op10,
          sequenceNo: 10,
          workCenterCode: "101",
          fromDate: MON,
          toDate: TUE,
          plannedStartDate: TUE,
          plannedEndDate: TUE,
          moveFollowing: true,
          warnings: [],
          reason: "co_run",
        },
      }))
    );
    expect(auditEntries.filter((e) => e.entityType === "production_plan")).toEqual([
      {
        entityType: "production_plan",
        entityId: null,
        action: "co_run",
        detail: {
          workCenterCode: "101",
          date: TUE,
          operations: `${w.a.orderNumber} op 10, ${w.c.orderNumber} op 10, ${w.b.orderNumber} op 10`,
          moved: 2,
        },
      },
    ]);
    expect(auditEntries).toHaveLength(3);
  });

  it("Planera afterwards does not move the group; Lås upp → Planera releases it", async () => {
    const w = await seedWorld();
    await planningService.coRun(tuesdayInput(w), w.user.id);
    const group = [w.a, w.c, w.b];
    const groupRows = () => Promise.all(group.map((o) => opRow(o.op10)));
    const co = await groupRows();
    expect(co.map((r) => [r.plannedStartDate, r.planLocked, r.runPosition])).toEqual([
      [TUE, true, 1],
      [TUE, true, 2],
      [TUE, true, 3],
    ]);

    // Planera: the locked days lie fast — days, locks and places as they were.
    await planningService.planProductionRun(w.user.id);
    expect(await groupRows()).toEqual(co);

    // Lås upp: the days stay until the next Planera…
    for (const o of group) expect((await planningService.unlockOperation(o.op10, w.user.id)).operation.planLocked).toBe(false);
    expect((await groupRows()).map((r) => [r.plannedStartDate, r.planLocked])).toEqual(co.map((r) => [r.plannedStartDate, false]));
    // …which then lays the operations out on free capacity again: 12 h no
    // longer share an 8 h Tuesday.
    await planningService.planProductionRun(w.user.id);
    const released = await groupRows();
    expect(released.every((r) => !r.planLocked)).toBe(true);
    expect(released.filter((r) => r.plannedStartDate === TUE).length).toBeLessThan(3);
    const perDay = await db.execute<{ minutes: string }>(sql`
      SELECT sum(d.minutes)::text AS minutes FROM mo_operation_plan_days d
      JOIN mo_operations o ON o.id = d.mo_operation_id
      WHERE o.work_center_id = ${w.r1.id} GROUP BY d.plan_date`);
    for (const row of perDay) expect(Number(row.minutes)).toBeLessThanOrEqual(480);
  });

  it("an operation that was unplanned is moved, locked and placed like the others", async () => {
    const w = await seedWorld();
    // B loses its plan (an older order, never planned).
    await db.execute(sql`DELETE FROM mo_operation_plan_days WHERE mo_operation_id = ${w.b.op10}`);
    await db.execute(sql`UPDATE mo_operations SET planned_start_date = NULL, planned_end_date = NULL, planned_at = NULL WHERE id = ${w.b.op10}`);
    const result = (await planningService.coRun(
      parsed(coRunSchema, {
        workCenterId: w.r1.id,
        date: THU,
        operations: [
          { moOperationId: w.b.op10, plannedStartDate: null },
          { moOperationId: w.a.op10, plannedStartDate: MON },
        ],
      }),
      w.user.id
    ))!;
    expect(result.operations.map((o) => [o.fromDate, o.plannedStartDate, o.outcome])).toEqual([
      [null, THU, "moved"],
      [MON, THU, "moved"],
    ]);
    expect(result.dayLoad).toEqual({
      before: { date: THU, loadHours: 0, availableHours: 8, overloaded: false },
      after: { date: THU, loadHours: 8, availableHours: 8, overloaded: false },
    });
    expect([await opRow(w.b.op10), await opRow(w.a.op10)]).toEqual([
      { plannedStartDate: THU, plannedEndDate: THU, planLocked: true, runPosition: 1 },
      { plannedStartDate: THU, plannedEndDate: THU, planLocked: true, runPosition: 2 },
    ]);
  });
});

describe("Samkör — vägrar utan att skriva", () => {
  // Every refusal is tested on both the preview and the write, and leaves
  // the days, the locks, the places and the log as they were.
  async function refuses(w: World, input: CoRunInput, error: new (...args: never[]) => Error) {
    const before = await planSnapshot();
    auditEntries.length = 0;
    const request = parsed(coRunSchema, input);
    await expect(planningService.previewCoRun(request)).rejects.toBeInstanceOf(error);
    await expect(planningService.coRun(request, w.user.id)).rejects.toBeInstanceOf(error);
    expect(await planSnapshot()).toEqual(before);
    expect(auditEntries).toEqual([]);
  }
  const ops = (w: World, a: string | null = MON, b: string | null = MON) => [
    { moOperationId: w.a.op10, plannedStartDate: a },
    { moOperationId: w.b.op10, plannedStartDate: b },
  ];

  it("409 co-run-changed: another start day than the list showed", async () => {
    const w = await seedWorld();
    await refuses(w, { workCenterId: w.r1.id, date: WED, operations: ops(w, MON, TUE) }, CoRunChangedError);
    await refuses(w, { workCenterId: w.r1.id, date: WED, operations: ops(w, null, MON) }, CoRunChangedError);
    // Someone moved it in the meantime.
    await planningService.moveOperation(w.b.op10, { date: THU, moveFollowing: true }, w.user.id);
    await refuses(w, { workCenterId: w.r1.id, date: WED, operations: ops(w) }, CoRunChangedError);
  });

  it("409 co-run-changed: an operation on another resource", async () => {
    const w = await seedWorld();
    await refuses(
      w,
      { workCenterId: w.r1.id, date: WED, operations: [{ moOperationId: w.a.op10, plannedStartDate: MON }, { moOperationId: w.a.op20, plannedStartDate: TUE }] },
      CoRunChangedError
    );
  });

  it("409 co-run-changed: a finished operation, and an order that is no longer open", async () => {
    const w = await seedWorld();
    await db.update(moOperations).set({ status: "done" }).where(eq(moOperations.id, w.b.op10));
    await refuses(w, { workCenterId: w.r1.id, date: WED, operations: ops(w) }, CoRunChangedError);
    await db.update(moOperations).set({ status: "pending" }).where(eq(moOperations.id, w.b.op10));
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'done' WHERE id = ${w.b.id}`);
    await refuses(w, { workCenterId: w.r1.id, date: WED, operations: ops(w) }, CoRunChangedError);
  });

  it("409 plan-date-no-capacity: a day the resource does not work", async () => {
    const w = await seedWorld();
    await refuses(w, { workCenterId: w.r1.id, date: SAT, operations: ops(w) }, PlanDateNoCapacityError);
  });

  it("409 operation-not-plannable: a selected operation without time left", async () => {
    const w = await seedWorld();
    await db.update(moOperations).set({ runTimePerUnit: "0" }).where(eq(moOperations.id, w.b.op10));
    const before = await planSnapshot();
    const request = parsed(coRunSchema, { workCenterId: w.r1.id, date: WED, operations: ops(w) });
    await expect(planningService.coRun(request, w.user.id)).rejects.toMatchObject({ name: "OperationNotPlannableError", reason: "no_time" });
    await expect(planningService.previewCoRun(request)).rejects.toBeInstanceOf(OperationNotPlannableError);
    expect(await planSnapshot()).toEqual(before);
  });

  it("400 plan-date-in-past, 404 for an unknown operation, 400 for a legoresurs and null for an unknown resource", async () => {
    const w = await seedWorld();
    TODAY = WED;
    // A and B are Försenade now (planned on Monday): yesterday is refused, today is fine.
    await refuses(w, { workCenterId: w.r1.id, date: TUE, operations: ops(w) }, PlanDateInPastError);
    await refuses(
      w,
      { workCenterId: w.r1.id, date: THU, operations: [{ moOperationId: w.a.op10, plannedStartDate: MON }, { moOperationId: crypto.randomUUID(), plannedStartDate: null }] },
      OperationNotFoundError
    );
    await refuses(w, { workCenterId: w.lego.id, date: THU, operations: ops(w) }, RunPlanSubcontractResourceError);

    const before = await planSnapshot();
    const unknown = parsed(coRunSchema, { workCenterId: crypto.randomUUID(), date: THU, operations: ops(w) });
    expect(await planningService.previewCoRun(unknown)).toBeNull();
    expect(await planningService.coRun(unknown, w.user.id)).toBeNull();
    expect(await planSnapshot()).toEqual(before);

    const today = (await planningService.coRun(parsed(coRunSchema, { workCenterId: w.r1.id, date: WED, operations: ops(w) }), w.user.id))!;
    expect(today.operations.map((o) => [o.plannedStartDate, o.outcome])).toEqual([
      [WED, "moved"],
      [WED, "moved"],
    ]);
  });
});

describe("Samkör — samtidighet", () => {
  it("the write waits for the production_plan lock; the preview does not", async () => {
    const w = await seedWorld();
    const input = tuesdayInput(w);
    const before = await planSnapshot();
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    let locked!: () => void;
    const inside = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await lockProductionPlan(tx);
      locked();
      await holding;
    });
    await inside;
    let run: ReturnType<typeof planningService.coRun> | undefined;
    // Released even when something fails, so the open transaction never hangs the file.
    try {
      // The preview takes no lock: it answers while the plan is held.
      const preview = (await planningService.previewCoRun(input))!;
      expect(preview.operations.map((o) => o.outcome)).toEqual(["moved", "already_on_day", "moved"]);
      run = planningService.coRun(input, w.user.id);
      run.catch(() => {});
      await waitForLockWaiter();
      expect(await planSnapshot()).toEqual(before);
    } finally {
      open();
    }
    await holder;
    const result = (await run!)!;
    expect(result.operations.map((o) => o.plannedStartDate)).toEqual([TUE, TUE, TUE]);
    expect(await Promise.all([w.a, w.c, w.b].map(async (o) => (await opRow(o.op10)).runPosition))).toEqual([1, 2, 3]);
  });

  it("two co-runs of different operations to the same day serialise: two whole blocks, one after the other", async () => {
    const w = await seedWorld();
    const first = parsed(coRunSchema, {
      workCenterId: w.r1.id,
      date: TUE,
      operations: [{ moOperationId: w.a.op10, plannedStartDate: MON }, { moOperationId: w.c.op10, plannedStartDate: TUE }],
    });
    const second = parsed(coRunSchema, {
      workCenterId: w.r1.id,
      date: TUE,
      operations: [{ moOperationId: w.b.op10, plannedStartDate: MON }, { moOperationId: w.d.op10, plannedStartDate: TUE }],
    });
    const [x, y] = await Promise.all([planningService.coRun(first, w.user.id), planningService.coRun(second, w.user.id)]);
    expect([x!.operations.map((o) => o.plannedStartDate), y!.operations.map((o) => o.plannedStartDate)]).toEqual([
      [TUE, TUE],
      [TUE, TUE],
    ]);
    const rows = await Promise.all([w.a, w.c, w.b, w.d].map((o) => opRow(o.op10)));
    expect(rows.every((r) => r.plannedStartDate === TUE && r.planLocked)).toBe(true);
    // A,C then B,D — or B,D then A,C. Never a mix, never a place twice.
    expect([
      [1, 2, 3, 4],
      [3, 4, 1, 2],
    ]).toContainEqual(rows.map((r) => r.runPosition));
    // The one that ran last answered with the whole day's order.
    expect([x!.runOrder.length, y!.runOrder.length].sort()).toEqual([2, 4]);
  });

  it("the same co-run twice at once: one is written, the other finds the plan changed", async () => {
    const w = await seedWorld();
    const input = parsed(coRunSchema, {
      workCenterId: w.r1.id,
      date: WED,
      operations: [{ moOperationId: w.a.op10, plannedStartDate: MON }, { moOperationId: w.b.op10, plannedStartDate: MON }],
    });
    const outcomes = await Promise.allSettled([planningService.coRun(input, w.user.id), planningService.coRun(input, w.user.id)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(CoRunChangedError);
    expect([await opRow(w.a.op10), await opRow(w.b.op10)]).toEqual([
      { plannedStartDate: WED, plannedEndDate: WED, planLocked: true, runPosition: 1 },
      { plannedStartDate: WED, plannedEndDate: WED, planLocked: true, runPosition: 2 },
    ]);
    expect(auditEntries.filter((e) => e.action === "co_run")).toHaveLength(1);
  });
});
