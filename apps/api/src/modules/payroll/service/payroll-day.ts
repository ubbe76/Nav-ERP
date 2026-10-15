// Pure payroll day engine — computes one employee's one calendar day of
// worked time, overtime, OB (obekväm arbetstid / inconvenient-hours premium)
// and unaccounted time from raw attendance + the day's schedule/absences.
//
// No DB, no imports from other modules: plain TypeScript + the standard
// library only. Everything downstream (period summaries, attestation
// snapshots, PAXml export) consumes DayComputation, so this file is the
// single source of truth for the arithmetic — see the algorithm comments
// below for the exact rules.
//
// All interval math is done in epoch ms and only floored to whole minutes at
// the final summation step (sum raw ms first, `Math.floor(ms / 60000)`
// once) — never per interval-pair — so partial-minute overlaps never
// accumulate rounding error across multiple additions.

export interface Interval {
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive — Interval is half-open [start, end)
}

export interface DayScheduleInput {
  netMinutes: number;
  breaks: { type: "unpaid" | "paid"; startTime: string; endTime: string }[];
}

export interface ObRuleInput {
  code: string;
  paxmlCode: string;
  dayKind: "weekday" | "saturday" | "sunday" | "holiday";
  startTime: string;
  endTime: string;
}

export interface DayComputationInput {
  date: string; // local YYYY-MM-DD
  isHoliday: boolean; // date exists in holidays (any kind)
  schedule: DayScheduleInput | null; // null = ledig (no scheduled work)
  attendance: Interval[]; // raw session intervals, may extend past the day
  absences: { code: string; paxmlCode: string; minutes: number }[];
  atfMinutes: number; // ATF (arbetstidsförkortning) withdrawals dated this day
  obRules: ObRuleInput[]; // active rules, all kinds — the engine filters by day kind
  overtimeThresholdMinutes: number;
}

export interface DayComputation {
  date: string;
  scheduledMinutes: number;
  workedMinutes: number;
  absences: { code: string; paxmlCode: string; minutes: number }[];
  ob: { code: string; paxmlCode: string; minutes: number }[];
  overtimeMinutes: number; // over schedule on scheduled days
  overtimeOffScheduleMinutes: number; // any work on schedule-free days
  atfMinutes: number;
  unaccountedMinutes: number; // scheduled not covered by work/absence/ATF
}

/**
 * Day kind used to select OB rules. A holiday always wins, regardless of
 * which weekday it falls on — a Saturday that is also a holiday only
 * matches "holiday" rules, never "saturday" ones.
 */
export function dayKindOf(date: string, isHoliday: boolean): ObRuleInput["dayKind"] {
  if (isHoliday) return "holiday";
  const weekday = new Date(`${date}T00:00:00`).getDay();
  if (weekday === 0) return "sunday";
  if (weekday === 6) return "saturday";
  return "weekday";
}

/** Builds a LOCAL (server-local) epoch ms timestamp from a YYYY-MM-DD date and an "HH:MM" clock. */
export function clockToMs(date: string, clock: string): number {
  return new Date(`${date}T${clock}:00`).getTime();
}

/**
 * [00:00 local, next local day's 00:00). The next day is computed via the
 * Date constructor's (year, month, day+1) overload rather than by adding
 * 24h of milliseconds, so DST transition days keep the correct wall-clock
 * length.
 */
export function dayBounds(date: string): Interval {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const start = clockToMs(date, "00:00");
  const end = new Date(year, month - 1, day + 1).getTime();
  return { start, end };
}

/**
 * Sorts by start and merges overlapping AND touching intervals (a.end >=
 * b.start). Empty inputs (end <= start) are dropped before merging.
 */
export function mergeIntervals(list: Interval[]): Interval[] {
  const cleaned = list.filter((iv) => iv.end > iv.start).sort((a, b) => a.start - b.start);
  const result: Interval[] = [];
  for (const iv of cleaned) {
    const last = result[result.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      result.push({ start: iv.start, end: iv.end });
    }
  }
  return result;
}

/**
 * Subtracts the union of `b` from each interval of `a`, in order. Empty
 * remainders are dropped; `b` is merged internally first so overlapping cut
 * windows don't double-subtract.
 */
export function subtractIntervals(a: Interval[], b: Interval[]): Interval[] {
  const cuts = mergeIntervals(b);
  const result: Interval[] = [];
  for (const iv of a) {
    let segments: Interval[] = [{ start: iv.start, end: iv.end }];
    for (const cut of cuts) {
      const next: Interval[] = [];
      for (const seg of segments) {
        if (cut.end <= seg.start || cut.start >= seg.end) {
          // No overlap with this cut — segment passes through untouched.
          next.push(seg);
          continue;
        }
        if (cut.start > seg.start) next.push({ start: seg.start, end: cut.start });
        if (cut.end < seg.end) next.push({ start: cut.end, end: seg.end });
      }
      segments = next;
    }
    for (const seg of segments) {
      if (seg.end > seg.start) result.push(seg);
    }
  }
  return result;
}

