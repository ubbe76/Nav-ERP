import { createArticleSchema, createWeekScheduleSchema, createWorkCenterSchema, stampOutSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, moOperationResources, moOperations, moReports, stampSessions, systemSettings } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { updateOperationInTx } from "../src/modules/manufacturing/repository/order-edit.js";
import {
  createManufacturingService,
  MoOperationResourceChangedError,
  MoOperationStampedError,
  WorkCenterInAlternativesError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService, type ManufacturingPlanReader } from "../src/modules/planning/service/planning.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { parsed } from "./helpers/parsed.js";

// Alternativa resurser (#15), etapp 1 — the TO side against Postgres: the
// snapshot at release (mo_operation_resources), Byt resurs through Ändra
// operationer (the row's times, Vald för hand, the invariant, a switch
// outside the rows, the replan, the terminal's station), the refusals and
// the race against an instämpling, and the costing that reads the TO's
// resource. The beredning's rules are in routing-alternatives.test.ts.
// "Today" is pinned to Monday 2030-03-04 like mo-edit.test.ts.
const W1 = "2030-03-04";
const W2 = "2030-03-11";
const W3 = "2030-03-18";
const TODAY = W1;

const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const auditRepository = createAuditRepository(db);
const periodLocks = { isDateLocked: async () => false };

const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
// How often the TO card asked for förslag (it must not read the load
// without an operation that could get one).
let suggestionReads = 0;
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
  periodLocks,
  undefined,
  {
    planNewOrderInTx: (tx, moId, given, opts) => planReaderRef.current!.planNewOrderInTx(tx, moId, given, opts),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
    operationResourceSuggestions: (moId) => {
      suggestionReads++;
      return planReaderRef.current!.operationResourceSuggestions!(moId);
    },
  }
);
const timeReportRepository = createTimeReportRepository(db);
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, periodLocks);
const timeReportService = createTimeReportService(timeReportRepository, mfgService, periodLocks, { log: async () => {} });
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
  audit: { log: async () => {} },
});
planReaderRef.current = planningService;
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => ({
    costingMaterialSource: "standard" as const,
    costingSupplierPriceTier: "base" as const,
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 0,
    costingMaterialMarkupPercent: 0,
  }),
});

