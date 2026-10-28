import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { absences, db } from "@navet/db";
import { PAXML_CODES, testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import {
  createPayrollRepository,
  upsertOvertimeDispositionInTx,
} from "../src/modules/payroll/repository/payroll.repository.js";
import { createPayrollService } from "../src/modules/payroll/service/payroll.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createAtfRepository } from "../src/modules/timereport/repository/atf.repository.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { AttendanceInputRequiredError } from "../src/modules/timereport/service/attendance-deviation.js";

// Utjämning (etapp 2): payroll and the terminal's deviation check read the
// resolved calendar, so a balanced week's last workday reaches them with no
// change of their own. Real schedule/payroll/timereport services; only the
// settings, the period lock and the clock are stubs. The payroll engine reads
// schedule clocks in the server's zone, so the file pins Europe/Stockholm.

// Week 45 of 2026 (winter time, UTC+1): Monday 2 – Friday 6 November.
const MON = "2026-11-02";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";
const at = (date: string, clock: string) => new Date(`${date}T${clock}:00+01:00`);

const authRepo = createAuthRepository(db);
const timeReportRepository = createTimeReportRepository(db);
const payrollRepository = createPayrollRepository(db);
const audit = createAuditRepository(db);
const periodLocks = { isDateLocked: async () => false };
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, periodLocks, {
  settings: { getSettings: async () => ({ scheduleBalancing: true }) },
  absences: payrollRepository,
});
const payrollService = createPayrollService(
  payrollRepository,
  timeReportRepository,
  periodLocks,
  scheduleService,
  timeReportRepository,
  createAtfRepository(db),
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  audit,
  { getCompanyInfo: async () => null },
  { renderPayrollReport: async () => Buffer.from("") }
);

const settings = { attendanceReasonRequired: true, attendanceReasonToleranceMinutes: 5, terminalOvertimeChoice: false };
let now = at(FRI, "07:00");
const timeReportService = createTimeReportService(
  timeReportRepository,
  createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService),
  periodLocks,
  audit,
  {
    settings: { getSettings: async () => ({ ...settings }) },
    calendar: scheduleService,
    previewDay: (employeeId, date, opts) => payrollService.previewDay(employeeId, date, opts),
    dispositionWriter: { upsert: upsertOvertimeDispositionInTx },
    now: () => now,
  }
);

const TRUNCATE = sql`TRUNCATE attendance_sessions, stamp_sessions, time_reports, atf_transactions, overtime_dispositions,
  absences, absence_types, employee_day_overrides, employee_week_overrides, holidays, week_schedule_days, week_schedules,
  day_schedule_breaks, day_schedules, employees, payroll_periods, payroll_attestations, audit_log, users CASCADE`;

let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  now = at(FRI, "07:00");
});

