import { createArticleSchema, createStockLocationSchema, createWorkCenterSchema, stampOutSchema, workStampSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { auditLog, db, moOperations, moReports, stampSessions, stockTransactions, timeReports } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  InvalidStatusTransitionError,
  MoReportStockMissingError,
  ScrapReasonRequiredError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import {
  AttendanceOverlapError,
  createTimeReportService,
  InvalidAttendanceIntervalError,
  InvalidWorkStampIntervalError,
  StampReportMissingError,
  StampSessionOpenError,
} from "../src/modules/timereport/service/timereport.service.js";
import { PayrollPeriodLockedError } from "../src/modules/payroll/service/period-lock.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";

// Stämplingar (Personal & lön, 2026-11-22): a closed work stamp corrected,
// registered afterwards and removed — times in place, operation and
// quantities by undoing and redoing the stamp's report in ONE transaction —
// and a forgotten day's attendance added.

let lockedDates = new Set<string>();
const periodLocks = { isDateLocked: async (date: string) => lockedDates.has(date) };
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  undefined as never,
  createAuditRepository(db),
  undefined,
  periodLocks
);
const service = createTimeReportService(createTimeReportRepository(db), mfgService, periodLocks, createAuditRepository(db));

const TRUNCATE = sql`TRUNCATE mo_reports, mo_report_materials, mo_operation_scrap, attendance_sessions, stamp_sessions, time_reports,
  employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups,
  stock_transactions, stock_locations, warehouses, bom_components, articles, payroll_periods, audit_log, user_settings, users CASCADE`;

