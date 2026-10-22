import { describe, expect, it } from "vitest";
import {
  clockToMs,
  computeEmployeeDay,
  mergeIntervals,
  periodDates,
  periodRange,
  subtractIntervals,
  type DayComputationInput,
} from "../src/modules/payroll/service/payroll-day.js";
import { normalizePayrollDay } from "../src/modules/payroll/service/payroll.service.js";

// Pure unit tests for the day engine — no DB, no fixtures. This file still
// runs inside the shared vitest suite (global-setup migrates the test DB),
// but none of these tests touch it.

const DAY = "2026-07-13"; // Monday (weekday)
const NEXT_DAY = "2026-07-14"; // Tuesday, for the overnight-clip case
const SATURDAY_HOLIDAY = "2026-07-25"; // Saturday that is also a holiday

// Builds an Interval from two "HH:MM" clocks on the given local date.
function iv(date: string, startClock: string, endClock: string) {
  return { start: clockToMs(date, startClock), end: clockToMs(date, endClock) };
}

describe("payroll day engine — computeEmployeeDay", () => {
  it("1. normal day: worked ~485, overtime 0 at threshold 15, overtime 5 at threshold 0", () => {
    const base: DayComputationInput = {
      date: DAY,
      isHoliday: false,
      schedule: { netMinutes: 480, breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }] },
      attendance: [iv(DAY, "06:58", "16:03")],
      absences: [],
      atfMinutes: 0,
      obRules: [],
      overtimeThresholdMinutes: 15,
    };

    const withThreshold15 = computeEmployeeDay(base);
    expect(withThreshold15.scheduledMinutes).toBe(480);
    expect(withThreshold15.workedMinutes).toBe(485);
    expect(withThreshold15.overtimeMinutes).toBe(0);
    expect(withThreshold15.unaccountedMinutes).toBe(0);

    const withThreshold0 = computeEmployeeDay({ ...base, overtimeThresholdMinutes: 0 });
    expect(withThreshold0.overtimeMinutes).toBe(5);
  });

  it("2. unpaid break deduction: 07:00-16:00 minus lunch = 480, not 540", () => {
    const result = computeEmployeeDay({
      date: DAY,
      isHoliday: false,
      schedule: { netMinutes: 480, breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }] },
      attendance: [iv(DAY, "07:00", "16:00")],
      absences: [],
      atfMinutes: 0,
      obRules: [],
      overtimeThresholdMinutes: 15,
    });

    expect(result.workedMinutes).toBe(480);
  });

  it("3. absence full day: no attendance, unaccounted 0, overtime 0", () => {
    const result = computeEmployeeDay({
      date: DAY,
      isHoliday: false,
      schedule: { netMinutes: 480, breaks: [] },
      attendance: [],
      absences: [{ code: "SJK", paxmlCode: "SJK", minutes: 480 }],
      atfMinutes: 0,
      obRules: [],
      overtimeThresholdMinutes: 15,
    });

    expect(result.workedMinutes).toBe(0);
    expect(result.unaccountedMinutes).toBe(0);
    expect(result.overtimeMinutes).toBe(0);
  });

  it("4. partial absence + work: overtime 60 against expected 240", () => {
    const result = computeEmployeeDay({
      date: DAY,
      isHoliday: false,
      schedule: { netMinutes: 480, breaks: [] },
      attendance: [iv(DAY, "08:00", "13:00")], // 300 min
      absences: [{ code: "VAB", paxmlCode: "VAB", minutes: 240 }],
      atfMinutes: 0,
      obRules: [],
      overtimeThresholdMinutes: 15,
    });

    expect(result.workedMinutes).toBe(300);
    expect(result.overtimeMinutes).toBe(60);
  });

  it("5. unaccounted time: no absence, worked short of schedule", () => {
    const result = computeEmployeeDay({
      date: DAY,
      isHoliday: false,
      schedule: { netMinutes: 480, breaks: [] },
      attendance: [iv(DAY, "08:00", "12:00")], // 240 min
      absences: [],
      atfMinutes: 0,
      obRules: [],
      overtimeThresholdMinutes: 15,
    });

    expect(result.workedMinutes).toBe(240);
    expect(result.unaccountedMinutes).toBe(240);
    expect(result.overtimeMinutes).toBe(0);
  });

  it("6. off-schedule work: all worked minutes become overtimeOffScheduleMinutes", () => {
    const result = computeEmployeeDay({
      date: DAY,
      isHoliday: false,
      schedule: null,
      attendance: [iv(DAY, "09:00", "11:00")], // 120 min
      absences: [],
      atfMinutes: 0,
      obRules: [],
      overtimeThresholdMinutes: 15,
    });

    expect(result.scheduledMinutes).toBe(0);
    expect(result.workedMinutes).toBe(120);
    expect(result.overtimeOffScheduleMinutes).toBe(120);
    expect(result.overtimeMinutes).toBe(0);
    expect(result.unaccountedMinutes).toBe(0);
  });

  it("7. OB weekday evening rule overlaps worked time", () => {
    const result = computeEmployeeDay({
      date: DAY, // Monday
      isHoliday: false,
      schedule: { netMinutes: 360, breaks: [] },
      attendance: [iv(DAY, "14:00", "20:00")],
      absences: [],
      atfMinutes: 0,
      obRules: [{ code: "OB1", paxmlCode: "OB1", dayKind: "weekday", startTime: "18:00", endTime: "23:00" }],
      overtimeThresholdMinutes: 15,
    });

    expect(result.ob).toEqual([{ code: "OB1", paxmlCode: "OB1", minutes: 120 }]);
  });

  it("8. holiday day-kind wins: a saturday-that-is-a-holiday only matches the holiday rule", () => {
    const result = computeEmployeeDay({
      date: SATURDAY_HOLIDAY,
      isHoliday: true,
      schedule: { netMinutes: 360, breaks: [] },
      attendance: [iv(SATURDAY_HOLIDAY, "10:00", "20:00")],
      absences: [],
      atfMinutes: 0,
      obRules: [
        { code: "OBSAT", paxmlCode: "OBSAT", dayKind: "saturday", startTime: "10:00", endTime: "14:00" },
        { code: "OBHOL", paxmlCode: "OBHOL", dayKind: "holiday", startTime: "14:00", endTime: "20:00" },
      ],
      overtimeThresholdMinutes: 15,
    });

    expect(result.ob).toEqual([{ code: "OBHOL", paxmlCode: "OBHOL", minutes: 360 }]);
  });

  it("9. overnight session is clipped at the day boundary: worked 180", () => {
    const result = computeEmployeeDay({
      date: DAY,
      isHoliday: false,
      schedule: null,
      attendance: [{ start: clockToMs(DAY, "21:00"), end: clockToMs(NEXT_DAY, "02:00") }],
      absences: [],
      atfMinutes: 0,
      obRules: [],
      overtimeThresholdMinutes: 15,
    });

    expect(result.workedMinutes).toBe(180);
  });

  it("10. ATF withdrawal absorbs the scheduled day: unaccounted 0", () => {
    const result = computeEmployeeDay({
      date: DAY,
      isHoliday: false,
      schedule: { netMinutes: 480, breaks: [] },
      attendance: [],
      absences: [],
      atfMinutes: 480,
      obRules: [],
      overtimeThresholdMinutes: 15,
    });

    expect(result.workedMinutes).toBe(0);
    expect(result.unaccountedMinutes).toBe(0);
    expect(result.overtimeMinutes).toBe(0);
  });
});

