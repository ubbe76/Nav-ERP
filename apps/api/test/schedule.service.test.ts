import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import {
  WeekScheduleNotFoundError,
  EmployeeNotFoundError,
  createTimeReportService,
} from "../src/modules/timereport/service/timereport.service.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import {
  DayScheduleNotFoundError,
  DuplicateHolidayDateError,
  DuplicateScheduleCodeError,
  HolidayNotFoundError,
  InvalidScheduleError,
  ScheduleOverrideNotFoundError,
  createScheduleService,
  isoWeekOf,
  isoWeekRange,
  swedishHolidays,
} from "../src/modules/timereport/service/schedule.service.js";
import { PayrollPeriodLockedError } from "../src/modules/payroll/service/period-lock.js";

const timeReportRepo = createTimeReportRepository(db);
// Mutable period-lock stub — the real payroll_periods-backed checker is
// exercised in payroll-attest.test.ts.
let dateLocked = false;
const timeReportService = createTimeReportService(
  timeReportRepo,
  createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService),
  { isDateLocked: async () => dateLocked },
  // Schedule tests don't exercise corrections/audit — no-op writer.
  { log: async () => {} }
);
const service = createScheduleService(createScheduleRepository(db), timeReportRepo, {
  isDateLocked: async () => dateLocked,
});

const TRUNCATE = sql`TRUNCATE employee_day_overrides, employee_week_overrides, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, employees CASCADE`;

