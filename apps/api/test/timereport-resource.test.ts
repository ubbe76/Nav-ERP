import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { attendanceSessions, db, stampSessions, timeReports } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createWorkInProgressService } from "../src/modules/costing/service/work-in-progress.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { updateOperationInTx } from "../src/modules/manufacturing/repository/order-edit.js";
import {
  createManufacturingService,
  WorkCenterInAlternativesError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { remainingOperationMinutes } from "../src/modules/planning/service/capacity-calc.js";
import { createPlanningService, type ManufacturingPlanReader } from "../src/modules/planning/service/planning.service.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import type { AnalysisWorkCenterRow } from "../src/modules/reports/service/calc-outcome-calc.js";
import { createReportsService } from "../src/modules/reports/service/reports.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { ExchangeRateUnavailableError } from "../src/modules/system/service/exchange-rates.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import {
  createTimeReportService,
  StampWorkCenterChangedError,
} from "../src/modules/timereport/service/timereport.service.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Alternativa resurser (#15), granskningen av etapp 1 — a time report keeps
// the resource it was worked on (migration 0192), so a Byt resurs after
// reported time no longer reprices it. Against Postgres:
// - every path that materializes a time report writes the resource;
// - the efterkalkyl, Produkter i arbete per a date before the switch, the
//   avvikelseanalys (Timpris, exact sum) and Kalkylutfall Resurs;
// - a report from before 0192 (null) counts on the current resource;
// - the new resource's setup is planned after the switch;
// - a resource in alternatives cannot become lego (409), a stale terminal
//   list cannot stamp on the old station (409);
// - the routing lock no longer blocks a TO being created, and a type change
//   waits for a routing edit that reads the resource.

const TODAY = "2030-03-04";
const audit = { log: async () => {} };
const periodLocks = { isDateLocked: async () => false };
const authRepo = createAuthRepository(db);
const salesRepository = createSalesRepository(db);
const manufacturingRepository = createManufacturingRepository(db);

const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
const mfgService = createManufacturingService(
  manufacturingRepository,
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  createAuditRepository(db),
  undefined,
  periodLocks,
  undefined,
  {
    planNewOrderInTx: (tx, moId, given, opts) => planReaderRef.current!.planNewOrderInTx(tx, moId, given, opts),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
  }
);
const timeReportRepository = createTimeReportRepository(db);
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, periodLocks);
const timeReportService = createTimeReportService(timeReportRepository, mfgService, periodLocks, audit);
const planningRepository = createPlanningRepository(db);
const planningService = createPlanningService(planningRepository, {
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
const costingSettings = {
  costingMaterialSource: "standard" as const,
  costingSupplierPriceTier: "base" as const,
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
  costingMaterialMarkupPercent: 0,
};
const costingService = createCostingService(createCostingRepository(db), { getSettings: async () => costingSettings });
const reportsService = createReportsService(createReportsRepository(db), costingService);
const wipService = createWorkInProgressService({
  db,
  settings: { getSettings: async () => costingSettings },
  rates: {
    getRate: async (currency, date) => {
      throw new ExchangeRateUnavailableError(currency, date);
    },
  },
});

const TRUNCATE = sql`TRUNCATE cost_calculations, mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, attendance_sessions, stamp_sessions, time_reports, employees, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

// The resources of the task's example on a 40 h week — 110 Kantpress
// (600 kr/h), 120 Kantpress 2 (300 kr/h), 130 Kantpress 3 (450), 140 Svets
// (500), 150 Gammal press (no alternative anywhere). Op 10 on 110 (setup 10
// min, 60 min/st) with the alternatives 120 (30 min/st) and 130 (setup 5);
// Op 20 on 140 (6 min/st). The TO is 10 st.
async function seedWorld() {
  const user = await authRepo.create({ email: `tr-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Planerare", role: "admin" });
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule({
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  });
  const wc = (code: string, name: string, hourlyRate: number) =>
    mfgService.createWorkCenter({ code, name, weekScheduleId: week.id, capacityFactor: 1, hourlyRate, overheadPercent: 0, active: true });
  const r110 = await wc("110", "Kantpress", 600);
  const r120 = await wc("120", "Kantpress 2", 300);
  const r130 = await wc("130", "Kantpress 3", 450);
  const r140 = await wc("140", "Svets", 500);
  const r150 = await wc("150", "Gammal press", 500);
  const parent = await testArticleService.createArticle({ articleNumber: `P-${crypto.randomUUID().slice(0, 6)}`, name: "Produkt", type: "manufactured", unit: "st", active: true });
  const routing10 = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: r110.id,
    setupTime: 10,
    runTimePerUnit: 60,
    alternatives: [{ workCenterId: r120.id, runTimePerUnit: 30 }, { workCenterId: r130.id, setupTime: 5 }],
  });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: r140.id, setupTime: 0, runTimePerUnit: 6 });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 10 }, user.id);
  const ops = await mfgService.listOperations(order.id);
  const worker = await timeReportService.createEmployee({ employeeNumber: `E${crypto.randomUUID().slice(0, 4)}`, name: "Urban", active: true });
  return {
    user,
    worker,
    r110,
    r120,
    r130,
    r140,
    r150,
    parent,
    routing10,
    order,
    op10: ops.find((o) => o.sequenceNo === 10)!,
    op20: ops.find((o) => o.sequenceNo === 20)!,
  };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

