import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AttendanceInputRequiredError,
  assessArrival,
  assessDeparture,
  attendanceInputRequiredBody,
} from "../src/modules/timereport/service/attendance-deviation.js";

// Pure rules for sen ankomst / tidig hemgång — no DB. The payroll engine
// (and therefore these rules) reads schedule clocks in the server's local
// zone, which the API container sets to Europe/Stockholm; the test pins the
// same zone so the instants below mean what they say.
let savedTz: string | undefined;
beforeAll(() => {
  savedTz = process.env.TZ;
  process.env.TZ = "Europe/Stockholm";
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const DAY = "2026-06-10"; // Wednesday, summer time (UTC+2)
const schedule = { startTime: "07:00", endTime: "16:00", netMinutes: 480 };
const on = { attendanceReasonRequired: true, attendanceReasonToleranceMinutes: 5 };
const off = { attendanceReasonRequired: false, attendanceReasonToleranceMinutes: 5 };
// Stockholm wall clock → instant (summer time in June).
const at = (clock: string, date = DAY, offset = "+02:00") => new Date(`${date}T${clock}${offset}`);

describe("assessArrival — sen ankomst", () => {
  it("measures the first attendance against the schedule's start and asks beyond the tolerance", () => {
    const late = assessArrival({ date: DAY, schedule, at: at("07:12:00"), firstOfDay: true, settings: on });
    expect(late).toEqual({ kind: "late", minutes: 12, scheduledTime: "07:00", requiresReason: true });
  });

  it("asks nothing exactly at the tolerance (strictly greater), and counts whole minutes", () => {
    expect(assessArrival({ date: DAY, schedule, at: at("07:05:00"), firstOfDay: true, settings: on })).toMatchObject({
      minutes: 5,
      requiresReason: false,
    });
    // 5 min 59 s is still 5 whole minutes.
    expect(assessArrival({ date: DAY, schedule, at: at("07:05:59"), firstOfDay: true, settings: on })).toMatchObject({
      minutes: 5,
      requiresReason: false,
    });
    expect(assessArrival({ date: DAY, schedule, at: at("07:06:00"), firstOfDay: true, settings: on })).toMatchObject({
      minutes: 6,
      requiresReason: true,
    });
  });

  it("an arrival on time or early is no deviation", () => {
    expect(assessArrival({ date: DAY, schedule, at: at("06:45:00"), firstOfDay: true, settings: on })).toBeNull();
    expect(assessArrival({ date: DAY, schedule, at: at("07:00:30"), firstOfDay: true, settings: on })).toBeNull();
  });

  it("a return after an early departure (not the day's first attendance) asks nothing", () => {
    expect(assessArrival({ date: DAY, schedule, at: at("13:30:00"), firstOfDay: false, settings: on })).toBeNull();
  });

  it("a free day (no day schedule — also a red day) asks nothing", () => {
    expect(assessArrival({ date: DAY, schedule: null, at: at("10:00:00"), firstOfDay: true, settings: on })).toBeNull();
  });

  it("a day schedule without net time is a free day too", () => {
    const empty = { startTime: "00:00", endTime: "00:00", netMinutes: 0 };
    expect(assessArrival({ date: DAY, schedule: empty, at: at("10:00:00"), firstOfDay: true, settings: on })).toBeNull();
  });

  it("a short day on a holiday's day schedule is measured against that schedule", () => {
    const eve = "2026-12-23"; // winter time
    const shortDay = { startTime: "07:00", endTime: "12:00", netMinutes: 300 };
    const late = assessArrival({ date: eve, schedule: shortDay, at: at("07:20:00", eve, "+01:00"), firstOfDay: true, settings: on });
    expect(late).toMatchObject({ kind: "late", minutes: 20, scheduledTime: "07:00", requiresReason: true });
  });

  it("with the setting off the deviation is reported but never requires a reason", () => {
    expect(assessArrival({ date: DAY, schedule, at: at("08:00:00"), firstOfDay: true, settings: off })).toEqual({
      kind: "late",
      minutes: 60,
      scheduledTime: "07:00",
      requiresReason: false,
    });
  });

  it("Stockholm time around the summer-time switches", () => {
    // 2026-03-29: clocks jump 02:00 → 03:00 (UTC+1 → UTC+2).
    const spring = "2026-03-29";
    expect(
      assessArrival({ date: spring, schedule, at: new Date("2026-03-29T05:12:00Z"), firstOfDay: true, settings: on })
    ).toMatchObject({ minutes: 12 });
    // 2026-10-25: clocks fall back 03:00 → 02:00 (UTC+2 → UTC+1).
    const autumn = "2026-10-25";
    expect(
      assessArrival({ date: autumn, schedule, at: new Date("2026-10-25T06:12:00Z"), firstOfDay: true, settings: on })
    ).toMatchObject({ minutes: 12 });
  });
});

describe("assessDeparture — tidig hemgång", () => {
  it("measures the stop against the schedule's end", () => {
    expect(assessDeparture({ date: DAY, schedule, at: at("15:20:00"), atfWithdrawal: false, settings: on })).toEqual({
      kind: "early",
      minutes: 40,
      scheduledTime: "16:00",
      requiresReason: true,
    });
  });

  it("exactly at the tolerance asks nothing; after the end is no deviation", () => {
    expect(assessDeparture({ date: DAY, schedule, at: at("15:55:00"), atfWithdrawal: false, settings: on })).toMatchObject({
      minutes: 5,
      requiresReason: false,
    });
    expect(assessDeparture({ date: DAY, schedule, at: at("16:10:00"), atfWithdrawal: false, settings: on })).toBeNull();
  });

  it("a departure through Ta ut ATF is never a deviation", () => {
    expect(assessDeparture({ date: DAY, schedule, at: at("12:00:00"), atfWithdrawal: true, settings: on })).toBeNull();
  });

  it("a free day asks nothing", () => {
    expect(assessDeparture({ date: DAY, schedule: null, at: at("12:00:00"), atfWithdrawal: false, settings: on })).toBeNull();
  });
});

describe("AttendanceInputRequiredError", () => {
  it("carries both questions in the 409 body", () => {
    const err = new AttendanceInputRequiredError(
      { kind: "early", minutes: 40, scheduledTime: "16:00" },
      { minutes: 45, offSchedule: false, current: "payout" }
    );
    expect(attendanceInputRequiredBody(err)).toEqual({
      error: err.message,
      code: "attendance-input-required",
      reason: { kind: "early", minutes: 40, scheduledTime: "16:00" },
      overtime: { minutes: 45, offSchedule: false, current: "payout" },
    });
  });
});
