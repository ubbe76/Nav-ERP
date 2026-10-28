import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { absences, db } from "@navet/db";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createPayrollRepository } from "../src/modules/payroll/repository/payroll.repository.js";
import {
  InvalidScheduleError,
  ScheduleBalancingInvalidError,
  ScheduleBalancingOffError,
  createScheduleService,
} from "../src/modules/timereport/service/schedule.service.js";

// Utjämning (ATF och inarbetning) on the week schedule — the service side:
// the setting, validation on save, the förhandsvisning and the resolver.
// The rule itself is unit-tested in schedule-balancing.test.ts.

const timeReportRepo = createTimeReportRepository(db);
const payrollRepo = createPayrollRepository(db);
let balancingOn = true;
const service = createScheduleService(
  createScheduleRepository(db),
  timeReportRepo,
  { isDateLocked: async () => false },
  { settings: { getSettings: async () => ({ scheduleBalancing: balancingOn }) }, absences: payrollRepo }
);
// The same repositories without the balancing dependencies — what every
// other fixture in the suite builds.
const plainService = createScheduleService(createScheduleRepository(db), timeReportRepo, { isDateLocked: async () => false });

const TRUNCATE = sql`TRUNCATE absences, absence_types, employee_day_overrides, employee_week_overrides, holidays,
  week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, employees CASCADE`;