const TRUNCATE = sql`TRUNCATE cost_calculations, mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, attendance_sessions, stamp_sessions, time_reports, employees, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  suggestionReads = 0;
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(eq(systemSettings.key, "planning_long_operation_weeks"));
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function opRow(opId: string) {
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, opId));
  return row!;
}

async function resourceRows(opId: string) {
  return db
    .select({
      workCenterId: moOperationResources.workCenterId,
      rank: moOperationResources.rank,
      setupTime: moOperationResources.setupTime,
      runTimePerUnit: moOperationResources.runTimePerUnit,
    })
    .from(moOperationResources)
    .where(eq(moOperationResources.moOperationId, opId))
    .orderBy(moOperationResources.rank);
}

async function operationView(moId: string, opId: string) {
  return (await mfgService.listOperations(moId)).find((op) => op.id === opId)!;
}

async function terminalOpIds(workCenterId: string) {
  return (await mfgService.listTerminalOperations({ workCenterIds: [workCenterId] })).rows.map((r) => r.operationId);
}

// Four own resources on a 40 h week — 110 Kantpress (600 kr/h), 120
// Kantpress 2 (300 kr/h), 130 Kantpress 3, 140 Svets — and a legoresurs.
// The parent's route: Op 10 on 110 (setup 10 min, 60 min/st) with the
// alternatives 120 (setup som ordinarie, 30 min/st) and 130 (setup 5,
// stycktid som ordinarie); Op 20 on 140 (no alternatives). The TO is 10 st,
// released and planned at creation.
// With `fill110` a TO of 40 h on 110 is released first: it fills W1, so the
// world's Op 10 is planned in W2 on a full 110 — while 120 and 130 are free.
async function seedWorld(opts: { inactiveAlternative?: boolean; fill110?: boolean } = {}) {
  const user = await authRepo.create({ email: `alt-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Planerare", role: "admin" });
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule(parsed(createWeekScheduleSchema, {
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  }));
  const wc = (code: string, name: string, hourlyRate: number) =>
    mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code, name, weekScheduleId: week.id, capacityFactor: 1, hourlyRate, overheadPercent: 0, active: true }));
  const r110 = await wc("110", "Kantpress", 600);
  const r120 = await wc("120", "Kantpress 2", 300);
  const r130 = await wc("130", "Kantpress 3", 450);
  const r140 = await wc("140", "Svets", 500);
  const r150 = await wc("150", "Gammal press", 500);
  const parent = await testArticleService.createArticle(parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID().slice(0, 6)}`, name: "Produkt", type: "manufactured", active: true }));
  const routing10 = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: r110.id,
    setupTime: 10,
    runTimePerUnit: 60,
    alternatives: [
      { workCenterId: r120.id, runTimePerUnit: 30 },
      { workCenterId: r130.id, setupTime: 5 },
      ...(opts.inactiveAlternative ? [{ workCenterId: r150.id }] : []),
    ],
  });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: r140.id, setupTime: 0, runTimePerUnit: 6 });
  // An alternative that went inactive after it was chosen stays in the
  // beredning but is no possible resource for a new TO.
  if (opts.inactiveAlternative) await mfgService.updateWorkCenter(r150.id, { active: false });
  let filler: { id: string } | null = null;
  if (opts.fill110) {
    const fillerArticle = await testArticleService.createArticle(parsed(createArticleSchema, { articleNumber: `F-${crypto.randomUUID().slice(0, 6)}`, name: "Fyllnad", type: "manufactured", active: true }));
    await mfgService.createRoutingOperation(fillerArticle.id, { sequenceNo: 10, workCenterId: r110.id, setupTime: 2400, runTimePerUnit: 0 });
    filler = await mfgService.createManufacturingOrder({ articleId: fillerArticle.id, quantity: 1 }, user.id);
  }
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 10 }, user.id);
  const ops = await mfgService.listOperations(order.id);
  return {
    user,
    r110,
    r120,
    r130,
    r140,
    r150,
    parent,
    routing10,
    filler,
    order,
    op10: ops.find((o) => o.sequenceNo === 10)!,
    op20: ops.find((o) => o.sequenceNo === 20)!,
  };
}

async function employee() {
  return timeReportService.createEmployee({ employeeNumber: `E${crypto.randomUUID().slice(0, 4)}`, name: "Urban", active: true });
}

describe("the snapshot at release", () => {
  it("gives an operation with alternatives rank 0 = the ordinarie and the alternatives with resolved times; one without gets none", async () => {
    const w = await seedWorld({ inactiveAlternative: true });
    expect(await resourceRows(w.op10.id)).toEqual([
      { workCenterId: w.r110.id, rank: 0, setupTime: "10.00", runTimePerUnit: "60.0000" },
      // 120: setup som ordinarie (10), its own 30 min/st.
      { workCenterId: w.r120.id, rank: 1, setupTime: "10.00", runTimePerUnit: "30.0000" },
      // 130: its own setup 5, stycktid som ordinarie (60). The inactive 150 is left out.
      { workCenterId: w.r130.id, rank: 2, setupTime: "5.00", runTimePerUnit: "60.0000" },
    ]);
    expect(await resourceRows(w.op20.id)).toEqual([]);
    // The list's shape: resources with code/name by rank, resourceLocked, on ordinarie.
    const view = await operationView(w.order.id, w.op10.id);
    expect(view).toMatchObject({ workCenterId: w.r110.id, resourceLocked: false });
    expect(view.resources).toEqual([
      { workCenterId: w.r110.id, code: "110", name: "Kantpress", rank: 0, setupTime: "10.00", runTimePerUnit: "60.0000" },
      { workCenterId: w.r120.id, code: "120", name: "Kantpress 2", rank: 1, setupTime: "10.00", runTimePerUnit: "30.0000" },
      { workCenterId: w.r130.id, code: "130", name: "Kantpress 3", rank: 2, setupTime: "5.00", runTimePerUnit: "60.0000" },
    ]);
    expect((await operationView(w.order.id, w.op20.id)).resources).toEqual([]);
  });

  it("is a snapshot: later beredning edits never touch a released TO, and a TO released after them takes the new set", async () => {
    const w = await seedWorld();
    await mfgService.updateRoutingOperation(w.parent.id, w.routing10.id, { setupTime: 20, alternatives: [{ workCenterId: w.r130.id }] });
    expect((await resourceRows(w.op10.id)).map((r) => r.workCenterId)).toEqual([w.r110.id, w.r120.id, w.r130.id]);
    const later = await mfgService.createManufacturingOrder({ articleId: w.parent.id, quantity: 1 }, w.user.id);
    const [op] = await mfgService.listOperations(later.id);
    expect(await resourceRows(op!.id)).toEqual([
      { workCenterId: w.r110.id, rank: 0, setupTime: "20.00", runTimePerUnit: "60.0000" },
      // Som ordinarie follows the changed ordinary setup time.
      { workCenterId: w.r130.id, rank: 1, setupTime: "20.00", runTimePerUnit: "60.0000" },
    ]);
  });

  it("gives an article without alternatives exactly today's TO: no rows anywhere", async () => {
    const user = await authRepo.create({ email: `alt-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "P", role: "admin" });
    const r = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "160", name: "Kap", active: true }));
    const parent = await testArticleService.createArticle(parsed(createArticleSchema, { articleNumber: `Q-${crypto.randomUUID().slice(0, 6)}`, name: "Q", type: "manufactured", active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: r.id, setupTime: 1, runTimePerUnit: 1 });
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 2 }, user.id);
    const [op] = await mfgService.listOperations(order.id);
    expect(op).toMatchObject({ workCenterId: r.id, resources: [], resourceLocked: false });
    expect(await db.select().from(moOperationResources)).toEqual([]);
  });
});

