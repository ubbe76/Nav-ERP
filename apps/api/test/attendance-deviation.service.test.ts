import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  attendanceDeviationReasons,
  attendanceSessions,
  auditLog,
  db,
  manufacturingOrders,
  overtimeDispositions,
  stampSessions,
} from "@navet/db";
import { PAXML_CODES, testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
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
import {
  AttendanceSessionAlreadyStoppedError,
  createTimeReportService,
  type AttendanceDeviationDeps,
} from "../src/modules/timereport/service/timereport.service.js";
import {
  AtfTransactionMismatchError,
  AttendanceInputRequiredError,
  AttendanceReasonInvalidError,
} from "../src/modules/timereport/service/attendance-deviation.js";

// Närvaroavvikelser against Postgres: the reason / overtime guards on
// Stämpla in närvaro, Stämpla in (regel 5) and Gå hem, wired with the real
// schedule, payroll day and disposition writer — only the settings, the
// period lock and the clock are stubs. The payroll engine reads schedule
// clocks in the server's zone (Europe/Stockholm in the container), so the
// file pins that zone.

const DAY = "2026-06-10"; // Wednesday, summer time (UTC+2)
const PREV = "2026-06-09";
const at = (clock: string, date = DAY) => new Date(`${date}T${clock}+02:00`);

const authRepo = createAuthRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const timeReportRepository = createTimeReportRepository(db);
const atfRepository = createAtfRepository(db);
const payrollRepository = createPayrollRepository(db);
const audit = createAuditRepository(db);

const lockedDates = new Set<string>();
const periodLocks = { isDateLocked: async (date: string) => lockedDates.has(date) };
const scheduleService = createScheduleService(createScheduleRepository(db), timeReportRepository, periodLocks);
const payrollService = createPayrollService(
  payrollRepository,
  timeReportRepository,
  periodLocks,
  scheduleService,
  timeReportRepository,
  atfRepository,
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  audit,
  { getCompanyInfo: async () => null },
  { renderPayrollReport: async () => Buffer.from("") }
);

const settings = { attendanceReasonRequired: false, attendanceReasonToleranceMinutes: 5, terminalOvertimeChoice: false };
let now = at("07:00:00");

function deps(overrides: Partial<AttendanceDeviationDeps> = {}): AttendanceDeviationDeps {
  return {
    settings: { getSettings: async () => ({ ...settings }) },
    calendar: scheduleService,
    previewDay: (employeeId, date, opts) => payrollService.previewDay(employeeId, date, opts),
    dispositionWriter: { upsert: upsertOvertimeDispositionInTx },
    now: () => now,
    ...overrides,
  };
}
const service = createTimeReportService(timeReportRepository, mfgService, periodLocks, audit, deps());

const TRUNCATE = sql`TRUNCATE attendance_deviation_reasons, attendance_sessions, atf_transactions, overtime_dispositions, employee_day_overrides, day_schedules, holidays, absences, stamp_sessions, time_reports, employees, mo_reports, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, bom_components, articles, payroll_periods, audit_log, users CASCADE`;

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
  lockedDates.clear();
  Object.assign(settings, { attendanceReasonRequired: false, attendanceReasonToleranceMinutes: 5, terminalOvertimeChoice: false });
  now = at("07:00:00");
});

