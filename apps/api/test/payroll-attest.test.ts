import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, payrollPeriods } from "@navet/db";
import { PAXML_CODES, testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import {
  AlreadyAttestedError,
  AttestationNotFoundError,
  PeriodNotEndedError,
  PeriodNotLockedError,
  UnattestedEmployeesError,
  UnfinishedAttendanceError,
  createPayrollService,
} from "../src/modules/payroll/service/payroll.service.js";
import { PayrollPeriodLockedError, createPeriodLockChecker } from "../src/modules/payroll/service/period-lock.js";
import { createAtfRepository } from "../src/modules/timereport/repository/atf.repository.js";
import { createAtfService } from "../src/modules/timereport/service/atf.service.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import {
  createScheduleService,
  isoWeekOf,
  swedishHolidays,
} from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";

// The whole point of this file is the integration between the payroll
// period lock and every service that writes into the payroll basis, so all
// four services are wired with the REAL payroll_periods-backed checker (and
// the real audit repository, so the audit rows can be asserted). Only the
// ATF settings reader is stubbed — it's a config knob orthogonal to the
// status flows under test (same trick as payroll-summary.test.ts).
const payrollRepository = createPayrollRepository(db);
const periodLocks = createPeriodLockChecker(payrollRepository);
const timeReportRepository = createTimeReportRepository(db);
const scheduleRepository = createScheduleRepository(db);
const atfRepository = createAtfRepository(db);
const auditRepository = createAuditRepository(db);
const authRepo = createAuthRepository(db);

const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService
);
const timeReportService = createTimeReportService(
  timeReportRepository,
  mfgService,
  periodLocks,
  auditRepository
);
const scheduleService = createScheduleService(scheduleRepository, timeReportRepository, periodLocks);
const atfService = createAtfService(
  atfRepository,
  timeReportRepository,
  { getSettings: async () => ({ atfMinutesPerWeek: 0 }) },
  periodLocks
);
const service = createPayrollService(
  payrollRepository,
  timeReportRepository,
  periodLocks,
  scheduleService,
  timeReportRepository,
  atfRepository,
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  auditRepository,
  // Only the exports read the company header — see payroll-export.test.ts.
  { getCompanyInfo: async () => null },
  // The PDF report has its own coverage in payroll-pdf.test.ts (with the
  // real renderer) — a stub keeps this file focused on the lock/attest
  // status flows.
  { renderPayrollReport: async () => Buffer.from("") }
);

const TRUNCATE = sql`TRUNCATE
  absences, absence_types, ob_rules, payroll_periods, payroll_attestations,
  attendance_sessions, stamp_sessions, time_reports, atf_transactions,
  employee_day_overrides, employee_week_overrides,
  week_schedule_days, week_schedules, day_schedule_breaks, day_schedules,
  holidays, employees,
  mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers,
  bom_components, articles,
  audit_log, users
  CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Fixed, already-ended period: May 2026 (2026-05-04 is a Monday, so ISO week
// 19 runs Mon 2026-05-04 – Sun 2026-05-10 entirely inside the month).
const YEAR = 2026;
const MONTH = 5;

// Local (server-timezone) instant — mirrors payroll-day.ts's clockToMs so
// raw-SQL-backdated sessions land on the calendar date the test expects.
function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0);
}

// Established pattern (payroll-summary.test.ts): create through the repo,
// then backdate with raw SQL — sessions always start "now".
async function backdateAttendanceSession(id: string, startedAt: Date, stoppedAt: Date | null) {
  await db.execute(sql`
    UPDATE attendance_sessions
    SET started_at = ${startedAt.toISOString()}::timestamptz,
        stopped_at = ${stoppedAt === null ? null : stoppedAt.toISOString()}::timestamptz
    WHERE id = ${id}
  `);
}

async function makeUser(name = "Löneadmin") {
  return authRepo.create({
    email: `payroll-attest-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name,
    role: "admin",
  });
}

async function makeEmployee(name = "Anställd") {
  return timeReportRepository.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name,
    active: true,
  });
}

