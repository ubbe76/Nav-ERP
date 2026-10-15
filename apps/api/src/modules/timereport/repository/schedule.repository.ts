import { and, asc, between, eq, inArray } from "drizzle-orm";
import {
  dayScheduleBreaks,
  daySchedules,
  employeeDayOverrides,
  employeeWeekOverrides,
  holidays,
  weekScheduleDays,
  weekSchedules,
  type Db,
} from "@navet/db";
import type { CreateHolidayInput, ScheduleBreakInput, WeekScheduleDayInput } from "@navet/shared";

// Postgres `time` columns come back as "HH:MM:SS" — the API speaks "HH:MM".
const hhmm = (t: string) => t.slice(0, 5);

const mapBreak = (row: typeof dayScheduleBreaks.$inferSelect) => ({
  type: row.type,
  startTime: hhmm(row.startTime),
  endTime: hhmm(row.endTime),
});

function mapDaySchedule(
  row: typeof daySchedules.$inferSelect,
  breaks: (typeof dayScheduleBreaks.$inferSelect)[]
) {
  return {
    ...row,
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    breaks: breaks.map(mapBreak),
  };
}

export function createScheduleRepository(db: Db) {
  async function loadDaySchedules(ids?: string[]) {
    if (ids && ids.length === 0) return [];
    const scheduleRows = await db
      .select()
      .from(daySchedules)
      .where(ids ? inArray(daySchedules.id, ids) : undefined)
      .orderBy(asc(daySchedules.code));
    if (scheduleRows.length === 0) return [];
    const breakRows = await db
      .select()
      .from(dayScheduleBreaks)
      .where(
        inArray(
          dayScheduleBreaks.dayScheduleId,
          scheduleRows.map((s) => s.id)
        )
      )
      .orderBy(asc(dayScheduleBreaks.startTime));
    return scheduleRows.map((s) => mapDaySchedule(s, breakRows.filter((b) => b.dayScheduleId === s.id)));
  }

  return {
    // --- Dagsscheman ---

    async listDaySchedules() {
      return loadDaySchedules();
    },

    async listDaySchedulesByIds(ids: string[]) {
      return loadDaySchedules(ids);
    },

    async findDayScheduleById(id: string) {
      const [row] = await loadDaySchedules([id]);
      return row ?? null;
    },

    async createDaySchedule(input: {
      code: string;
      name: string;
      startTime: string;
      endTime: string;
      active: boolean;
      breaks: ScheduleBreakInput[];
    }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(daySchedules)
          .values({
            code: input.code,
            name: input.name,
            startTime: input.startTime,
            endTime: input.endTime,
            active: input.active,
          })
          .returning();
        const breakRows =
          input.breaks.length === 0
            ? []
            : await tx
                .insert(dayScheduleBreaks)
                .values(input.breaks.map((b) => ({ ...b, dayScheduleId: row!.id })))
                .returning();
        return mapDaySchedule(row!, breakRows.sort((a, b) => a.startTime.localeCompare(b.startTime)));
      });
    },

    // `breaks` is replaced wholesale when provided.
    async updateDaySchedule(
      id: string,
      input: {
        code?: string;
        name?: string;
        startTime?: string;
        endTime?: string;
        active?: boolean;
        breaks?: ScheduleBreakInput[];
      }
    ) {
      return db.transaction(async (tx) => {
        const { breaks, ...fields } = input;
        const [row] =
          Object.keys(fields).length > 0
            ? await tx.update(daySchedules).set(fields).where(eq(daySchedules.id, id)).returning()
            : await tx.select().from(daySchedules).where(eq(daySchedules.id, id));
        if (!row) return null;
        if (breaks) {
          await tx.delete(dayScheduleBreaks).where(eq(dayScheduleBreaks.dayScheduleId, id));
          if (breaks.length > 0) {
            await tx.insert(dayScheduleBreaks).values(breaks.map((b) => ({ ...b, dayScheduleId: id })));
          }
        }
        const breakRows = await tx
          .select()
          .from(dayScheduleBreaks)
          .where(eq(dayScheduleBreaks.dayScheduleId, id))
          .orderBy(asc(dayScheduleBreaks.startTime));
        return mapDaySchedule(row, breakRows);
      });
    },

    // --- Veckoscheman ---

    async listWeekSchedules() {
      const scheduleRows = await db.select().from(weekSchedules).orderBy(asc(weekSchedules.code));
      if (scheduleRows.length === 0) return [];
      const dayRows = await db
        .select({
          weekScheduleId: weekScheduleDays.weekScheduleId,
          weekday: weekScheduleDays.weekday,
          dayScheduleId: weekScheduleDays.dayScheduleId,
          dayScheduleCode: daySchedules.code,
          dayScheduleName: daySchedules.name,
        })
        .from(weekScheduleDays)
        .innerJoin(daySchedules, eq(daySchedules.id, weekScheduleDays.dayScheduleId))
        .where(
          inArray(
            weekScheduleDays.weekScheduleId,
            scheduleRows.map((s) => s.id)
          )
        )
        .orderBy(asc(weekScheduleDays.weekday));
      return scheduleRows.map((s) => ({
        ...s,
        days: dayRows.filter((d) => d.weekScheduleId === s.id).map(({ weekScheduleId: _, ...d }) => d),
      }));
    },

    async findWeekScheduleById(id: string) {
      const [row] = await db.select().from(weekSchedules).where(eq(weekSchedules.id, id));
      if (!row) return null;
      const dayRows = await db
        .select({
          weekday: weekScheduleDays.weekday,
          dayScheduleId: weekScheduleDays.dayScheduleId,
          dayScheduleCode: daySchedules.code,
          dayScheduleName: daySchedules.name,
        })
        .from(weekScheduleDays)
        .innerJoin(daySchedules, eq(daySchedules.id, weekScheduleDays.dayScheduleId))
        .where(eq(weekScheduleDays.weekScheduleId, id))
        .orderBy(asc(weekScheduleDays.weekday));
      return { ...row, days: dayRows };
    },

    async createWeekSchedule(input: { code: string; name: string; active: boolean; days: WeekScheduleDayInput[] }) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(weekSchedules)
          .values({ code: input.code, name: input.name, active: input.active })
          .returning();
        if (input.days.length > 0) {
          await tx.insert(weekScheduleDays).values(input.days.map((d) => ({ ...d, weekScheduleId: row!.id })));
        }
        return row!.id;
      });
    },

    // `days` is replaced wholesale when provided.
    async updateWeekSchedule(
      id: string,
      input: { code?: string; name?: string; active?: boolean; days?: WeekScheduleDayInput[] }
    ) {
      return db.transaction(async (tx) => {
        const { days, ...fields } = input;
        const [row] =
          Object.keys(fields).length > 0
            ? await tx.update(weekSchedules).set(fields).where(eq(weekSchedules.id, id)).returning()
            : await tx.select().from(weekSchedules).where(eq(weekSchedules.id, id));
        if (!row) return null;
        if (days) {
          await tx.delete(weekScheduleDays).where(eq(weekScheduleDays.weekScheduleId, id));
          if (days.length > 0) {
            await tx.insert(weekScheduleDays).values(days.map((d) => ({ ...d, weekScheduleId: id })));
          }
        }
        return row.id;
      });
    },

    // Rows for resolving: which day schedule applies per (week schedule, weekday).
    async listWeekScheduleDaysByScheduleIds(weekScheduleIds: string[]) {
      if (weekScheduleIds.length === 0) return [];
      return db
        .select({
          weekScheduleId: weekScheduleDays.weekScheduleId,
          weekday: weekScheduleDays.weekday,
          dayScheduleId: weekScheduleDays.dayScheduleId,
        })
        .from(weekScheduleDays)
        .where(inArray(weekScheduleDays.weekScheduleId, weekScheduleIds));
    },

    // --- Helgdagar ---

    async listHolidays(year?: number) {
      return db
        .select({
          id: holidays.id,
          date: holidays.date,
          name: holidays.name,
          dayScheduleId: holidays.dayScheduleId,
          dayScheduleCode: daySchedules.code,
          dayScheduleName: daySchedules.name,
        })
        .from(holidays)
        .leftJoin(daySchedules, eq(daySchedules.id, holidays.dayScheduleId))
        .where(year ? between(holidays.date, `${year}-01-01`, `${year}-12-31`) : undefined)
        .orderBy(asc(holidays.date));
    },

    async listHolidaysInRange(from: string, to: string) {
      return db.select().from(holidays).where(between(holidays.date, from, to));
    },

    async createHoliday(input: CreateHolidayInput) {
      const [row] = await db
        .insert(holidays)
        .values({ date: input.date, name: input.name, dayScheduleId: input.dayScheduleId ?? null })
        .returning();
      return row!;
    },

    // Read before delete — the period-lock guard needs the holiday's date.
    async findHolidayById(id: string) {
      const [row] = await db.select().from(holidays).where(eq(holidays.id, id));
      return row ?? null;
    },

    async deleteHoliday(id: string) {
      const [row] = await db.delete(holidays).where(eq(holidays.id, id)).returning();
      return row ?? null;
    },

    // Bulk seed: existing dates keep their (possibly customized) holiday row.
    async createHolidaysIfMissing(rows: { date: string; name: string }[]) {
      if (rows.length === 0) return [];
      return db.insert(holidays).values(rows).onConflictDoNothing({ target: holidays.date }).returning();
    },

    // --- Kalenderavvikelser ---

    async listWeekOverrides(employeeId: string) {
      return db
        .select({
          id: employeeWeekOverrides.id,
          isoYear: employeeWeekOverrides.isoYear,
          isoWeek: employeeWeekOverrides.isoWeek,
          weekScheduleId: employeeWeekOverrides.weekScheduleId,
          weekScheduleCode: weekSchedules.code,
          weekScheduleName: weekSchedules.name,
        })
        .from(employeeWeekOverrides)
        .innerJoin(weekSchedules, eq(weekSchedules.id, employeeWeekOverrides.weekScheduleId))
        .where(eq(employeeWeekOverrides.employeeId, employeeId))
        .orderBy(asc(employeeWeekOverrides.isoYear), asc(employeeWeekOverrides.isoWeek));
    },

    async upsertWeekOverride(employeeId: string, isoYear: number, isoWeek: number, weekScheduleId: string) {
      const [row] = await db
        .insert(employeeWeekOverrides)
        .values({ employeeId, isoYear, isoWeek, weekScheduleId })
        .onConflictDoUpdate({
          target: [employeeWeekOverrides.employeeId, employeeWeekOverrides.isoYear, employeeWeekOverrides.isoWeek],
          set: { weekScheduleId },
        })
        .returning();
      return row!;
    },

    // Read before delete — the period-lock guard needs the overridden week.
    async findWeekOverride(employeeId: string, overrideId: string) {
      const [row] = await db
        .select()
        .from(employeeWeekOverrides)
        .where(and(eq(employeeWeekOverrides.id, overrideId), eq(employeeWeekOverrides.employeeId, employeeId)));
      return row ?? null;
    },

    async deleteWeekOverride(employeeId: string, overrideId: string) {
      const [row] = await db
        .delete(employeeWeekOverrides)
        .where(and(eq(employeeWeekOverrides.id, overrideId), eq(employeeWeekOverrides.employeeId, employeeId)))
        .returning();
      return row ?? null;
    },

    async listDayOverrides(employeeId: string) {
      return db
        .select({
          id: employeeDayOverrides.id,
          date: employeeDayOverrides.date,
          dayScheduleId: employeeDayOverrides.dayScheduleId,
          dayScheduleCode: daySchedules.code,
          dayScheduleName: daySchedules.name,
        })
        .from(employeeDayOverrides)
        .leftJoin(daySchedules, eq(daySchedules.id, employeeDayOverrides.dayScheduleId))
        .where(eq(employeeDayOverrides.employeeId, employeeId))
        .orderBy(asc(employeeDayOverrides.date));
    },

    async listDayOverridesInRange(employeeId: string, from: string, to: string) {
      return db
        .select()
        .from(employeeDayOverrides)
        .where(and(eq(employeeDayOverrides.employeeId, employeeId), between(employeeDayOverrides.date, from, to)));
    },

    async upsertDayOverride(employeeId: string, date: string, dayScheduleId: string | null) {
      const [row] = await db
        .insert(employeeDayOverrides)
        .values({ employeeId, date, dayScheduleId })
        .onConflictDoUpdate({
          target: [employeeDayOverrides.employeeId, employeeDayOverrides.date],
          set: { dayScheduleId },
        })
        .returning();
      return row!;
    },

    // Read before delete — the period-lock guard needs the overridden date.
    async findDayOverride(employeeId: string, overrideId: string) {
      const [row] = await db
        .select()
        .from(employeeDayOverrides)
        .where(and(eq(employeeDayOverrides.id, overrideId), eq(employeeDayOverrides.employeeId, employeeId)));
      return row ?? null;
    },

    async deleteDayOverride(employeeId: string, overrideId: string) {
      const [row] = await db
        .delete(employeeDayOverrides)
        .where(and(eq(employeeDayOverrides.id, overrideId), eq(employeeDayOverrides.employeeId, employeeId)))
        .returning();
      return row ?? null;
    },
  };
}

export type ScheduleRepository = ReturnType<typeof createScheduleRepository>;
