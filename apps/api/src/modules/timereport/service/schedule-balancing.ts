// Utjämning (ATF och inarbetning) on a week schedule — pure, no DB imports.
// The ONE implementation of the rule; the calendar resolver, the week
// schedule validation and the form's preview all call it.
//
// The week schedule states ordinary time and ATF per week. Both are earned
// per workday (equal shares over the schedule's workdays), and the week's
// last workday gets whatever the week still owes, so inarbetning and ATF
// always add up — also in a short week:
//
// - workdays: the week schedule's days with net time > 0 that are not
//   holidays (full röda dagar and reduced halvdagar alike — a holiday keeps
//   its own day schedule and earns nothing);
// - target: workdays × (ordinary − ATF) per day, plus the ATF share lost on
//   every workday BEFORE the last one with absence of a kind that earns no
//   ATF (sjuk/VAB/…), proportional to the absent part of the day, at most
//   one share. The last workday's own absence never counts — it would make
//   the day longer than the full-day absence just registered for it;
// - the last workday's net time = target − the other workdays' net time,
//   rounded once to whole minutes; its end time is walked forward from the
//   day schedule's start through the unpaid breaks (paid breaks are work)
//   and continues past the schedule's own end when the day is longer.
//
// Employee day overrides are not inputs: they replace their own day only
// (and one on the last workday wins over the balanced time) — the caller
// applies them.

export interface BalancingBreak {
  type: "unpaid" | "paid";
  startTime: string; // "HH:MM"
  endTime: string;
}

export interface BalancingDaySchedule {
  startTime: string; // "HH:MM"
  endTime: string;
  netMinutes: number;
  breaks: BalancingBreak[];
}

export interface BalancingWeekInput {
  ordinaryMinutesPerWeek: number;
  atfMinutesPerWeek: number;
  // The week schedule's days (ISO weekday 1 = Monday … 7 = Sunday). Days with
  // net time 0 are not workdays.
  days: { weekday: number; schedule: BalancingDaySchedule }[];
  // ISO weekdays of this week that are holidays (any kind).
  holidayWeekdays: Iterable<number>;
  // ISO weekday → minutes of absence that earns no ATF.
  nonEarningAbsenceMinutes?: ReadonlyMap<number, number>;
}

export interface BalancedLastDay {
  weekday: number;
  netMinutes: number;
  endMinutes: number; // minutes after midnight
  endTime: string; // "HH:MM"
  workdays: number;
  normalWorkdays: number;
  weekAtfMinutes: number; // ATF earned (and taken) this week, rounded
  lostAtfMinutes: number; // share lost to absence, rounded
}

const MINUTES_PER_DAY = 24 * 60;

export const toMinutes = (clock: string) => {
  const [hours = 0, minutes = 0] = clock.split(":").map(Number);
  return hours * 60 + minutes;
};

export const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// The clock (minutes after midnight) at which `netMinutes` of work is done
// when the day starts at the schedule's start time: unpaid breaks are
// skipped, paid ones count as work, and work goes on past the schedule's end
// when the day is longer than the schedule. Landing exactly on an unpaid
// break's start ends the day there (before the break).
export function endMinutesAfterWork(schedule: BalancingDaySchedule, netMinutes: number): number {
  const start = toMinutes(schedule.startTime);
  const end = toMinutes(schedule.endTime);
  const unpaid = schedule.breaks
    .filter((b) => b.type === "unpaid")
    .map((b) => ({ start: toMinutes(b.startTime), end: toMinutes(b.endTime) }))
    .sort((a, b) => a.start - b.start);

  let remaining = Math.max(0, netMinutes);
  let cursor = start;
  for (const brk of unpaid) {
    const segment = brk.start - cursor;
    if (remaining <= segment) return cursor + remaining;
    remaining -= segment;
    cursor = brk.end;
  }
  // After the last break: to the schedule's end and, when needed, beyond it.
  const lastSegment = Math.max(0, end - cursor);
  return remaining <= lastSegment ? cursor + remaining : end + (remaining - lastSegment);
}