describe("Byt resurs — Ändra operationer", () => {
  it("a switch to an alternative takes the row's times, sets Vald för hand, keeps the rows, replans and logs before/after", async () => {
    const w = await seedWorld();
    // A locked plan: the switch drops the lock, the weeks were booked on 110.
    await planningService.moveOperation(w.op10.id, { weekMonday: W2, moveFollowing: true }, w.user.id);
    expect(await opRow(w.op10.id)).toMatchObject({ planLocked: true, plannedStartWeek: W2 });

    const { operation, warnings } = await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    expect(warnings).toEqual(expect.any(Array));
    expect(operation).toMatchObject({
      workCenterId: w.r120.id,
      workCenterCode: "120",
      setupTime: "10.00",
      runTimePerUnit: "30.0000",
      resourceLocked: true,
      planLocked: false,
      // Replanned on 120's free capacity: this week (10 + 30 × 10 = 310 min).
      plannedStartWeek: W1,
    });
    expect(operation.resources.map((r) => r.code)).toEqual(["110", "120", "130"]);
    expect(await resourceRows(w.op10.id)).toHaveLength(3);

    // The terminal's station follows the operation's resource.
    expect(await terminalOpIds(w.r120.id)).toContain(w.op10.id);
    expect(await terminalOpIds(w.r110.id)).not.toContain(w.op10.id);

    const [logged] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "manufacturing_order"), eq(auditLog.action, "operation_changed")));
    expect(logged!.detail).toMatchObject({
      sequenceNo: 10,
      workCenterCode: "120",
      before: { workCenterCode: "110", runTimePerUnit: 60, resourceLocked: false },
      after: { workCenterCode: "120", runTimePerUnit: 30, resourceLocked: true },
    });
  });

  it("switches back to the ordinarie with its times, and resourceLocked: false leaves it unchosen", async () => {
    const w = await seedWorld();
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r130.id }, w.user.id);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r130.id, setupTime: "5.00", runTimePerUnit: "60.0000", resourceLocked: true });
    const back = await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r110.id, resourceLocked: false }, w.user.id);
    expect(back.operation).toMatchObject({ workCenterId: w.r110.id, setupTime: "10.00", runTimePerUnit: "60.0000", resourceLocked: false });
    // The flag alone: set and cleared without a switch (Ändra's checkbox).
    expect((await mfgService.updateOperation(w.order.id, w.op10.id, { resourceLocked: true }, w.user.id)).operation.resourceLocked).toBe(true);
    expect((await mfgService.updateOperation(w.order.id, w.op10.id, { resourceLocked: false }, w.user.id)).operation.resourceLocked).toBe(false);
  });

  it("keeps the invariant: given times win over the row's and land on the row; a time change alone writes the current row", async () => {
    const w = await seedWorld();
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id, runTimePerUnit: 25 }, w.user.id);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r120.id, setupTime: "10.00", runTimePerUnit: "25.0000" });
    await mfgService.updateOperation(w.order.id, w.op10.id, { setupTime: 7 }, w.user.id);
    expect(await resourceRows(w.op10.id)).toEqual([
      { workCenterId: w.r110.id, rank: 0, setupTime: "10.00", runTimePerUnit: "60.0000" },
      { workCenterId: w.r120.id, rank: 1, setupTime: "7.00", runTimePerUnit: "25.0000" },
      { workCenterId: w.r130.id, rank: 2, setupTime: "5.00", runTimePerUnit: "60.0000" },
    ]);
    // Away and back again: the corrected times come back with the resource.
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r110.id }, w.user.id);
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    expect(await opRow(w.op10.id)).toMatchObject({ setupTime: "7.00", runTimePerUnit: "25.0000" });
  });

  it("a switch outside the rows removes them, and Vald för hand with them", async () => {
    const w = await seedWorld();
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    const out = await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r140.id }, w.user.id);
    // Outside the rows the times stay the operation's (as before #15).
    expect(out.operation).toMatchObject({ workCenterId: w.r140.id, runTimePerUnit: "30.0000", resourceLocked: false, resources: [] });
    expect(await resourceRows(w.op10.id)).toEqual([]);
    // The flag cannot be set on an operation without alternatives.
    expect((await mfgService.updateOperation(w.order.id, w.op10.id, { resourceLocked: true }, w.user.id)).operation.resourceLocked).toBe(false);
  });

  it("refuses the switch while someone is stamped in; after the stamp-out (reported time) it is allowed, and the time stays priced on 110", async () => {
    const w = await seedWorld();
    const worker = await employee();
    const session = await timeReportService.stampIn({ employeeId: worker.id, moOperationId: w.op10.id }, w.user.id);
    await expect(mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id)).rejects.toBeInstanceOf(
      MoOperationStampedError
    );
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r110.id, resourceLocked: false });
    // Two hours stamped on 110.
    await db.update(stampSessions).set({ startedAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(stampSessions.id, session.id));
    const out = await timeReportService.stampOut(session.id, parsed(stampOutSchema, {}), w.user.id);
    expect(out.timeReport).toMatchObject({ hours: "2.00", workCenterId: w.r110.id });
    const moved = await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    expect(moved.operation).toMatchObject({ workCenterCode: "120", resourceLocked: true });

    // The reported time keeps its resource (time_reports.work_center_id): the
    // efterkalkyl prices it at 110's 600 kr/h, not 120's 300, and new time at 120's.
    await timeReportService.createTimeReport({ employeeId: worker.id, moOperationId: w.op10.id, date: "2026-11-02", hours: 1 }, w.user.id);
    await mfgService.complete(w.order.id, { quantity: 10 }, w.user.id);
    const { calculation, analysis } = await costingService.postCalculate(w.order.id, true);
    expect(calculation.laborCost).toBe("1500.0000");
    const rows = analysis!.operationRows.filter((r) => r.sequenceNo === 10);
    expect(rows.map((r) => [r.workCenterCode, r.actual, r.kind === "time" && r.baseHourlyRate])).toEqual([
      ["110", 1200, 300],
      ["120", 300, 300],
    ]);
    // 110's rate difference over the 2 h is Timpris, on the 110 row.
    expect(rows.map((r) => r.parts.rate)).toEqual([600, 0]);
  });
});

