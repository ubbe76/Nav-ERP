import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@navet/db";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { clockToMs, computeEmployeeDay, dayBounds, dayKindOf, periodDates } from "../src/modules/payroll/service/payroll-day.js";
import { createValuationService } from "../src/modules/stock/service/valuation.service.js";
import { addDays, stockholmDateOf, stockholmInstant, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createAtfService } from "../src/modules/timereport/service/atf.service.js";
import { pdfText } from "./helpers/pdf.js";

// Datum är Stockholmsdagar, with the process in UTC (test/setup.ts): 23:30
// UTC the evening before is already the next Stockholm day (winter +01:00,
// summer +02:00), and the services below must say so without TZ.

const HOUR = 3_600_000;

describe("the Stockholm day in tests", () => {
  afterEach(() => vi.useRealTimers());

  it("the suite runs in UTC, the case the rule guards against", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
  });

  it.each([
    ["2026-11-06T23:30:00Z", "2026-11-07"],
    ["2026-11-06T22:59:00Z", "2026-11-06"],
    ["2026-07-06T22:30:00Z", "2026-07-07"],
    ["2026-07-06T21:59:00Z", "2026-07-06"],
  ])("at %s the day is %s", (instant, day) => {
    vi.useFakeTimers({ now: new Date(instant) });
    expect(stockholmToday()).toBe(day);
    expect(stockholmDateOf(new Date(instant))).toBe(day);
  });
});

describe("services default to the Stockholm day at 23:30 UTC", () => {
  afterEach(() => vi.useRealTimers());

  it("the stock valuation's asOf", async () => {
    // Only Date is faked — the pg client's timers stay real.
    vi.useFakeTimers({ now: new Date("2026-11-06T23:30:00Z"), toFake: ["Date"] });
    const valuation = await createValuationService({ db }).getValuation({ method: "standard" });
    expect(valuation.asOf).toBe("2026-11-07");
  });

  it("ATF's asOf: Monday in Stockholm completes the week that ended on Sunday", async () => {
    const employee = { id: "e", atfMode: "bank" as const, atfMinutesPerWeek: 60, atfStartDate: "2026-11-02" };
    const atf = createAtfService(
      {
        sumAtfTransactions: async () => ({ withdrawnMinutes: 0, adjustedMinutes: 0 }),
        listAtfTransactions: async () => [],
      } as unknown as Parameters<typeof createAtfService>[0],
      { findEmployeeById: async () => employee },
      { getSettings: async () => ({ atfMinutesPerWeek: 0 }) },
      { isDateLocked: async () => false }
    );
    // Sunday 8 November 23:30 UTC = Monday 9 November 00:30 in Stockholm.
    vi.useFakeTimers({ now: new Date("2026-11-08T23:30:00Z"), toFake: ["Date"] });
    expect((await atf.getAtfStatus("e")).accruedMinutes).toBe(60);
    vi.setSystemTime(new Date("2026-11-08T22:30:00Z")); // still Sunday in Stockholm
    expect((await atf.getAtfStatus("e")).accruedMinutes).toBe(0);
  });
});

describe("the payroll day reads the Stockholm wall clock", () => {
  it("schedule clocks and day bounds, winter and summer", () => {
    expect(clockToMs("2026-06-10", "07:00")).toBe(Date.parse("2026-06-10T05:00:00Z"));
    expect(clockToMs("2026-11-06", "07:00")).toBe(Date.parse("2026-11-06T06:00:00Z"));
    expect(dayBounds("2026-11-07")).toEqual({ start: Date.parse("2026-11-06T23:00:00Z"), end: Date.parse("2026-11-07T23:00:00Z") });
  });

  it("the switch days keep their wall-clock length and read clocks like a Date in the zone", () => {
    const spring = dayBounds("2026-03-29");
    const autumn = dayBounds("2026-10-25");
    expect(spring.end - spring.start).toBe(23 * HOUR);
    expect(autumn.end - autumn.start).toBe(25 * HOUR);
    // Spring: 02:30 does not exist — read with the winter offset, i.e. 03:30 summer time.
    expect(stockholmInstant("2026-03-29", "02:30")).toBe(Date.parse("2026-03-29T01:30:00Z"));
    expect(stockholmInstant("2026-03-29", "03:30")).toBe(Date.parse("2026-03-29T01:30:00Z"));
    expect(stockholmInstant("2026-03-29", "01:30")).toBe(Date.parse("2026-03-29T00:30:00Z"));
    // Autumn: 02:30 occurs twice — the first one, still summer time.
    expect(stockholmInstant("2026-10-25", "02:30")).toBe(Date.parse("2026-10-25T00:30:00Z"));
    expect(stockholmInstant("2026-10-25", "03:30")).toBe(Date.parse("2026-10-25T02:30:00Z"));
    expect(stockholmInstant("2026-10-25", "01:30:15")).toBe(Date.parse("2026-10-24T23:30:15Z"));
  });

  it("weekdays and month dates are plain calendar arithmetic", () => {
    expect(dayKindOf("2026-11-07", false)).toBe("saturday");
    expect(dayKindOf("2026-11-08", false)).toBe("sunday");
    expect(dayKindOf("2026-11-09", false)).toBe("weekday");
    expect(periodDates(2026, 2)).toHaveLength(28);
    expect(periodDates(2028, 2)).toHaveLength(29);
    expect(periodDates(2026, 12).at(-1)).toBe("2026-12-31");
    expect(periodDates(2026, 11)[0]).toBe("2026-11-01");
  });
});

