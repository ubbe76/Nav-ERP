import { describe, expect, it } from "vitest";
import { plannedDateLabel, weekdayShortDate } from "../../web/lib/planning.js";

describe("plannedDateLabel", () => {
  it("is null for an unplanned operation", () => {
    expect(plannedDateLabel(null, null)).toBeNull();
  });
  it("shows one day", () => {
    expect(plannedDateLabel("2026-11-12", "2026-11-12")).toBe("12 nov");
    expect(plannedDateLabel("2026-11-12", null)).toBe("12 nov");
  });
  it("collapses the month within one month", () => {
    expect(plannedDateLabel("2026-11-12", "2026-11-14")).toBe("12–14 nov");
  });
  it("names both months across a month boundary", () => {
    expect(plannedDateLabel("2026-11-28", "2026-12-02")).toBe("28 nov–2 dec");
  });
  it("names both months across a year boundary", () => {
    expect(plannedDateLabel("2026-12-30", "2027-01-04")).toBe("30 dec–4 jan");
  });
  it("does not collapse the same month of different years", () => {
    expect(plannedDateLabel("2026-11-12", "2027-11-14")).toBe("12 nov–14 nov");
  });
});

describe("weekdayShortDate", () => {
  it("names the weekday of a Stockholm day", () => {
    expect(weekdayShortDate("2026-11-16")).toBe("mån 16 nov");
    expect(weekdayShortDate("2026-11-22")).toBe("sön 22 nov");
  });
});