describe("Planera", () => {
  it("never changes a resource, its times, the rows or Vald för hand — the switched operation is planned where it is", async () => {
    const w = await seedWorld();
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    const before = await opRow(w.op10.id);
    const rowsBefore = await resourceRows(w.op10.id);
    await planningService.planProductionRun(w.user.id);
    expect(await opRow(w.op10.id)).toMatchObject({
      workCenterId: w.r120.id,
      setupTime: before.setupTime,
      runTimePerUnit: before.runTimePerUnit,
      resourceLocked: true,
      plannedStartWeek: W1,
    });
    expect(await resourceRows(w.op10.id)).toEqual(rowsBefore);
    // An untouched operation with alternatives stays on its ordinarie too.
    const other = await mfgService.createManufacturingOrder({ articleId: w.parent.id, quantity: 1 }, w.user.id);
    const [op] = await mfgService.listOperations(other.id);
    await planningService.planProductionRun(w.user.id);
    expect(await opRow(op!.id)).toMatchObject({ workCenterId: w.r110.id, resourceLocked: false });
  });
});

describe("Byt resurs — against a concurrent instämpling", () => {
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => (open = resolve));
    return { promise, open };
  }
  const outcome = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).name);

  it("a switch that starts while an instämpling is uncommitted waits for it and is then refused (409)", async () => {
    const w = await seedWorld();
    const worker = await employee();
    const inserted = gate();
    const release = gate();
    // The instämpling's one INSERT (createStampSession), held open: its FK
    // takes FOR KEY SHARE on the operation, which Ändra's FOR UPDATE waits for.
    const stamp = db.transaction(async (tx) => {
      await tx.insert(stampSessions).values({ employeeId: worker.id, moOperationId: w.op10.id, createdBy: w.user.id });
      inserted.open();
      await release.promise;
    });
    await inserted.promise;
    const change = mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    // Released even when the wait fails, so the open transaction never hangs the file.
    await waitForLockWaiter().finally(release.open);
    const results = await Promise.allSettled([stamp, change]);
    expect(results.map(outcome)).toEqual(["ok", "MoOperationStampedError"]);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r110.id, resourceLocked: false });
  });

  it("an instämpling that starts during the switch waits for it and lands on the new resource", async () => {
    const w = await seedWorld();
    const worker = await employee();
    const switched = gate();
    const release = gate();
    // Ändra's own transaction body, held open after the switch.
    const change = db.transaction(async (tx) => {
      const result = await updateOperationInTx(tx, w.order.id, w.op10.id, { workCenterId: w.r120.id }, (t, id) => planningService.replanOrderInTx(t, id));
      switched.open();
      await release.promise;
      return result;
    });
    await switched.promise;
    const stamp = timeReportService.stampIn({ employeeId: worker.id, moOperationId: w.op10.id }, w.user.id);
    await waitForLockWaiter().finally(release.open);
    const results = await Promise.allSettled([change, stamp]);
    expect(results.map(outcome)).toEqual(["ok", "ok"]);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r120.id, resourceLocked: true });
    const [session] = await db.select().from(stampSessions).where(eq(stampSessions.moOperationId, w.op10.id));
    // The stamp's locked read waited for the switch: it records 120, and so
    // will its time report.
    expect(session).toMatchObject({ workCenterId: w.r120.id });
    expect(await terminalOpIds(w.r120.id)).toContain(w.op10.id);
  });
});