// Every clock of 1990–2040 the way a Date in the zone reads it, checked
// without stockholmInstant's own arithmetic: the instant whose Stockholm wall
// clock is the given one (summer offset first, so an autumn clock that occurs
// twice is the first), and a spring clock the jump skips with the winter
// offset. Pins the per-date offset cache to the uncached reading (the
// brute-force comparison against the old local-zone code under
// TZ=Europe/Stockholm gave the same, zero differences).
describe("stockholmInstant against the zone's own wall clock", () => {
  const WALL = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  function expected(date: string, clock: string): number {
    const wall = Date.parse(`${date}T${clock}:00Z`);
    const shows = (ms: number) => WALL.format(ms) === `${date} ${clock}:00`;
    if (shows(wall - 2 * HOUR)) return wall - 2 * HOUR;
    return wall - HOUR; // winter time, or a skipped spring clock read with it
  }
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  // The last Sunday of the month.
  const lastSunday = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month, 0));
    return addDays(last.toISOString().slice(0, 10), -last.getUTCDay());
  };

  it("every minute of the switch nights, every quarter of the rest and of the days either side, from a cold and a warm cache", () => {
    const differences: string[] = [];
    for (let year = 1990; year <= 2040; year++) {
      for (const switchDay of [lastSunday(year, 3), lastSunday(year, 10)]) {
        for (const date of [addDays(switchDay, -1), switchDay, addDays(switchDay, 1)]) {
          for (let minute = 0; minute < 24 * 60; minute += date === switchDay && minute < 5 * 60 ? 1 : 15) {
            const want = expected(date, clock(minute));
            for (const got of [stockholmInstant(date, clock(minute)), stockholmInstant(date, clock(minute))]) {
              if (got !== want) differences.push(`${date} ${clock(minute)}: ${new Date(got).toISOString()} ≠ ${new Date(want).toISOString()}`);
            }
          }
        }
      }
    }
    expect(differences.slice(0, 10)).toEqual([]);
  });

  it("four clocks on every day, and the next day's midnight that ends a payroll day", () => {
    const differences: string[] = [];
    for (let date = "1990-01-01"; date <= "2040-12-31"; date = addDays(date, 1)) {
      for (const c of ["00:00", "02:30", "07:00", "23:59"]) {
        if (stockholmInstant(date, c) !== expected(date, c)) differences.push(`${date} ${c}`);
      }
      if (stockholmInstant(date, "24:00") !== stockholmInstant(addDays(date, 1), "00:00")) differences.push(`${date} 24:00`);
    }
    expect(differences.slice(0, 10)).toEqual([]);
  });

  it("a malformed clock or date still throws, as before the cache", () => {
    expect(() => stockholmInstant("2026-11-07", "7:00")).toThrow(RangeError);
    expect(() => stockholmInstant("2026-13-01", "07:00")).toThrow(RangeError);
  });
});