beforeEach(async () => {
  balancingOn = true;
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Week 45 of 2026: Monday 2 – Sunday 8 November.
const MON = "2026-11-02";
const WED = "2026-11-04";
const THU = "2026-11-05";
const FRI = "2026-11-06";

// The spec's example: Mon–Thu 07:00–16:15 (8 h 15 min), Friday 07:00–12:58
// (5 h 38 min), ordinary 40 h and ATF 82 min per week.
async function fixtures(opts: { ordinary?: number | null; atf?: number } = {}) {
  const monThu = await service.createDaySchedule({
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
  const friday = await service.createDaySchedule({
    code: "FREDAG",
    name: "Fredag",
    startTime: "07:00",
    endTime: "12:58",
    active: true,
    breaks: [{ type: "unpaid", startTime: "09:00", endTime: "09:20" }],
  });
  const days = [1, 2, 3, 4].map((weekday) => ({ weekday, dayScheduleId: monThu.id })).concat([{ weekday: 5, dayScheduleId: friday.id }]);
  const week = await service.createWeekSchedule({
    code: "DAG-ATF",
    name: "Dag med ATF",
    active: true,
    days,
    ordinaryMinutesPerWeek: opts.ordinary === undefined ? 2400 : opts.ordinary,
    atfMinutesPerWeek: opts.atf ?? 82,
  });
  const employee = await timeReportRepo.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name: "Utjämnad",
    active: true,
  });
  await timeReportRepo.updateEmployee(employee.id, { defaultWeekScheduleId: week.id });
  return { monThu, friday, days, week, employee };
}

async function absence(employeeId: string, date: string, minutes: number, earnsAtf: boolean) {
  const code = earnsAtf ? "SEM" : "SJK";
  const type =
    (await payrollRepo.findAbsenceTypeByCode(code)) ??
    (await payrollRepo.createAbsenceType({ code, name: earnsAtf ? "Semester" : "Sjukfrånvaro", paxmlCode: code, earnsAtf }));
  await db.insert(absences).values({ employeeId, absenceTypeId: type.id, date, minutes });
}

const day = async (employeeId: string, date: string) => (await service.resolveEmployeeCalendar(employeeId, date, date))[0]!;

describe("the system setting", () => {
  it("refuses ordinary time on a week schedule while it is off — but allows clearing it", async () => {
    const { week } = await fixtures();
    balancingOn = false;
    await expect(service.updateWeekSchedule(week.id, { ordinaryMinutesPerWeek: 2300 })).rejects.toThrow(ScheduleBalancingOffError);
    await expect(
      service.createWeekSchedule({ code: "X", name: "X", active: true, days: [], ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 0 })
    ).rejects.toThrow(ScheduleBalancingOffError);
    const cleared = await service.updateWeekSchedule(week.id, { ordinaryMinutesPerWeek: null });
    expect(cleared.ordinaryMinutesPerWeek).toBeNull();
  });

  it("off: a stored balancing is ignored and the calendar resolves as before", async () => {
    const { employee } = await fixtures();
    await service.createHoliday({ date: WED, name: "Röd onsdag" });
    balancingOn = false;
    const friday = await day(employee.id, FRI);
    expect(friday.daySchedule).toMatchObject({ netMinutes: 338, endTime: "12:58", scheduleNetMinutes: 338, scheduleEndTime: "12:58" });
    expect(friday.balance).toBeUndefined();
  });

  it("a service built without the balancing dependencies never balances", async () => {
    const { employee } = await fixtures();
    await service.createHoliday({ date: WED, name: "Röd onsdag" });
    const [friday] = await plainService.resolveEmployeeCalendar(employee.id, FRI, FRI);
    expect(friday!.daySchedule).toMatchObject({ netMinutes: 338, endTime: "12:58" });
  });
});

describe("saving a balanced week schedule", () => {
  it("stores and returns the fields", async () => {
    const { week } = await fixtures();
    expect(week).toMatchObject({ ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });
    const [listed] = await service.listWeekSchedules();
    expect(listed).toMatchObject({ ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });
  });

  it("defaults to no balancing", async () => {
    const plain = await service.createWeekSchedule({
      code: "P",
      name: "P",
      active: true,
      days: [],
      ordinaryMinutesPerWeek: null,
      atfMinutesPerWeek: 0,
    });
    expect(plain).toMatchObject({ ordinaryMinutesPerWeek: null, atfMinutesPerWeek: 0 });
  });

  it("rejects a schedule whose last workday would get no time", async () => {
    const { week } = await fixtures();
    const err = await service.updateWeekSchedule(week.id, { ordinaryMinutesPerWeek: 2000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScheduleBalancingInvalidError);
    expect(err).toBeInstanceOf(InvalidScheduleError); // → 400 like the other schedule errors
    expect((err as Error).message).toContain("en hel vecka skulle fredagen bli");
  });

  it("rejects ATF that is not less than the ordinary time, and a schedule without workdays", async () => {
    const { week } = await fixtures();
    await expect(service.updateWeekSchedule(week.id, { ordinaryMinutesPerWeek: 600, atfMinutesPerWeek: 600 })).rejects.toThrow(
      ScheduleBalancingInvalidError
    );
    await expect(service.updateWeekSchedule(week.id, { days: [] })).rejects.toThrow("minst en arbetsdag");
  });

  it("validates the merged result when only the days change", async () => {
    const { week, monThu } = await fixtures();
    // Friday on MAN-TOR too: still balances (it just ends 13:38 instead).
    const ok = await service.updateWeekSchedule(week.id, {
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: monThu.id })),
    });
    expect(ok.days).toHaveLength(5);
  });

  it("refuses a day schedule change that would break a balanced week schedule using it", async () => {
    const { monThu } = await fixtures();
    // Mon–Thu until 19:00 → Friday would get 2318 − 4 × 660 < 0.
    const err = await service.updateDaySchedule(monThu.id, { endTime: "19:00" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScheduleBalancingInvalidError);
    expect((err as Error).message).toMatch(/^Veckoschemat DAG-ATF: /);
    // A harmless change goes through.
    await expect(service.updateDaySchedule(monThu.id, { name: "Mån–tor" })).resolves.toMatchObject({ name: "Mån–tor" });
  });
});

describe("previewWeekSchedule", () => {
  it("shows a whole week and a week whose last workday is a holiday", async () => {
    const { days } = await fixtures();
    const preview = await service.previewWeekSchedule({ days, ordinaryMinutesPerWeek: 2400, atfMinutesPerWeek: 82 });
    expect(preview).toMatchObject({ normalWorkdays: 5, ordinaryMinutesPerDay: 480, atfMinutesPerDay: 16.4 });
    expect(preview.fullWeek.netMinutes).toBe(4 * 495 + 338);
    expect(preview.fullWeek.atfMinutes).toBe(82);
    expect(preview.fullWeek.days.find((d) => d.last)).toMatchObject({ weekday: 5, endTime: "12:58", netMinutes: 338 });
    expect(preview.lastDayHoliday).toMatchObject({ holidayWeekday: 5, atfMinutes: 66 });
    expect(preview.lastDayHoliday!.days.find((d) => d.weekday === 5)).toMatchObject({ holiday: true, endTime: null, netMinutes: 0 });
    expect(preview.lastDayHoliday!.days.find((d) => d.last)).toMatchObject({ weekday: 4, endTime: "14:09", netMinutes: 369 });
  });

  it("validates like the save", async () => {
    const { days } = await fixtures();
    await expect(service.previewWeekSchedule({ days, ordinaryMinutesPerWeek: 2000, atfMinutesPerWeek: 82 })).rejects.toThrow(
      ScheduleBalancingInvalidError
    );
  });
});

describe("resolveEmployeeCalendar with balancing", () => {
  it("a whole week leaves every day as its schedule", async () => {
    const { employee } = await fixtures();
    const week = await service.resolveEmployeeCalendar(employee.id, MON, "2026-11-08");
    expect(week.map((d) => d.daySchedule?.endTime ?? null)).toEqual(["16:15", "16:15", "16:15", "16:15", "12:58", null, null]);
    expect(week[4]!.balance).toEqual({ workdays: 5, normalWorkdays: 5, weekAtfMinutes: 82, lostAtfMinutes: 0 });
    expect(week[0]!.balance).toBeUndefined();
  });

  it("a single-day call on Friday still sees Wednesday's holiday", async () => {
    const { employee } = await fixtures();
    await service.createHoliday({ date: WED, name: "Röd onsdag" });
    const friday = await day(employee.id, FRI);
    expect(friday.daySchedule).toMatchObject({ netMinutes: 369, endTime: "13:29", scheduleNetMinutes: 338, scheduleEndTime: "12:58" });
    expect(friday.balance).toMatchObject({ workdays: 4, weekAtfMinutes: 66 });
  });

  it("a red Friday makes Thursday the short day", async () => {
    const { employee } = await fixtures();
    await service.createHoliday({ date: FRI, name: "Röd fredag" });
    const thursday = await day(employee.id, THU);
    expect(thursday.daySchedule).toMatchObject({ code: "MAN-TOR", netMinutes: 369, endTime: "14:09" });
    const friday = await day(employee.id, FRI);
    expect(friday.source).toBe("holiday");
    expect(friday.daySchedule).toBeNull();
  });

  it("a registered sick Wednesday lengthens Friday; holiday weeks around stay as they are", async () => {
    const { employee } = await fixtures();
    await absence(employee.id, WED, 495, false);
    expect((await day(employee.id, FRI)).daySchedule).toMatchObject({ netMinutes: 354, endTime: "13:14" });
    // The next week is untouched.
    expect((await day(employee.id, "2026-11-13")).daySchedule).toMatchObject({ netMinutes: 338, endTime: "12:58" });
  });

  it("absence that earns ATF (semester) changes nothing", async () => {
    const { employee } = await fixtures();
    await absence(employee.id, WED, 495, true);
    expect((await day(employee.id, FRI)).daySchedule).toMatchObject({ netMinutes: 338, endTime: "12:58" });
  });

  it("a day override on the last workday wins; one on another day does not move it", async () => {
    const { employee, monThu } = await fixtures();
    await service.setDayOverride(employee.id, { date: WED, dayScheduleId: null });
    expect((await day(employee.id, FRI)).daySchedule).toMatchObject({ netMinutes: 338, endTime: "12:58" });

    await service.setDayOverride(employee.id, { date: FRI, dayScheduleId: monThu.id });
    const friday = await day(employee.id, FRI);
    expect(friday.source).toBe("day-override");
    expect(friday.daySchedule).toMatchObject({ code: "MAN-TOR", netMinutes: 495, endTime: "16:15" });
    expect(friday.balance).toBeUndefined();
  });

  it("a week override uses that week schedule's own fields", async () => {
    const { employee, days } = await fixtures();
    const noAtf = await service.createWeekSchedule({
      code: "UTAN-ATF",
      name: "Bara inarbetning",
      active: true,
      days,
      ordinaryMinutesPerWeek: 2400,
      atfMinutesPerWeek: 0,
    });
    await service.setWeekOverride(employee.id, { isoYear: 2026, isoWeek: 45, weekScheduleId: noAtf.id });
    expect((await day(employee.id, FRI)).daySchedule).toMatchObject({ netMinutes: 420, endTime: "14:20" });
    expect((await day(employee.id, "2026-11-13")).daySchedule).toMatchObject({ netMinutes: 338 });
  });

  it("a week schedule without ordinary time is not balanced", async () => {
    const { employee, week } = await fixtures();
    await service.updateWeekSchedule(week.id, { ordinaryMinutesPerWeek: null });
    await service.createHoliday({ date: WED, name: "Röd onsdag" });
    expect((await day(employee.id, FRI)).daySchedule).toMatchObject({ netMinutes: 338, endTime: "12:58" });
  });

  it("a range starting mid-week balances the week it starts in", async () => {
    const { employee } = await fixtures();
    await service.createHoliday({ date: MON, name: "Röd måndag" });
    const days = await service.resolveEmployeeCalendar(employee.id, THU, "2026-11-13");
    expect(days[1]!.daySchedule).toMatchObject({ netMinutes: 369, endTime: "13:29" }); // 6 Nov
    expect(days[days.length - 1]!.daySchedule).toMatchObject({ netMinutes: 338 }); // 13 Nov
  });
});