describe("payroll day engine — interval helpers", () => {
  it("11. mergeIntervals merges overlapping and touching intervals and drops empties; subtractIntervals leaves presence untouched when the break is outside it", () => {
    const merged = mergeIntervals([
      iv(DAY, "10:00", "12:00"),
      iv(DAY, "11:00", "13:00"), // overlaps the first
      iv(DAY, "13:00", "14:00"), // touches the merged block (end === start)
      { start: clockToMs(DAY, "15:00"), end: clockToMs(DAY, "15:00") }, // empty, dropped
    ]);
    expect(merged).toEqual([iv(DAY, "10:00", "14:00")]);

    const presence = [iv(DAY, "10:00", "12:00")];
    const outsideBreak = [iv(DAY, "13:00", "14:00")];
    expect(subtractIntervals(presence, outsideBreak)).toEqual(presence);
  });

  it("12. periodDates and periodRange build calendar-local month boundaries", () => {
    expect(periodDates(2026, 2)).toHaveLength(28);
    expect(periodRange(2026, 6)).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });
});

describe("payroll day engine — sen ankomst och tidig hemgång", () => {
  const scheduled: DayComputationInput = {
    date: DAY,
    isHoliday: false,
    schedule: {
      netMinutes: 480,
      breaks: [{ type: "unpaid", startTime: "12:00", endTime: "13:00" }],
      startTime: "07:00",
      endTime: "16:00",
    },
    attendance: [],
    absences: [],
    atfMinutes: 0,
    obRules: [],
    overtimeThresholdMinutes: 0,
  };

  it("13. late from the first presence, early from the last — no tolerance", () => {
    const day = computeEmployeeDay({
      ...scheduled,
      attendance: [iv(DAY, "07:12", "11:00"), iv(DAY, "13:00", "15:20")],
    });
    expect(day.lateMinutes).toBe(12);
    expect(day.earlyLeaveMinutes).toBe(40);
  });

  it("14. on time (or early in, late out) is 0; a gap in the middle is neither", () => {
    const day = computeEmployeeDay({
      ...scheduled,
      attendance: [iv(DAY, "06:50", "10:00"), iv(DAY, "10:30", "16:05")],
    });
    expect(day.lateMinutes).toBe(0);
    expect(day.earlyLeaveMinutes).toBe(0);
  });

  it("15. 0 without a schedule, without presence, or without the schedule's clocks", () => {
    const free = computeEmployeeDay({ ...scheduled, schedule: null, attendance: [iv(DAY, "10:00", "12:00")] });
    expect([free.lateMinutes, free.earlyLeaveMinutes]).toEqual([0, 0]);
    const absent = computeEmployeeDay(scheduled);
    expect([absent.lateMinutes, absent.earlyLeaveMinutes]).toEqual([0, 0]);
    const noClocks = computeEmployeeDay({
      ...scheduled,
      schedule: { netMinutes: 480, breaks: [] },
      attendance: [iv(DAY, "09:00", "12:00")],
    });
    expect([noClocks.lateMinutes, noClocks.earlyLeaveMinutes]).toEqual([0, 0]);
  });

  it("16. an overnight session clipped at midnight is not late on the next day", () => {
    const day = computeEmployeeDay({
      ...scheduled,
      date: NEXT_DAY,
      attendance: [{ start: clockToMs(DAY, "22:00"), end: clockToMs(NEXT_DAY, "16:00") }],
    });
    expect(day.lateMinutes).toBe(0);
    expect(day.earlyLeaveMinutes).toBe(0);
  });

  it("17. snapshots locked before the fields existed normalize to 0", () => {
    const { lateMinutes: _late, earlyLeaveMinutes: _early, ...old } = computeEmployeeDay({
      ...scheduled,
      attendance: [iv(DAY, "07:30", "16:00")],
    });
    const normalized = normalizePayrollDay(old);
    expect(normalized.lateMinutes).toBe(0);
    expect(normalized.earlyLeaveMinutes).toBe(0);
    expect(normalized.overtimeDisposition).toBe("payout");
  });
});