beforeEach(async () => {
  dateLocked = false;
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

let codeCounter = 0;
const nextCode = () => `S${++codeCounter}`;

// Dagtid 07:00–16:00 with lunch (rast, unpaid) and fika (paus, paid) →
// 9 h gross − 30 min rast = 8.5 h net.
async function makeDaySchedule(overrides: Partial<Parameters<typeof service.createDaySchedule>[0]> = {}) {
  return service.createDaySchedule({
    code: nextCode(),
    name: "Dagtid",
    startTime: "07:00",
    endTime: "16:00",
    active: true,
    breaks: [
      { type: "unpaid", startTime: "12:00", endTime: "12:30" },
      { type: "paid", startTime: "09:00", endTime: "09:15" },
    ],
    ...overrides,
  });
}

async function makeEmployee() {
  return timeReportRepo.createEmployee({
    employeeNumber: `E-${crypto.randomUUID().slice(0, 8)}`,
    name: "Schemalagd",
    active: true,
  });
}

describe("day schedules (dagsscheman)", () => {
  it("creates a schedule with rast and paus, normalized to HH:MM and sorted", async () => {
    const schedule = await makeDaySchedule();

    expect(schedule.startTime).toBe("07:00");
    expect(schedule.endTime).toBe("16:00");
    expect(schedule.breaks).toEqual([
      { type: "paid", startTime: "09:00", endTime: "09:15" },
      { type: "unpaid", startTime: "12:00", endTime: "12:30" },
    ]);
  });

  it("rejects end time before start time", async () => {
    await expect(makeDaySchedule({ startTime: "16:00", endTime: "07:00", breaks: [] })).rejects.toBeInstanceOf(
      InvalidScheduleError
    );
  });

  it("rejects breaks outside the day's bounds", async () => {
    await expect(
      makeDaySchedule({ breaks: [{ type: "unpaid", startTime: "06:00", endTime: "07:30" }] })
    ).rejects.toBeInstanceOf(InvalidScheduleError);
  });

  it("rejects overlapping breaks", async () => {
    await expect(
      makeDaySchedule({
        breaks: [
          { type: "unpaid", startTime: "12:00", endTime: "12:45" },
          { type: "paid", startTime: "12:30", endTime: "13:00" },
        ],
      })
    ).rejects.toBeInstanceOf(InvalidScheduleError);
  });

  it("rejects a duplicate code with 409-mapped error", async () => {
    await makeDaySchedule({ code: "DAG" });
    await expect(makeDaySchedule({ code: "DAG" })).rejects.toBeInstanceOf(DuplicateScheduleCodeError);
  });

  it("replaces breaks wholesale on update and keeps them when omitted", async () => {
    const schedule = await makeDaySchedule();

    const renamed = await service.updateDaySchedule(schedule.id, { name: "Dagtid ny" });
    expect(renamed.breaks).toHaveLength(2);

    const cleared = await service.updateDaySchedule(schedule.id, { breaks: [] });
    expect(cleared.breaks).toHaveLength(0);
  });

  it("validates updates against the merged schedule (new end vs existing breaks)", async () => {
    const schedule = await makeDaySchedule();
    // Break 12:00–12:30 would fall outside the shortened day.
    await expect(service.updateDaySchedule(schedule.id, { endTime: "11:00" })).rejects.toBeInstanceOf(
      InvalidScheduleError
    );
  });
});

describe("week schedules (veckoscheman)", () => {
  it("creates a mon–fri schedule with joined day schedule info", async () => {
    const day = await makeDaySchedule();
    const week = await service.createWeekSchedule({
      code: "VDAG",
      name: "Dagtid vecka",
      active: true,
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    });

    expect(week.days).toHaveLength(5);
    expect(week.days[0]).toMatchObject({ weekday: 1, dayScheduleCode: day.code, dayScheduleName: "Dagtid" });
  });

  it("rejects duplicate weekdays and unknown day schedules", async () => {
    const day = await makeDaySchedule();
    await expect(
      service.createWeekSchedule({
        code: nextCode(),
        name: "Dubbel måndag",
        active: true,
        days: [
          { weekday: 1, dayScheduleId: day.id },
          { weekday: 1, dayScheduleId: day.id },
        ],
      })
    ).rejects.toBeInstanceOf(InvalidScheduleError);

    await expect(
      service.createWeekSchedule({
        code: nextCode(),
        name: "Okänt dagsschema",
        active: true,
        days: [{ weekday: 1, dayScheduleId: crypto.randomUUID() }],
      })
    ).rejects.toBeInstanceOf(DayScheduleNotFoundError);
  });

  it("rejects a duplicate code and replaces days wholesale on update", async () => {
    const day = await makeDaySchedule();
    const week = await service.createWeekSchedule({
      code: "VDAG",
      name: "Vecka",
      active: true,
      days: [{ weekday: 1, dayScheduleId: day.id }],
    });
    await expect(
      service.createWeekSchedule({ code: "VDAG", name: "Kopia", active: true, days: [] })
    ).rejects.toBeInstanceOf(DuplicateScheduleCodeError);

    const updated = await service.updateWeekSchedule(week.id, {
      days: [
        { weekday: 6, dayScheduleId: day.id },
        { weekday: 7, dayScheduleId: day.id },
      ],
    });
    expect(updated.days.map((d) => d.weekday)).toEqual([6, 7]);
  });
});

describe("holidays (helgdagar)", () => {
  it("creates full-off and half-day holidays, rejects duplicates, deletes", async () => {
    const halfDay = await makeDaySchedule({ code: "HALV", name: "Halvdag", endTime: "12:00", breaks: [] });

    await service.createHoliday({ date: "2026-12-24", name: "Julafton" });
    await service.createHoliday({ date: "2026-12-23", name: "Dan före dopparedan", dayScheduleId: halfDay.id });

    await expect(service.createHoliday({ date: "2026-12-24", name: "Dubblett" })).rejects.toBeInstanceOf(
      DuplicateHolidayDateError
    );
    await expect(
      service.createHoliday({ date: "2026-12-25", name: "Juldagen", dayScheduleId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(DayScheduleNotFoundError);

    const listed = await service.listHolidays(2026);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ date: "2026-12-23", dayScheduleCode: "HALV" });
    expect(listed[1]).toMatchObject({ date: "2026-12-24", dayScheduleId: null });

    await service.deleteHoliday(listed[0]!.id);
    expect(await service.listHolidays(2026)).toHaveLength(1);
    await expect(service.deleteHoliday(listed[0]!.id)).rejects.toBeInstanceOf(HolidayNotFoundError);
  });
});

describe("swedish holidays (svenska helgdagar)", () => {
  it("computes movable holidays correctly for 2026", () => {
    const byName = new Map(swedishHolidays(2026).map((h) => [h.name, h.date]));
    // Easter Sunday 2026 is April 5.
    expect(byName.get("Långfredagen")).toBe("2026-04-03");
    expect(byName.get("Påskdagen")).toBe("2026-04-05");
    expect(byName.get("Annandag påsk")).toBe("2026-04-06");
    expect(byName.get("Kristi himmelsfärdsdag")).toBe("2026-05-14");
    expect(byName.get("Pingstdagen")).toBe("2026-05-24");
    // Saturday 20–26 June, and the Friday before it.
    expect(byName.get("Midsommarafton")).toBe("2026-06-19");
    expect(byName.get("Midsommardagen")).toBe("2026-06-20");
    // Saturday 31 Oct–6 Nov: 2026-10-31 is itself a Saturday.
    expect(byName.get("Alla helgons dag")).toBe("2026-10-31");
    expect(byName.get("Nyårsdagen")).toBe("2026-01-01");
    expect(byName.get("Julafton")).toBe("2026-12-24");
    expect(swedishHolidays(2026)).toHaveLength(16);
  });

  it("handles years where the Saturday rules shift (2025)", () => {
    const byName = new Map(swedishHolidays(2025).map((h) => [h.name, h.date]));
    // Easter Sunday 2025 is April 20.
    expect(byName.get("Påskdagen")).toBe("2025-04-20");
    expect(byName.get("Kristi himmelsfärdsdag")).toBe("2025-05-29");
    // 20 June 2025 is a Friday → midsommardagen lands on the 21st.
    expect(byName.get("Midsommardagen")).toBe("2025-06-21");
    expect(byName.get("Midsommarafton")).toBe("2025-06-20");
    // 31 Oct 2025 is a Friday → alla helgons dag lands on 1 Nov.
    expect(byName.get("Alla helgons dag")).toBe("2025-11-01");
  });

  it("seeds a year idempotently without touching customized holidays", async () => {
    const halfDay = await makeDaySchedule({ code: "HALV", name: "Halvdag", endTime: "12:00", breaks: [] });
    // Pre-existing customized julafton must survive the seeding untouched.
    await service.createHoliday({ date: "2026-12-24", name: "Julafton (halvdag)", dayScheduleId: halfDay.id });

    const first = await service.generateSwedishHolidays(2026);
    expect(first).toEqual({ created: 15, skipped: 1 });

    const second = await service.generateSwedishHolidays(2026);
    expect(second).toEqual({ created: 0, skipped: 16 });

    const listed = await service.listHolidays(2026);
    expect(listed).toHaveLength(16);
    const julafton = listed.find((h) => h.date === "2026-12-24");
    expect(julafton).toMatchObject({ name: "Julafton (halvdag)", dayScheduleCode: "HALV" });
  });
});

describe("employee default week schedule (standardschema)", () => {
  it("sets, validates and clears defaultWeekScheduleId via employee PATCH", async () => {
    const employee = await makeEmployee();
    const day = await makeDaySchedule();
    const week = await service.createWeekSchedule({
      code: "VDAG",
      name: "Vecka",
      active: true,
      days: [{ weekday: 1, dayScheduleId: day.id }],
    });

    await expect(
      timeReportService.updateEmployee(employee.id, { defaultWeekScheduleId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(WeekScheduleNotFoundError);

    const updated = await timeReportService.updateEmployee(employee.id, { defaultWeekScheduleId: week.id });
    expect(updated.defaultWeekScheduleId).toBe(week.id);

    const cleared = await timeReportService.updateEmployee(employee.id, { defaultWeekScheduleId: null });
    expect(cleared.defaultWeekScheduleId).toBeNull();
  });
});

describe("calendar overrides (kalenderavvikelser)", () => {
  it("upserts week overrides on (year, week) and deletes them", async () => {
    const employee = await makeEmployee();
    const day = await makeDaySchedule();
    const weekA = await service.createWeekSchedule({ code: "A", name: "A", active: true, days: [] });
    const weekB = await service.createWeekSchedule({
      code: "B",
      name: "B",
      active: true,
      days: [{ weekday: 1, dayScheduleId: day.id }],
    });

    await service.setWeekOverride(employee.id, { isoYear: 2026, isoWeek: 30, weekScheduleId: weekA.id });
    await service.setWeekOverride(employee.id, { isoYear: 2026, isoWeek: 30, weekScheduleId: weekB.id });

    const { weekOverrides } = await service.getEmployeeScheduleOverrides(employee.id);
    expect(weekOverrides).toHaveLength(1);
    expect(weekOverrides[0]).toMatchObject({ isoYear: 2026, isoWeek: 30, weekScheduleCode: "B" });

    await expect(
      service.setWeekOverride(employee.id, { isoYear: 2026, isoWeek: 31, weekScheduleId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(WeekScheduleNotFoundError);
    await expect(
      service.setWeekOverride(crypto.randomUUID(), { isoYear: 2026, isoWeek: 31, weekScheduleId: weekA.id })
    ).rejects.toBeInstanceOf(EmployeeNotFoundError);

    await service.deleteWeekOverride(employee.id, weekOverrides[0]!.id);
    await expect(service.deleteWeekOverride(employee.id, weekOverrides[0]!.id)).rejects.toBeInstanceOf(
      ScheduleOverrideNotFoundError
    );
  });

  it("upserts day overrides on date, allowing ledig (null) and schedule swaps", async () => {
    const employee = await makeEmployee();
    const day = await makeDaySchedule();

    await service.setDayOverride(employee.id, { date: "2026-07-21", dayScheduleId: null });
    await service.setDayOverride(employee.id, { date: "2026-07-21", dayScheduleId: day.id });

    const { dayOverrides } = await service.getEmployeeScheduleOverrides(employee.id);
    expect(dayOverrides).toHaveLength(1);
    expect(dayOverrides[0]).toMatchObject({ date: "2026-07-21", dayScheduleCode: day.code });

    await expect(
      service.setDayOverride(employee.id, { date: "2026-07-22", dayScheduleId: crypto.randomUUID() })
    ).rejects.toBeInstanceOf(DayScheduleNotFoundError);
  });

  it("rejects every schedule write that touches a locked payroll period", async () => {
    const employee = await makeEmployee();
    const day = await makeDaySchedule();
    const week = await service.createWeekSchedule({ code: "L", name: "Låst", active: true, days: [] });
    const dayOverride = await service.setDayOverride(employee.id, { date: "2026-07-21", dayScheduleId: day.id });
    const weekOverride = await service.setWeekOverride(employee.id, {
      isoYear: 2026,
      isoWeek: 30,
      weekScheduleId: week.id,
    });
    const holiday = await service.createHoliday({ date: "2026-07-23", name: "Testdag" });

    dateLocked = true;

    await expect(
      service.setDayOverride(employee.id, { date: "2026-07-24", dayScheduleId: day.id })
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    await expect(service.deleteDayOverride(employee.id, dayOverride.id)).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
    await expect(
      service.setWeekOverride(employee.id, { isoYear: 2026, isoWeek: 31, weekScheduleId: week.id })
    ).rejects.toBeInstanceOf(PayrollPeriodLockedError);
    await expect(service.deleteWeekOverride(employee.id, weekOverride.id)).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
    await expect(service.createHoliday({ date: "2026-07-25", name: "Testdag 2" })).rejects.toBeInstanceOf(
      PayrollPeriodLockedError
    );
    await expect(service.deleteHoliday(holiday.id)).rejects.toBeInstanceOf(PayrollPeriodLockedError);

    // Missing rows still 404 rather than reporting the lock.
    await expect(service.deleteDayOverride(employee.id, crypto.randomUUID())).rejects.toBeInstanceOf(
      ScheduleOverrideNotFoundError
    );
    await expect(service.deleteWeekOverride(employee.id, crypto.randomUUID())).rejects.toBeInstanceOf(
      ScheduleOverrideNotFoundError
    );
    await expect(service.deleteHoliday(crypto.randomUUID())).rejects.toBeInstanceOf(HolidayNotFoundError);
  });
});

describe("isoWeekRange", () => {
  it("is the inverse of isoWeekOf, including weeks that span two months and two years", async () => {
    // Mon 2026-05-04 – Sun 2026-05-10, entirely inside May.
    expect(isoWeekRange(2026, 19)).toEqual({ monday: "2026-05-04", sunday: "2026-05-10" });
    // Mon 2026-04-27 – Sun 2026-05-03 straddles April/May: both months have
    // to be checked before a week override is allowed.
    expect(isoWeekRange(2026, 18)).toEqual({ monday: "2026-04-27", sunday: "2026-05-03" });
    // ISO week 1 of 2026 starts in December 2025.
    expect(isoWeekRange(2026, 1)).toEqual({ monday: "2025-12-29", sunday: "2026-01-04" });
    // 2026 has 53 ISO weeks; the last one ends in January 2027.
    expect(isoWeekRange(2026, 53)).toEqual({ monday: "2026-12-28", sunday: "2027-01-03" });

    for (const date of ["2026-05-04", "2026-05-03", "2025-12-29", "2027-01-03"]) {
      const { isoYear, isoWeek } = isoWeekOf(date);
      const { monday, sunday } = isoWeekRange(isoYear, isoWeek);
      expect(monday <= date && date <= sunday).toBe(true);
    }
  });
});

describe("isoWeekOf", () => {
  it("handles year boundaries in both directions", () => {
    // 2026-01-01 is a Thursday → week 1 of 2026.
    expect(isoWeekOf("2026-01-01")).toEqual({ isoYear: 2026, isoWeek: 1 });
    // 2027-01-01 is a Friday → still week 53 of 2026.
    expect(isoWeekOf("2027-01-01")).toEqual({ isoYear: 2026, isoWeek: 53 });
    // 2024-12-30 is a Monday → already week 1 of 2025.
    expect(isoWeekOf("2024-12-30")).toEqual({ isoYear: 2025, isoWeek: 1 });
    // Mid-year sanity check.
    expect(isoWeekOf("2026-07-17")).toEqual({ isoYear: 2026, isoWeek: 29 });
  });
});

describe("resolveEmployeeCalendar (upplösning)", () => {
  it("applies priority: day override > holiday > week override > standard > ledig", async () => {
    const employee = await makeEmployee();
    const dag = await makeDaySchedule({ code: "DAG", name: "Dagtid" });
    const kvall = await makeDaySchedule({
      code: "KVALL",
      name: "Kvällsskift",
      startTime: "14:00",
      endTime: "22:00",
      breaks: [],
    });
    const halv = await makeDaySchedule({ code: "HALV", name: "Halvdag", endTime: "12:00", breaks: [] });

    const standardWeek = await service.createWeekSchedule({
      code: "VDAG",
      name: "Dagtid vecka",
      active: true,
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: dag.id })),
    });
    const eveningWeek = await service.createWeekSchedule({
      code: "VKVALL",
      name: "Kvällsvecka",
      active: true,
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: kvall.id })),
    });

    await timeReportService.updateEmployee(employee.id, { defaultWeekScheduleId: standardWeek.id });
    // Week 31 of 2026 (Mon 2026-07-27 … Sun 2026-08-02) runs the evening schedule.
    await service.setWeekOverride(employee.id, { isoYear: 2026, isoWeek: 31, weekScheduleId: eveningWeek.id });
    // Wed 2026-07-22 is a half-day holiday; Tue 2026-07-28 a full holiday.
    await service.createHoliday({ date: "2026-07-22", name: "Halvdagshelg", dayScheduleId: halv.id });
    await service.createHoliday({ date: "2026-07-28", name: "Röd dag" });
    // Day overrides: Tue 2026-07-21 off (beats standard), Tue 2026-07-28 works
    // Dagtid anyway (beats the holiday).
    await service.setDayOverride(employee.id, { date: "2026-07-21", dayScheduleId: null });
    await service.setDayOverride(employee.id, { date: "2026-07-28", dayScheduleId: dag.id });

    const days = await service.resolveEmployeeCalendar(employee.id, "2026-07-20", "2026-08-02");
    expect(days).toHaveLength(14);
    const byDate = new Map(days.map((d) => [d.date, d]));

    // Standard weekday, net 8.5 h.
    expect(byDate.get("2026-07-20")).toMatchObject({
      weekday: 1,
      source: "standard",
      daySchedule: { code: "DAG", netMinutes: 510 },
    });
    // Day override "ledig" beats the standard schedule.
    expect(byDate.get("2026-07-21")).toMatchObject({ source: "day-override", daySchedule: null });
    // Holiday with a half-day schedule beats the standard schedule.
    expect(byDate.get("2026-07-22")).toMatchObject({
      source: "holiday",
      holidayName: "Halvdagshelg",
      daySchedule: { code: "HALV" },
    });
    // Saturday has no weekday row in the standard schedule → off.
    expect(byDate.get("2026-07-25")).toMatchObject({ source: "standard", daySchedule: null });
    // Week override applies the evening schedule.
    expect(byDate.get("2026-07-27")).toMatchObject({ source: "week-override", daySchedule: { code: "KVALL" } });
    // Day override beats the full-day holiday.
    expect(byDate.get("2026-07-28")).toMatchObject({ source: "day-override", daySchedule: { code: "DAG" } });
  });

  it("returns source null when the employee has no schedule at all", async () => {
    const employee = await makeEmployee();
    const days = await service.resolveEmployeeCalendar(employee.id, "2026-07-20", "2026-07-21");
    expect(days).toEqual([
      { date: "2026-07-20", weekday: 1, source: null, daySchedule: null },
      { date: "2026-07-21", weekday: 2, source: null, daySchedule: null },
    ]);
  });

  it("validates the range and the employee", async () => {
    const employee = await makeEmployee();
    await expect(service.resolveEmployeeCalendar(employee.id, "2026-07-20", "2026-07-19")).rejects.toBeInstanceOf(
      InvalidScheduleError
    );
    await expect(service.resolveEmployeeCalendar(employee.id, "2026-01-01", "2027-06-01")).rejects.toBeInstanceOf(
      InvalidScheduleError
    );
    await expect(
      service.resolveEmployeeCalendar(crypto.randomUUID(), "2026-07-20", "2026-07-21")
    ).rejects.toBeInstanceOf(EmployeeNotFoundError);
  });

  it("attaches the day schedule's break windows, normalized to HH:MM, without changing netMinutes", async () => {
    const employee = await makeEmployee();
    // 07:00–16:00 (9 h gross) with a 60-min unpaid break and a 15-min paid
    // break → paid breaks count as work, so net = 540 − 60 = 480.
    const day = await makeDaySchedule({
      code: nextCode(),
      breaks: [
        { type: "unpaid", startTime: "12:00", endTime: "13:00" },
        { type: "paid", startTime: "09:00", endTime: "09:15" },
      ],
    });
    const week = await service.createWeekSchedule({
      code: nextCode(),
      name: "Vecka",
      active: true,
      days: [{ weekday: 1, dayScheduleId: day.id }],
    });
    await timeReportService.updateEmployee(employee.id, { defaultWeekScheduleId: week.id });

    // 2026-07-20 is a Monday (weekday 1).
    const days = await service.resolveEmployeeCalendar(employee.id, "2026-07-20", "2026-07-20");
    expect(days[0]!.daySchedule).toMatchObject({
      netMinutes: 480,
      breaks: [
        { type: "paid", startTime: "09:00", endTime: "09:15" },
        { type: "unpaid", startTime: "12:00", endTime: "13:00" },
      ],
    });
  });

  it("exposes an empty breaks array for a day schedule with no breaks", async () => {
    const employee = await makeEmployee();
    const day = await makeDaySchedule({ code: nextCode(), breaks: [] });
    const week = await service.createWeekSchedule({
      code: nextCode(),
      name: "Vecka",
      active: true,
      days: [{ weekday: 1, dayScheduleId: day.id }],
    });
    await timeReportService.updateEmployee(employee.id, { defaultWeekScheduleId: week.id });

    const days = await service.resolveEmployeeCalendar(employee.id, "2026-07-20", "2026-07-20");
    expect(days[0]!.daySchedule?.breaks).toEqual([]);
  });
});

describe("listHolidaysInRange", () => {
  it("returns holidays inside the range and excludes ones outside it", async () => {
    await service.createHoliday({ date: "2026-07-15", name: "Före" });
    await service.createHoliday({ date: "2026-07-22", name: "Innanför" });
    await service.createHoliday({ date: "2026-08-05", name: "Efter" });

    const holidays = await service.listHolidaysInRange("2026-07-20", "2026-07-31");
    expect(holidays).toHaveLength(1);
    expect(holidays[0]).toMatchObject({ date: "2026-07-22", name: "Innanför", dayScheduleId: null });
  });
});
