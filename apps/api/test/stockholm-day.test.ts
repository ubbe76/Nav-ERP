import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "@navet/db";
import { clockToMs, dayBounds, dayKindOf, periodDates } from "../src/modules/payroll/service/payroll-day.js";
import { createValuationService } from "../src/modules/stock/service/valuation.service.js";
import { stockholmDateOf, stockholmInstant, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createAtfService } from "../src/modules/timereport/service/atf.service.js";

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
