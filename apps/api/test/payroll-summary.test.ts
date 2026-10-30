import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, payrollAttestations, payrollPeriods } from "@navet/db";
import { PAXML_CODES } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import { createPayrollService } from "../src/modules/payroll/service/payroll.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { EmployeeNotFoundError } from "../src/modules/timereport/service/timereport.service.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createAtfRepository } from "../src/modules/timereport/repository/atf.repository.js";

// Real repositories/services throughout except the settings collaborator
// (a mutable stub, same trick as atf.service.test.ts's systemAtfMinutesPerWeek
// — the overtime threshold is a config knob orthogonal to the integration
// under test, and stubbing it keeps the test deterministic regardless of
// whatever another suite may have left in the shared system_settings table).
const payrollRepository = createPayrollRepository(db);
const timeReportRepository = createTimeReportRepository(db);
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, {
  isDateLocked: async () => false,
});
const atfRepository = createAtfRepository(db);
const authRepo = createAuthRepository(db);

let overtimeThresholdMinutes = 0;
const service = createPayrollService(
  payrollRepository,
  timeReportRepository,
  { isDateLocked: async () => false },
  scheduleService,
  timeReportRepository,
  atfRepository,
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: overtimeThresholdMinutes, ...PAXML_CODES }) },
  { log: async () => {} },
  // Only the exports read the company header — see payroll-export.test.ts.
  { getCompanyInfo: async () => null },
  // The PDF report has its own coverage in payroll-pdf.test.ts (with the
  // real renderer) — a stub keeps this file focused on the period summary.
  { renderPayrollReport: async () => Buffer.from("") }
);

const TRUNCATE = sql`TRUNCATE
  absences, absence_types, ob_rules, payroll_periods, payroll_attestations,
  attendance_sessions, stamp_sessions, time_reports, atf_transactions,
  employee_day_overrides, employee_week_overrides,
  week_schedule_days, week_schedules, day_schedule_breaks, day_schedules,
  holidays, employees, users
  CASCADE`;

beforeEach(async () => {
  overtimeThresholdMinutes = 0;
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Local (server-timezone) instant — mirrors payroll-day.ts's clockToMs, which
// builds "local" timestamps the same way, so raw-SQL-backdated rows land on
// the calendar dates the test expects regardless of the host's timezone.
function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0);
}

