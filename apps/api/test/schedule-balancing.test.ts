import { describe, expect, it } from "vitest";
import {
  balanceWeek,
  describeBalancingProblem,
  endMinutesAfterWork,
  findBalancingProblem,
  toClock,
  type BalancingDaySchedule,
} from "../src/modules/timereport/service/schedule-balancing.js";

// The example from the spec (and HRMS-Sverige): Mon–Thu 07:00–16:15 with
// unpaid 09:00–09:20 and 12:00–12:40 (8 h 15 min), Friday 07:00–12:58 with
// only the morning break (5 h 38 min). Ordinary 40 h, ATF 82 min per week.
const MON_THU: BalancingDaySchedule = {
  startTime: "07:00",
  endTime: "16:15",
  netMinutes: 495,
  breaks: [
    { type: "unpaid", startTime: "09:00", endTime: "09:20" },
    { type: "unpaid", startTime: "12:00", endTime: "12:40" },
  ],
};
const FRIDAY: BalancingDaySchedule = {
  startTime: "07:00",
  endTime: "12:58",
  netMinutes: 338,
  breaks: [{ type: "unpaid", startTime: "09:00", endTime: "09:20" }],
};
const WEEK = {
  ordinaryMinutesPerWeek: 2400,
  atfMinutesPerWeek: 82,
  days: [1, 2, 3, 4].map((weekday) => ({ weekday, schedule: MON_THU })).concat([{ weekday: 5, schedule: FRIDAY }]),
};

const week = (holidayWeekdays: number[] = [], absence: [number, number][] = []) =>
  balanceWeek({ ...WEEK, holidayWeekdays, nonEarningAbsenceMinutes: new Map(absence) });

describe("balanceWeek — the spec's table", () => {
  it("a whole week: Friday 5 h 38 min, ends 12:58", () => {
    expect(week()).toEqual({
      weekday: 5,
      netMinutes: 338,
      endMinutes: 12 * 60 + 58,
      endTime: "12:58",
      workdays: 5,
      normalWorkdays: 5,
      weekAtfMinutes: 82,
      lostAtfMinutes: 0,
    });
  });

  it("a red Wednesday: Friday 6 h 09 min, ends 13:29 — the quarter is not given away", () => {
    expect(week([3])).toMatchObject({ weekday: 5, netMinutes: 369, endTime: "13:29", workdays: 4, weekAtfMinutes: 66 });
  });

  it("a red Monday gives the same Friday", () => {
    expect(week([1])).toMatchObject({ weekday: 5, netMinutes: 369, endTime: "13:29" });
  });

  it("a red Friday makes Thursday the short day, ending 14:09 after lunch", () => {
    expect(week([5])).toMatchObject({ weekday: 4, netMinutes: 369, endTime: "14:09", workdays: 4 });
  });

  it("red Wednesday–Friday makes Tuesday the last workday, ending 15:12", () => {
    expect(week([3, 4, 5])).toMatchObject({ weekday: 2, netMinutes: 432, endTime: "15:12", workdays: 2 });
  });

  it("a whole sick Wednesday loses its ATF share: Friday ends 13:14", () => {
    expect(week([], [[3, 495]])).toMatchObject({ weekday: 5, netMinutes: 354, endTime: "13:14", lostAtfMinutes: 16, weekAtfMinutes: 66 });
  });

  it("half a day of VAB loses a proportional share: Friday ends 13:06", () => {
    expect(week([], [[3, 240]])).toMatchObject({ weekday: 5, netMinutes: 346, endTime: "13:06", lostAtfMinutes: 8 });
  });

  it("a red Wednesday and a sick Monday: Friday ends 13:46", () => {
    expect(week([3], [[1, 495]])).toMatchObject({ weekday: 5, netMinutes: 386, endTime: "13:46" });
  });
});

describe("balanceWeek — which days count", () => {
  it("absence on the last workday itself changes nothing", () => {
    expect(week([], [[5, 338]])).toMatchObject({ netMinutes: 338, endTime: "12:58", lostAtfMinutes: 0 });
  });

  it("absence longer than the day loses at most one share", () => {
    expect(week([], [[3, 2000]])).toMatchObject({ netMinutes: 354 });
  });

  it("absence on a holiday or a day off earns nothing to lose", () => {
    expect(week([3], [[3, 495]])).toMatchObject({ netMinutes: 369 });
    expect(week([], [[6, 480]])).toMatchObject({ netMinutes: 338 });
  });

  it("weekend holidays outside the schedule do not shorten the week", () => {
    expect(week([6, 7])).toMatchObject({ weekday: 5, netMinutes: 338, workdays: 5 });
  });

  it("ATF 0 balances only the inarbetning", () => {
    expect(balanceWeek({ ...WEEK, atfMinutesPerWeek: 0, holidayWeekdays: [] })).toMatchObject({
      weekday: 5,
      netMinutes: 420,
      endTime: "14:20",
      weekAtfMinutes: 0,
    });
    expect(balanceWeek({ ...WEEK, atfMinutesPerWeek: 0, holidayWeekdays: [3] })).toMatchObject({ netMinutes: 435 });
  });

  it("a four-day week schedule divides by four", () => {
    const fourDays = {
      ordinaryMinutesPerWeek: 1920,
      atfMinutesPerWeek: 64,
      days: [1, 2, 3].map((weekday) => ({ weekday, schedule: MON_THU })).concat([{ weekday: 4, schedule: FRIDAY }]),
    };
    // 4 × (480 − 16) − 3 × 495 = 371
    expect(balanceWeek({ ...fourDays, holidayWeekdays: [] })).toMatchObject({ weekday: 4, netMinutes: 371 });
  });

  it("day schedules without net time are not workdays", () => {
    const zero: BalancingDaySchedule = { startTime: "07:00", endTime: "07:30", netMinutes: 0, breaks: [{ type: "unpaid", startTime: "07:00", endTime: "07:30" }] };
    const withZeroSaturday = { ...WEEK, days: [...WEEK.days, { weekday: 6, schedule: zero }] };
    expect(balanceWeek({ ...withZeroSaturday, holidayWeekdays: [] })).toMatchObject({ weekday: 5, netMinutes: 338, normalWorkdays: 5 });
  });

  it("every workday a holiday leaves nothing to balance", () => {
    expect(week([1, 2, 3, 4, 5])).toBeNull();
    expect(balanceWeek({ ...WEEK, days: [], holidayWeekdays: [] })).toBeNull();
  });

  it("rounds once per week", () => {
    // 82 / 5 = 16.4 per day: the red-Wednesday week earns 65.6 → 66.
    expect(week([3])?.weekAtfMinutes).toBe(66);
    // Three red days: 2 × 463.6 − 495 = 432.2 → 432.
    expect(week([3, 4, 5])?.netMinutes).toBe(432);
  });
});

