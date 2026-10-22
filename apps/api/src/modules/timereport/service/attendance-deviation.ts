// Avvikelser vid närvarostämpling — sen ankomst and tidig hemgång measured
// against the day's schedule, and the 409 the terminal answers with when a
// reason (or an overtime choice) is missing.
//
// Leaf on purpose: no DB, no service imports. The minute arithmetic is the
// payroll day engine's own (lateMinutesOf/earlyLeaveMinutesOf on clockToMs),
// so the terminal's question and the attestation's Avvikelser column measure
// the same Stockholm day the same way — the only thing this file adds is the
// policy: which stamp is asked about, and when the tolerance is exceeded.
import {
  clockToMs,
  earlyLeaveMinutesOf,
  lateMinutesOf,
  overlapsScheduleWindow,
  type Interval,
} from "../../payroll/service/payroll-day.js";

// The slice of the schedule's ResolvedDay this file reads. A day without a
// day schedule is ledig (no schedule, or a red day); a holiday WITH a day
// schedule is a short day and is measured like any other.
export interface DeviationDaySchedule {
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  netMinutes?: number;
}

export interface DeviationSettings {
  attendanceReasonRequired: boolean;
  attendanceReasonToleranceMinutes: number;
}

export interface AttendanceDeviation {
  kind: "late" | "early";
  minutes: number;
  scheduledTime: string; // the schedule clock the stamp is measured against
  // The setting is on and the deviation is strictly greater than the
  // tolerance.
  requiresReason: boolean;
}

function isScheduled(schedule: DeviationDaySchedule | null): schedule is DeviationDaySchedule {
  return schedule !== null && (schedule.netMinutes === undefined || schedule.netMinutes > 0);
}

function deviation(
  kind: "late" | "early",
  minutes: number,
  scheduledTime: string,
  settings: DeviationSettings
): AttendanceDeviation | null {
  if (minutes <= 0) return null;
  return {
    kind,
    minutes,
    scheduledTime,
    requiresReason: settings.attendanceReasonRequired && minutes > settings.attendanceReasonToleranceMinutes,
  };
}

/** The schedule window [start, end) the deviations are measured in — the payroll day engine's clocks. */
export function scheduleWindow(date: string, schedule: DeviationDaySchedule): Interval {
  return { start: clockToMs(date, schedule.startTime), end: clockToMs(date, schedule.endTime) };
}

/** The day's schedule window when the day is scheduled, else null (ledig: nothing is ever asked). */
export function scheduledWindow(date: string, schedule: DeviationDaySchedule | null): Interval | null {
  return isScheduled(schedule) ? scheduleWindow(date, schedule) : null;
}

/**
 * Sen ankomst for an attendance-in at `at` on the Stockholm day `date`.
 * Payroll measures lateness on the first presence that overlaps the
 * schedule window (payroll-day.ts), so the terminal asks exactly when this
 * attendance becomes that presence: it starts before the window's end, and
 * no earlier attendance of the day already overlaps the window
 * (`earlierPresenceInWindow`). Coming back after an early departure needs
 * no new reason — the reason sits on that departure — while a night shift
 * that ended before the schedule's start hides nothing.
 */
export function assessArrival(input: {
  date: string;
  schedule: DeviationDaySchedule | null;
  at: Date;
  earlierPresenceInWindow: boolean;
  settings: DeviationSettings;
}): AttendanceDeviation | null {
  if (input.earlierPresenceInWindow || !isScheduled(input.schedule)) return null;
  const window = scheduleWindow(input.date, input.schedule);
  if (input.at.getTime() >= window.end) return null; // the new presence never meets the schedule
  const minutes = lateMinutesOf(input.date, input.schedule.startTime, input.at.getTime());
  return deviation("late", minutes, input.schedule.startTime, input.settings);
}

/**
 * Tidig hemgång for a Gå hem at `at` on the Stockholm day `date`, closing an
 * attendance that started at `startedAt`. A departure on a day with a Ta ut
 * ATF withdrawal is explained by the withdrawal (and payroll already counts
 * its minutes), so it is never one. Like payroll, only a presence that
 * overlaps the schedule window can leave early — a stint that ended before
 * the schedule began is not a departure from it.
 */
export function assessDeparture(input: {
  date: string;
  schedule: DeviationDaySchedule | null;
  startedAt: Date;
  at: Date;
  atfWithdrawal: boolean;
  settings: DeviationSettings;
}): AttendanceDeviation | null {
  if (input.atfWithdrawal || !isScheduled(input.schedule)) return null;
  const window = scheduleWindow(input.date, input.schedule);
  if (!overlapsScheduleWindow({ start: input.startedAt.getTime(), end: input.at.getTime() }, window)) return null;
  const minutes = earlyLeaveMinutesOf(input.date, input.schedule.endTime, input.at.getTime());
  return deviation("early", minutes, input.schedule.endTime, input.settings);
}

export interface OvertimeQuestion {
  minutes: number; // overtime + off-schedule overtime the day would get
  offSchedule: boolean; // the day has no schedule (helgövertid)
  current: "payout" | "comp"; // the day's choice today: override ?? employee default
}

// The terminal's missing input — a reason, an overtime choice, or both at
// once (came early, left early and still worked past the schedule). The
// terminal shows the 409 body as it is and sends the request again with the
// answers; it never computes anything itself.
export class AttendanceInputRequiredError extends Error {
  constructor(
    readonly reason: { kind: "late" | "early"; minutes: number; scheduledTime: string } | null,
    readonly overtime: OvertimeQuestion | null
  ) {
    super(
      [
        reason
          ? reason.kind === "late"
            ? `A reason is required for arriving ${reason.minutes} minutes after the schedule (${reason.scheduledTime})`
            : `A reason is required for leaving ${reason.minutes} minutes before the schedule (${reason.scheduledTime})`
          : null,
        overtime ? `choose how ${overtime.minutes} minutes of overtime are compensated` : null,
      ]
        .filter(Boolean)
        .join("; ")
    );
    this.name = "AttendanceInputRequiredError";
  }
}

// Same shape as materialShortageBody: the error envelope plus the questions.
export function attendanceInputRequiredBody(err: AttendanceInputRequiredError) {
  return { error: err.message, code: "attendance-input-required", reason: err.reason, overtime: err.overtime };
}

export class AttendanceReasonInvalidError extends Error {
  constructor(id: string) {
    super(`Attendance deviation reason ${id} does not exist or is inactive`);
    this.name = "AttendanceReasonInvalidError";
  }
}

export class AtfTransactionMismatchError extends Error {
  constructor(id: string) {
    super(`ATF transaction ${id} is not today's withdrawal for this employee`);
    this.name = "AtfTransactionMismatchError";
  }
}