// Independent of periodDates()/the implementation — just Date.getDay() over
// the month, used to hand-check the aggregate scheduledMinutes/unaccounted
// totals without hardcoding a magic number.
function countWeekdaysInMonth(year: number, month: number): number {
  const daysInMonth = new Date(year, month, 0).getDate();
  let count = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const weekday = new Date(year, month - 1, day).getDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

// Established pattern (timereport.service.test.ts:313): create the row
// through the repo, then backdate it with raw SQL — attendance sessions
// always default to "now", and the engine only cares about wall-clock time.
async function backdateAttendanceSession(id: string, startedAt: Date, stoppedAt: Date | null) {
  await db.execute(sql`
    UPDATE attendance_sessions
    SET started_at = ${startedAt.toISOString()}::timestamptz,
        stopped_at = ${stoppedAt === null ? null : stoppedAt.toISOString()}::timestamptz
    WHERE id = ${id}
  `);
}

async function makeUser() {
  return authRepo.create({
    email: `payroll-summary-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Löneadmin",
    role: "admin",
  });
}

async function makeEmployee(overrides: Partial<{ active: boolean }> = {}) {
  return timeReportRepository.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name: "Anställd",
    active: overrides.active ?? true,
  });
}

// One employee, Mon–Fri Dagtid 07:00–16:00 (unpaid lunch 12:00–13:00, net
// 480 min), a morning OB rule and an SJK absence type — the fixture every
// test in this file builds on. Fixed past month: May 2026 (2026-05-04 is a
// Monday, 2026-05-05 a Tuesday; the month has 21 weekdays).
async function seedScenario() {
  const user = await makeUser();
  const employee = await makeEmployee();

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

  await service.createObRule({
    code: "OB1",
    name: "Morgon-OB",
    dayKind: "weekday",
    startTime: "06:00",
    endTime: "07:00",
    paxmlCode: "OB1",
  });
  const absenceType = await service.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });

  // Day 1 (Mon 2026-05-04): closed session 06:30–16:00 → 570 raw minutes,
  // minus the 60 min unpaid lunch = 510 worked. 30 of those (06:30–07:00)
  // fall inside the morning OB window. Raw excess over the 480 min schedule
  // is 30 min, which counts as overtime at the default threshold (0).
  const session1 = await timeReportRepository.createAttendanceSession(employee.id, user.id);
  await backdateAttendanceSession(session1.id, localDate(2026, 5, 4, 6, 30), localDate(2026, 5, 4, 16, 0));

  // Day 2 (Tue 2026-05-05): an OPEN session (never stopped) — contributes 0
  // worked minutes by design, but its startedAt is before the period's end,
  // so it must flag openAttendance. Plus a 120 min SJK absence and a 60 min
  // ATF withdrawal, both dated the same day.
  const session2 = await timeReportRepository.createAttendanceSession(employee.id, user.id);
  await backdateAttendanceSession(session2.id, localDate(2026, 5, 5, 8, 0), null);
  await service.createAbsence(employee.id, { absenceTypeId: absenceType.id, date: "2026-05-05", minutes: 120 }, user.id);
  await atfRepository.createAtfTransaction(employee.id, { date: "2026-05-05", type: "withdrawal", minutes: 60 }, user.id);

  return { user, employee, daySchedule, weekSchedule, absenceType };
}

describe("payroll service — period summary", () => {
  it("computes hand-checked per-day and aggregate minutes, flags open attendance, and excludes a dataless inactive employee", async () => {
    const { employee } = await seedScenario();

    // Active-with-data control, and the actual exclusion case: inactive with
    // absolutely no attendance/absence/ATF in the period.
    const inactiveNoData = await makeEmployee({ active: false });

    const summary = await service.getPeriodSummary(2026, 5);

    expect(summary.year).toBe(2026);
    expect(summary.month).toBe(5);
    expect(summary.status).toBe("open");
    expect(summary.lockedAt).toBeNull();
    expect(summary.employees.map((e) => e.employeeId)).not.toContain(inactiveNoData.id);

    const employeeSummary = summary.employees.find((e) => e.employeeId === employee.id);
    expect(employeeSummary).toBeDefined();
    expect(employeeSummary!.employeeNumber).toBe(employee.employeeNumber);
    expect(employeeSummary!.employmentType).toBeNull();

    const day1 = employeeSummary!.days.find((d) => d.date === "2026-05-04");
    expect(day1).toMatchObject({
      scheduledMinutes: 480,
      workedMinutes: 510,
      ob: [{ code: "OB1", paxmlCode: "OB1", minutes: 30 }],
      overtimeMinutes: 30,
      overtimeOffScheduleMinutes: 0,
      atfMinutes: 0,
      unaccountedMinutes: 0,
    });

    const day2 = employeeSummary!.days.find((d) => d.date === "2026-05-05");
    expect(day2).toMatchObject({
      scheduledMinutes: 480,
      workedMinutes: 0,
      absences: [{ code: "SJK", paxmlCode: "SJK", minutes: 120 }],
      atfMinutes: 60,
      overtimeMinutes: 0,
      overtimeOffScheduleMinutes: 0,
      unaccountedMinutes: 300,
    });

    // Aggregate over the whole month: every other weekday is scheduled
    // (480 min) but untouched (no work/absence/ATF), so it contributes its
    // full 480 to unaccountedMinutes and nothing else; weekends are
    // schedule-free and contribute nothing at all.
    const weekdayCount = countWeekdaysInMonth(2026, 5);
    expect(weekdayCount).toBe(21);
    expect(employeeSummary!.scheduledMinutes).toBe(weekdayCount * 480);
    expect(employeeSummary!.workedMinutes).toBe(510);
    expect(employeeSummary!.overtimeMinutes).toBe(30);
    expect(employeeSummary!.overtimeOffScheduleMinutes).toBe(0);
    expect(employeeSummary!.atfMinutes).toBe(60);
    expect(employeeSummary!.absence).toEqual([{ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK", minutes: 120 }]);
    expect(employeeSummary!.ob).toEqual([{ code: "OB1", paxmlCode: "OB1", minutes: 30 }]);
    expect(employeeSummary!.unaccountedMinutes).toBe(300 + (weekdayCount - 2) * 480);
    expect(employeeSummary!.openAttendance).toBe(true);
    expect(employeeSummary!.attested).toBe(false);
    expect(employeeSummary!.attestedAt).toBeNull();
    expect(employeeSummary!.attestedByName).toBeNull();
  });

  it("includes an inactive employee who has attendance in the period", async () => {
    const user = await makeUser();
    const inactiveWithData = await makeEmployee({ active: false });
    const session = await timeReportRepository.createAttendanceSession(inactiveWithData.id, user.id);
    await backdateAttendanceSession(session.id, localDate(2026, 5, 6, 9, 0), localDate(2026, 5, 6, 10, 0));

    const summary = await service.getPeriodSummary(2026, 5);
    expect(summary.employees.map((e) => e.employeeId)).toContain(inactiveWithData.id);
  });

  it("raises the overtime threshold so the same raw excess no longer counts as overtime", async () => {
    await seedScenario();
    overtimeThresholdMinutes = 100; // day 1's raw excess (30 min) is now under threshold

    const summary = await service.getPeriodSummary(2026, 5);
    const employeeSummary = summary.employees[0]!;
    const day1 = employeeSummary.days.find((d) => d.date === "2026-05-04");
    expect(day1!.overtimeMinutes).toBe(0);
  });

  it("getEmployeePeriodDays returns the same per-day detail plus raw session/absence rows", async () => {
    const { employee } = await seedScenario();

    const result = await service.getEmployeePeriodDays(employee.id, 2026, 5);

    expect(result.days.find((d) => d.date === "2026-05-04")?.workedMinutes).toBe(510);
    expect(result.days.find((d) => d.date === "2026-05-05")?.workedMinutes).toBe(0);

    expect(result.sessions).toHaveLength(2);
    const sessionsByDate = new Map(result.sessions.map((s) => [s.date, s]));
    expect(sessionsByDate.get("2026-05-04")).toMatchObject({ stoppedAt: expect.any(String) });
    expect(sessionsByDate.get("2026-05-05")).toMatchObject({ stoppedAt: null });

    expect(result.absences).toEqual([
      { id: expect.any(String), date: "2026-05-05", code: "SJK", name: "Sjukfrånvaro", minutes: 120, note: null },
    ]);
  });

  it("getEmployeePeriodDays 404s for an unknown employee", async () => {
    await expect(service.getEmployeePeriodDays(crypto.randomUUID(), 2026, 5)).rejects.toBeInstanceOf(
      EmployeeNotFoundError
    );
  });

  it("joins an existing attestation row onto the live-computed summary", async () => {
    const user = await makeUser();
    const employee = await makeEmployee(); // active, no schedule/attendance needed for this check

    // An open period row (so the summary is still computed live, not read
    // from a snapshot) with one attestation for the employee.
    const [period] = await db.insert(payrollPeriods).values({ year: 2026, month: 7, status: "open" }).returning();
    await db.insert(payrollAttestations).values({
      periodId: period!.id,
      employeeId: employee.id,
      attestedBy: user.id,
      attestedAt: new Date(2026, 6, 31, 16, 0),
    });

    const summary = await service.getPeriodSummary(2026, 7);
    expect(summary.status).toBe("open");
    const employeeSummary = summary.employees.find((e) => e.employeeId === employee.id);
    expect(employeeSummary!.attested).toBe(true);
    expect(employeeSummary!.attestedByName).toBe("Löneadmin");
    expect(employeeSummary!.attestedAt).toBe(new Date(2026, 6, 31, 16, 0).toISOString());
  });

  it("returns the locked period's stored snapshot instead of recomputing", async () => {
    const fabricatedSummary = {
      year: 2026,
      month: 6,
      status: "locked" as const,
      lockedAt: "2026-06-30T12:00:00.000Z",
      generatedAt: "2026-06-29T08:00:00.000Z",
      employees: [],
    };

    await db.insert(payrollPeriods).values({
      year: 2026,
      month: 6,
      status: "locked",
      lockedAt: new Date(fabricatedSummary.lockedAt),
      summary: fabricatedSummary,
    });

    // No employees/schedule/attendance seeded for June at all — if this
    // returned anything other than the exact stored blob, it would have had
    // to come from computing over an empty period, which is why an equality
    // check against the fabricated object (not just a shape check) proves
    // the snapshot branch actually short-circuits.
    const summary = await service.getPeriodSummary(2026, 6);
    expect(summary).toEqual(fabricatedSummary);
  });
});

describe("overtime disposition on period days", () => {
  it("defaults to payout, follows the employee default, and lets a day override win", async () => {
    const { employee, user } = await seedScenario();
    // Mon 2026-05-04 already has seedScenario's own 06:30–16:00 session; this
    // one (07:00–17:00) overlaps it, merging into 06:30–17:00 (570 worked
    // minutes after the unpaid lunch) vs the 480 min schedule → 90 min
    // overtime — the exact figure doesn't matter to this test (only that it's
    // > 0 and lands on this day), just that overtimeCompMinutes tracks it.
    // Inserted already closed: seedScenario keeps Tuesday's attendance open,
    // and an employee has at most one open attendance (migration 0173).
    await db.execute(sql`
      INSERT INTO attendance_sessions (employee_id, created_by, started_at, stopped_at)
      VALUES (${employee.id}, ${user.id}, ${localDate(2026, 5, 4, 7, 0).toISOString()}::timestamptz, ${localDate(2026, 5, 4, 17, 0).toISOString()}::timestamptz)
    `);

    let summary = await service.getPeriodSummary(2026, 5);
    let row = summary.employees.find((e) => e.employeeId === employee.id)!;
    let day = row.days.find((d) => d.date === "2026-05-04")!;
    expect(day.overtimeDisposition).toBe("payout");
    expect(day.overtimeDispositionSource).toBe("default");
    expect(row.overtimeCompMinutes).toBe(0);

    await timeReportRepository.updateEmployee(employee.id, { overtimeCompensation: "comp" });
    summary = await service.getPeriodSummary(2026, 5);
    row = summary.employees.find((e) => e.employeeId === employee.id)!;
    day = row.days.find((d) => d.date === "2026-05-04")!;
    expect(day.overtimeDisposition).toBe("comp");
    expect(row.overtimeCompMinutes).toBe(day.overtimeMinutes);
    expect(row.overtimeCompMinutes).toBeGreaterThan(0);

    await service.setOvertimeDisposition(employee.id, "2026-05-04", "payout", user.id);
    summary = await service.getPeriodSummary(2026, 5);
    row = summary.employees.find((e) => e.employeeId === employee.id)!;
    day = row.days.find((d) => d.date === "2026-05-04")!;
    expect(day.overtimeDisposition).toBe("payout");
    expect(day.overtimeDispositionSource).toBe("override");
    expect(row.overtimeCompMinutes).toBe(0);
  });
});