async function setup(opts: { schedule?: boolean } = {}) {
  const user = await authRepo.create({
    email: `dev-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Terminal",
    role: "admin",
  });
  const employee = await timeReportRepository.createEmployee({ employeeNumber: "107", name: "Urban", active: true });
  if (opts.schedule !== false) {
    const daySchedule = await scheduleService.createDaySchedule({
      code: "DAG",
      name: "Dag 07-16",
      startTime: "07:00",
      endTime: "16:00",
      breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }],
      active: true,
    });
    await scheduleService.setDayOverride(employee.id, { date: DAY, dayScheduleId: daySchedule.id });
  }
  const [traffic] = await db.insert(attendanceDeviationReasons).values({ code: "TRAFIK", name: "Trafik/resa" }).returning();
  const [doctor] = await db.insert(attendanceDeviationReasons).values({ code: "LAKARE", name: "Läkarbesök" }).returning();
  return { user, employee, traffic: traffic!, doctor: doctor! };
}

// A released TO with one operation, for Stämpla in.
async function makeOperation(userId: string) {
  const parent = await articleService.createArticle({
    articleNumber: `P-${crypto.randomUUID()}`,
    name: "Produkt",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, userId);
  const [operation] = await mfgService.listOperations(order.id);
  return { order, operation: operation! };
}

async function expectInputRequired(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(AttendanceInputRequiredError);
  return err as AttendanceInputRequiredError;
}

async function session(id: string) {
  const [row] = await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, id));
  return row!;
}

describe("settings off", () => {
  it("behaves as before: no question for a late arrival, an early departure or overtime", async () => {
    const { user, employee } = await setup();
    now = at("08:30:00");
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    expect(opened.startReasonId).toBeNull();
    now = at("14:00:00");
    const { session: closed } = await service.attendanceOut(opened.id, user.id);
    expect(closed.stoppedAt).toEqual(at("14:00:00"));
    expect(closed.stopReasonId).toBeNull();
    expect(await db.select().from(overtimeDispositions)).toHaveLength(0);
    // A plain Gå hem is still not logged — the session is the record.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "attendance_stopped"))).toHaveLength(0);
  });

  it("stores a reason that is sent anyway", async () => {
    const { user, employee, traffic } = await setup();
    now = at("08:30:00");
    const opened = await service.attendanceIn(
      { employeeId: employee.id, reason: { reasonId: traffic.id, note: "kö på E4" } },
      user.id
    );
    expect([opened.startReasonId, opened.startNote]).toEqual([traffic.id, "kö på E4"]);
  });
});

describe("sen ankomst", () => {
  it("asks for a reason beyond the tolerance and stores the answer", async () => {
    const { user, employee, traffic } = await setup();
    settings.attendanceReasonRequired = true;
    now = at("07:12:00");
    const err = await expectInputRequired(service.attendanceIn({ employeeId: employee.id }, user.id));
    expect(err.reason).toEqual({ kind: "late", minutes: 12, scheduledTime: "07:00" });
    expect(err.overtime).toBeNull();
    expect(await db.select().from(attendanceSessions)).toHaveLength(0);

    const opened = await service.attendanceIn(
      { employeeId: employee.id, reason: { reasonId: traffic.id, note: "kö på E4" } },
      user.id
    );
    const stored = await session(opened.id);
    expect([stored.startReasonId, stored.startNote, stored.startedAt]).toEqual([traffic.id, "kö på E4", at("07:12:00")]);
  });

  it("asks nothing within the tolerance, on a free day, or on a return after an early departure", async () => {
    const { user, employee, doctor } = await setup();
    settings.attendanceReasonRequired = true;
    now = at("07:05:00");
    const first = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("10:00:00");
    await service.attendanceOut(first.id, user.id, { reason: { reasonId: doctor.id } });
    now = at("13:30:00");
    const back = await service.attendanceIn({ employeeId: employee.id }, user.id);
    expect(back.startReasonId).toBeNull();

    // The day before has no schedule.
    const other = await timeReportRepository.createEmployee({ employeeNumber: "108", name: "Ledig", active: true });
    now = at("11:00:00", PREV);
    await expect(service.attendanceIn({ employeeId: other.id }, user.id)).resolves.toBeDefined();
  });

  it("refuses an unknown or inactive reason with 400 attendance-reason-invalid", async () => {
    const { user, employee, traffic } = await setup();
    await db.update(attendanceDeviationReasons).set({ active: false }).where(eq(attendanceDeviationReasons.id, traffic.id));
    now = at("07:30:00");
    await expect(
      service.attendanceIn({ employeeId: employee.id, reason: { reasonId: traffic.id } }, user.id)
    ).rejects.toBeInstanceOf(AttendanceReasonInvalidError);
    await expect(
      service.attendanceIn({ employeeId: employee.id, reason: { reasonId: crypto.randomUUID() } }, user.id)
    ).rejects.toBeInstanceOf(AttendanceReasonInvalidError);
  });

  it("asks nothing for a date in a locked payroll period", async () => {
    const { user, employee } = await setup();
    settings.attendanceReasonRequired = true;
    lockedDates.add(DAY);
    now = at("09:00:00");
    await expect(service.attendanceIn({ employeeId: employee.id }, user.id)).resolves.toBeDefined();
  });

  it("a forgotten Gå hem asks nothing for the forgotten time, but today's late start needs its reason", async () => {
    const { user, employee, traffic } = await setup();
    settings.attendanceReasonRequired = true;
    now = at("07:00:00", PREV);
    const stale = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("07:20:00");
    const forgottenStoppedAt = at("15:00:00", PREV).toISOString();
    const err = await expectInputRequired(service.attendanceIn({ employeeId: employee.id, forgottenStoppedAt }, user.id));
    expect(err.reason).toEqual({ kind: "late", minutes: 20, scheduledTime: "07:00" });
    // Nothing written: the stale attendance is still open.
    expect((await session(stale.id)).stoppedAt).toBeNull();

    const today = await service.attendanceIn(
      { employeeId: employee.id, forgottenStoppedAt, reason: { reasonId: traffic.id } },
      user.id
    );
    expect((await session(today.id)).startReasonId).toBe(traffic.id);
    const closed = await session(stale.id);
    expect([closed.stoppedAt, closed.stopReasonId]).toEqual([at("15:00:00", PREV), null]);
  });

  it("Stämpla in on work that opens the attendance asks first — before the order starts", async () => {
    const { user, employee, traffic } = await setup();
    settings.attendanceReasonRequired = true;
    const { order, operation } = await makeOperation(user.id);

    now = at("07:30:00");
    const err = await expectInputRequired(
      service.stampIn({ employeeId: employee.id, moOperationId: operation!.id }, user.id)
    );
    expect(err.reason).toMatchObject({ kind: "late", minutes: 30 });
    expect(await db.select().from(stampSessions)).toHaveLength(0);
    expect(await db.select().from(attendanceSessions)).toHaveLength(0);
    const [unstarted] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, order.id));
    expect(unstarted!.status).toBe("released");

    const stamp = await service.stampIn(
      { employeeId: employee.id, moOperationId: operation!.id, attendanceReason: { reasonId: traffic.id, note: "buss" } },
      user.id
    );
    expect(stamp.attendanceStarted).toBe(true);
    const [attendance] = await db.select().from(attendanceSessions);
    expect([attendance!.startReasonId, attendance!.startNote]).toEqual([traffic.id, "buss"]);
  });
});

describe("tidig hemgång", () => {
  it("asks for a reason beyond the tolerance and stores the answer with an audit entry", async () => {
    const { user, employee, doctor } = await setup();
    settings.attendanceReasonRequired = true;
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("15:20:00");
    const err = await expectInputRequired(service.attendanceOut(opened.id, user.id));
    expect(err.reason).toEqual({ kind: "early", minutes: 40, scheduledTime: "16:00" });
    expect((await session(opened.id)).stoppedAt).toBeNull();

    await service.attendanceOut(opened.id, user.id, { reason: { reasonId: doctor.id, note: "tandläkare" } });
    const stored = await session(opened.id);
    expect([stored.stoppedAt, stored.stopReasonId, stored.stopNote]).toEqual([at("15:20:00"), doctor.id, "tandläkare"]);
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "attendance_stopped"));
    expect(entry!.detail).toMatchObject({ stopReasonId: doctor.id, stopNote: "tandläkare", overtimeDisposition: null });
  });

  it("Ta ut ATF explains the departure — but only today's withdrawal by the same employee", async () => {
    const { user, employee } = await setup();
    settings.attendanceReasonRequired = true;
    const other = await timeReportRepository.createEmployee({ employeeNumber: "108", name: "Annan", active: true });
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("12:00:00");

    const othersAtf = await atfRepository.createAtfTransaction(other.id, { date: DAY, type: "withdrawal", minutes: 240 }, user.id);
    await expect(
      service.attendanceOut(opened.id, user.id, { atfTransactionId: othersAtf.id })
    ).rejects.toBeInstanceOf(AtfTransactionMismatchError);
    const yesterdays = await atfRepository.createAtfTransaction(employee.id, { date: PREV, type: "withdrawal", minutes: 240 }, user.id);
    await expect(
      service.attendanceOut(opened.id, user.id, { atfTransactionId: yesterdays.id })
    ).rejects.toBeInstanceOf(AtfTransactionMismatchError);
    const adjustment = await atfRepository.createAtfTransaction(employee.id, { date: DAY, type: "adjustment", minutes: 240 }, user.id);
    await expect(
      service.attendanceOut(opened.id, user.id, { atfTransactionId: adjustment.id })
    ).rejects.toBeInstanceOf(AtfTransactionMismatchError);

    const own = await atfRepository.createAtfTransaction(employee.id, { date: DAY, type: "withdrawal", minutes: 180 }, user.id);
    const { session: closed } = await service.attendanceOut(opened.id, user.id, { atfTransactionId: own.id });
    expect([closed.stoppedAt, closed.stopReasonId]).toEqual([at("12:00:00"), null]);
  });
});

describe("övertid vid Gå hem", () => {
  it("asks how the day's overtime is compensated and writes the choice with the stop", async () => {
    const { user, employee } = await setup();
    settings.terminalOvertimeChoice = true;
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("17:00:00");
    const err = await expectInputRequired(service.attendanceOut(opened.id, user.id));
    // 07–17 minus the unpaid lunch = 540, schedule 480.
    expect(err.overtime).toEqual({ minutes: 60, offSchedule: false, current: "payout" });
    expect(err.reason).toBeNull();
    expect(await db.select().from(overtimeDispositions)).toHaveLength(0);

    await service.attendanceOut(opened.id, user.id, { overtimeDisposition: "comp" });
    const [row] = await db.select().from(overtimeDispositions);
    expect([row!.employeeId, row!.date, row!.disposition]).toEqual([employee.id, DAY, "comp"]);
    const [set] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "overtime_disposition"), eq(auditLog.action, "set")));
    expect(set!.detail).toEqual({ employeeId: employee.id, date: DAY, disposition: "comp", source: "terminal" });
  });

  it("pre-fills the day's current choice and asks again; the last Gå hem wins", async () => {
    const { user, employee } = await setup();
    settings.terminalOvertimeChoice = true;
    await payrollService.setOvertimeDisposition(employee.id, DAY, "comp", user.id);
    const first = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("16:00:00");
    await service.attendanceOut(first.id, user.id); // exactly the schedule — no overtime, no question
    now = at("18:00:00");
    const second = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("19:00:00");
    const err = await expectInputRequired(service.attendanceOut(second.id, user.id));
    expect(err.overtime).toEqual({ minutes: 60, offSchedule: false, current: "comp" });
    await service.attendanceOut(second.id, user.id, { overtimeDisposition: "payout" });
    const rows = await db.select().from(overtimeDispositions);
    expect(rows.map((r) => r.disposition)).toEqual(["payout"]);
  });

  it("asks for both at once: left early and still worked past the schedule", async () => {
    const { user, employee, doctor } = await setup();
    Object.assign(settings, { attendanceReasonRequired: true, terminalOvertimeChoice: true });
    now = at("05:00:00");
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("15:00:00");
    const err = await expectInputRequired(service.attendanceOut(opened.id, user.id));
    // 05–15 minus lunch = 540 worked against 480.
    expect(err.reason).toEqual({ kind: "early", minutes: 60, scheduledTime: "16:00" });
    expect(err.overtime).toEqual({ minutes: 60, offSchedule: false, current: "payout" });
    // Answering one question still leaves the other.
    const partial = await expectInputRequired(
      service.attendanceOut(opened.id, user.id, { reason: { reasonId: doctor.id } })
    );
    expect(partial.reason).toBeNull();
    expect(partial.overtime).not.toBeNull();
    await service.attendanceOut(opened.id, user.id, { reason: { reasonId: doctor.id }, overtimeDisposition: "payout" });
  });

  it("off-schedule work is helgövertid", async () => {
    const { user, employee } = await setup({ schedule: false });
    settings.terminalOvertimeChoice = true;
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("09:30:00");
    const err = await expectInputRequired(service.attendanceOut(opened.id, user.id));
    expect(err.overtime).toEqual({ minutes: 150, offSchedule: true, current: "payout" });
  });

  it("asks nothing and writes nothing in a locked period", async () => {
    const { user, employee } = await setup();
    Object.assign(settings, { attendanceReasonRequired: true, terminalOvertimeChoice: true });
    lockedDates.add(DAY);
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("18:00:00");
    await service.attendanceOut(opened.id, user.id, { overtimeDisposition: "comp" });
    expect(await db.select().from(overtimeDispositions)).toHaveLength(0);
  });

  it("a failing disposition write rolls back the stop and the paused work", async () => {
    const { user, employee } = await setup();
    settings.terminalOvertimeChoice = true;
    const failing = createTimeReportService(
      timeReportRepository,
      mfgService,
      periodLocks,
      audit,
      deps({
        dispositionWriter: {
          upsert: async (tx, ...args) => {
            await upsertOvertimeDispositionInTx(tx, ...args);
            throw new Error("boom");
          },
        },
      })
    );
    // Stämpla in opens the attendance (regel 5) and leaves work to pause.
    const { operation } = await makeOperation(user.id);
    const stamp = await failing.stampIn({ employeeId: employee.id, moOperationId: operation.id }, user.id);
    const [opened] = await db.select().from(attendanceSessions);
    now = at("17:00:00");
    await expect(failing.attendanceOut(opened!.id, user.id, { overtimeDisposition: "comp" })).rejects.toThrow("boom");
    expect((await session(opened!.id)).stoppedAt).toBeNull();
    const [work] = await db.select().from(stampSessions).where(eq(stampSessions.id, stamp.id));
    expect(work!.pausedAt).toBeNull();
    expect(await db.select().from(overtimeDispositions)).toHaveLength(0);

    // The working service pauses it with the stop.
    const { pausedWorkSessions } = await service.attendanceOut(opened!.id, user.id, { overtimeDisposition: "comp" });
    expect(pausedWorkSessions).toBe(1);
  });

  it("two simultaneous Gå hem: one stops, the other gets already-stopped, the choice is written once", async () => {
    const { user, employee } = await setup();
    settings.terminalOvertimeChoice = true;
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("17:00:00");
    const results = await Promise.allSettled([
      service.attendanceOut(opened.id, user.id, { overtimeDisposition: "comp" }),
      service.attendanceOut(opened.id, user.id, { overtimeDisposition: "comp" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AttendanceSessionAlreadyStoppedError);
    expect(await db.select().from(overtimeDispositions)).toHaveLength(1);
    const sets = await db.select().from(auditLog).where(eq(auditLog.entityType, "overtime_disposition"));
    expect(sets).toHaveLength(1);
  });
});

describe("attesteringen", () => {
  it("corrects the reasons on a session (null clears) and refuses a new inactive one", async () => {
    const { user, employee, traffic, doctor } = await setup();
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("15:00:00");
    await service.attendanceOut(opened.id, user.id);

    const updated = await service.updateAttendanceSession(
      opened.id,
      { startReasonId: traffic.id, startNote: "kö", stopReasonId: doctor.id },
      user.id
    );
    expect([updated.startReasonId, updated.startNote, updated.stopReasonId, updated.stopNote]).toEqual([
      traffic.id,
      "kö",
      doctor.id,
      null,
    ]);

    // The reason already on the session may since have been inactivated.
    await db.update(attendanceDeviationReasons).set({ active: false }).where(eq(attendanceDeviationReasons.id, traffic.id));
    await expect(
      service.updateAttendanceSession(opened.id, { startReasonId: traffic.id, startNote: "kö på E4" }, user.id)
    ).resolves.toMatchObject({ startNote: "kö på E4" });
    await expect(
      service.updateAttendanceSession(opened.id, { stopReasonId: traffic.id }, user.id)
    ).rejects.toBeInstanceOf(AttendanceReasonInvalidError);

    const cleared = await service.updateAttendanceSession(opened.id, { startReasonId: null, startNote: null }, user.id);
    expect([cleared.startReasonId, cleared.startNote, cleared.stopReasonId]).toEqual([null, null, doctor.id]);
  });

  it("shows the deviations and the reasons in the period", async () => {
    const { user, employee, doctor } = await setup();
    now = at("07:30:00"); // 30 min late, setting off — no reason
    const opened = await service.attendanceIn({ employeeId: employee.id }, user.id);
    now = at("15:00:00"); // 60 min early, with a reason
    await service.attendanceOut(opened.id, user.id, { reason: { reasonId: doctor.id, note: "tandläkare" } });

    const days = await payrollService.getEmployeePeriodDays(employee.id, 2026, 6);
    const day = days.days.find((d) => d.date === DAY)!;
    expect([day.lateMinutes, day.earlyLeaveMinutes]).toEqual([30, 60]);
    expect(days.sessions).toEqual([
      expect.objectContaining({
        id: opened.id,
        startReason: null,
        startNote: null,
        stopReason: { id: doctor.id, code: "LAKARE", name: "Läkarbesök" },
        stopNote: "tandläkare",
      }),
    ]);

    const summary = await payrollService.getPeriodSummary(2026, 6);
    const row = summary.employees.find((e) => e.employeeId === employee.id)!;
    // One day with deviations; its late arrival has no reason.
    expect([row.deviationDays, row.missingReasonDays]).toEqual([1, 1]);
  });
});
