import { createWeekScheduleSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { absences, auditLog, db, payrollAttestations, payrollPeriods, type Tx } from "@navet/db";
import { stockholmInstant } from "../src/modules/system/service/delivery-days.js";
import { PAXML_CODES, testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import {
  assertPayrollPeriodsOpenInTx,
  lockPayrollPeriodExclusivelyInTx,
} from "../src/modules/payroll/repository/payroll-period-guard.js";
import { UnattestedEmployeesError, createPayrollService } from "../src/modules/payroll/service/payroll.service.js";
import { PayrollPeriodLockedError, createPeriodLockChecker } from "../src/modules/payroll/service/period-lock.js";
import { createAtfRepository } from "../src/modules/timereport/repository/atf.repository.js";
import { createAtfService } from "../src/modules/timereport/service/atf.service.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";
import { failure, waitForLockWaiter } from "./helpers/year-end.js";

// Tidgranskningen: (1) Lås is serialised against every writer the
// löneunderlag reads — the real payroll_periods-backed checker and the real
// repositories, as in payroll-attest.test.ts — and (2) the calendar is
// clipped to Anställd från/till.
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
  testArticleService,
  unwiredSalesOrderLinks
);
const timeReportService = createTimeReportService(timeReportRepository, mfgService, periodLocks, auditRepository);
const scheduleService = createScheduleService(scheduleRepository, timeReportRepository, periodLocks);
const atfService = createAtfService(
  atfRepository,
  timeReportRepository,
  { getSettings: async () => ({ atfMinutesPerWeek: 0 }) },
  periodLocks
);

// Lås paused in the middle of computing the basis (after it took the
// period): the holiday read every computation starts with waits for the
// gate while one is armed.
let computeGate: { reached: () => void; open: Promise<void> } | null = null;
const service = createPayrollService(
  payrollRepository,
  timeReportRepository,
  periodLocks,
  {
    resolveEmployeeCalendar: (employeeId, from, to) => scheduleService.resolveEmployeeCalendar(employeeId, from, to),
    listHolidaysInRange: async (from, to) => {
      const gate = computeGate;
      if (gate) {
        gate.reached();
        await gate.open;
      }
      return scheduleService.listHolidaysInRange(from, to);
    },
  },
  timeReportRepository,
  atfRepository,
  { getSettings: async () => ({ payrollOvertimeThresholdMinutes: 0, ...PAXML_CODES }) },
  auditRepository,
  { getCompanyInfo: async () => null },
  { renderPayrollReport: async () => Buffer.from("") }
);

const TRUNCATE = sql`TRUNCATE
  absences, absence_types, ob_rules, payroll_periods, payroll_attestations, overtime_dispositions,
  attendance_sessions, stamp_sessions, time_reports, atf_transactions,
  employee_day_overrides, employee_week_overrides,
  week_schedule_days, week_schedules, day_schedule_breaks, day_schedules,
  holidays, employees,
  audit_log, users
  CASCADE`;

beforeEach(async () => {
  computeGate = null;
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// May 2026 has ended; 2026-05-04 is a Monday.
const YEAR = 2026;
const MONTH = 5;

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString();
  return new Date(stockholmInstant(wall.slice(0, 10), wall.slice(11, 16)));
}

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
    email: `tidgranskning-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Löneadmin",
    role: "admin",
  });
}

async function makeEmployee(name: string, weekScheduleId?: string) {
  const employee = await timeReportRepository.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name,
    active: true,
  });
  if (weekScheduleId) await timeReportRepository.updateEmployee(employee.id, { defaultWeekScheduleId: weekScheduleId });
  return employee;
}

// Mon–Fri 07:00–16:00 with an unpaid hour: 480 minutes a day.
async function makeWeekSchedule() {
  const daySchedule = await scheduleService.createDaySchedule({
    code: "DAG",
    name: "Dagtid",
    startTime: "07:00",
    endTime: "16:00",
    active: true,
    breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }],
  });
  const weekSchedule = await scheduleService.createWeekSchedule(
    parsed(createWeekScheduleSchema, {
      code: "VDAG",
      name: "Dagtid vecka",
      active: true,
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: daySchedule.id })),
    })
  );
  return { daySchedule, weekSchedule };
}

async function addAttendance(employeeId: string, userId: string, day: number, from = 7, to = 16) {
  const session = await timeReportRepository.createAttendanceSession(employeeId, userId);
  await backdateAttendanceSession(session.id, localDate(YEAR, MONTH, day, from), localDate(YEAR, MONTH, day, to));
  return session;
}

// One employee with a closed attendance on Monday 4 May, attested — May is
// ready to lock.
async function seedAttestedPeriod() {
  const user = await makeUser();
  const { daySchedule, weekSchedule } = await makeWeekSchedule();
  const employee = await makeEmployee("Anna Andersson", weekSchedule.id);
  const absenceType = await service.createAbsenceType({ code: "SJK", name: "Sjukfrånvaro", paxmlCode: "SJK" });
  const session = await addAttendance(employee.id, user.id, 4);
  await service.attest(YEAR, MONTH, employee.id, user.id);
  return { user, employee, daySchedule, weekSchedule, absenceType, session };
}

async function periodRow() {
  const [row] = await db
    .select()
    .from(payrollPeriods)
    .where(and(eq(payrollPeriods.year, YEAR), eq(payrollPeriods.month, MONTH)));
  return row ?? null;
}

async function lockedAuditRows() {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "payroll_period"), eq(auditLog.action, "locked")));
}

// Another transaction in flight (tillverkningsgranskning.test.ts's helper):
// `work` runs, then the transaction stays open until release().
function hold(work: (tx: Tx) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let ready!: () => void;
  const reached = new Promise<void>((resolve) => (ready = resolve));
  const done = db.transaction(async (tx) => {
    await work(tx);
    ready();
    await gate;
  });
  return { locked: Promise.race([reached, done]), release, done };
}

// Starts Lås, stops it inside the basis computation (the period is held),
// starts `write` — which must end up WAITING for the period — and then lets
// Lås finish. Returns the locked basis and the write's error (null = it
// went through).
async function writeDuringLock(userId: string, write: () => Promise<unknown>) {
  let open!: () => void;
  let reached!: () => void;
  const computing = new Promise<void>((resolve) => (reached = resolve));
  computeGate = { reached, open: new Promise<void>((resolve) => (open = resolve)) };
  const locking = service.lockPeriod(YEAR, MONTH, userId);
  let writing: Promise<unknown>;
  try {
    await computing;
    computeGate = null; // only Lås waits at the gate
    writing = failure(write());
    await waitForLockWaiter();
  } finally {
    computeGate = null;
    open();
  }
  const summary = await locking;
  return { summary, error: await writing };
}

describe("Lås mot skrivare som löneunderlaget läser", () => {
  it("waits for an absence being saved and freezes a basis that has it", async () => {
    const { user, employee, absenceType } = await seedAttestedPeriod();

    // The writer's transaction as createAbsence runs it: the guard, then the
    // row — still uncommitted when Lås is pressed.
    const writer = hold(async (tx) => {
      await assertPayrollPeriodsOpenInTx(tx, ["2026-05-05"]);
      await tx
        .insert(absences)
        .values({ employeeId: employee.id, absenceTypeId: absenceType.id, date: "2026-05-05", minutes: 480, createdBy: user.id });
    });
    await writer.locked;
    const locking = service.lockPeriod(YEAR, MONTH, user.id);
    try {
      await waitForLockWaiter();
    } finally {
      writer.release();
    }
    await writer.done;

    const summary = await locking;
    const basis = summary.employees.find((e) => e.employeeId === employee.id)!;
    expect(basis.absence).toEqual([expect.objectContaining({ code: "SJK", minutes: 480 })]);
    expect((await periodRow())!.status).toBe("locked");
  });

  it("refuses an absence saved while Lås is computing — no row outside the basis", async () => {
    const { user, employee, absenceType } = await seedAttestedPeriod();

    const { summary, error } = await writeDuringLock(user.id, () =>
      service.createAbsence(employee.id, { absenceTypeId: absenceType.id, date: "2026-05-05", minutes: 480 }, user.id)
    );

    expect(error).toBeInstanceOf(PayrollPeriodLockedError);
    expect(summary.employees.find((e) => e.employeeId === employee.id)!.absence).toEqual([]);
    expect(await db.select().from(absences)).toHaveLength(0);
  });

  it("refuses an unattest while Lås is computing — the locked period stays attested", async () => {
    const { user, employee } = await seedAttestedPeriod();

    const { summary, error } = await writeDuringLock(user.id, () => service.unattest(YEAR, MONTH, employee.id, user.id));

    expect(error).toBeInstanceOf(PayrollPeriodLockedError);
    expect(summary.employees.find((e) => e.employeeId === employee.id)!.attested).toBe(true);
    expect(await db.select().from(payrollAttestations)).toHaveLength(1);
  });

  it("lets one of two simultaneous Lås through, with one locked entry in the log", async () => {
    const { user } = await seedAttestedPeriod();

    const results = await Promise.allSettled([service.lockPeriod(YEAR, MONTH, user.id), service.lockPeriod(YEAR, MONTH, user.id)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ lockedAt: string | null }>[];
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(PayrollPeriodLockedError);
    expect(await lockedAuditRows()).toHaveLength(1);
    // The stored basis is the winner's.
    const row = (await periodRow())!;
    expect(row.lockedAt!.toISOString()).toBe(fulfilled[0]!.value.lockedAt);
  });

  it("a second Lås behind one in flight waits and is refused", async () => {
    const { user } = await seedAttestedPeriod();

    const { error } = await writeDuringLock(user.id, () => service.lockPeriod(YEAR, MONTH, user.id));

    expect(error).toBeInstanceOf(PayrollPeriodLockedError);
    expect(await lockedAuditRows()).toHaveLength(1);
  });

  it("rolls the lock back when the basis has blockers — no log entry, the period stays open", async () => {
    const { user } = await seedAttestedPeriod();
    await makeEmployee("Bo Oattesterad");

    expect(await failure(service.lockPeriod(YEAR, MONTH, user.id))).toBeInstanceOf(UnattestedEmployeesError);
    expect((await periodRow())!.status).toBe("open");
    expect(await lockedAuditRows()).toHaveLength(0);
  });

  // Every other guarded writer, started while Lås computes: it waits for the
  // period and is refused once the lock has committed.
  const writers: {
    name: string;
    write: (f: Awaited<ReturnType<typeof seedAttestedPeriod>>) => Promise<unknown>;
  }[] = [
    {
      name: "närvarorättning",
      write: (f) =>
        timeReportService.updateAttendanceSession(
          f.session.id,
          { stoppedAt: localDate(YEAR, MONTH, 4, 18).toISOString() },
          f.user.id
        ),
    },
    { name: "borttagen närvaro", write: (f) => timeReportService.deleteAttendanceSession(f.session.id, f.user.id) },
    {
      name: "ATF-uttag",
      write: (f) =>
        atfService.createAtfTransaction(f.employee.id, { date: "2026-05-06", type: "withdrawal", minutes: 60 }, f.user.id),
    },
    {
      name: "övertidsval",
      write: (f) => service.setOvertimeDisposition(f.employee.id, "2026-05-04", "comp", f.user.id),
    },
    {
      name: "dagsavvikelse",
      write: (f) => scheduleService.setDayOverride(f.employee.id, { date: "2026-05-06", dayScheduleId: null }),
    },
    {
      name: "veckoavvikelse",
      write: (f) =>
        scheduleService.setWeekOverride(f.employee.id, { isoYear: 2026, isoWeek: 19, weekScheduleId: f.weekSchedule.id }),
    },
    { name: "helgdag", write: () => scheduleService.createHoliday({ date: "2026-05-14", name: "Testdag" }) },
  ];
  for (const writer of writers) {
    it(`refuses ${writer.name} while Lås is computing`, async () => {
      const fixture = await seedAttestedPeriod();
      const before = JSON.stringify((await service.getPeriodSummary(YEAR, MONTH)).employees.map((e) => e.days));

      const { summary, error } = await writeDuringLock(fixture.user.id, () => writer.write(fixture));

      expect(error).toBeInstanceOf(PayrollPeriodLockedError);
      // Nothing moved: what a fresh computation gives now is what was frozen.
      expect(JSON.stringify(summary.employees.map((e) => e.days))).toBe(before);
      await service.unlockPeriod(YEAR, MONTH, fixture.user.id);
      expect(JSON.stringify((await service.getPeriodSummary(YEAR, MONTH)).employees.map((e) => e.days))).toBe(before);
    });
  }

  it("deletes existing rows in a locked period nowhere: absence, ATF, overrides and holiday removals wait and are refused", async () => {
    const fixture = await seedAttestedPeriod();
    const { user, employee, absenceType } = fixture;
    const absence = await service.createAbsence(
      employee.id,
      { absenceTypeId: absenceType.id, date: "2026-05-05", minutes: 480 },
      user.id
    );
    const atf = await atfService.createAtfTransaction(employee.id, { date: "2026-05-06", type: "withdrawal", minutes: 60 }, user.id);
    const holiday = await scheduleService.createHoliday({ date: "2026-05-14", name: "Testdag" });
    const dayOverride = await scheduleService.setDayOverride(employee.id, { date: "2026-05-07", dayScheduleId: null });

    // Lås held by another transaction that then commits the locked status.
    const lock = hold(async (tx) => {
      await lockPayrollPeriodExclusivelyInTx(tx, YEAR, MONTH);
      await tx.update(payrollPeriods).set({ status: "locked" }).where(and(eq(payrollPeriods.year, YEAR), eq(payrollPeriods.month, MONTH)));
    });
    await lock.locked;
    const pending = [
      failure(service.deleteAbsence(absence.id, user.id)),
      failure(atfService.deleteAtfTransaction(employee.id, atf.id)),
      failure(scheduleService.deleteHoliday(holiday.id)),
      failure(scheduleService.deleteDayOverride(employee.id, dayOverride.id)),
    ];
    try {
      await waitForLockWaiter();
    } finally {
      lock.release();
    }
    await lock.done;

    for (const error of await Promise.all(pending)) expect(error).toBeInstanceOf(PayrollPeriodLockedError);
    expect(await db.select().from(absences)).toHaveLength(1);
    expect(await atfRepository.findAtfTransaction(employee.id, atf.id)).not.toBeNull();
    expect(await scheduleRepository.findHolidayById(holiday.id)).not.toBeNull();
    expect(await scheduleRepository.findDayOverride(employee.id, dayOverride.id)).not.toBeNull();
  });

  it("the forgotten Gå hem is guarded in its own transaction (an attendance left open in a locked month)", async () => {
    const { user, employee } = await seedAttestedPeriod();
    await service.lockPeriod(YEAR, MONTH, user.id);
    // Cannot happen through the services (open attendance blocks Lås) — the
    // repository's own guard is what is under test.
    const open = await timeReportRepository.createAttendanceSession(employee.id, user.id);
    await backdateAttendanceSession(open.id, localDate(YEAR, MONTH, 29, 7), null);

    const error = await failure(
      timeReportRepository.closeForgottenAndBegin(employee.id, open.id, localDate(YEAR, MONTH, 29, 16), new Date(), user.id)
    );

    expect(error).toBeInstanceOf(PayrollPeriodLockedError);
    expect((await timeReportRepository.findAttendanceSessionById(open.id))!.stoppedAt).toBeNull();
  });

  it("the holiday seed skips a month that is locked when the insert runs", async () => {
    const { user } = await seedAttestedPeriod();
    await service.lockPeriod(YEAR, MONTH, user.id);

    // Straight to the repository, as a seed whose pre-check read "open".
    const created = await scheduleRepository.createHolidaysIfMissing([
      { date: "2026-05-01", name: "Första maj" },
      { date: "2026-06-06", name: "Sveriges nationaldag" },
    ]);

    expect(created.map((h) => h.date)).toEqual(["2026-06-06"]);
  });
});

describe("Anställd från/till i lönen", () => {
  const WEEKDAY_MINUTES = 480;

  async function summaryOf(employeeId: string) {
    const summary = await service.getPeriodSummary(YEAR, MONTH);
    return summary.employees.find((e) => e.employeeId === employeeId) ?? null;
  }

  it("gives the days before Anställd från no schedule, no Ofördelat and no deviation", async () => {
    await makeUser();
    const { weekSchedule } = await makeWeekSchedule();
    const employee = await makeEmployee("Ny Nilsson", weekSchedule.id);
    await timeReportRepository.updateEmployee(employee.id, { employedFrom: "2026-05-15" });

    const calendar = await scheduleService.resolveEmployeeCalendar(employee.id, "2026-05-13", "2026-05-15");
    expect(calendar.map((d) => [d.date, d.daySchedule?.code ?? null, d.outsideEmployment ?? false])).toEqual([
      ["2026-05-13", null, true],
      ["2026-05-14", null, true],
      ["2026-05-15", "DAG", false],
    ]);

    // Weekdays 15–31 May 2026: Fri 15, 18–22, 25–29 = 11.
    const basis = (await summaryOf(employee.id))!;
    expect(basis.scheduledMinutes).toBe(11 * WEEKDAY_MINUTES);
    expect(basis.unaccountedMinutes).toBe(11 * WEEKDAY_MINUTES);
    const before = basis.days.filter((d) => d.date < "2026-05-15");
    expect(before.every((d) => d.scheduledMinutes === 0 && d.unaccountedMinutes === 0)).toBe(true);
  });

  it("gives the days after Anställd till no schedule", async () => {
    await makeUser();
    const { weekSchedule } = await makeWeekSchedule();
    const employee = await makeEmployee("Sista Svensson", weekSchedule.id);
    await timeReportRepository.updateEmployee(employee.id, { employedTo: "2026-05-08" });

    // Weekdays 1–8 May 2026: Fri 1, 4–8 = 6.
    const basis = (await summaryOf(employee.id))!;
    expect(basis.scheduledMinutes).toBe(6 * WEEKDAY_MINUTES);
    expect(basis.days.find((d) => d.date === "2026-05-11")!.scheduledMinutes).toBe(0);
  });

  it("counts attendance outside the employment as worked time, without lateness", async () => {
    const user = await makeUser();
    const { weekSchedule } = await makeWeekSchedule();
    const employee = await makeEmployee("Ny Nilsson", weekSchedule.id);
    await timeReportRepository.updateEmployee(employee.id, { employedFrom: "2026-05-15" });
    await addAttendance(employee.id, user.id, 4, 9, 12); // Monday 4 May, 09–12

    const day = (await summaryOf(employee.id))!.days.find((d) => d.date === "2026-05-04")!;
    expect(day.workedMinutes).toBe(180);
    expect(day.scheduledMinutes).toBe(0);
    expect(day.lateMinutes).toBe(0);
    expect(day.earlyLeaveMinutes).toBe(0);
    expect(day.unaccountedMinutes).toBe(0);
  });

  it("leaves an employee starting next month out of the basis — Lås is not blocked", async () => {
    const { user, weekSchedule } = await seedAttestedPeriod();
    const next = await makeEmployee("Juni Jonsson", weekSchedule.id);
    await timeReportRepository.updateEmployee(next.id, { employedFrom: "2026-06-01" });

    expect(await summaryOf(next.id)).toBeNull();
    const locked = await service.lockPeriod(YEAR, MONTH, user.id);
    expect(locked.employees.map((e) => e.name)).toEqual(["Anna Andersson"]);
  });

  it("leaves an employee who left before the month (still active) out of the basis — Lås is not blocked", async () => {
    const { user, weekSchedule } = await seedAttestedPeriod();
    const left = await makeEmployee("April Axelsson", weekSchedule.id);
    await timeReportRepository.updateEmployee(left.id, { employedTo: "2026-04-30" });

    expect(await summaryOf(left.id)).toBeNull();
    const locked = await service.lockPeriod(YEAR, MONTH, user.id);
    expect(locked.employees.map((e) => e.name)).toEqual(["Anna Andersson"]);
  });

  it("keeps an employee outside the employment who has data in the month, and blocks Lås on them", async () => {
    const { user, weekSchedule } = await seedAttestedPeriod();
    const next = await makeEmployee("Juni Jonsson", weekSchedule.id);
    await timeReportRepository.updateEmployee(next.id, { employedFrom: "2026-06-01" });
    await addAttendance(next.id, user.id, 28);

    const basis = (await summaryOf(next.id))!;
    expect(basis.workedMinutes).toBe(540); // no schedule, so no break is taken out
    expect(basis.scheduledMinutes).toBe(0);
    expect(await failure(service.lockPeriod(YEAR, MONTH, user.id))).toBeInstanceOf(UnattestedEmployeesError);
  });

  it("empty dates are as before: scheduled every weekday and blocking Lås until attested", async () => {
    const { user, weekSchedule } = await seedAttestedPeriod();
    const plain = await makeEmployee("Utan Datum", weekSchedule.id);

    // 21 weekdays in May 2026.
    expect((await summaryOf(plain.id))!.scheduledMinutes).toBe(21 * WEEKDAY_MINUTES);
    const error = await failure(service.lockPeriod(YEAR, MONTH, user.id));
    expect(error).toBeInstanceOf(UnattestedEmployeesError);
    expect((error as UnattestedEmployeesError).names).toEqual(["Utan Datum"]);
  });

  it("utjämning: days outside the employment drop out of the week like holidays", async () => {
    await makeUser();
    const balancing = createScheduleService(scheduleRepository, timeReportRepository, periodLocks, {
      settings: { getSettings: async () => ({ scheduleBalancing: true }) },
    });
    const daySchedule = await balancing.createDaySchedule({
      code: "DAG",
      name: "Dagtid",
      startTime: "07:00",
      endTime: "16:00",
      active: true,
      breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }],
    });
    // 38 h a week on 5 × 8 h: every day earns 7 h 36 min, the last one is short.
    const weekSchedule = await balancing.createWeekSchedule(
      parsed(createWeekScheduleSchema, {
        code: "V38",
        name: "38 timmar",
        active: true,
        ordinaryMinutesPerWeek: 2280,
        atfMinutesPerWeek: 0,
        days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: daySchedule.id })),
      })
    );
    const net = async (employeeId: string) =>
      (await balancing.resolveEmployeeCalendar(employeeId, "2026-05-04", "2026-05-08")).map((d) => d.daySchedule?.netMinutes ?? null);

    const whole = await makeEmployee("Hel Vecka", weekSchedule.id);
    expect(await net(whole.id)).toEqual([480, 480, 480, 480, 360]);

    // Starts Wednesday 6 May: three workdays, 3 × 456 − 2 × 480 = 408.
    const starts = await makeEmployee("Börjar Onsdag", weekSchedule.id);
    await timeReportRepository.updateEmployee(starts.id, { employedFrom: "2026-05-06" });
    expect(await net(starts.id)).toEqual([null, null, 480, 480, 408]);

    // Leaves Wednesday 6 May: Wednesday is the week's last workday.
    const leaves = await makeEmployee("Slutar Onsdag", weekSchedule.id);
    await timeReportRepository.updateEmployee(leaves.id, { employedTo: "2026-05-06" });
    expect(await net(leaves.id)).toEqual([480, 480, 408, null, null]);
  });
});