function manual(w: World, moOperationId: string, date: string, hours: number) {
  return timeReportService.createTimeReport({ employeeId: w.worker.id, moOperationId, date, hours }, w.user.id);
}

async function reportResource(id: string) {
  const [row] = await db.select({ workCenterId: timeReports.workCenterId }).from(timeReports).where(eq(timeReports.id, id));
  return row!.workCenterId;
}

async function reportResources(moOperationId: string) {
  const rows = await db.select({ workCenterId: timeReports.workCenterId }).from(timeReports).where(eq(timeReports.moOperationId, moOperationId));
  return rows.map((r) => r.workCenterId);
}

// The plan's view of an operation: its remaining minutes as Beläggning and
// the lead-time dating count them, from both loaders.
async function remainingMinutes(w: World, moOperationId: string) {
  const capacity = await planningRepository.loadCapacityInput("2030-01-01", "2030-12-31");
  const dating = await planningRepository.loadMoDatingInputs({ orderIds: [w.order.id], articleIds: [] });
  const fromCapacity = remainingOperationMinutes(capacity.operations.find((op) => op.moOperationId === moOperationId)!);
  const fromDating = remainingOperationMinutes(dating.operations.find((op) => op.moOperationId === moOperationId)!);
  expect(fromDating).toBe(fromCapacity);
  return fromCapacity;
}

async function wipLabor(asOf: string) {
  const report = await wipService.getWorkInProgress({ asOf, basis: "direct" });
  return report.rows[0]?.labor ?? 0;
}