describe("endMinutesAfterWork", () => {
  it("ends before the first break when the work fits", () => {
    expect(toClock(endMinutesAfterWork(MON_THU, 90))).toBe("08:30");
  });

  it("ends exactly at a break's start rather than after it", () => {
    expect(toClock(endMinutesAfterWork(MON_THU, 120))).toBe("09:00");
    expect(toClock(endMinutesAfterWork(MON_THU, 280))).toBe("12:00");
  });

  it("skips unpaid breaks", () => {
    expect(toClock(endMinutesAfterWork(MON_THU, 121))).toBe("09:21");
    expect(toClock(endMinutesAfterWork(MON_THU, 495))).toBe("16:15");
  });

  it("counts paid breaks as work", () => {
    const withFika: BalancingDaySchedule = { ...FRIDAY, breaks: [{ type: "paid", startTime: "09:00", endTime: "09:15" }] };
    expect(toClock(endMinutesAfterWork(withFika, 150))).toBe("09:30");
  });

  it("continues past the schedule's own end", () => {
    expect(toClock(endMinutesAfterWork(FRIDAY, 369))).toBe("13:29");
    expect(toClock(endMinutesAfterWork(MON_THU, 515))).toBe("16:35");
  });
});

describe("findBalancingProblem", () => {
  it("accepts the spec's schedule in every combination of holidays", () => {
    expect(findBalancingProblem(WEEK)).toBeNull();
  });

  it("reports a plain week whose last day gets no time", () => {
    const problem = findBalancingProblem({ ...WEEK, ordinaryMinutesPerWeek: 2000 });
    expect(problem).toMatchObject({ holidayWeekdays: [], weekday: 5, reason: "too-short" });
    expect(describeBalancingProblem(problem!)).toContain("en hel vecka skulle fredagen bli");
  });

  it("reports a last workday that would run past midnight", () => {
    // Evening shifts: Mon–Thu 14:00–20:00 (6 h) owe 2 h each, so Friday
    // (14:00–22:00) would get 40 h − 4 × 6 h = 16 h and end 06:00 next day.
    const evening: BalancingDaySchedule = { startTime: "14:00", endTime: "20:00", netMinutes: 360, breaks: [] };
    const late: BalancingDaySchedule = { startTime: "14:00", endTime: "22:00", netMinutes: 480, breaks: [] };
    const problem = findBalancingProblem({
      ordinaryMinutesPerWeek: 2400,
      atfMinutesPerWeek: 0,
      days: [1, 2, 3, 4].map((weekday) => ({ weekday, schedule: evening })).concat([{ weekday: 5, schedule: late }]),
    });
    expect(problem).toMatchObject({ holidayWeekdays: [], weekday: 5, reason: "past-midnight", endTime: "30:00" });
    expect(describeBalancingProblem(problem!)).toContain("efter midnatt");
  });

  it("checks the worst case of absence too", () => {
    // Fine without absence (Friday 08:00–23:50) but every other day sick
    // adds four ATF shares of 30 min and pushes it past midnight.
    const day: BalancingDaySchedule = { startTime: "08:00", endTime: "16:00", netMinutes: 480, breaks: [] };
    const friday: BalancingDaySchedule = { startTime: "08:00", endTime: "16:00", netMinutes: 480, breaks: [] };
    const input = {
      ordinaryMinutesPerWeek: 2400 + 5 * 30 + 5 * 94,
      atfMinutesPerWeek: 150,
      days: [1, 2, 3, 4].map((weekday) => ({ weekday, schedule: day })).concat([{ weekday: 5, schedule: friday }]),
    };
    expect(balanceWeek({ ...input, holidayWeekdays: [] })).toMatchObject({ netMinutes: 950, endTime: "23:50" });
    expect(findBalancingProblem(input)).toMatchObject({ reason: "past-midnight", weekday: 5 });
  });

  it("names the holiday in the message", () => {
    expect(
      describeBalancingProblem({ holidayWeekdays: [5], weekday: 4, netMinutes: 900, endTime: "24:10", reason: "past-midnight" })
    ).toBe("Utjämningen går inte ihop: med helgdag på fredag skulle torsdagen sluta 24:10, efter midnatt.");
  });
});
