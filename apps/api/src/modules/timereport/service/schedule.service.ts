import {
  computeDayScheduleNetMinutes,
  type CreateDayScheduleInput,
  type CreateHolidayInput,
  type CreateWeekScheduleInput,
  type ScheduleBreakInput,
  type SetDayOverrideInput,
  type SetWeekOverrideInput,
  type UpdateDayScheduleInput,
  type UpdateWeekScheduleInput,
  type WeekScheduleDayInput,
} from "@navet/shared";
import type { ScheduleRepository } from "../repository/schedule.repository.js";
import { EmployeeNotFoundError, WeekScheduleNotFoundError } from "./timereport.service.js";
// Leaf file in the payroll module — no import cycle (see period-lock.ts).
import { PayrollPeriodLockedError, type PeriodLockChecker } from "../../payroll/service/period-lock.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";

export class DayScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Day schedule ${id} not found`);
    this.name = "DayScheduleNotFoundError";
  }
}

export class HolidayNotFoundError extends Error {
  constructor(id: string) {
    super(`Holiday ${id} not found`);
    this.name = "HolidayNotFoundError";
  }
}

export class ScheduleOverrideNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule override ${id} not found`);
    this.name = "ScheduleOverrideNotFoundError";
  }
}

export class DuplicateScheduleCodeError extends Error {
  constructor(code: string) {
    super(`A schedule with code "${code}" already exists`);
    this.name = "DuplicateScheduleCodeError";
  }
}

export class DuplicateHolidayDateError extends Error {
  constructor(date: string) {
    super(`A holiday on ${date} already exists`);
    this.name = "DuplicateHolidayDateError";
  }
}

// Semantic validation failures (overlapping breaks, end before start, …) — 400.
export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScheduleError";
  }
}

const toMinutes = (clockTime: string) => {
  const [hours, minutes] = clockTime.split(":").map(Number);
  return hours! * 60 + minutes!;
};

