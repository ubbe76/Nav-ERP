import { describe, expect, it } from "vitest";
import { round2 } from "@navet/shared";
import {
  AllocationTooSmallError,
  addMonths,
  allocationAmounts,
  allocationDescription,
  lastDayOfMonth,
  monthsBetween,
  monthsDue,
  nextRunMonth,
  runDate,
} from "../src/modules/economy/service/recurring-schedule.js";

// Pure tests for the återkommande verifikat rules: the month arithmetic,
// which months a post owes, and the fördelning's split.

describe("month arithmetic", () => {
  it("adds months across year ends, both ways", () => {
    expect(addMonths("2026-11", 1)).toBe("2026-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-03", 24)).toBe("2028-03");
    expect(monthsBetween("2026-01", "2026-01")).toBe(0);
    expect(monthsBetween("2026-11", "2027-02")).toBe(3);
  });

  it("knows the last day of every month, leap years included", () => {
    expect(lastDayOfMonth("2026-02")).toBe(28);
    expect(lastDayOfMonth("2028-02")).toBe(29);
    expect(lastDayOfMonth("2026-04")).toBe(30);
    expect(lastDayOfMonth("2026-12")).toBe(31);
    expect(runDate("2026-02", "last")).toBe("2026-02-28");
    expect(runDate("2026-02", 5)).toBe("2026-02-05");
    expect(runDate("2026-02", 28)).toBe("2026-02-28");
  });
});

describe("monthsDue", () => {
  const base = { startMonth: "2026-01", endMonth: null, dayOfMonth: 25 as const, doneMonths: new Set<string>() };

  it("lists every month whose day has passed and that has no run, oldest first", () => {
    expect(monthsDue({ ...base, today: "2026-03-25" })).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("leaves out this month while its day is still ahead", () => {
    expect(monthsDue({ ...base, today: "2026-03-24" })).toEqual(["2026-01", "2026-02"]);
  });

  it("skips months that already have a run — created or failed alike", () => {
    expect(monthsDue({ ...base, today: "2026-03-25", doneMonths: new Set(["2026-01", "2026-02"]) })).toEqual(["2026-03"]);
    expect(monthsDue({ ...base, today: "2026-03-25", doneMonths: new Set(["2026-02"]) })).toEqual(["2026-01", "2026-03"]);
  });

  it("stops at the end month", () => {
    expect(monthsDue({ ...base, endMonth: "2026-02", today: "2026-06-30" })).toEqual(["2026-01", "2026-02"]);
  });

  it("gives nothing before the start month", () => {
    expect(monthsDue({ ...base, startMonth: "2026-05", today: "2026-04-30" })).toEqual([]);
  });

  it("\"last\" is due on the month's last day and not before", () => {
    const last = { ...base, dayOfMonth: "last" as const };
    expect(monthsDue({ ...last, today: "2026-02-27" })).toEqual(["2026-01"]);
    expect(monthsDue({ ...last, today: "2026-02-28" })).toEqual(["2026-01", "2026-02"]);
  });
});

describe("nextRunMonth", () => {
  it("is the first month without a run, independent of today", () => {
    expect(nextRunMonth({ startMonth: "2026-01", endMonth: null, dayOfMonth: 1, doneMonths: new Set() })).toBe("2026-01");
    expect(nextRunMonth({ startMonth: "2026-01", endMonth: null, dayOfMonth: 1, doneMonths: new Set(["2026-01", "2026-02"]) })).toBe("2026-03");
  });

  it("skips a failed month too (it waits for Kör nu) and ends with the end month", () => {
    expect(nextRunMonth({ startMonth: "2026-01", endMonth: "2026-03", dayOfMonth: 1, doneMonths: new Set(["2026-01", "2026-03"]) })).toBe("2026-02");
    expect(nextRunMonth({ startMonth: "2026-01", endMonth: "2026-02", dayOfMonth: 1, doneMonths: new Set(["2026-01", "2026-02"]) })).toBeNull();
  });
});

describe("allocationAmounts", () => {
  it("splits evenly when it divides", () => {
    expect(allocationAmounts(1200, 12)).toEqual(Array(12).fill(100));
  });

  it("rounds to öre and lets the last month take the rest, so the sum is exact", () => {
    const amounts = allocationAmounts(1000, 3);
    expect(amounts).toEqual([333.33, 333.33, 333.34]);
    expect(round2(amounts.reduce((a, b) => a + b, 0))).toBe(1000);
  });

  it("sums exactly for awkward amounts and long schedules, never a negative month", () => {
    for (const [amount, months] of [
      [1.2, 120],
      [0.07, 7],
      [99999.99, 11],
      [12345.67, 13],
      [100, 3],
    ] as const) {
      const amounts = allocationAmounts(amount, months);
      expect(amounts).toHaveLength(months);
      expect(round2(amounts.reduce((a, b) => round2(a + b), 0))).toBe(amount);
      expect(amounts.every((a) => a >= 0.01)).toBe(true);
      // Rounded down per month: the rest lands on the last month only.
      expect(amounts[months - 1]!).toBeGreaterThanOrEqual(amounts[0]!);
    }
  });

  it("refuses an amount that cannot give every month an öre", () => {
    expect(() => allocationAmounts(1, 120)).toThrow(AllocationTooSmallError);
    expect(() => allocationAmounts(0.05, 7)).toThrow(AllocationTooSmallError);
  });

  it("builds the month text", () => {
    expect(allocationDescription("Försäkring 2026", "2026-03", "2026-01", 12)).toBe("Försäkring 2026 (månad 3 av 12)");
  });
});