describe("a Byt resurs after reported time (the task's example)", () => {
  it("prices each report on the resource it was worked on: efterkalkyl, PIA per a date before the switch, avvikelseanalys and Kalkylutfall Resurs", async () => {
    const w = await seedWorld();
    // October on 110: 5 h (3 + 2) and 5 st OK.
    await manual(w, w.op10.id, "2026-10-05", 3);
    await manual(w, w.op10.id, "2026-10-06", 2);
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 5, quantityScrapped: 0, markDone: false, createdBy: w.user.id, source: "card" });
    expect(await reportResources(w.op10.id)).toEqual([w.r110.id, w.r110.id]);
    // 5 h × 600 on 110.
    expect(await wipLabor("2026-10-31")).toBe(3000);
    // 110 has worked the operation: its setup is done, 5 st × 60 min left.
    expect(await remainingMinutes(w, w.op10.id)).toBe(300);

    // November: the planner moves the operation to 120.
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    // PIA per a date before the switch is unchanged (a booked bokslut stays current).
    expect(await wipLabor("2026-10-31")).toBe(3000);
    // 120 has not been set up: its setup (10 min) is planned on top of 5 st × 30 min.
    expect(await remainingMinutes(w, w.op10.id)).toBe(160);

    // 2 h on 120 and 1 h on Op 20 (140).
    await manual(w, w.op10.id, "2026-11-03", 2);
    await manual(w, w.op20.id, "2026-11-03", 1);
    expect(await reportResources(w.op10.id)).toEqual([w.r110.id, w.r110.id, w.r120.id]);
    // Now 120 has worked it too: its setup is done.
    expect(await remainingMinutes(w, w.op10.id)).toBe(150);
    // 3000 on 110 + 2 × 300 on 120 + 1 × 500 on 140.
    expect(await wipLabor("2026-11-05")).toBe(4100);

    await mfgService.complete(w.order.id, { quantity: 10 }, w.user.id);
    const { calculation, analysis } = await costingService.postCalculate(w.order.id, true);
    // Not 7 h × 300 = 2100 for Op 10: 5 h at 110's rate, 2 h at 120's.
    expect(calculation.laborCost).toBe("4100.0000");
    const op10 = analysis!.operationRows.filter((r) => r.sequenceNo === 10);
    expect(op10.map((r) => [r.workCenterCode, r.kind === "time" && r.hours, r.actual])).toEqual([
      ["110", 5, 3000],
      ["120", 2, 600],
    ]);
    const [on110, on120] = op10 as Extract<(typeof op10)[number], { kind: "time" }>[];
    // The base stays the operation's on its current resource — 120's times
    // (10 + 30 × 10 min) at 120's R₀ — and the time worked on 110 is valued
    // at that R₀ too: the rate difference (600 − 300) × 5 h is Timpris.
    expect(on120).toMatchObject({ baseRunHours: 5, baseHourlyRate: 300, hourlyRate: 300, base: 1550 });
    expect(on120!.baseSetupHours).toBeCloseTo(10 / 60, 6);
    expect(on120!.parts).toMatchObject({ rate: 0, unclassified: 600 - 1550 });
    expect(on110).toMatchObject({ baseSetupHours: 0, baseRunHours: 0, baseHourlyRate: 300, hourlyRate: 600, base: 0 });
    expect(on110!.parts).toMatchObject({ rate: 1500, unclassified: 1500 });
    // The order: Kalkylerat 1550 + 500, Utfall 4100; the parts sum exactly.
    expect(analysis).toMatchObject({ base: 2050, actual: 4100, deviation: 2050 });
    const p = analysis!.parts;
    expect(Math.round((p.price + p.quantity + p.rate + p.setup + p.run + p.unclassified + p.markups) * 100)).toBe(205000);
    expect(p.rate).toBe(1500);

    // Kalkylutfall Resurs puts the hours (and their kronor) on the resource they were worked on.
    const byResource = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "workCenter" });
    if (byResource.view !== "analysis") throw new Error("view");
    const rows = byResource.rows as AnalysisWorkCenterRow[];
    expect(rows.map((r) => [r.workCenterCode, r.hours, r.baseRunHours])).toEqual([
      ["110", 5, 0],
      ["120", 2, 5],
      ["140", 1, 1],
    ]);
    expect(rows[0]).toMatchObject({ timeDeviation: 3000, actual: 3000 });
    expect(rows[0]!.parts.rate).toBe(1500);
    expect(byResource.totals).toMatchObject({ base: 2050, actual: 4100, deviation: 2050 });
    expect(byResource.kpis).toMatchObject({ deviation: 2050, time: 2050 });

    // Preview = saved: the same rows in the same order, and the same analysis.
    const preview = await costingService.postCalculate(w.order.id);
    expect(preview.analysis!.operationRows.map((r) => [r.workCenterCode, r.actual, r.parts])).toEqual(
      analysis!.operationRows.map((r) => [r.workCenterCode, r.actual, r.parts])
    );
  });

  it("counts a report from before 0192 (no resource) on the operation's current resource, as before", async () => {
    const w = await seedWorld();
    const old = await manual(w, w.op10.id, "2026-10-05", 2);
    await db.update(timeReports).set({ workCenterId: null }).where(eq(timeReports.id, old.id));
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    // The plan counts it as worked on the current resource: 120's setup is
    // done, 10 st × 30 min left.
    expect(await remainingMinutes(w, w.op10.id)).toBe(300);
    await mfgService.complete(w.order.id, { quantity: 10 }, w.user.id);
    const { analysis } = await costingService.postCalculate(w.order.id, true);
    const op10 = analysis!.operationRows.filter((r) => r.sequenceNo === 10);
    // One row, on 120, at 120's rate — today's rule for an unknown resource.
    expect(op10.map((r) => [r.workCenterCode, r.kind === "time" && r.hours, r.actual])).toEqual([["120", 2, 600]]);
    expect(await wipLabor("2026-10-31")).toBe(600);
    // The time list shows the operation's resource for it.
    const [listed] = await timeReportService.listTimeReportsByManufacturingOrder(w.order.id);
    expect(listed).toMatchObject({ workCenterId: null, workCenterName: "Kantpress 2" });
  });
});