// The spec's example: Mon–Thu 07:00–16:15 (8 h 15 min), Friday 07:00–12:58
// (5 h 38 min), ordinary 40 h and ATF 82 min per week.
async function setup() {
  const user = await authRepo.create({ email: `utj-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Terminal", role: "admin" });
  const monThu = await scheduleService.createDaySchedule({
    code: "MAN-TOR",
    name: "Måndag–torsdag",
    startTime: "07:00",
    endTime: "16:15",
    active: true,
    breaks: [
      { type: "unpaid", startTime: "09:00", endTime: "09:20" },
      { type: "unpaid", startTime: "12:00", endTime: "12:40" },
    ],
  });
  const friday = await scheduleService.createDaySchedule({
    code: "FREDAG",
    name: "Fredag",
    startTime: "07:00",
    endTime: "12:58",
    active: true,
    breaks: [{ type: "unpaid", startTime: "09:00", endTime: "09:20" }],
  });
  const week = await scheduleService.createWeekSchedule({
    code: "DAG-ATF",
    name: "Dag med ATF",
    active: true,
    days: [1, 2, 3, 4].map((weekday) => ({ weekday, dayScheduleId: monThu.id })).concat([{ weekday: 5, dayScheduleId: friday.id }]),
    ordinaryMinutesPerWeek: 2400,
    atfMinutesPerWeek: 82,
  });
  const employee = await timeReportRepository.createEmployee({ employeeNumber: "301", name: "Utjämnad", active: true });
  await timeReportRepository.updateEmployee(employee.id, { defaultWeekScheduleId: week.id });
  return { user, employee };
}

// A whole attendance from 07:00 to `stop` on `date`, through the terminal.
async function workDay(employeeId: string, userId: string, date: string, stop: string) {
  now = at(date, "07:00");
  const opened = await timeReportService.attendanceIn({ employeeId }, userId);
  now = at(date, stop);
  // With a reason, so the stop always goes through — the questions are
  // tested separately below.
  const reasons = await payrollRepository.listAttendanceDeviationReasons(false);
  const reason = reasons[0] ?? (await payrollRepository.createAttendanceDeviationReason({ code: "OVR", name: "Övrigt" }));
  await timeReportService.attendanceOut(opened.id, userId, { reason: { reasonId: reason.id } });
}

async function payrollDay(employeeId: string, date: string) {
  const { days } = await payrollService.getEmployeePeriodDays(employeeId, 2026, 11);
  return days.find((d) => d.date === date)!;
}

async function sickDay(employeeId: string, date: string, minutes: number) {
  const type = await payrollRepository.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK", earnsAtf: false });
  await db.insert(absences).values({ employeeId, absenceTypeId: type.id, date, minutes });
}

describe("lönen följer den utjämnade sista arbetsdagen", () => {
  it("a whole week: going home 12:58 on Friday leaves nothing unaccounted", async () => {
    const { user, employee } = await setup();
    await workDay(employee.id, user.id, FRI, "12:58");
    expect(await payrollDay(employee.id, FRI)).toMatchObject({
      scheduledMinutes: 338,
      workedMinutes: 338,
      unaccountedMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
    });
  });

  it("a red Wednesday: Friday is 6 h 09 min — 12:58 is 31 min early and unaccounted", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    await workDay(employee.id, user.id, FRI, "12:58");
    expect(await payrollDay(employee.id, FRI)).toMatchObject({
      scheduledMinutes: 369,
      workedMinutes: 338,
      unaccountedMinutes: 31,
      earlyLeaveMinutes: 31,
      overtimeMinutes: 0,
    });
  });

  it("a red Wednesday: going home 13:29 is the whole day", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    await workDay(employee.id, user.id, FRI, "13:29");
    expect(await payrollDay(employee.id, FRI)).toMatchObject({
      scheduledMinutes: 369,
      workedMinutes: 369,
      unaccountedMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
    });
  });

  it("a red Wednesday: work until 15:00 is overtime from 13:29", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    await workDay(employee.id, user.id, FRI, "15:00");
    // 07:00–15:00 minus the 20 min break = 460 worked; 460 − 369 = 91.
    expect(await payrollDay(employee.id, FRI)).toMatchObject({ workedMinutes: 460, overtimeMinutes: 91, earlyLeaveMinutes: 0 });
  });

  it("a red Friday: Thursday is the short day, 07:00–14:09", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: FRI, name: "Röd fredag" });
    await workDay(employee.id, user.id, THU, "14:09");
    expect(await payrollDay(employee.id, THU)).toMatchObject({
      scheduledMinutes: 369,
      workedMinutes: 369,
      unaccountedMinutes: 0,
      earlyLeaveMinutes: 0,
    });
    expect(await payrollDay(employee.id, FRI)).toMatchObject({ scheduledMinutes: 0 });
  });

  it("a sick Wednesday: the absence covers Wednesday, and Friday owes its lost ATF share", async () => {
    const { user, employee } = await setup();
    await sickDay(employee.id, WED, 495);
    await workDay(employee.id, user.id, FRI, "12:58");
    expect(await payrollDay(employee.id, WED)).toMatchObject({ scheduledMinutes: 495, unaccountedMinutes: 0 });
    expect(await payrollDay(employee.id, FRI)).toMatchObject({
      scheduledMinutes: 354,
      unaccountedMinutes: 16,
      earlyLeaveMinutes: 16,
    });
  });

  it("a sick Friday: Heldag is the day as resolved, and the absence covers it", async () => {
    const { employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    const [friday] = await scheduleService.resolveEmployeeCalendar(employee.id, FRI, FRI);
    // The Frånvaro form's Heldag reads this; the last workday's own absence
    // does not change it again.
    await sickDay(employee.id, FRI, friday!.daySchedule!.netMinutes);
    expect(await payrollDay(employee.id, FRI)).toMatchObject({ scheduledMinutes: 369, unaccountedMinutes: 0 });
  });

  it("the attestation's Avvikelser counts the early Friday of a short week", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    // Corrected by the supervisor without a reason (as a stamp with the
    // setting off would be): a deviation day that misses its reason.
    const opened = await timeReportRepository.createAttendanceSession(employee.id, user.id);
    await db.execute(sql`UPDATE attendance_sessions SET started_at = ${at(FRI, "07:00").toISOString()}::timestamptz,
      stopped_at = ${at(FRI, "12:58").toISOString()}::timestamptz WHERE id = ${opened.id}`);
    const summary = await payrollService.getPeriodSummary(2026, 11);
    const row = summary.employees.find((e) => e.employeeId === employee.id)!;
    expect([row.deviationDays, row.missingReasonDays]).toEqual([1, 1]);
  });
});

describe("terminalens fråga om tidig hemgång", () => {
  async function goHome(employeeId: string, userId: string, date: string, stop: string) {
    now = at(date, "07:00");
    const opened = await timeReportService.attendanceIn({ employeeId }, userId);
    now = at(date, stop);
    return timeReportService.attendanceOut(opened.id, userId).catch((e: unknown) => e);
  }

  it("a whole week: Gå hem 12:58 on Friday asks nothing", async () => {
    const { user, employee } = await setup();
    const result = await goHome(employee.id, user.id, FRI, "12:58");
    expect(result).not.toBeInstanceOf(Error);
  });

  it("a red Wednesday: Gå hem 12:58 asks for a reason, against 13:29", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    const err = await goHome(employee.id, user.id, FRI, "12:58");
    expect(err).toBeInstanceOf(AttendanceInputRequiredError);
    expect((err as AttendanceInputRequiredError).reason).toEqual({ kind: "early", minutes: 31, scheduledTime: "13:29" });
  });

  it("a red Wednesday: Gå hem 13:29 asks nothing", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    const result = await goHome(employee.id, user.id, FRI, "13:29");
    expect(result).not.toBeInstanceOf(Error);
  });

  it("a red Friday: Thursday's Gå hem is measured against 14:09", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: FRI, name: "Röd fredag" });
    const err = await goHome(employee.id, user.id, THU, "13:00");
    expect((err as AttendanceInputRequiredError).reason).toEqual({ kind: "early", minutes: 69, scheduledTime: "14:09" });
  });

  it("an ordinary Monday is untouched by the balancing", async () => {
    const { user, employee } = await setup();
    await scheduleService.createHoliday({ date: WED, name: "Röd onsdag" });
    const err = await goHome(employee.id, user.id, MON, "16:00");
    expect((err as AttendanceInputRequiredError).reason).toEqual({ kind: "early", minutes: 15, scheduledTime: "16:15" });
  });
});