// The whole payroll day on the two switch Sundays, the minutes counted by
// hand from the UTC instants (spring: 02:00 winter time is 03:00 summer time
// at 01:00Z; autumn: 03:00 summer time is 02:00 winter time at 01:00Z).
describe("computeEmployeeDay across the switches", () => {
  const ob = { code: "OBNATT", paxmlCode: "OB1", dayKind: "sunday" as const, startTime: "00:00", endTime: "06:00" };
  const day = (date: string, attendance: { start: string; end: string }[]) =>
    computeEmployeeDay({
      date,
      isHoliday: false,
      schedule: null,
      attendance: attendance.map((a) => ({ start: Date.parse(a.start), end: Date.parse(a.end) })),
      absences: [],
      atfMinutes: 0,
      obRules: [ob],
      overtimeThresholdMinutes: 0,
    });

  it("spring, 29 March 2026: a night shift Saturday 22:00 – Sunday 06:00 is 7 hours, 5 on the Sunday", () => {
    // Saturday 22:00 winter time = 21:00Z; Sunday 06:00 summer time = 04:00Z.
    const shift = [{ start: "2026-03-28T21:00:00Z", end: "2026-03-29T04:00:00Z" }];
    // Sunday from 00:00 winter time (23:00Z): 23:00Z–04:00Z = 300 minutes, all
    // inside 00:00–06:00 (23:00Z–04:00Z).
    const sunday = day("2026-03-29", shift);
    expect(sunday.workedMinutes).toBe(300);
    expect(sunday.overtimeOffScheduleMinutes).toBe(300);
    expect(sunday.ob).toEqual([{ code: "OBNATT", paxmlCode: "OB1", minutes: 300 }]);
    // Saturday 22:00–24:00 = 21:00Z–23:00Z = 120 minutes; the rule is Sunday's.
    const saturday = day("2026-03-28", shift);
    expect(saturday.workedMinutes).toBe(120);
    expect(saturday.ob).toEqual([]);
    // The whole Sunday is 23 hours, its night 00:00–06:00 five.
    const whole = day("2026-03-29", [{ start: "2026-03-28T12:00:00Z", end: "2026-03-30T12:00:00Z" }]);
    expect(whole.workedMinutes).toBe(23 * 60);
    expect(whole.ob[0]!.minutes).toBe(300);
  });

  it("autumn, 25 October 2026: a night shift Saturday 22:00 – Sunday 06:00 is 9 hours, 7 on the Sunday", () => {
    // Saturday 22:00 summer time = 20:00Z; Sunday 06:00 winter time = 05:00Z.
    const shift = [{ start: "2026-10-24T20:00:00Z", end: "2026-10-25T05:00:00Z" }];
    // Sunday from 00:00 summer time (22:00Z): 22:00Z–05:00Z = 420 minutes,
    // all inside 00:00–06:00 (22:00Z–05:00Z, the hour 02–03 twice).
    const sunday = day("2026-10-25", shift);
    expect(sunday.workedMinutes).toBe(420);
    expect(sunday.overtimeOffScheduleMinutes).toBe(420);
    expect(sunday.ob).toEqual([{ code: "OBNATT", paxmlCode: "OB1", minutes: 420 }]);
    // Saturday 22:00–24:00 = 20:00Z–22:00Z = 120 minutes.
    const saturday = day("2026-10-24", shift);
    expect(saturday.workedMinutes).toBe(120);
    expect(saturday.ob).toEqual([]);
    // The whole Sunday is 25 hours, its night 00:00–06:00 seven.
    const whole = day("2026-10-25", [{ start: "2026-10-24T12:00:00Z", end: "2026-10-26T12:00:00Z" }]);
    expect(whole.workedMinutes).toBe(25 * 60);
    expect(whole.ob[0]!.minutes).toBe(420);
  });
});

describe("documents print the Stockholm day", () => {
  const pdf = createDocumentPdfService({ getCompanyInfo: async () => null as never, getLogo: async () => null });

  it("a pick list printed at 00:30 on 7 November in Stockholm (23:30Z the 6th) says the 7th", async () => {
    const buffer = await pdf.renderPickList({
      documentNumber: "KO-1",
      printedAt: new Date("2026-11-06T23:30:00Z"),
      customerName: "Kund AB",
      expectedDeliveryDate: null,
      note: null,
      rows: [],
    } as never);
    expect(pdfText(buffer)).toContain("Utskriven: 2026-11-07");
  });

  it("an order created at 00:30 says that day, and a due date column keeps its own day", async () => {
    const buffer = await pdf.render({
      title: "Inköpsorder",
      documentNumber: "IO-1",
      date: new Date("2026-06-30T22:30:00Z"), // 1 July 00:30 summer time
      dueDate: new Date("2026-07-31"), // a date column: UTC midnight
      partnerLabel: "Leverantör",
      partner: { name: "ACME AB", address: null, postalCode: null, city: null },
      currency: "SEK",
      rows: [],
      showTotal: false,
      deliveryTerm: null,
      paymentTerm: null,
      carrier: null,
    } as never);
    const text = pdfText(buffer);
    expect(text).toContain("2026-07-01");
    expect(text).not.toContain("2026-06-30");
    expect(text).toContain("2026-07-31");
  });
});