// One employee, Mon–Fri Dagtid 07:00–16:00, one CLOSED attendance session,
// one absence and one ATF withdrawal in May 2026 — a period that is ready to
// be attested and locked (no open attendance anywhere).
async function seedPeriod() {
  const user = await makeUser();
  const employee = await makeEmployee("Anna Andersson");

  const daySchedule = await scheduleService.createDaySchedule({
    code: "DAG",
    name: "Dagtid",
    startTime: "07:00",
    endTime: "16:00",
    active: true,
    breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }],
  });
  const weekSchedule = await scheduleService.createWeekSchedule({
    code: "VDAG",
    name: "Dagtid vecka",
    active: true,
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: daySchedule.id })),
  });
  await timeReportRepository.updateEmployee(employee.id, { defaultWeekScheduleId: weekSchedule.id });

  const absenceType = await service.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });

  const session = await timeReportRepository.createAttendanceSession(employee.id, user.id);
  await backdateAttendanceSession(session.id, localDate(2026, 5, 4, 7, 0), localDate(2026, 5, 4, 16, 0));

  const absence = await service.createAbsence(
    employee.id,
    { absenceTypeId: absenceType.id, date: "2026-05-05", minutes: 120 },
    user.id
  );
  await atfRepository.createAtfTransaction(employee.id, { date: "2026-05-06", type: "withdrawal", minutes: 60 }, user.id);

  return { user, employee, daySchedule, weekSchedule, absenceType, absence };
}

// Minimal released MO so manual time reports have an operation to hang on
// (copied from timereport.service.test.ts).
async function makeReleasedOperation(userId: string) {
  const parent = await testArticleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Parent",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const workCenter = await mfgService.createWorkCenter({
    code: "100", // work_centers.code is varchar(3)
    name: "Svets",
    hourlyRate: 500,
    overheadPercent: 20,
    active: true,
  });
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 1,
    workCenterId: workCenter.id,
    setupTime: 10,
    runTimePerUnit: 2,
  });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, userId);
  const [operation] = await mfgService.listOperations(order.id);
  return operation!;
}

async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

async function periodRow(year = YEAR, month = MONTH) {
  const [row] = await db
    .select()
    .from(payrollPeriods)
    .where(and(eq(payrollPeriods.year, year), eq(payrollPeriods.month, month)));
  return row ?? null;
}

describe("payroll attestation", () => {
  it("attests an employee (creating the period row lazily) and shows it on the summary", async () => {
    const { user, employee } = await seedPeriod();

    expect(await periodRow()).toBeNull();
    await service.attest(YEAR, MONTH, employee.id, user.id);

    const row = await periodRow();
    expect(row!.status).toBe("open");

    const summary = await service.getPeriodSummary(YEAR, MONTH);
    const employeeSummary = summary.employees.find((e) => e.employeeId === employee.id)!;
    expect(employeeSummary.attested).toBe(true);
    expect(employeeSummary.attestedByName).toBe("Löneadmin");
    expect(employeeSummary.attestedAt).toEqual(expect.any(String));
  });

  it("rejects attesting the same employee twice", async () => {
    const { user, employee } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);

    await expect(service.attest(YEAR, MONTH, employee.id, user.id)).rejects.toBeInstanceOf(AlreadyAttestedError);
  });

  it("rejects attesting an employee with an unfinished attendance session in the period", async () => {
    const { user, employee } = await seedPeriod();
    const open = await timeReportRepository.createAttendanceSession(employee.id, user.id);
    await backdateAttendanceSession(open.id, localDate(2026, 5, 7, 8, 0), null);

    await expect(service.attest(YEAR, MONTH, employee.id, user.id)).rejects.toBeInstanceOf(UnfinishedAttendanceError);
  });

  it("unattests an employee and drops the flag from the summary", async () => {
    const { user, employee } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);

    await service.unattest(YEAR, MONTH, employee.id, user.id);

    const summary = await service.getPeriodSummary(YEAR, MONTH);
    expect(summary.employees.find((e) => e.employeeId === employee.id)!.attested).toBe(false);
  });

  it("404s when unattesting an employee that was never attested", async () => {
    const { user, employee } = await seedPeriod();
    await expect(service.unattest(YEAR, MONTH, employee.id, user.id)).rejects.toBeInstanceOf(AttestationNotFoundError);
  });
});

