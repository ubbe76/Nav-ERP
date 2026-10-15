import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { stampOutSchema } from "@navet/shared";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import {
  AlreadyPresentError,
  AlreadyStampedInError,
  AttendanceSessionAlreadyStoppedError,
  AttendanceSessionNotFoundError,
  DuplicateEmployeeNumberError,
  EmployeeNotFoundError,
  InactiveEmployeeError,
  InvalidAttendanceIntervalError,
  InvalidStopTimeError,
  StampSessionAlreadyStoppedError,
  TimeReportNotFoundError,
  createTimeReportService,
} from "../src/modules/timereport/service/timereport.service.js";
import { InvalidStatusTransitionError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { PayrollPeriodLockedError } from "../src/modules/payroll/service/period-lock.js";

const articleService = createArticleService(createArticleRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const authRepo = createAuthRepository(db);
const timeReportRepository = createTimeReportRepository(db);

// Mutable period-lock stub — the real payroll_periods-backed checker is
// exercised in payroll-attest.test.ts.
// `dateLocked` locks every date at once; `lockedDates` locks specific dates,
// so the correction tests can tell the old-date guard and new-date guard
// apart (one locked, the other open, and vice versa).
let dateLocked = false;
const lockedDates = new Set<string>();
const timeReportService = createTimeReportService(
  timeReportRepository,
  mfgService,
  { isDateLocked: async (date: string) => dateLocked || lockedDates.has(date) },
  // Corrections' audit trail is asserted for real in payroll-attest.test.ts;
  // here it's a no-op so these tests stay focused on the service rules.
  { log: async () => {} }
);

beforeEach(async () => {
  dateLocked = false;
  lockedDates.clear();
  await db.execute(
    sql`TRUNCATE attendance_sessions, production_groups, stamp_sessions, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, bom_components, articles, payroll_periods, audit_log, users CASCADE`
  );
});

afterAll(async () => {
  await db.execute(
    sql`TRUNCATE attendance_sessions, production_groups, stamp_sessions, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, bom_components, articles, payroll_periods, audit_log, users CASCADE`
  );
});

async function makeUser() {
  return authRepo.create({
    email: `tr-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reporter",
    role: "admin",
  });
}

async function makeReleasedMoWithOperation() {
  const user = await makeUser();
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Parent",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 500, overheadPercent: 20, active: true });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [operation] = await mfgService.listOperations(order.id);
  return { user, order, operation: operation!, workCenter };
}

// Same as above but with two routing operations on the order, so the
// simultaneous-stamps tests can pick two distinct moOperationIds.
async function makeReleasedMoWithTwoOperations() {
  const user = await makeUser();
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Parent",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 500, overheadPercent: 20, active: true });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 2, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const operations = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { user, order, operationA: operations[0]!, operationB: operations[1]! };
}

describe("time report service", () => {
  it("creates an employee and a time report against an MO operation", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Kalle", active: true });

    const report = await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 3.5 },
      user.id
    );

    expect(report.employeeId).toBe(employee.id);
    expect(report.hours).toBe("3.50");
  });

  it("rejects a manual time report dated inside a locked payroll period", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-LOCK", name: "Låst", active: true });
    dateLocked = true;

    await expect(
      timeReportService.createTimeReport(
        { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 3.5 },
        user.id
      )
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });

  it("lists time reports for a manufacturing order via the nested operation join", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-2", name: "Anna", active: true });

    await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 2 },
      user.id
    );
    await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-08", hours: 1.5 },
      user.id
    );

    const reports = await timeReportService.listTimeReportsByManufacturingOrder(order.id);
    expect(reports).toHaveLength(2);
  });

  it("refuses a stamp-out whose session was closed underneath it and keeps exactly one time report", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-RACE", name: "Race", active: true });
    const session = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    // Simulates regel 10 closing the stamp between doStampOut's read and its close.
    const realClose = timeReportRepository.closeStampSession;
    timeReportRepository.closeStampSession = async (id, stoppedAt, timeReportId) => {
      await db.execute(sql`UPDATE stamp_sessions SET stopped_at = now() WHERE id = ${id}`);
      return realClose(id, stoppedAt, timeReportId);
    };
    try {
      await expect(timeReportService.stampOut(session.id, stampOutSchema.parse({}), user.id)).rejects.toBeInstanceOf(
        StampSessionAlreadyStoppedError
      );
    } finally {
      timeReportRepository.closeStampSession = realClose;
    }
    const reports = [...(await db.execute(sql`SELECT id FROM time_reports WHERE employee_id = ${employee.id}`))];
    expect(reports).toHaveLength(0);
  });
});

describe("stamp sessions (stämpelterminal)", () => {
  async function makeEmployee(active = true) {
    return timeReportService.createEmployee({
      employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
      name: "Stämplare",
      active,
    });
  }

  it("stamps in on a released order and auto-starts it", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );

    expect(session.stoppedAt).toBeNull();
    const refreshed = await mfgService.getManufacturingOrder(order.id);
    expect(refreshed!.status).toBe("in_progress");
  });

  it("rejects stamping in on a cancelled order", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    await mfgService.cancel(order.id);
    const employee = await makeEmployee();

    await expect(
      timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id)
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("rejects stamping in on an operation that is already done", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    await mfgService.completeOperation(operation.id, { actualTime: 2 }, user.id);
    const employee = await makeEmployee();

    await expect(
      timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id)
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("rejects an inactive employee", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee(false);

    await expect(
      timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id)
    ).rejects.toBeInstanceOf(InactiveEmployeeError);
  });

  it("lets an employee have several simultaneous open stamp sessions on different operations", async () => {
    const { user, operationA, operationB } = await makeReleasedMoWithTwoOperations();
    const employee = await makeEmployee();

    const sessionA = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operationA.id },
      user.id
    );
    const sessionB = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operationB.id },
      user.id
    );

    expect(sessionA.stoppedAt).toBeNull();
    expect(sessionB.stoppedAt).toBeNull();

    const open = (await timeReportService.listStampSessions(true)).filter((s) => s.employeeId === employee.id);
    expect(open).toHaveLength(2);
  });

  it("stamping out of one session leaves the other one open", async () => {
    const { user, operationA, operationB } = await makeReleasedMoWithTwoOperations();
    const employee = await makeEmployee();

    const sessionA = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operationA.id },
      user.id
    );
    const sessionB = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operationB.id },
      user.id
    );

    await timeReportService.stampOut(sessionA.id, {}, user.id);

    const open = await timeReportService.listStampSessions(true);
    const openIds = open.map((s) => s.id);
    expect(openIds).not.toContain(sessionA.id);
    expect(openIds).toContain(sessionB.id);

    const refreshedB = await timeReportRepository.findStampSessionById(sessionB.id);
    expect(refreshedB!.stoppedAt).toBeNull();
  });

  it("refuses stamping in twice on the same operation while a session on it is already open", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    await expect(
      timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id)
    ).rejects.toBeInstanceOf(AlreadyStampedInError);
  });

  it("stamps out: closes the session and materializes a terminal time report", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );

    const { session: closed, timeReport } = await timeReportService.stampOut(
      session.id,
      { note: "Klart för idag" },
      user.id
    );

    expect(closed.stoppedAt).not.toBeNull();
    expect(closed.timeReportId).toBe(timeReport.id);
    // Elapsed is near-zero in a test, so the floor kicks in.
    expect(Number(timeReport.hours)).toBeGreaterThanOrEqual(0.01);

    const reports = await timeReportService.listTimeReportsByManufacturingOrder(order.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.source).toBe("terminal");

    await expect(timeReportService.stampOut(session.id, {}, user.id)).rejects.toBeInstanceOf(
      StampSessionAlreadyStoppedError
    );
  });

  it("marks the operation done with total reported hours as actual time", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    // A prior manual report contributes to the operation's total actual time.
    await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-10", hours: 2.5 },
      user.id
    );

    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    await timeReportService.stampOut(session.id, { markOperationDone: true }, user.id);

    const [refreshedOp] = await mfgService.listOperations(order.id);
    expect(refreshedOp!.status).toBe("done");
    expect(Number(refreshedOp!.actualTime)).toBeGreaterThanOrEqual(2.51);
  });

  it("edits the employee number and rejects duplicates", async () => {
    const a = await makeEmployee();
    const b = await makeEmployee();

    const updated = await timeReportService.updateEmployee(a.id, { employeeNumber: "E-999" });
    expect(updated.employeeNumber).toBe("E-999");

    await expect(
      timeReportService.updateEmployee(a.id, { employeeNumber: b.employeeNumber })
    ).rejects.toBeInstanceOf(DuplicateEmployeeNumberError);
  });

  it("updates employee register fields and rejects unknown ids", async () => {
    const employee = await makeEmployee();

    const updated = await timeReportService.updateEmployee(employee.id, {
      phone: "070-123 45 67",
      personalIdentityNumber: "19800101-1234",
      employedFrom: "2020-03-01",
      employmentType: "hourly",
      wage: 185.5,
      weeklyHours: 40,
    });
    expect(updated.phone).toBe("070-123 45 67");
    expect(updated.employmentType).toBe("hourly");
    expect(updated.wage).toBe("185.50");
    expect(updated.weeklyHours).toBe("40.00");

    await expect(timeReportService.updateEmployee(crypto.randomUUID(), { name: "X" })).rejects.toBeInstanceOf(
      EmployeeNotFoundError
    );
  });

  it("clocks attendance in and out, rejecting a double clock-in", async () => {
    const { user } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    const session = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    expect(session.stoppedAt).toBeNull();
    await expect(timeReportService.attendanceIn({ employeeId: employee.id }, user.id)).rejects.toBeInstanceOf(
      AlreadyPresentError
    );

    const { session: closed, pausedWorkSessions } = await timeReportService.attendanceOut(session.id, user.id);
    expect(closed.stoppedAt).not.toBeNull();
    expect(pausedWorkSessions).toBe(0);

    await expect(timeReportService.attendanceOut(session.id, user.id)).rejects.toBeInstanceOf(
      AttendanceSessionAlreadyStoppedError
    );
  });

  it("going home pauses open work instead of stopping it — no reports yet", async () => {
    const { user, order, operationA, operationB } = await makeReleasedMoWithTwoOperations();
    const employee = await makeEmployee();

    const attendance = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operationA.id }, user.id);
    await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operationB.id }, user.id);

    const { pausedWorkSessions } = await timeReportService.attendanceOut(attendance.id, user.id);
    expect(pausedWorkSessions).toBe(2);

    // Still stamped in — but paused, and nothing was reported.
    const openStamps = await timeReportService.listStampSessions(true);
    expect(openStamps).toHaveLength(2);
    expect(openStamps.every((s) => s.pausedAt !== null)).toBe(true);
    const reports = await timeReportService.listTimeReportsByManufacturingOrder(order.id);
    expect(reports).toHaveLength(0);

    // Attendance-in resumes the work.
    await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const resumed = await timeReportService.listStampSessions(true);
    expect(resumed.every((s) => s.pausedAt === null)).toBe(true);
  });

  it("excludes paused time from the reported hours at stamp-out", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    const attendance = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    // Simulate: started 5h ago, went home 4h ago (i.e. 1h of real work, then
    // a 4h pause that is still ongoing at stamp-out).
    const now = Date.now();
    await db.execute(
      sql`UPDATE stamp_sessions SET started_at = ${new Date(now - 5 * 3_600_000).toISOString()}::timestamptz WHERE id = ${session.id}`
    );
    await timeReportService.attendanceOut(attendance.id, user.id);
    await db.execute(
      sql`UPDATE stamp_sessions SET paused_at = ${new Date(now - 4 * 3_600_000).toISOString()}::timestamptz WHERE id = ${session.id}`
    );

    const { timeReport } = await timeReportService.stampOut(
      session.id,
      { quantityOk: 5, quantityScrapped: 0 },
      user.id
    );
    // 5h elapsed − 4h pause ≈ 1h reported.
    expect(Number(timeReport.hours)).toBeGreaterThan(0.9);
    expect(Number(timeReport.hours)).toBeLessThan(1.1);
    void order;
  });

  it("accumulates pausedSeconds over an attendance cycle", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    const first = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    await timeReportService.attendanceOut(first.id, user.id);
    // Backdate the pause an hour so the resume folds real seconds in.
    await db.execute(
      sql`UPDATE stamp_sessions SET paused_at = ${new Date(Date.now() - 3_600_000).toISOString()}::timestamptz WHERE id = ${session.id}`
    );
    await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);

    const sessions = await timeReportService.listStampSessions(true);
    const resumed = sessions.find((s) => s.id === session.id)!;
    expect(resumed.pausedAt).toBeNull();
    expect(Number(resumed.pausedSeconds)).toBeGreaterThan(3500);
  });

  it("distinguishes manual reports from terminal reports in the list", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-10", hours: 1 },
      user.id
    );
    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    await timeReportService.stampOut(session.id, {}, user.id);

    const reports = await timeReportService.listTimeReports({ limit: 50, offset: 0 });
    const sources = reports.rows.map((r) => r.source).sort();
    expect(sources).toEqual(["manual", "terminal"]);
  });
});

describe("stamp terminal — quantity reporting at stamp-out", () => {
  async function makeEmployee() {
    return timeReportService.createEmployee({
      employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
      name: "Stämplare",
      active: true,
    });
  }

  it("accumulates OK + scrapped on the operation and logs the scrap reason", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    const first = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    await timeReportService.stampOut(
      first.id,
      { quantityOk: 3, quantityScrapped: 1, scrapReason: "Repor" },
      user.id
    );

    const second = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    await timeReportService.stampOut(
      second.id,
      { quantityOk: 2, quantityScrapped: 0, markOperationDone: true },
      user.id
    );

    const operations = await mfgService.listOperations(order.id);
    expect(Number(operations[0]?.quantityCompleted)).toBe(5);
    expect(Number(operations[0]?.quantityScrapped)).toBe(1);
    expect(operations[0]?.status).toBe("done");

    const scrapLog = await mfgService.listScrapForOrder(order.id);
    expect(scrapLog).toHaveLength(1);
    expect(scrapLog[0]?.reason).toBe("Repor");
    expect(scrapLog[0]?.employeeName).toBe(employee.name);
  });

  it("lists open sessions with the order's planned quantity and the operation's reported totals", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    const first = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    const fresh = (await timeReportService.listStampSessions(true)).find((s) => s.id === first.id)!;
    expect(Number(fresh.orderQuantity)).toBe(Number(order.quantity));
    expect(fresh.operationQuantityCompleted ?? "0").toMatch(/^0/);
    expect(Number(fresh.operationQuantityScrapped)).toBe(0);

    await timeReportService.stampOut(
      first.id,
      { quantityOk: 3, quantityScrapped: 1, scrapReason: "Repor" },
      user.id
    );
    const second = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    const listed = (await timeReportService.listStampSessions(true)).find((s) => s.id === second.id)!;
    expect(Number(listed.orderQuantity)).toBe(Number(order.quantity));
    expect(Number(listed.operationQuantityCompleted)).toBe(3);
    expect(Number(listed.operationQuantityScrapped)).toBe(1);
  });

  it("a pause stamp-out (0/0) reports nothing on the operation", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();

    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    await timeReportService.stampOut(session.id, { quantityOk: 0, quantityScrapped: 0 }, user.id);

    const operations = await mfgService.listOperations(order.id);
    expect(operations[0]?.quantityCompleted).toBeNull();
    expect(Number(operations[0]?.quantityScrapped)).toBe(0);
    expect(operations[0]?.status).toBe("pending");
  });

  it("rejects scrap without a reason at the schema boundary", () => {
    const parsed = stampOutSchema.safeParse({ quantityOk: 5, quantityScrapped: 2 });
    expect(parsed.success).toBe(false);
    const withReason = stampOutSchema.safeParse({ quantityOk: 5, quantityScrapped: 2, scrapReason: "Måttfel" });
    expect(withReason.success).toBe(true);
  });
});

describe("supervisor corrections — attendance sessions and time reports", () => {
  async function makeEmployee() {
    return timeReportService.createEmployee({
      employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
      name: "Rättad",
      active: true,
    });
  }

  it("corrects a stopped attendance session's times", async () => {
    const { user } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const opened = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const { session: closed } = await timeReportService.attendanceOut(opened.id, user.id);

    const newStartedAt = new Date(closed.startedAt.getTime() - 3_600_000).toISOString();
    const newStoppedAt = new Date(closed.stoppedAt!.getTime() - 1_800_000).toISOString();

    const updated = await timeReportService.updateAttendanceSession(
      closed.id,
      { startedAt: newStartedAt, stoppedAt: newStoppedAt },
      user.id
    );

    expect(updated.startedAt.toISOString()).toBe(newStartedAt);
    expect(updated.stoppedAt!.toISOString()).toBe(newStoppedAt);
  });

  it("rejects a stopped time at or before the started time", async () => {
    const { user } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const opened = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const { session: closed } = await timeReportService.attendanceOut(opened.id, user.id);

    await expect(
      timeReportService.updateAttendanceSession(
        closed.id,
        { stoppedAt: closed.startedAt.toISOString() },
        user.id
      )
    ).rejects.toBeInstanceOf(InvalidAttendanceIntervalError);
  });

  it("rejects reopening a session that would collide with another open one", async () => {
    const { user } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const first = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    await timeReportService.attendanceOut(first.id, user.id);
    // A second attendance cycle is now open for the same employee.
    await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);

    await expect(
      timeReportService.updateAttendanceSession(first.id, { stoppedAt: null }, user.id)
    ).rejects.toBeInstanceOf(AlreadyPresentError);
  });

  it("deletes an attendance session", async () => {
    const { user } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const opened = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const { session: closed } = await timeReportService.attendanceOut(opened.id, user.id);

    await timeReportService.deleteAttendanceSession(closed.id, user.id);

    const sessions = await timeReportService.listAttendanceSessions(false);
    expect(sessions.find((s) => s.id === closed.id)).toBeUndefined();

    await expect(
      timeReportService.updateAttendanceSession(closed.id, { startedAt: new Date().toISOString() }, user.id)
    ).rejects.toBeInstanceOf(AttendanceSessionNotFoundError);
  });

  it("rejects attendance corrections on a locked date", async () => {
    const { user } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const opened = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const { session: closed } = await timeReportService.attendanceOut(opened.id, user.id);

    dateLocked = true;
    // Re-submit the unchanged startedAt — a no-op interval, so the only
    // thing that can reject this is the period lock.
    await expect(
      timeReportService.updateAttendanceSession(closed.id, { startedAt: closed.startedAt.toISOString() }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    await expect(timeReportService.deleteAttendanceSession(closed.id, user.id)).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
  });

  it("guards both the old and new date when correcting an attendance session", async () => {
    const { user } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const opened = await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const { session: closed } = await timeReportService.attendanceOut(opened.id, user.id);
    const today = new Date().toLocaleDateString("sv-SE");

    // New startedAt would land on a locked date; the old date is open.
    lockedDates.add("2026-01-15");
    const movedIntoLocked = new Date("2026-01-15T12:00:00.000Z").toISOString();
    await expect(
      timeReportService.updateAttendanceSession(closed.id, { startedAt: movedIntoLocked }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    lockedDates.clear();

    // Old startedAt's date is locked, even though the edit doesn't move it
    // off that date (a no-op interval — the only possible rejection is the
    // period lock).
    lockedDates.add(today);
    await expect(
      timeReportService.updateAttendanceSession(closed.id, { startedAt: closed.startedAt.toISOString() }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });

  it("edits a time report's hours, reflected in sumReportedHoursForOperation", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const report = await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 2 },
      user.id
    );
    expect(await timeReportRepository.sumReportedHoursForOperation(operation.id)).toBe(2);

    const updated = await timeReportService.updateTimeReport(report.id, { hours: 5 }, user.id);
    expect(Number(updated.hours)).toBe(5);
    expect(await timeReportRepository.sumReportedHoursForOperation(operation.id)).toBe(5);
  });

  it("clears a time report's note and rejects unknown ids", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const report = await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 2, note: "Först" },
      user.id
    );

    const updated = await timeReportService.updateTimeReport(report.id, { note: null }, user.id);
    expect(updated.note).toBeNull();

    await expect(
      timeReportService.updateTimeReport(crypto.randomUUID(), { hours: 1 }, user.id)
    ).rejects.toBeInstanceOf(TimeReportNotFoundError);
  });

  it("deletes a time report, unlinking its stamp session", async () => {
    const { user, order, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const session = await timeReportService.stampIn(
      { employeeId: employee.id, moOperationId: operation.id },
      user.id
    );
    const { timeReport } = await timeReportService.stampOut(session.id, {}, user.id);

    await timeReportService.deleteTimeReport(timeReport.id, user.id);

    const reports = await timeReportService.listTimeReportsByManufacturingOrder(order.id);
    expect(reports).toHaveLength(0);
    const stamps = await timeReportService.listStampSessions(false);
    expect(stamps.find((s) => s.id === session.id)?.timeReportId).toBeNull();

    await expect(
      timeReportService.deleteTimeReport(timeReport.id, user.id)
    ).rejects.toBeInstanceOf(TimeReportNotFoundError);
  });

  it("rejects time report corrections on a locked date", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const report = await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 2 },
      user.id
    );

    dateLocked = true;
    await expect(timeReportService.updateTimeReport(report.id, { hours: 3 }, user.id)).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
    await expect(timeReportService.deleteTimeReport(report.id, user.id)).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
  });

  it("guards both the old and new date when correcting a time report", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await makeEmployee();
    const report = await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 2 },
      user.id
    );

    // New date locked, old date open.
    lockedDates.add("2026-08-01");
    await expect(
      timeReportService.updateTimeReport(report.id, { date: "2026-08-01" }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    lockedDates.clear();

    // Old date locked, new date open — moving out of a locked period is
    // blocked too.
    lockedDates.add("2026-07-07");
    await expect(
      timeReportService.updateTimeReport(report.id, { date: "2026-08-02" }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });
});

describe("närvaro och sluttid", () => {
  it("regel 5: stamping in without attendance clocks the employee in and resumes paused work", async () => {
    const { user, operationA, operationB } = await makeReleasedMoWithTwoOperations();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-R5", name: "Fem", active: true });
    const first = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operationA.id }, user.id);
    expect(first.attendanceStarted).toBe(true);
    const [attendance] = await timeReportService.listAttendanceSessions(true);
    await timeReportService.attendanceOut(attendance!.id, user.id); // pauses operation A

    const second = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operationB.id }, user.id);

    expect(second.attendanceStarted).toBe(true);
    const open = await timeReportService.listStampSessions(true);
    expect(open.filter((s) => s.employeeId === employee.id).every((s) => s.pausedAt === null)).toBe(true);
    expect((await timeReportService.listAttendanceSessions(true)).filter((a) => a.employeeId === employee.id)).toHaveLength(1);
  });

  it("regel 5: an employee already present gets no second attendance", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-R5B", name: "Närvarande", active: true });
    await timeReportService.attendanceIn({ employeeId: employee.id }, user.id);
    const stamp = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    expect(stamp.attendanceStarted).toBe(false);
  });

  it("regel 6: a supervisor stop time ends the stint there and dates the report on that day", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-R6", name: "Sex", active: true });
    const stamp = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    const start = new Date(Date.now() - 30 * 3_600_000);
    await db.execute(sql`UPDATE stamp_sessions SET started_at = ${start.toISOString()}::timestamptz WHERE id = ${stamp.id}`);
    const stoppedAt = new Date(start.getTime() + 7.5 * 3_600_000);

    const { timeReport, session } = await timeReportService.stampOut(
      stamp.id,
      stampOutSchema.parse({ stoppedAt: stoppedAt.toISOString() }),
      user.id
    );

    expect(timeReport.hours).toBe("7.50");
    expect(timeReport.date).toBe(stoppedAt.toLocaleDateString("sv-SE"));
    expect(session.stoppedAt!.getTime()).toBe(stoppedAt.getTime());
  });

  it("regel 6: a paused stamp stopped at its pause start reports the same hours as without a stop time", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-R6P", name: "Paus", active: true });
    const stamp = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    const start = new Date(Date.now() - 26 * 3_600_000);
    const pausedAt = new Date(start.getTime() + 8 * 3_600_000);
    await db.execute(
      sql`UPDATE stamp_sessions SET started_at = ${start.toISOString()}::timestamptz, paused_at = ${pausedAt.toISOString()}::timestamptz WHERE id = ${stamp.id}`
    );
    const { timeReport } = await timeReportService.stampOut(
      stamp.id,
      stampOutSchema.parse({ stoppedAt: pausedAt.toISOString() }),
      user.id
    );
    expect(timeReport.hours).toBe("8.00");
  });

  it("regel 6: refuses a stop time before the start, in the future or in a locked period", async () => {
    const { user, operation } = await makeReleasedMoWithOperation();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-R6X", name: "Fel", active: true });
    const stamp = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    const before = new Date(Date.now() - 3_600_000).toISOString();
    await db.execute(sql`UPDATE stamp_sessions SET started_at = now() WHERE id = ${stamp.id}`);
    await expect(
      timeReportService.stampOut(stamp.id, stampOutSchema.parse({ stoppedAt: before }), user.id)
    ).rejects.toBeInstanceOf(InvalidStopTimeError);
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    await expect(
      timeReportService.stampOut(stamp.id, stampOutSchema.parse({ stoppedAt: future }), user.id)
    ).rejects.toBeInstanceOf(InvalidStopTimeError);
    await db.execute(sql`UPDATE stamp_sessions SET started_at = now() - interval '2 hours' WHERE id = ${stamp.id}`);
    dateLocked = true;
    await expect(
      timeReportService.stampOut(stamp.id, stampOutSchema.parse({ stoppedAt: new Date(Date.now() - 60_000).toISOString() }), user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    // nothing was written by the refusals
    const open = await timeReportService.listStampSessions(true);
    expect(open.some((s) => s.id === stamp.id)).toBe(true);
  });
});