/** Total overlap between two interval sets, each merged first to avoid double-counting, floored once. */
export function overlapMinutes(a: Interval[], b: Interval[]): number {
  const mergedA = mergeIntervals(a);
  const mergedB = mergeIntervals(b);
  let totalMs = 0;
  for (const x of mergedA) {
    for (const y of mergedB) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) totalMs += end - start;
    }
  }
  return Math.floor(totalMs / 60000);
}

function clip(iv: Interval, bounds: Interval): Interval {
  return { start: Math.max(iv.start, bounds.start), end: Math.min(iv.end, bounds.end) };
}

function nonEmpty(iv: Interval): boolean {
  return iv.end > iv.start;
}

function totalMinutes(list: Interval[]): number {
  const totalMs = list.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  return Math.floor(totalMs / 60000);
}

function sumMinutes(values: number[]): number {
  return values.reduce((sum, n) => sum + n, 0);
}

/**
 * Computes one employee's one day. See the module comment and
 * task-6-brief.md for the exact algorithm this mirrors line for line:
 *
 * - presence = attendance clipped to the local day, merged.
 * - workedIntervals = presence minus unpaid break windows (paid breaks are
 *   not subtracted — they count as worked time).
 * - OB overlap is computed against workedIntervals (post-break-subtraction),
 *   only for rules whose dayKind matches the day (holiday wins over
 *   weekend), and only rules with minutes > 0 are kept, in input order.
 * - Off-schedule days (scheduledMinutes === 0) route ALL worked minutes to
 *   overtimeOffScheduleMinutes; overtimeMinutes stays 0.
 * - On scheduled days, overtime is the full raw excess (not just the part
 *   past the threshold) once raw > threshold; otherwise 0.
 */
export function computeEmployeeDay(input: DayComputationInput): DayComputation {
  const bounds = dayBounds(input.date);
  const presence = mergeIntervals(input.attendance.map((s) => clip(s, bounds)).filter(nonEmpty));
  const unpaidBreaks = (input.schedule?.breaks ?? [])
    .filter((b) => b.type === "unpaid")
    .map((b) => ({ start: clockToMs(input.date, b.startTime), end: clockToMs(input.date, b.endTime) }));
  const workedIntervals = subtractIntervals(presence, unpaidBreaks);
  const workedMinutes = totalMinutes(workedIntervals);
  const scheduledMinutes = input.schedule?.netMinutes ?? 0;
  const absenceTotal = sumMinutes(input.absences.map((a) => a.minutes));
  const kind = dayKindOf(input.date, input.isHoliday);

  const ob = input.obRules
    .filter((r) => r.dayKind === kind)
    .map((r) => ({
      code: r.code,
      paxmlCode: r.paxmlCode,
      minutes: overlapMinutes(workedIntervals, [
        { start: clockToMs(input.date, r.startTime), end: clockToMs(input.date, r.endTime) },
      ]),
    }))
    .filter((r) => r.minutes > 0);

  let overtimeMinutes = 0;
  let overtimeOffScheduleMinutes = 0;
  if (scheduledMinutes === 0) {
    overtimeOffScheduleMinutes = workedMinutes;
  } else {
    const expected = Math.max(0, scheduledMinutes - absenceTotal - input.atfMinutes);
    const raw = workedMinutes - expected;
    if (raw > input.overtimeThresholdMinutes) overtimeMinutes = raw;
  }

  const unaccountedMinutes = Math.max(0, scheduledMinutes - workedMinutes - absenceTotal - input.atfMinutes);

  return {
    date: input.date,
    scheduledMinutes,
    workedMinutes,
    absences: input.absences,
    ob,
    overtimeMinutes,
    overtimeOffScheduleMinutes,
    atfMinutes: input.atfMinutes,
    unaccountedMinutes,
  };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** All YYYY-MM-DD dates of the given calendar month, built via a local Date loop (no UTC shift). */
export function periodDates(year: number, month: number): string[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const dates: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    dates.push(formatLocalDate(new Date(year, month - 1, day)));
  }
  return dates;
}

/** First and last calendar date of the month, as used for period from/to filters. */
export function periodRange(year: number, month: number): { from: string; to: string } {
  const dates = periodDates(year, month);
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}