// A day schedule must be internally consistent: start < end (over-midnight
// night shifts are not supported in v1), every break inside the day, breaks
// non-overlapping.
function validateDayScheduleTimes(startTime: string, endTime: string, breaks: ScheduleBreakInput[]) {
  if (toMinutes(startTime) >= toMinutes(endTime)) {
    throw new InvalidScheduleError("End time must be after start time (over-midnight schedules are not supported)");
  }
  const sorted = [...breaks].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  for (const b of sorted) {
    if (toMinutes(b.startTime) >= toMinutes(b.endTime)) {
      throw new InvalidScheduleError("Break end time must be after its start time");
    }
    if (toMinutes(b.startTime) < toMinutes(startTime) || toMinutes(b.endTime) > toMinutes(endTime)) {
      throw new InvalidScheduleError("Breaks must lie within the day's start and end times");
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (toMinutes(sorted[i]!.startTime) < toMinutes(sorted[i - 1]!.endTime)) {
      throw new InvalidScheduleError("Breaks must not overlap");
    }
  }
}

// ISO 8601 week of a YYYY-MM-DD date: the Thursday of the same week decides
// which iso year the week belongs to (weeks 52/53 spill across New Year).
export function isoWeekOf(date: string): { isoYear: number; isoWeek: number } {
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = d.getUTCDay() || 7; // ISO: 1 = Monday … 7 = Sunday
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const isoYear = d.getUTCFullYear();
  const isoWeek = Math.ceil(((d.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7);
  return { isoYear, isoWeek };
}

// Gregorian Easter Sunday (påskdagen) via the anonymous/Meeus-Jones-Butcher
// computus — everything from långfredagen to pingstdagen hangs off it.
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const addDaysUTC = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);
const toDateString = (date: Date) => date.toISOString().slice(0, 10);

// Inverse of isoWeekOf: the Monday and Sunday bounding an ISO week. Jan 4 is
// by definition in ISO week 1, so week 1's Monday is the Monday on or before
// it. Used by the period-lock guard — a week override may straddle two
// calendar months, and both have to be checked.
export function isoWeekRange(isoYear: number, isoWeek: number): { monday: string; sunday: string } {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week1Monday = addDaysUTC(jan4, -((jan4.getUTCDay() || 7) - 1));
  const monday = addDaysUTC(week1Monday, (isoWeek - 1) * 7);
  return { monday: toDateString(monday), sunday: toDateString(addDaysUTC(monday, 6)) };
}

// First Saturday within [from, from + 6] — midsommardagen (Sat 20–26 June)
// and alla helgons dag (Sat 31 Oct–6 Nov) are defined this way.
function saturdayOnOrAfter(year: number, month: number, day: number): Date {
  const start = new Date(Date.UTC(year, month - 1, day));
  return addDaysUTC(start, (6 - start.getUTCDay() + 7) % 7);
}

// Svenska helgdagar: the official public holidays (röda dagar) plus julafton,
// midsommarafton and nyårsafton, which Swedish workplaces treat as full days
// off in practice.
export function swedishHolidays(year: number): { date: string; name: string }[] {
  const easter = easterSunday(year);
  const midsummerDay = saturdayOnOrAfter(year, 6, 20);
  const holidays = [
    { date: `${year}-01-01`, name: "Nyårsdagen" },
    { date: `${year}-01-06`, name: "Trettondedag jul" },
    { date: toDateString(addDaysUTC(easter, -2)), name: "Långfredagen" },
    { date: toDateString(easter), name: "Påskdagen" },
    { date: toDateString(addDaysUTC(easter, 1)), name: "Annandag påsk" },
    { date: `${year}-05-01`, name: "Första maj" },
    { date: toDateString(addDaysUTC(easter, 39)), name: "Kristi himmelsfärdsdag" },
    { date: toDateString(addDaysUTC(easter, 49)), name: "Pingstdagen" },
    { date: `${year}-06-06`, name: "Sveriges nationaldag" },
    { date: toDateString(addDaysUTC(midsummerDay, -1)), name: "Midsommarafton" },
    { date: toDateString(midsummerDay), name: "Midsommardagen" },
    { date: toDateString(saturdayOnOrAfter(year, 10, 31)), name: "Alla helgons dag" },
    { date: `${year}-12-24`, name: "Julafton" },
    { date: `${year}-12-25`, name: "Juldagen" },
    { date: `${year}-12-26`, name: "Annandag jul" },
    { date: `${year}-12-31`, name: "Nyårsafton" },
  ];
  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

// The employee register lives in the timereport service; the schedule service
// only needs to check existence.
export interface EmployeeReader {
  findEmployeeById(id: string): Promise<{ id: string; defaultWeekScheduleId: string | null } | null>;
}

export type CalendarDaySource = "day-override" | "holiday" | "week-override" | "standard";

// One resolved calendar day for an employee — the element type of
// resolveEmployeeCalendar's result. Exported so cross-module consumers (the
// payroll summary service) can type their own dependency on the method
// without duplicating the shape.
export interface ResolvedDay {
  date: string;
  weekday: number;
  source: CalendarDaySource | null;
  holidayName?: string;
  daySchedule: {
    id: string;
    code: string;
    name: string;
    startTime: string;
    endTime: string;
    netMinutes: number;
    breaks: { type: "unpaid" | "paid"; startTime: string; endTime: string }[];
  } | null;
}

export function createScheduleService(
  repo: ScheduleRepository,
  employees: EmployeeReader,
  periodLocks: PeriodLockChecker
) {
  async function requireEmployee(employeeId: string) {
    const employee = await employees.findEmployeeById(employeeId);
    if (!employee) throw new EmployeeNotFoundError(employeeId);
    return employee;
  }

  // Schedule changes move the scheduled/unaccounted minutes of every day they
  // touch, so they are rejected once that day's payroll period is locked.
  async function requireOpenPeriod(date: string) {
    if (await periodLocks.isDateLocked(date)) throw new PayrollPeriodLockedError(date);
  }

  // A week override changes every day of its ISO week, and that week can
  // straddle two calendar months — checking the Monday and the Sunday covers
  // both (a week never spans more than two months).
  async function requireOpenWeek(isoYear: number, isoWeek: number) {
    const { monday, sunday } = isoWeekRange(isoYear, isoWeek);
    await requireOpenPeriod(monday);
    await requireOpenPeriod(sunday);
  }

  // Referenced day schedules must exist, and a weekday can only appear once.
  async function validateWeekScheduleDays(days: WeekScheduleDayInput[]) {
    const weekdays = new Set<number>();
    for (const day of days) {
      if (weekdays.has(day.weekday)) throw new InvalidScheduleError("Each weekday can only appear once");
      weekdays.add(day.weekday);
    }
    const ids = [...new Set(days.map((d) => d.dayScheduleId))];
    const found = await repo.listDaySchedulesByIds(ids);
    const foundIds = new Set(found.map((s) => s.id));
    const missing = ids.find((id) => !foundIds.has(id));
    if (missing) throw new DayScheduleNotFoundError(missing);
  }

  return {
    // --- Dagsscheman ---

    async listDaySchedules() {
      return repo.listDaySchedules();
    },

    async createDaySchedule(input: CreateDayScheduleInput) {
      validateDayScheduleTimes(input.startTime, input.endTime, input.breaks);
      try {
        return await repo.createDaySchedule(input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateScheduleCodeError(input.code);
        throw err;
      }
    },

    async updateDaySchedule(id: string, input: UpdateDayScheduleInput) {
      const existing = await repo.findDayScheduleById(id);
      if (!existing) throw new DayScheduleNotFoundError(id);
      validateDayScheduleTimes(
        input.startTime ?? existing.startTime,
        input.endTime ?? existing.endTime,
        input.breaks ?? existing.breaks
      );
      try {
        const row = await repo.updateDaySchedule(id, input);
        if (!row) throw new DayScheduleNotFoundError(id);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateScheduleCodeError(input.code ?? "");
        throw err;
      }
    },

    // --- Veckoscheman ---

    async listWeekSchedules() {
      return repo.listWeekSchedules();
    },

    async getWeekSchedule(id: string) {
      const schedule = await repo.findWeekScheduleById(id);
      if (!schedule) throw new WeekScheduleNotFoundError(id);
      return schedule;
    },

    async createWeekSchedule(input: CreateWeekScheduleInput) {
      await validateWeekScheduleDays(input.days);
      try {
        const id = await repo.createWeekSchedule(input);
        return (await repo.findWeekScheduleById(id))!;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateScheduleCodeError(input.code);
        throw err;
      }
    },

    async updateWeekSchedule(id: string, input: UpdateWeekScheduleInput) {
      if (input.days) await validateWeekScheduleDays(input.days);
      try {
        const updatedId = await repo.updateWeekSchedule(id, input);
        if (!updatedId) throw new WeekScheduleNotFoundError(id);
        return (await repo.findWeekScheduleById(updatedId))!;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateScheduleCodeError(input.code ?? "");
        throw err;
      }
    },

    // --- Helgdagar ---

    async listHolidays(year?: number) {
      return repo.listHolidays(year);
    },

    // Passthrough used by the payroll day-engine to classify OB day kinds
    // (e.g. "is this a holiday?") over a date range without resolving a
    // specific employee's calendar.
    async listHolidaysInRange(from: string, to: string) {
      return repo.listHolidaysInRange(from, to);
    },

    async createHoliday(input: CreateHolidayInput) {
      if (input.dayScheduleId && !(await repo.findDayScheduleById(input.dayScheduleId))) {
        throw new DayScheduleNotFoundError(input.dayScheduleId);
      }
      await requireOpenPeriod(input.date);
      try {
        return await repo.createHoliday(input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateHolidayDateError(input.date);
        throw err;
      }
    },

    async deleteHoliday(id: string) {
      const existing = await repo.findHolidayById(id);
      if (!existing) throw new HolidayNotFoundError(id);
      await requireOpenPeriod(existing.date);

      const row = await repo.deleteHoliday(id);
      if (!row) throw new HolidayNotFoundError(id);
    },

    // Seed the year with Swedish holidays as fully-off days; dates that
    // already have a holiday are left untouched (idempotent).
    //
    // Dates inside a locked payroll period are skipped rather than inserted:
    // a holiday changes the scheduled minutes of the day it falls on, and the
    // single-date createHoliday above rejects exactly that. Skipping (instead
    // of failing the whole seed) matches this routine's idempotent semantics
    // — re-running it after the period is unlocked picks the dates up.
    async generateSwedishHolidays(year: number) {
      const candidates = swedishHolidays(year);

      // The candidates span at most ~13 distinct months, so the lock is
      // resolved once per month rather than once per date.
      const lockedByMonth = new Map<string, boolean>();
      const insertable: typeof candidates = [];
      for (const candidate of candidates) {
        const month = candidate.date.slice(0, 7);
        let locked = lockedByMonth.get(month);
        if (locked === undefined) {
          locked = await periodLocks.isDateLocked(candidate.date);
          lockedByMonth.set(month, locked);
        }
        if (!locked) insertable.push(candidate);
      }

      const created = await repo.createHolidaysIfMissing(insertable);
      return { created: created.length, skipped: candidates.length - created.length };
    },

    // --- Kalenderavvikelser ---

    async getEmployeeScheduleOverrides(employeeId: string) {
      await requireEmployee(employeeId);
      const [weekOverrides, dayOverrides] = await Promise.all([
        repo.listWeekOverrides(employeeId),
        repo.listDayOverrides(employeeId),
      ]);
      return { weekOverrides, dayOverrides };
    },

    async setWeekOverride(employeeId: string, input: SetWeekOverrideInput) {
      await requireEmployee(employeeId);
      if (!(await repo.findWeekScheduleById(input.weekScheduleId))) {
        throw new WeekScheduleNotFoundError(input.weekScheduleId);
      }
      await requireOpenWeek(input.isoYear, input.isoWeek);
      return repo.upsertWeekOverride(employeeId, input.isoYear, input.isoWeek, input.weekScheduleId);
    },

    async deleteWeekOverride(employeeId: string, overrideId: string) {
      await requireEmployee(employeeId);
      const existing = await repo.findWeekOverride(employeeId, overrideId);
      if (!existing) throw new ScheduleOverrideNotFoundError(overrideId);
      await requireOpenWeek(existing.isoYear, existing.isoWeek);

      const row = await repo.deleteWeekOverride(employeeId, overrideId);
      if (!row) throw new ScheduleOverrideNotFoundError(overrideId);
    },

    async setDayOverride(employeeId: string, input: SetDayOverrideInput) {
      await requireEmployee(employeeId);
      if (input.dayScheduleId && !(await repo.findDayScheduleById(input.dayScheduleId))) {
        throw new DayScheduleNotFoundError(input.dayScheduleId);
      }
      await requireOpenPeriod(input.date);
      return repo.upsertDayOverride(employeeId, input.date, input.dayScheduleId);
    },

    async deleteDayOverride(employeeId: string, overrideId: string) {
      await requireEmployee(employeeId);
      const existing = await repo.findDayOverride(employeeId, overrideId);
      if (!existing) throw new ScheduleOverrideNotFoundError(overrideId);
      await requireOpenPeriod(existing.date);

      const row = await repo.deleteDayOverride(employeeId, overrideId);
      if (!row) throw new ScheduleOverrideNotFoundError(overrideId);
    },

    // --- Upplösning ---

    // Resolve which day schedule applies per date. Priority, most specific
    // first: employee day override → company holiday → employee week override
    // → standard week schedule → no schedule (ledig). This is the function the
    // future löneunderlag generation reuses to diff attendance against.
    async resolveEmployeeCalendar(employeeId: string, from: string, to: string) {
      const employee = await requireEmployee(employeeId);

      const fromDate = new Date(`${from}T00:00:00Z`);
      const toDate = new Date(`${to}T00:00:00Z`);
      const spanDays = (toDate.getTime() - fromDate.getTime()) / 86_400_000 + 1;
      if (spanDays < 1) throw new InvalidScheduleError("'to' must not be before 'from'");
      if (spanDays > 370) throw new InvalidScheduleError("Date range must not exceed 370 days");

      const [dayOverrides, holidayRows, weekOverrides] = await Promise.all([
        repo.listDayOverridesInRange(employeeId, from, to),
        repo.listHolidaysInRange(from, to),
        repo.listWeekOverrides(employeeId),
      ]);

      const dayOverrideByDate = new Map(dayOverrides.map((o) => [o.date, o]));
      const holidayByDate = new Map(holidayRows.map((h) => [h.date, h]));
      const weekOverrideByWeek = new Map(weekOverrides.map((o) => [`${o.isoYear}-${o.isoWeek}`, o]));

      const weekScheduleIds = [
        ...new Set(
          [...weekOverrides.map((o) => o.weekScheduleId), employee.defaultWeekScheduleId].filter(
            (id): id is string => id !== null
          )
        ),
      ];
      const weekDays = await repo.listWeekScheduleDaysByScheduleIds(weekScheduleIds);
      const dayScheduleByWeekAndWeekday = new Map(weekDays.map((d) => [`${d.weekScheduleId}:${d.weekday}`, d.dayScheduleId]));

      const dayScheduleIds = [
        ...new Set(
          [
            ...dayOverrides.map((o) => o.dayScheduleId),
            ...holidayRows.map((h) => h.dayScheduleId),
            ...weekDays.map((d) => d.dayScheduleId),
          ].filter((id): id is string => id !== null)
        ),
      ];
      const daySchedulesById = new Map(
        (await repo.listDaySchedulesByIds(dayScheduleIds)).map((s) => [
          s.id,
          {
            id: s.id,
            code: s.code,
            name: s.name,
            startTime: s.startTime,
            endTime: s.endTime,
            netMinutes: computeDayScheduleNetMinutes(s),
            // Break windows (already normalized to HH:MM by the repo's
            // hhmm()) so the payroll day-engine can subtract unpaid breaks
            // from attendance presence without a second lookup.
            breaks: s.breaks.map((b) => ({ type: b.type, startTime: b.startTime, endTime: b.endTime })),
          },
        ])
      );

      const days: ResolvedDay[] = [];

      for (let cursor = new Date(fromDate); cursor <= toDate; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const date = cursor.toISOString().slice(0, 10);
        const weekday = cursor.getUTCDay() || 7;

        let source: CalendarDaySource | null = null;
        let dayScheduleId: string | null = null;
        let holidayName: string | undefined;

        const dayOverride = dayOverrideByDate.get(date);
        const holiday = holidayByDate.get(date);
        if (dayOverride) {
          source = "day-override";
          dayScheduleId = dayOverride.dayScheduleId;
        } else if (holiday) {
          source = "holiday";
          holidayName = holiday.name;
          dayScheduleId = holiday.dayScheduleId;
        } else {
          const { isoYear, isoWeek } = isoWeekOf(date);
          const weekOverride = weekOverrideByWeek.get(`${isoYear}-${isoWeek}`);
          const weekScheduleId = weekOverride?.weekScheduleId ?? employee.defaultWeekScheduleId;
          if (weekScheduleId) {
            source = weekOverride ? "week-override" : "standard";
            dayScheduleId = dayScheduleByWeekAndWeekday.get(`${weekScheduleId}:${weekday}`) ?? null;
          }
        }

        days.push({
          date,
          weekday,
          source,
          ...(holidayName !== undefined ? { holidayName } : {}),
          daySchedule: dayScheduleId ? (daySchedulesById.get(dayScheduleId) ?? null) : null,
        });
      }

      return days;
    },
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