describe("every path that materializes a time report writes the resource", () => {
  it("the terminal's stamp-out and a Sluttid carry the stamp's resource; a manual report takes the operation's", async () => {
    const w = await seedWorld();
    const stamped = await timeReportService.stampIn({ employeeId: w.worker.id, moOperationId: w.op10.id }, w.user.id);
    expect(stamped.workCenterId).toBe(w.r110.id);
    const out = await timeReportService.stampOut(stamped.id, {}, w.user.id);
    expect(out.timeReport.workCenterId).toBe(w.r110.id);

    // Sluttid (a supervisor's stop time) on Op 20.
    const onOp20 = await timeReportService.stampIn({ employeeId: w.worker.id, moOperationId: w.op20.id }, w.user.id);
    await db.update(stampSessions).set({ startedAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(stampSessions.id, onOp20.id));
    const sluttid = await timeReportService.stampOut(onOp20.id, { stoppedAt: new Date(Date.now() - 3_600_000).toISOString() }, w.user.id);
    expect(sluttid.timeReport).toMatchObject({ hours: "1.00", workCenterId: w.r140.id });

    // Manual (POST /time-reports, TO-kortets Rapportera tid) after a switch: the operation's resource now.
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    expect((await manual(w, w.op10.id, "2026-11-02", 1)).workCenterId).toBe(w.r120.id);
  });

  it("the automatic stamp-out (an operation turning done, Slutför order) carries the stamp's resource", async () => {
    const w = await seedWorld();
    const other = await timeReportService.createEmployee({ employeeNumber: "E2", name: "Signe", active: true });
    // Signe on Op 10: Urban reports it done, which stamps her out (regel 10).
    const hers = await timeReportService.stampIn({ employeeId: other.id, moOperationId: w.op10.id }, w.user.id);
    await mfgService.reportOperationQuantities(w.op10.id, { quantityOk: 10, quantityScrapped: 0, markDone: true, createdBy: w.user.id, source: "card" });
    const [closed] = await db.select().from(stampSessions).where(eq(stampSessions.id, hers.id));
    expect(closed!.timeReportId).not.toBeNull();
    expect(await reportResource(closed!.timeReportId!)).toBe(w.r110.id);

    // Urban on Op 20: Slutför order stamps him out.
    const his = await timeReportService.stampIn({ employeeId: w.worker.id, moOperationId: w.op20.id }, w.user.id);
    await mfgService.complete(w.order.id, { quantity: 10 }, w.user.id);
    const [stopped] = await db.select().from(stampSessions).where(eq(stampSessions.id, his.id));
    expect(await reportResource(stopped!.timeReportId!)).toBe(w.r140.id);

    // Efterrapportering on the Klar order (Rapportera tid on the card).
    expect((await manual(w, w.op20.id, "2026-11-04", 0.5)).workCenterId).toBe(w.r140.id);
  });

  it("a stamp opened before 0192 (no resource) takes the operation's resource at the stop — the terminal's and the automatic one", async () => {
    const w = await seedWorld();
    const [legacy10] = await db
      .insert(stampSessions)
      .values({ employeeId: w.worker.id, moOperationId: w.op10.id, createdBy: w.user.id })
      .returning();
    const other = await timeReportService.createEmployee({ employeeNumber: "E3", name: "Vera", active: true });
    const [legacy20] = await db
      .insert(stampSessions)
      .values({ employeeId: other.id, moOperationId: w.op20.id, createdBy: w.user.id, pausedAt: new Date() })
      .returning();
    expect([legacy10!.workCenterId, legacy20!.workCenterId]).toEqual([null, null]);
    const out = await timeReportService.stampOut(legacy10!.id, {}, w.user.id);
    expect(out.timeReport.workCenterId).toBe(w.r110.id);
    await mfgService.complete(w.order.id, { quantity: 10 }, w.user.id);
    const [stopped] = await db.select().from(stampSessions).where(eq(stampSessions.id, legacy20!.id));
    expect(await reportResource(stopped!.timeReportId!)).toBe(w.r140.id);
  });

  it("a PATCH of a time report never sets a resource", async () => {
    const w = await seedWorld();
    const report = await manual(w, w.op10.id, "2026-11-02", 1);
    const updated = await timeReportService.updateTimeReport(report.id, { hours: 2, workCenterId: w.r120.id } as never, w.user.id);
    expect(updated).toMatchObject({ hours: "2.00", workCenterId: w.r110.id });
  });
});

describe("Terminalens gamla lista — the instämpling names the station", () => {
  it("refuses a stamp on the listed station after the operation was switched, before the order or the attendance is touched", async () => {
    const w = await seedWorld();
    await mfgService.updateOperation(w.order.id, w.op10.id, { workCenterId: w.r120.id }, w.user.id);
    await expect(
      timeReportService.stampIn({ employeeId: w.worker.id, moOperationId: w.op10.id, workCenterId: w.r110.id }, w.user.id)
    ).rejects.toBeInstanceOf(StampWorkCenterChangedError);
    expect(await db.select().from(stampSessions)).toEqual([]);
    expect(await db.select().from(attendanceSessions)).toEqual([]);
    expect((await mfgService.getManufacturingOrder(w.order.id))!.status).toBe("released");
    // On the station the operation is on now it is stamped, and carries it.
    const session = await timeReportService.stampIn({ employeeId: w.worker.id, moOperationId: w.op10.id, workCenterId: w.r120.id }, w.user.id);
    expect(session.workCenterId).toBe(w.r120.id);
  });

  it("refuses it also when the switch commits between the check and the INSERT (the locked re-check)", async () => {
    const w = await seedWorld();
    let open!: () => void;
    const switched = new Promise<void>((resolve) => (open = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // Ändra's transaction, held open after the switch: the stamp's first
    // check reads the committed 110, its locked read waits and sees 120.
    const change = db.transaction(async (tx) => {
      const result = await updateOperationInTx(tx, w.order.id, w.op10.id, { workCenterId: w.r120.id }, (t, id) => planningService.replanOrderInTx(t, id));
      open();
      await held;
      return result;
    });
    await switched;
    const stamped = timeReportService.stampIn({ employeeId: w.worker.id, moOperationId: w.op10.id, workCenterId: w.r110.id }, w.user.id);
    await waitForLockWaiter().finally(release);
    const [changeResult, stampResult] = await Promise.allSettled([change, stamped]);
    expect(changeResult.status).toBe("fulfilled");
    expect(stampResult.status === "rejected" && stampResult.reason).toBeInstanceOf(StampWorkCenterChangedError);
    expect(await db.select().from(stampSessions)).toEqual([]);
  });
});

describe("a resource in alternatives cannot become a legoresurs", () => {
  it("refuses an alternative, the ordinarie of an operation with alternatives and an open TO's resource (409); a resource outside them may", async () => {
    const w = await seedWorld();
    for (const r of [w.r120, w.r110, w.r130]) {
      await expect(mfgService.updateWorkCenter(r.id, { type: "subcontract" })).rejects.toBeInstanceOf(WorkCenterInAlternativesError);
    }
    expect((await mfgService.getWorkCenter(w.r120.id))!.type).toBe("machine");
    // Other edits of such a resource go through.
    expect((await mfgService.updateWorkCenter(w.r120.id, { name: "Kantpress 2B" })).name).toBe("Kantpress 2B");
    // 150 takes part in nothing.
    expect((await mfgService.updateWorkCenter(w.r150.id, { type: "subcontract" })).type).toBe("subcontract");

    // 130 out of the beredning: still among the open TO's resources ⇒ refused.
    await mfgService.updateRoutingOperation(w.parent.id, w.routing10.id, { alternatives: [{ workCenterId: w.r120.id }] });
    await expect(mfgService.updateWorkCenter(w.r130.id, { type: "subcontract" })).rejects.toBeInstanceOf(WorkCenterInAlternativesError);
    // Once the TO is done its resource rows are history.
    await mfgService.complete(w.order.id, { quantity: 10 }, w.user.id);
    expect((await mfgService.updateWorkCenter(w.r130.id, { type: "subcontract" })).type).toBe("subcontract");
  });

  it("a type change waits for a routing edit that reads the resource, and is then refused", async () => {
    const w = await seedWorld();
    let entered!: () => void;
    const inPrepare = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    // The edit adds 150 as an alternative; its prepare has read 150 FOR SHARE.
    const edit = manufacturingRepository.updateRoutingOperation(w.parent.id, w.routing10.id, async (_current, _alternatives, workCenter) => {
      await workCenter(w.r150.id);
      entered();
      await held;
      return { alternatives: [{ workCenterId: w.r120.id }, { workCenterId: w.r150.id }] };
    });
    await inPrepare;
    const typeChange = mfgService.updateWorkCenter(w.r150.id, { type: "subcontract" });
    await waitForLockWaiter().finally(release);
    const [editResult, changeResult] = await Promise.allSettled([edit, typeChange]);
    expect(editResult.status).toBe("fulfilled");
    expect(changeResult.status === "rejected" && changeResult.reason).toBeInstanceOf(WorkCenterInAlternativesError);
  });
});

describe("the routing lock", () => {
  it("never blocks a TO being created while a routing edit holds its operation", async () => {
    const w = await seedWorld();
    let entered!: () => void;
    const inPrepare = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const edit = manufacturingRepository.updateRoutingOperation(w.parent.id, w.routing10.id, async () => {
      entered();
      await held;
      return { setupTime: 12 };
    });
    await inPrepare;
    try {
      // The new TO's mo_operations.routing_operation_id takes FOR KEY SHARE on
      // the routing row: with FOR UPDATE it waited for the edit.
      const created = await Promise.race([
        mfgService.createManufacturingOrder({ articleId: w.parent.id, quantity: 2 }, w.user.id),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5000)),
      ]);
      expect(created).not.toBe("blocked");
      // Created from the routing as committed before the edit.
      const [op] = (await mfgService.listOperations((created as { id: string }).id)).filter((o) => o.sequenceNo === 10);
      expect(op!.setupTime).toBe("10.00");
    } finally {
      release();
    }
    expect((await edit)!.setupTime).toBe("12.00");
  });
});