describe("the snapshot against a concurrent type change", () => {
  const outcome = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? "ok" : (r.reason as Error).name);

  it("a resource the TO is snapshotting cannot become lego meanwhile: the change waits for the TO and is then refused (409)", async () => {
    const w = await seedWorld();
    await mfgService.cancel(w.order.id, w.user.id); // its rows are history now
    let open!: () => void;
    const release = new Promise<void>((resolve) => (open = resolve));
    let snapshotted!: () => void;
    const inside = new Promise<void>((resolve) => (snapshotted = resolve));
    // A TO being created: its snapshot has written 120 among Op 10's rows
    // (uncommitted) and holds the resources FOR SHARE.
    let created!: { id: string };
    const creating = db.transaction(async (tx) => {
      created = await mfgService.createManufacturingOrderInTx(tx, { articleId: w.parent.id, quantity: 1 }, w.user.id);
      snapshotted();
      await release;
    });
    await inside;
    // Meanwhile the beredning drops its alternatives — 120 is no
    // beredningsalternativ any more, and the TO's rows are not committed.
    await mfgService.updateRoutingOperation(w.parent.id, w.routing10.id, { alternatives: [] });
    const typeChange = mfgService.updateWorkCenter(w.r120.id, { type: "subcontract" });
    // Released even when the wait fails, so the open transaction never hangs the file.
    await waitForLockWaiter().finally(open);
    const results = await Promise.allSettled([creating, typeChange]);
    // The type change waited for the TO, then found 120 among its rows.
    expect(results.map(outcome)).toEqual(["ok", WorkCenterInAlternativesError.name]);
    const op10 = (await mfgService.listOperations(created.id)).find((o) => o.sequenceNo === 10)!;
    expect(op10.resources.map((r) => r.code)).toEqual(["110", "120", "130"]);
    expect((await mfgService.getWorkCenter(w.r120.id))!.type).not.toBe("subcontract");
  });
});

describe("the costing reads the TO's resource", () => {
  it("prices the efterkalkyl and the variance base on the switched resource; the förkalkyl stays on the ordinarie", async () => {
    const w = await seedWorld();
    const worker = await employee();
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    await timeReportService.createTimeReport({ employeeId: worker.id, moOperationId: w.op10.id, date: "2026-11-02", hours: 2 }, w.user.id);
    await timeReportService.createTimeReport({ employeeId: worker.id, moOperationId: w.op20.id, date: "2026-11-02", hours: 1 }, w.user.id);
    await mfgService.complete(w.order.id, { quantity: 10 }, w.user.id);

    const { calculation, analysis } = await costingService.postCalculate(w.order.id, true);
    // 2 h on 120 (300 kr/h) + 1 h on 140 (500 kr/h).
    expect(calculation.laborCost).toBe("1100.0000");
    const row10 = analysis!.operationRows.find((r) => r.sequenceNo === 10)!;
    // The base is the TO's own operation (a changed TO is a new plan): 120's
    // times (10 + 30 × 10 = 310 min) at 120's rate at T₀ — no deviation
    // from the switch itself, only from the hours.
    expect(row10).toMatchObject({ kind: "time", workCenterCode: "120", baseRunHours: 5, baseHourlyRate: 300, hourlyRate: 300, actual: 600 });
    expect(row10.kind === "time" && row10.baseSetupHours).toBeCloseTo(10 / 60, 6);
    expect(row10.parts.rate).toBe(0);

    // The förkalkyl prices the routing's ordinarie: (10 + 60 × 10) / 60 h × 600 + Op 20 (0 + 6 × 10) / 60 × 500.
    const pre = await costingService.preCalculate(w.parent.id, 10);
    expect(pre.calculation.laborCost).toBe("6600.0000");
  });
});