describe("payroll period locking", () => {
  it("refuses to lock a period that has not ended yet", async () => {
    const { user } = await seedPeriod();
    const now = new Date();

    await expect(
      service.lockPeriod(now.getFullYear(), now.getMonth() + 1, user.id)
    ).rejects.toBeInstanceOf(PeriodNotEndedError);
  });

  it("refuses to lock while an employee is unattested, naming them", async () => {
    const { user, employee } = await seedPeriod();
    await makeEmployee("Bertil Bengtsson"); // active, no data — still included, still unattested
    await service.attest(YEAR, MONTH, employee.id, user.id);

    const error = await service.lockPeriod(YEAR, MONTH, user.id).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UnattestedEmployeesError);
    expect((error as UnattestedEmployeesError).names).toEqual(["Bertil Bengtsson"]);
  });

  it("locks the period, snapshots the summary and serves the snapshot on later reads", async () => {
    const { user, employee } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);

    const locked = await service.lockPeriod(YEAR, MONTH, user.id);
    expect(locked.status).toBe("locked");
    expect(locked.lockedAt).toEqual(expect.any(String));
    expect(locked.employees).toHaveLength(1);
    expect(locked.employees[0]!.days).toHaveLength(31);

    const row = await periodRow();
    expect(row!.status).toBe("locked");
    expect(row!.lockedBy).toBe(user.id);
    expect(row!.lockedAt).toBeInstanceOf(Date);
    // The stored JSON must be self-consistent — a later read hands it back
    // verbatim, so its own status/lockedAt fields have to say "locked".
    const stored = row!.summary as typeof locked;
    expect(stored.status).toBe("locked");
    expect(stored.lockedAt).toBe(locked.lockedAt);
    expect(stored.employees[0]!.days).toHaveLength(31);

    // Snapshot, not recompute: generatedAt is frozen at lock time.
    const first = await service.getPeriodSummary(YEAR, MONTH);
    const second = await service.getPeriodSummary(YEAR, MONTH);
    expect(first.generatedAt).toBe(locked.generatedAt);
    expect(second.generatedAt).toBe(locked.generatedAt);
    expect(second).toEqual(first);
  });

  it("serves getEmployeePeriodDays from the snapshot once the period is locked", async () => {
    const { user, employee, daySchedule } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);
    const locked = await service.lockPeriod(YEAR, MONTH, user.id);
    const frozenDays = locked.employees.find((e) => e.employeeId === employee.id)!.days;

    // Change the underlying schedule AFTER the lock (this write is not
    // date-scoped, so no guard stops it) — a live recompute would now report
    // different scheduled minutes than the frozen basis.
    await scheduleService.updateDaySchedule(daySchedule.id, { startTime: "06:00", endTime: "18:00" });

    const result = await service.getEmployeePeriodDays(employee.id, YEAR, MONTH);
    expect(result.days).toEqual(frozenDays);
    expect(result.days.find((d) => d.date === "2026-05-04")!.scheduledMinutes).toBe(480);

    // Unlocking drops the snapshot, so the same call recomputes live and now
    // reflects the changed schedule.
    await service.unlockPeriod(YEAR, MONTH, user.id);
    const afterUnlock = await service.getEmployeePeriodDays(employee.id, YEAR, MONTH);
    expect(afterUnlock.days.find((d) => d.date === "2026-05-04")!.scheduledMinutes).toBe(660);
  });

  it("returns empty days from the snapshot for an employee who was not part of the locked basis", async () => {
    const { user, employee } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);
    await service.lockPeriod(YEAR, MONTH, user.id);

    // Hired after the lock — no entry in the snapshot at all.
    const newcomer = await makeEmployee("Ny Anställd");
    const result = await service.getEmployeePeriodDays(newcomer.id, YEAR, MONTH);
    expect(result.days).toEqual([]);
  });

  it("rejects locking an already locked period", async () => {
    const { user, employee } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);
    await service.lockPeriod(YEAR, MONTH, user.id);

    await expect(service.lockPeriod(YEAR, MONTH, user.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });

  it("rejects attest/unattest once the period is locked", async () => {
    const { user, employee } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);
    await service.lockPeriod(YEAR, MONTH, user.id);

    await expect(service.attest(YEAR, MONTH, employee.id, user.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    await expect(service.unattest(YEAR, MONTH, employee.id, user.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });

  it("refuses to unlock a period that is not locked", async () => {
    const { user, employee } = await seedPeriod();
    await expect(service.unlockPeriod(YEAR, MONTH, user.id)).rejects.toBeInstanceOf(PeriodNotLockedError);

    // ... not even when the period row exists but is still open
    await service.attest(YEAR, MONTH, employee.id, user.id);
    await expect(service.unlockPeriod(YEAR, MONTH, user.id)).rejects.toBeInstanceOf(PeriodNotLockedError);
  });

  it("unlocks the period, clears the snapshot and recomputes the summary again", async () => {
    const { user, employee } = await seedPeriod();
    await service.attest(YEAR, MONTH, employee.id, user.id);
    const locked = await service.lockPeriod(YEAR, MONTH, user.id);

    await service.unlockPeriod(YEAR, MONTH, user.id);

    const row = await periodRow();
    expect(row!.status).toBe("open");
    expect(row!.summary).toBeNull();
    expect(row!.lockedAt).toBeNull();
    expect(row!.lockedBy).toBeNull();

    const summary = await service.getPeriodSummary(YEAR, MONTH);
    expect(summary.status).toBe("open");
    expect(summary.lockedAt).toBeNull();
    expect(summary.generatedAt).not.toBe(locked.generatedAt);
    // The attestation survives the unlock.
    expect(summary.employees.find((e) => e.employeeId === employee.id)!.attested).toBe(true);
  });
});

describe("payroll period lock guards", () => {
  // Everything below runs against a locked May 2026; June 2026 is the
  // "outside" control that must stay writable.
  async function lockedMay() {
    const seeded = await seedPeriod();
    await service.attest(YEAR, MONTH, seeded.employee.id, seeded.user.id);
    await service.lockPeriod(YEAR, MONTH, seeded.user.id);
    return seeded;
  }

  it("blocks absence create/delete inside the period but allows them outside it", async () => {
    const { user, employee, absenceType, absence } = await lockedMay();

    await expect(
      service.createAbsence(employee.id, { absenceTypeId: absenceType.id, date: "2026-05-11", minutes: 60 }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    await expect(service.deleteAbsence(absence.id, user.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    const outside = await service.createAbsence(
      employee.id,
      { absenceTypeId: absenceType.id, date: "2026-06-01", minutes: 60 },
      user.id
    );
    expect(outside.date).toBe("2026-06-01");
    await service.deleteAbsence(outside.id, user.id);
  });

  it("blocks manual time reports inside the period but allows them outside it", async () => {
    const { user, employee } = await lockedMay();
    const operation = await makeReleasedOperation(user.id);

    await expect(
      timeReportService.createTimeReport(
        { employeeId: employee.id, moOperationId: operation.id, date: "2026-05-12", hours: 3 },
        user.id
      )
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    const outside = await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation.id, date: "2026-06-02", hours: 3 },
      user.id
    );
    expect(outside.date).toBe("2026-06-02");
  });

  it("blocks ATF transaction create/delete inside the period but allows them outside it", async () => {
    const { user, employee } = await lockedMay();

    await expect(
      atfService.createAtfTransaction(employee.id, { date: "2026-05-13", type: "withdrawal", minutes: 60 }, user.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    // The withdrawal seeded inside the (now locked) period cannot be removed.
    const [seededWithdrawal] = await atfRepository.listAtfTransactions(employee.id);
    await expect(
      atfService.deleteAtfTransaction(employee.id, seededWithdrawal!.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    const outside = await atfService.createAtfTransaction(
      employee.id,
      { date: "2026-06-03", type: "withdrawal", minutes: 60 },
      user.id
    );
    await atfService.deleteAtfTransaction(employee.id, outside.id);
  });

  it("blocks day overrides inside the period but allows them outside it", async () => {
    const { employee, daySchedule } = await lockedMay();

    await expect(
      scheduleService.setDayOverride(employee.id, { date: "2026-05-14", dayScheduleId: daySchedule.id })
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    const outside = await scheduleService.setDayOverride(employee.id, {
      date: "2026-06-04",
      dayScheduleId: daySchedule.id,
    });
    expect(outside.date).toBe("2026-06-04");
    await scheduleService.deleteDayOverride(employee.id, outside.id);
  });

  it("blocks deleting a day override that sits inside the period", async () => {
    const seeded = await seedPeriod();
    const override = await scheduleService.setDayOverride(seeded.employee.id, {
      date: "2026-05-15",
      dayScheduleId: seeded.daySchedule.id,
    });
    await service.attest(YEAR, MONTH, seeded.employee.id, seeded.user.id);
    await service.lockPeriod(YEAR, MONTH, seeded.user.id);

    await expect(
      scheduleService.deleteDayOverride(seeded.employee.id, override.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });

  it("blocks week overrides whose ISO week touches the period, including a week spanning two months", async () => {
    const { employee, weekSchedule } = await lockedMay();

    // Mon 2026-05-04 – Sun 2026-05-10, entirely inside the locked month.
    const inside = isoWeekOf("2026-05-04");
    expect(inside.isoWeek).toBe(19);
    await expect(
      scheduleService.setWeekOverride(employee.id, { ...inside, weekScheduleId: weekSchedule.id })
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    // Mon 2026-04-27 – Sun 2026-05-03: only the Sunday is in the locked
    // month, and that is enough to reject it.
    const spanning = isoWeekOf("2026-04-27");
    await expect(
      scheduleService.setWeekOverride(employee.id, { ...spanning, weekScheduleId: weekSchedule.id })
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    // Mon 2026-06-01 – Sun 2026-06-07: fully outside.
    const outsideWeek = isoWeekOf("2026-06-01");
    const created = await scheduleService.setWeekOverride(employee.id, {
      ...outsideWeek,
      weekScheduleId: weekSchedule.id,
    });
    await scheduleService.deleteWeekOverride(employee.id, created.id);
  });

  it("blocks deleting a week override that sits inside the period", async () => {
    const seeded = await seedPeriod();
    const override = await scheduleService.setWeekOverride(seeded.employee.id, {
      ...isoWeekOf("2026-05-04"),
      weekScheduleId: seeded.weekSchedule.id,
    });
    await service.attest(YEAR, MONTH, seeded.employee.id, seeded.user.id);
    await service.lockPeriod(YEAR, MONTH, seeded.user.id);

    await expect(
      scheduleService.deleteWeekOverride(seeded.employee.id, override.id)
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
  });

  it("blocks holiday create/delete inside the period but allows them outside it", async () => {
    const seeded = await seedPeriod();
    const insideHoliday = await scheduleService.createHoliday({ date: "2026-05-20", name: "Testdag" });
    await service.attest(YEAR, MONTH, seeded.employee.id, seeded.user.id);
    await service.lockPeriod(YEAR, MONTH, seeded.user.id);

    await expect(
      scheduleService.createHoliday({ date: "2026-05-21", name: "Testdag 2" })
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    await expect(scheduleService.deleteHoliday(insideHoliday.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    const outside = await scheduleService.createHoliday({ date: "2026-06-05", name: "Testdag 3" });
    await scheduleService.deleteHoliday(outside.id);
  });

  it("skips locked months when seeding a year of Swedish holidays, and picks them up after unlock", async () => {
    const { user } = await lockedMay();

    const result = await scheduleService.generateSwedishHolidays(2026);

    const holidays = await scheduleService.listHolidays(2026);
    const dates = holidays.map((h) => h.date);
    // Första maj, Kristi himmelsfärdsdag (2026-05-14) and pingstdagen
    // (2026-05-24) all fall in the locked month and must not be inserted.
    expect(dates).not.toContain("2026-05-01");
    expect(dates).not.toContain("2026-05-14");
    expect(dates).not.toContain("2026-05-24");
    expect(dates.filter((d) => d.startsWith("2026-05"))).toEqual([]);
    // Months outside the lock are seeded as usual.
    expect(dates).toContain("2026-06-06");
    expect(dates).toContain("2026-12-25");
    expect(dates).toContain("2026-01-01");

    // The two skipped dates are counted as skipped, not created.
    const allCandidates = swedishHolidays(2026);
    const mayCandidates = allCandidates.filter((c) => c.date.startsWith("2026-05"));
    expect(mayCandidates).toHaveLength(3);
    expect(result.created).toBe(allCandidates.length - mayCandidates.length);
    expect(result.skipped).toBe(mayCandidates.length);

    // Re-running after unlocking picks exactly those dates up (idempotent).
    await service.unlockPeriod(YEAR, MONTH, user.id);
    const rerun = await scheduleService.generateSwedishHolidays(2026);
    expect(rerun.created).toBe(mayCandidates.length);
    expect((await scheduleService.listHolidays(2026)).map((h) => h.date)).toContain("2026-05-01");
  });

  it("allows writes into the period again once it is unlocked", async () => {
    const { user, employee, absenceType } = await lockedMay();

    await service.unlockPeriod(YEAR, MONTH, user.id);

    const absence = await service.createAbsence(
      employee.id,
      { absenceTypeId: absenceType.id, date: "2026-05-11", minutes: 60 },
      user.id
    );
    expect(absence.date).toBe("2026-05-11");
    await atfService.createAtfTransaction(employee.id, { date: "2026-05-13", type: "withdrawal", minutes: 60 }, user.id);
  });
});

describe("payroll audit log", () => {
  it("logs attest, unattest, lock and unlock with the acting user", async () => {
    const { user, employee } = await seedPeriod();

    await service.attest(YEAR, MONTH, employee.id, user.id);
    await service.unattest(YEAR, MONTH, employee.id, user.id);
    await service.attest(YEAR, MONTH, employee.id, user.id);
    await service.lockPeriod(YEAR, MONTH, user.id);
    await service.unlockPeriod(YEAR, MONTH, user.id);

    const attested = await auditRows("payroll_attestation", "attested");
    expect(attested).toHaveLength(2);
    expect(attested[0]!.userId).toBe(user.id);
    expect(attested[0]!.detail).toMatchObject({ employeeId: employee.id, year: YEAR, month: MONTH });

    const unattested = await auditRows("payroll_attestation", "unattested");
    expect(unattested).toHaveLength(1);
    expect(unattested[0]!.detail).toMatchObject({ employeeId: employee.id, year: YEAR, month: MONTH });

    const locked = await auditRows("payroll_period", "locked");
    expect(locked).toHaveLength(1);
    expect(locked[0]!.entityId).toBe("2026-05");
    expect(locked[0]!.userId).toBe(user.id);

    const unlocked = await auditRows("payroll_period", "unlocked");
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0]!.entityId).toBe("2026-05");
  });

  it("logs absence create and delete", async () => {
    const user = await makeUser();
    const employee = await makeEmployee();
    const absenceType = await service.createAbsenceType({ code: "SEM", name: "Semester", paxmlCode: "SEM" });

    const absence = await service.createAbsence(
      employee.id,
      { absenceTypeId: absenceType.id, date: "2026-05-18", minutes: 480 },
      user.id
    );
    await service.deleteAbsence(absence.id, user.id);

    const created = await auditRows("absence", "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.entityId).toBe(absence.id);
    expect(created[0]!.userId).toBe(user.id);
    expect(created[0]!.detail).toMatchObject({
      employeeId: employee.id,
      date: "2026-05-18",
      absenceTypeId: absenceType.id,
      minutes: 480,
    });

    const deleted = await auditRows("absence", "deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.entityId).toBe(absence.id);
    expect(deleted[0]!.detail).toMatchObject({ employeeId: employee.id, date: "2026-05-18" });
  });
});