beforeEach(async () => {
  lockedDates = new Set();
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function balance(articleId: string, locationId: string) {
  const [row] = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(row!.q);
}

// A released TO for 5 st with operations 10 and 20; the component (2 per
// unit) is linked to operation 10; the article's own location takes both.
async function setup() {
  const user = await authRepo.create({
    email: `stampl-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Arbetsledare",
    role: "supervisor",
  });
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
  const component = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `C-${crypto.randomUUID()}`, name: "Komponent", type: "purchased", defaultLocationId: location.id, active: true })
  );
  const parent = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Produkt", type: "manufactured", defaultLocationId: location.id, active: true })
  );
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
  const op10 = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2, routingOperationId: op10.id });
  await stockService.recordTransaction({ articleId: component.id, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [first, last] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  const employee = await service.createEmployee({ employeeNumber: "107", name: "Anna Exempel", active: true });
  return { user, location, component, parent, order, first: first!, last: last!, employee };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

// A real stamp-out at the terminal: in now, out now.
async function stamped(ctx: Ctx, operationId: string, input: object) {
  const session = await service.stampIn({ employeeId: ctx.employee.id, moOperationId: operationId }, ctx.user.id);
  await service.stampOut(session.id, parsed(stampOutSchema, input), ctx.user.id);
  return session.id;
}

// Tuesday 2026-11-03, 07:00–11:30 Swedish time (UTC+1).
const START = "2026-11-03T06:00:00.000Z";
const STOP = "2026-11-03T10:30:00.000Z";

function stamp(ctx: Ctx, operationId: string, extra: object = {}) {
  return parsed(workStampSchema, { moOperationId: operationId, startedAt: START, stoppedAt: STOP, ...extra });
}

async function stampRow(id: string) {
  const [row] = await db.select().from(stampSessions).where(eq(stampSessions.id, id));
  return row ?? null;
}

async function liveReports(operationId: string) {
  return db.select().from(moReports).where(and(eq(moReports.moOperationId, operationId), isNull(moReports.undoneAt)));
}

async function operation(id: string) {
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, id));
  return row!;
}

describe("Stämplingar: rätta en arbetsstämpling", () => {
  it("corrects times, pause and type in place — the report is left as it was", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 2 });
    const [reportBefore] = await liveReports(ctx.first.id);

    const result = await service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { pauseMinutes: 30, kind: "run", quantityOk: 2, note: "Rättad" }), ctx.user.id);

    expect(result.reportRedone).toBe(false);
    const row = (await stampRow(id))!;
    expect(row.startedAt.toISOString()).toBe(START);
    expect(row.stoppedAt!.toISOString()).toBe(STOP);
    expect(Number(row.pausedSeconds)).toBe(1800);
    expect(row.kind).toBe("run");
    const [report] = await liveReports(ctx.first.id);
    expect(report!.id).toBe(reportBefore!.id);
    const [time] = await db.select().from(timeReports).where(eq(timeReports.id, row.timeReportId!));
    expect(time).toMatchObject({ date: "2026-11-03", hours: "4.00", kind: "run", note: "Rättad" });
    expect(Number((await operation(ctx.first.id)).quantityCompleted)).toBe(2);
    const [log] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "stamp_session"), eq(auditLog.action, "corrected")));
    expect(log!.detail).toMatchObject({ reportRedone: false, after: { hours: 4, kind: "run" } });
  });

  it("redoes the report when the quantity changes: the material follows", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 2 });
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(96);
    const [old] = await liveReports(ctx.first.id);

    const result = await service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { quantityOk: 3 }), ctx.user.id);

    expect(result.reportRedone).toBe(true);
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(94);
    expect(Number((await operation(ctx.first.id)).quantityCompleted)).toBe(3);
    const [undone] = await db.select().from(moReports).where(eq(moReports.id, old!.id));
    expect(undone!.undoneAt).not.toBeNull();
    const live = await liveReports(ctx.first.id);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ source: "stamp_correction", quantityOk: "3.0000" });
    const row = (await stampRow(id))!;
    expect(row.timeReportId).toBe(live[0]!.timeReportId);
    const [time] = await db.select().from(timeReports).where(eq(timeReports.id, row.timeReportId!));
    expect(time).toMatchObject({ date: "2026-11-03", hours: "4.50" });
    // The old time report went with the undo.
    expect(await db.select().from(timeReports).where(eq(timeReports.employeeId, ctx.employee.id))).toHaveLength(1);
  });

  it("moves the stamp to the last operation: goods received there, material back from the first", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 2 });

    await service.correctWorkStamp(id, stamp(ctx, ctx.last.id, { quantityOk: 1 }), ctx.user.id);

    expect(Number((await operation(ctx.first.id)).quantityCompleted ?? 0)).toBe(0);
    expect(Number((await operation(ctx.last.id)).quantityCompleted)).toBe(1);
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(100);
    expect(await balance(ctx.parent.id, ctx.location.id)).toBe(1);
    expect(Number((await mfgService.getManufacturingOrder(ctx.order.id))!.quantityReceived)).toBe(1);
    expect((await stampRow(id))!.moOperationId).toBe(ctx.last.id);
  });

  it("rolls everything back when the new report is refused after the undo", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 2 });
    // Another order of the same article, done and closed: takes no reports.
    const other = await mfgService.createManufacturingOrder({ articleId: ctx.parent.id, quantity: 1 }, ctx.user.id);
    await mfgService.complete(other.id, {}, ctx.user.id);
    await mfgService.close(other.id, ctx.user.id);
    const [otherOp] = await mfgService.listOperations(other.id);

    await expect(service.correctWorkStamp(id, stamp(ctx, otherOp!.id, { quantityOk: 1 }), ctx.user.id)).rejects.toThrow(
      InvalidStatusTransitionError
    );

    // Nothing moved: the old report is live, the material still drawn.
    const live = await liveReports(ctx.first.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.source).toBe("terminal");
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(96);
    expect((await stampRow(id))!.moOperationId).toBe(ctx.first.id);
  });

  it("refuses when the goods the report received are gone — nothing written", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.last.id, { quantityOk: 1 });
    await stockService.recordTransaction({ articleId: ctx.parent.id, locationId: ctx.location.id, quantityDelta: -1, transactionType: "inventory_adjustment" });

    await expect(service.correctWorkStamp(id, stamp(ctx, ctx.last.id, { quantityOk: 2 }), ctx.user.id)).rejects.toThrow(MoReportStockMissingError);
    expect((await liveReports(ctx.last.id))[0]!.source).toBe("terminal");
  });

  it("needs a scrap reason, an interval that makes sense and a closed stamp", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 1 });
    await expect(
      service.correctWorkStamp(id, { ...stamp(ctx, ctx.first.id, { quantityOk: 1 }), quantityScrapped: 1 }, ctx.user.id)
    ).rejects.toThrow(ScrapReasonRequiredError);
    await expect(service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { quantityOk: 1, stoppedAt: START }), ctx.user.id)).rejects.toThrow(
      InvalidWorkStampIntervalError
    );
    await expect(service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { quantityOk: 1, pauseMinutes: 270 }), ctx.user.id)).rejects.toThrow(
      InvalidWorkStampIntervalError
    );
    const open = await service.stampIn({ employeeId: ctx.employee.id, moOperationId: ctx.last.id }, ctx.user.id);
    await expect(service.correctWorkStamp(open.id, stamp(ctx, ctx.last.id), ctx.user.id)).rejects.toThrow(StampSessionOpenError);
  });

  it("checks the payroll period of the old and the new day, not for the type alone", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 1 });
    lockedDates = new Set(["2026-11-03"]);
    await expect(service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { quantityOk: 1 }), ctx.user.id)).rejects.toThrow(
      PayrollPeriodLockedError
    );
    lockedDates = new Set();
    await service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { quantityOk: 1 }), ctx.user.id);
    lockedDates = new Set(["2026-11-03"]);
    // Only the type: no period check (the payroll never reads time reports).
    await service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { quantityOk: 1, kind: "setup" }), ctx.user.id);
    expect((await stampRow(id))!.kind).toBe("setup");
  });

  it("a stamp from before the report log: times only", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 1 });
    await db.delete(moReports).where(eq(moReports.moOperationId, ctx.first.id));

    await expect(service.correctWorkStamp(id, stamp(ctx, ctx.first.id, { quantityOk: 2 }), ctx.user.id)).rejects.toThrow(
      StampReportMissingError
    );
    await expect(service.deleteWorkStamp(id, ctx.user.id)).rejects.toThrow(StampReportMissingError);
    const result = await service.correctWorkStamp(id, stamp(ctx, ctx.first.id), ctx.user.id);
    expect(result.reportRedone).toBe(false);
    expect((await stampRow(id))!.startedAt.toISOString()).toBe(START);
  });
});

describe("Stämplingar: lägg till och ta bort en arbetsstämpling", () => {
  it("registers a stamp afterwards: closed stamp, time report and report in one go", async () => {
    const ctx = await setup();

    const { id } = await service.createWorkStamp(ctx.employee.id, stamp(ctx, ctx.first.id, { quantityOk: 2, pauseMinutes: 30, kind: "run" }), ctx.user.id);

    const row = (await stampRow(id))!;
    expect(row).toMatchObject({ employeeId: ctx.employee.id, moOperationId: ctx.first.id, kind: "run", pausedSeconds: "1800.00" });
    expect(row.stoppedAt!.toISOString()).toBe(STOP);
    const [time] = await db.select().from(timeReports).where(eq(timeReports.id, row.timeReportId!));
    expect(time).toMatchObject({ date: "2026-11-03", hours: "4.00", kind: "run" });
    expect((await liveReports(ctx.first.id))[0]).toMatchObject({ source: "stamp_correction", quantityOk: "2.0000", timeReportId: row.timeReportId });
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(96);
  });

  it("registers a time-only stamp (0/0) with a report row the TO card can undo", async () => {
    const ctx = await setup();
    const { id } = await service.createWorkStamp(ctx.employee.id, stamp(ctx, ctx.first.id), ctx.user.id);
    const row = (await stampRow(id))!;
    expect((await liveReports(ctx.first.id))[0]).toMatchObject({ source: "stamp_correction", quantityOk: "0.0000", timeReportId: row.timeReportId });
  });

  it("removes a stamp: report undone, material back, stamp and time report gone", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 2 });

    await service.deleteWorkStamp(id, ctx.user.id);

    expect(await stampRow(id)).toBeNull();
    expect(await liveReports(ctx.first.id)).toHaveLength(0);
    expect(await balance(ctx.component.id, ctx.location.id)).toBe(100);
    expect(await db.select().from(timeReports).where(eq(timeReports.employeeId, ctx.employee.id))).toHaveLength(0);
  });

  it("removes a stamp whose report was already undone on the TO card", async () => {
    const ctx = await setup();
    const id = await stamped(ctx, ctx.first.id, { quantityOk: 1 });
    const [report] = await liveReports(ctx.first.id);
    await mfgService.undoReport(ctx.order.id, report!.id, ctx.user.id);

    await service.deleteWorkStamp(id, ctx.user.id);
    expect(await stampRow(id)).toBeNull();
  });

  it("the day view shows the stamp with its report and the manual time reports", async () => {
    const ctx = await setup();
    const { id } = await service.createWorkStamp(ctx.employee.id, stamp(ctx, ctx.first.id, { quantityOk: 2 }), ctx.user.id);
    await service.createTimeReport({ employeeId: ctx.employee.id, moOperationId: ctx.last.id, date: "2026-11-03", hours: 1.5 }, ctx.user.id);

    const day = await service.getStampDay(ctx.employee.id, "2026-11-03");

    expect(day.stamps).toHaveLength(1);
    expect(day.stamps[0]).toMatchObject({ id, hours: 4.5, pauseMinutes: 0, legacy: false, report: { quantityOk: 2, source: "stamp_correction" } });
    expect(day.manualReports).toHaveLength(1);
    expect(day.manualReports[0]).toMatchObject({ hours: 1.5, moOperationId: ctx.last.id });
    expect((await service.getStampDay(ctx.employee.id, "2026-11-04")).stamps).toHaveLength(0);
  });
});

describe("Stämplingar: lägg till närvaro", () => {
  it("adds a closed attendance, refuses an overlap, a future stop and a locked period", async () => {
    const ctx = await setup();
    const row = await service.createAttendanceSession(
      ctx.employee.id,
      { startedAt: "2026-11-03T06:00:00.000Z", stoppedAt: "2026-11-03T15:00:00.000Z" },
      ctx.user.id
    );
    expect(row.stoppedAt!.toISOString()).toBe("2026-11-03T15:00:00.000Z");

    await expect(
      service.createAttendanceSession(ctx.employee.id, { startedAt: "2026-11-03T14:00:00.000Z", stoppedAt: "2026-11-03T16:00:00.000Z" }, ctx.user.id)
    ).rejects.toThrow(AttendanceOverlapError);
    // Touching is not overlapping.
    await service.createAttendanceSession(
      ctx.employee.id,
      { startedAt: "2026-11-03T15:00:00.000Z", stoppedAt: "2026-11-03T16:00:00.000Z" },
      ctx.user.id
    );
    await expect(
      service.createAttendanceSession(ctx.employee.id, { startedAt: "2026-11-03T06:00:00.000Z", stoppedAt: "2099-01-01T00:00:00.000Z" }, ctx.user.id)
    ).rejects.toThrow(InvalidAttendanceIntervalError);
    lockedDates = new Set(["2026-11-04"]);
    await expect(
      service.createAttendanceSession(ctx.employee.id, { startedAt: "2026-11-04T06:00:00.000Z", stoppedAt: "2026-11-04T15:00:00.000Z" }, ctx.user.id)
    ).rejects.toThrow(PayrollPeriodLockedError);
  });
});