// The balanced last workday of one week, or null when the week has no
// workday left (every workday a holiday) or the schedule has none at all.
export function balanceWeek(input: BalancingWeekInput): BalancedLastDay | null {
  const workdays = input.days.filter((d) => d.schedule.netMinutes > 0).sort((a, b) => a.weekday - b.weekday);
  const normalWorkdays = workdays.length;
  if (normalWorkdays === 0) return null;

  const holidays = new Set(input.holidayWeekdays);
  const active = workdays.filter((d) => !holidays.has(d.weekday));
  const last = active[active.length - 1];
  if (!last) return null;

  const ordinaryPerDay = input.ordinaryMinutesPerWeek / normalWorkdays;
  const atfPerDay = input.atfMinutesPerWeek / normalWorkdays;

  let lostAtf = 0;
  let others = 0;
  for (const day of active) {
    if (day === last) continue;
    others += day.schedule.netMinutes;
    const absent = input.nonEarningAbsenceMinutes?.get(day.weekday) ?? 0;
    if (absent > 0) lostAtf += atfPerDay * Math.min(1, absent / day.schedule.netMinutes);
  }

  const target = active.length * (ordinaryPerDay - atfPerDay) + lostAtf;
  const netMinutes = Math.round(target - others);
  const endMinutes = endMinutesAfterWork(last.schedule, netMinutes);
  return {
    weekday: last.weekday,
    netMinutes,
    endMinutes,
    endTime: toClock(endMinutes),
    workdays: active.length,
    normalWorkdays,
    weekAtfMinutes: Math.round(active.length * atfPerDay - lostAtf),
    lostAtfMinutes: Math.round(lostAtf),
  };
}

export interface BalancingProblem {
  holidayWeekdays: number[];
  weekday: number;
  netMinutes: number;
  endTime: string;
  reason: "too-short" | "past-midnight";
}

// Checks the rule for EVERY combination of holidays in the week (at most 2^7
// cases): the last workday must get more than 0 minutes without absences and
// still end before midnight with the most ATF lost to absence (a full share
// on every other workday). Returns the first case that fails, or null.
export function findBalancingProblem(input: Omit<BalancingWeekInput, "holidayWeekdays" | "nonEarningAbsenceMinutes">): BalancingProblem | null {
  const workdays = input.days.filter((d) => d.schedule.netMinutes > 0).map((d) => d.weekday).sort((a, b) => a - b);
  const allAbsent = new Map(input.days.map((d) => [d.weekday, d.schedule.netMinutes] as const));
  // mask 0 (no holidays, the plain week) comes first, so a schedule that
  // fails in an ordinary week reports that case.
  for (let mask = 0; mask < 1 << workdays.length; mask++) {
    const holidayWeekdays = workdays.filter((_, i) => (mask & (1 << i)) !== 0);
    const plain = balanceWeek({ ...input, holidayWeekdays });
    if (!plain) continue;
    if (plain.netMinutes <= 0) {
      return { holidayWeekdays, weekday: plain.weekday, netMinutes: plain.netMinutes, endTime: plain.endTime, reason: "too-short" };
    }
    const worst = balanceWeek({ ...input, holidayWeekdays, nonEarningAbsenceMinutes: allAbsent });
    if (worst && worst.endMinutes >= MINUTES_PER_DAY) {
      return { holidayWeekdays, weekday: worst.weekday, netMinutes: worst.netMinutes, endTime: worst.endTime, reason: "past-midnight" };
    }
  }
  return null;
}

const WEEKDAY_NAMES = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];
export const weekdayName = (weekday: number) => WEEKDAY_NAMES[weekday - 1] ?? String(weekday);

// Swedish: the message reaches the user as-is (no fixed dictionary text can
// name the failing case).
export function describeBalancingProblem(problem: BalancingProblem): string {
  const when =
    problem.holidayWeekdays.length === 0
      ? "en hel vecka"
      : `med helgdag på ${problem.holidayWeekdays.map(weekdayName).join(", ")}`;
  const day = weekdayName(problem.weekday);
  return problem.reason === "too-short"
    ? `Utjämningen går inte ihop: ${when} skulle ${day}en bli ${problem.netMinutes} minuter. Minska den ordinarie tiden eller korta de andra dagarna.`
    : `Utjämningen går inte ihop: ${when} skulle ${day}en sluta ${problem.endTime}, efter midnatt.`;
}