// Etapp 2 — förslag på resurs against Postgres: derived at every read
// (resource-suggestions.ts), the same on the TO card, in Beläggning and in
// Planera's answer; Planera never switches; Byt till X (Ändra's PATCH with
// only workCenterId) follows the förslag, which then ends.
describe("förslag på resurs (etapp 2)", () => {
  // 110 is full in W1 (the filler), so Op 10 (610 min) is planned in W2. On
  // 120 (10 + 30 × 10 = 310 min) and 130 (5 + 60 × 10 = 605 min) it fits W1;
  // the same week, so rank 1 (120) wins.
  const expected = (w: Awaited<ReturnType<typeof seedWorld>>) => ({
    workCenterId: w.r120.id,
    code: "120",
    name: "Kantpress 2",
    toWeek: W1,
    currentToWeek: W2,
    reason: "overloaded",
  });
  const allOperations = () =>
    db
      .select({
        id: moOperations.id,
        workCenterId: moOperations.workCenterId,
        resourceLocked: moOperations.resourceLocked,
        setupTime: moOperations.setupTime,
        runTimePerUnit: moOperations.runTimePerUnit,
      })
      .from(moOperations)
      .orderBy(moOperations.id);

  it("is the same on the TO card, in Beläggning and in Planera's answer — and Planera never touches the resource", async () => {
    const w = await seedWorld({ fill110: true });
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r110.id, plannedStartWeek: W2, plannedEndWeek: W2 });

    // The TO card (seedWorld read it once already).
    suggestionReads = 0;
    const ops = await mfgService.listOperations(w.order.id);
    expect(ops.find((o) => o.id === w.op10.id)!.suggestion).toEqual(expected(w));
    expect(ops.find((o) => o.id === w.op20.id)!.suggestion).toBeNull();
    expect(suggestionReads).toBe(1);

    // Beläggning: on the operation's cell, in the summary's list.
    const capacity = await planningService.getCapacity({ weeks: 3 });
    const r110 = capacity.groups.flatMap((g) => g.resources).find((r) => r.workCenterId === w.r110.id)!;
    expect(r110.weeks[1]!.orders.find((o) => o.moOperationId === w.op10.id)).toMatchObject({
      resourceLocked: false,
      ordinaryWorkCenterCode: null,
      suggestion: expected(w),
    });
    const listed = {
      moOperationId: w.op10.id,
      manufacturingOrderId: w.order.id,
      orderNumber: w.order.orderNumber,
      sequenceNo: 10,
      fromWorkCenterId: w.r110.id,
      fromCode: "110",
      toWorkCenterId: w.r120.id,
      toCode: "120",
      toName: "Kantpress 2",
      currentToWeek: W2,
      toWeek: W1,
      reason: "overloaded",
    };
    expect(capacity.summary.resourceSuggestions).toEqual([listed]);

    // Planera: the same plan again, the förslag in its answer — and every
    // operation keeps its resource, times and Vald för hand.
    const before = await allOperations();
    const run = await planningService.planProductionRun(w.user.id);
    expect(run.resourceSuggestions).toEqual([listed]);
    expect(await allOperations()).toEqual(before);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r110.id, resourceLocked: false, plannedEndWeek: W2 });
    // The answer agrees with the plan it wrote, read back by the matrix.
    expect((await planningService.getCapacity({ weeks: 3 })).summary.resourceSuggestions).toEqual(run.resourceSuggestions);
  });

  it("Byt till X with only the resource follows the förslag: the suggested week, Vald för hand, and the förslag is gone", async () => {
    const w = await seedWorld({ fill110: true });
    const suggestion = (await operationView(w.order.id, w.op10.id)).suggestion!;
    const { operation } = await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: suggestion.workCenterId }, w.user.id);
    expect(operation).toMatchObject({
      workCenterId: w.r120.id,
      setupTime: "10.00",
      runTimePerUnit: "30.0000",
      resourceLocked: true,
      plannedEndWeek: suggestion.toWeek,
    });
    suggestionReads = 0;
    expect((await operationView(w.order.id, w.op10.id)).suggestion).toBeNull();
    // Vald för hand closes the gate: no load is read for the card.
    expect(suggestionReads).toBe(0);
    expect((await planningService.getCapacity({ weeks: 3 })).summary.resourceSuggestions).toEqual([]);
    // Planera keeps it on 120.
    expect((await planningService.planProductionRun(w.user.id)).resourceSuggestions).toEqual([]);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r120.id, resourceLocked: true });
  });

  it("only an untouched operation that is neither locked nor Vald för hand gets one", async () => {
    const w = await seedWorld({ fill110: true });
    const current = async () => (await operationView(w.order.id, w.op10.id)).suggestion;
    expect(await current()).toEqual(expected(w));

    // Flytta locks the weeks: the planner's decision. Lås upp brings it back.
    await planningService.moveOperation(w.op10.id, { weekMonday: W2, moveFollowing: true }, w.user.id);
    expect(await current()).toBeNull();
    await planningService.unlockOperation(w.op10.id, w.user.id);
    expect(await current()).toEqual(expected(w));

    // Vald för hand without a switch, then cleared again.
    await mfgService.updateOperation(w.order.id, w.op10.id, { resourceLocked: true }, w.user.id);
    expect(await current()).toBeNull();
    await mfgService.updateOperation(w.order.id, w.op10.id, { resourceLocked: false }, w.user.id);
    expect(await current()).toEqual(expected(w));

    // Rörd: a time report (no quantity, so the card's gate still asks).
    const worker = await employee();
    const report = await timeReportService.createTimeReport({ employeeId: worker.id, moOperationId: w.op10.id, date: "2030-03-04", hours: 1 }, w.user.id);
    suggestionReads = 0;
    expect(await current()).toBeNull();
    expect(suggestionReads).toBe(1);
    expect((await planningService.getCapacity({ weeks: 3 })).summary.resourceSuggestions).toEqual([]);
    await timeReportService.deleteTimeReport(report.id, w.user.id);
    expect(await current()).toEqual(expected(w));

    // Rapporterad: a reported quantity closes the card's gate before any load is read.
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 1, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    suggestionReads = 0;
    expect(await current()).toBeNull();
    expect(suggestionReads).toBe(0);
  });

  it("rörd through the report log (an undone report) or a stamp alone gives no förslag — on the card, in Beläggning and in Planera", async () => {
    const w = await seedWorld({ fill110: true });
    const current = async () => (await operationView(w.order.id, w.op10.id)).suggestion;
    const listed = async () => (await planningService.getCapacity({ weeks: 3 })).summary.resourceSuggestions;
    expect(await current()).toEqual(expected(w));

    // An undone report: the quantities are back at 0, the log row stays (mo_reports).
    const [report] = await db
      .insert(moReports)
      .values({ manufacturingOrderId: w.order.id, moOperationId: w.op10.id, kind: "operation", source: "terminal", undoneAt: new Date() })
      .returning({ id: moReports.id });
    expect(await current()).toBeNull();
    expect(await listed()).toEqual([]);
    expect((await planningService.planProductionRun(w.user.id)).resourceSuggestions).toEqual([]);
    await db.delete(moReports).where(eq(moReports.id, report!.id));
    expect(await current()).toEqual(expected(w));

    // A closed stamp whose time report is gone (stamp_sessions alone).
    const worker = await employee();
    await db.insert(stampSessions).values({ employeeId: worker.id, moOperationId: w.op10.id, stoppedAt: new Date(), createdBy: w.user.id });
    expect(await current()).toBeNull();
    expect(await listed()).toEqual([]);
    expect((await planningService.planProductionRun(w.user.id)).resourceSuggestions).toEqual([]);
  });

  it("after an overbooked previous operation the förslag starts where Planera puts it — Byt gives exactly the förslag's week", async () => {
    const w = await seedWorld();
    await mfgService.cancel(w.order.id, w.user.id); // the seed's TO is no load here
    const article = async (prefix: string) =>
      testArticleService.createArticle(parsed(createArticleSchema, { articleNumber: `${prefix}-${crypto.randomUUID().slice(0, 6)}`, name: prefix, type: "manufactured", active: true }));
    // 30 h on 140 and 80 h on 110 (W1–W2) come first.
    const f140 = await article("F140");
    await mfgService.createRoutingOperation(f140.id, { sequenceNo: 10, workCenterId: w.r140.id, setupTime: 1800, runTimePerUnit: 0 });
    await mfgService.createManufacturingOrder({ articleId: f140.id, quantity: 1 }, w.user.id);
    const f110 = await article("F110");
    await mfgService.createRoutingOperation(f110.id, { sequenceNo: 10, workCenterId: w.r110.id, setupTime: 4800, runTimePerUnit: 0 });
    await mfgService.createManufacturingOrder({ articleId: f110.id, quantity: 1 }, w.user.id);
    // The order: Op 10 on 140 (10 h) fills 140's W1; Op 20 on 110 (10 h),
    // 120 as an alternative, lands in W3 behind the 80 h.
    const product = await article("S");
    await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: w.r140.id, setupTime: 600, runTimePerUnit: 0 });
    await mfgService.createRoutingOperation(product.id, {
      sequenceNo: 20,
      workCenterId: w.r110.id,
      setupTime: 600,
      runTimePerUnit: 0,
      alternatives: [{ workCenterId: w.r120.id }],
    });
    const order = await mfgService.createManufacturingOrder({ articleId: product.id, quantity: 1 }, w.user.id);
    const [op10, op20] = await mfgService.listOperations(order.id);
    expect([op10!.plannedEndWeek, op20!.plannedEndWeek]).toEqual([W1, W3]);

    // 140 loses half its capacity: Op 10's stored W1 is overbooked now — the
    // 30 h ahead of it take W1's 20 h and 10 h of W2, so Planera puts Op 10
    // in W2. The förslag starts there: 120 in W2, not in W1 as a floor from
    // the stored week would promise.
    await mfgService.updateWorkCenter(w.r140.id, { capacityFactor: 0.5 });
    const suggestion = (await operationView(order.id, op20!.id)).suggestion;
    expect(suggestion).toMatchObject({ workCenterId: w.r120.id, toWeek: W2, currentToWeek: W3, reason: "overloaded" });

    // Byt till 120: the order is replanned with Planera's rules and lands in
    // exactly the förslag's week.
    const { operation } = await mfgService.updateOperation(
      order.id,
      op20!.id,
      { workCenterId: suggestion!.workCenterId, expectedWorkCenterId: w.r110.id },
      w.user.id
    );
    expect(operation).toMatchObject({ workCenterId: w.r120.id, resourceLocked: true, plannedEndWeek: suggestion!.toWeek });
    expect(await opRow(op10!.id)).toMatchObject({ plannedStartWeek: W2, plannedEndWeek: W2 });
  });

  it("Byt till X sends its precondition: a moved operation, or one on another resource since, is refused and nothing changes", async () => {
    const w = await seedWorld({ fill110: true });
    const byt = (expectedWorkCenterId: string) =>
      mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id, expectedWorkCenterId }, w.user.id);
    // Flyttad since the förslag was read: the weeks are the planner's decision.
    await planningService.moveOperation(w.op10.id, { weekMonday: W2, moveFollowing: true }, w.user.id);
    await expect(byt(w.r110.id)).rejects.toBeInstanceOf(MoOperationResourceChangedError);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r110.id, planLocked: true, resourceLocked: false });
    // Ändra without the precondition still switches the locked operation:
    // someone switches it to 130 meanwhile, and it loses the lock.
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r130.id }, w.user.id);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r130.id, resourceLocked: true, planLocked: false });
    await expect(byt(w.r110.id)).rejects.toBeInstanceOf(MoOperationResourceChangedError);
    expect(await opRow(w.op10.id)).toMatchObject({ workCenterId: w.r130.id, resourceLocked: true });
    // On the resource it expects, unlocked: the switch goes through.
    const { operation } = await byt(w.r130.id);
    expect(operation).toMatchObject({ workCenterId: w.r120.id, setupTime: "10.00", runTimePerUnit: "30.0000", resourceLocked: true });
  });

  it("the TO card reads no load for an order without an operation that could get one", async () => {
    const w = await seedWorld();
    const plain = await mfgService.createManufacturingOrder({ articleId: w.parent.id, quantity: 1 }, w.user.id);
    suggestionReads = 0;
    // Without the filler 110 is not full: the card asks, Valregeln says no.
    expect((await mfgService.listOperations(w.order.id)).map((o) => o.suggestion)).toEqual([null, null]);
    expect(suggestionReads).toBe(1);
    // An order with Op 10 Vald för hand (its other operation has no alternatives): no read at all.
    await mfgService.updateOperation(plain.id, (await mfgService.listOperations(plain.id))[0]!.id, { resourceLocked: true }, w.user.id);
    suggestionReads = 0;
    expect((await mfgService.listOperations(plain.id)).every((o) => o.suggestion === null)).toBe(true);
    expect(suggestionReads).toBe(0);
  });
});
