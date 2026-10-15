import { describe, expect, it } from "vitest";
import {
  bucketDeliveryPrecision,
  type PrecisionOrderInput,
} from "../src/modules/reports/service/delivery-precision-calc.js";

// Pure calc tests — no database. The authoritative spec for leveransprecision.

const RANGE = { from: "2026-08", to: "2026-08" };

function order(expected: string | null, completed: string | null): PrecisionOrderInput {
  return { expectedDeliveryDate: expected, completedAt: completed };
}

describe("bucketDeliveryPrecision", () => {
  it("counts same-day delivery as on time and later days as late with the day diff", () => {
    const result = bucketDeliveryPrecision(
      [
        order("2026-08-10", "2026-08-10T14:00:00.000Z"), // same day — on time
        order("2026-08-10", "2026-08-13T08:00:00.000Z"), // 3 days late
        order("2026-08-20", "2026-08-12T08:00:00.000Z"), // early — on time
      ],
      RANGE
    );
    const aug = result.months.find((m) => m.month === "2026-08")!;
    expect(aug.total).toBe(3);
    expect(aug.onTime).toBe(2);
    expect(aug.late).toBe(1);
    expect(aug.precisionPct).toBe(67); // 2/3
    expect(aug.avgDaysLate).toBe(3);
    expect(result.totals).toMatchObject({ total: 3, onTime: 2, late: 1, precisionPct: 67, avgDaysLate: 3 });
  });

  it("averages days late over late orders only, one decimal", () => {
    const result = bucketDeliveryPrecision(
      [
        order("2026-08-10", "2026-08-11T08:00:00.000Z"), // 1 day
        order("2026-08-10", "2026-08-14T08:00:00.000Z"), // 4 days
        order("2026-08-10", "2026-08-10T08:00:00.000Z"), // on time — excluded from avg
      ],
      RANGE
    );
    expect(result.totals.avgDaysLate).toBe(2.5);
  });

  it("converts timestamps to Stockholm dates — a late-evening UTC delivery lands the next local day", () => {
    // 2026-08-31T22:30Z is 2026-09-01 00:30 in Stockholm — September, and one
    // day late against an Aug 31 promise.
    const result = bucketDeliveryPrecision([order("2026-08-31", "2026-08-31T22:30:00.000Z")], {
      from: "2026-08",
      to: "2026-09",
    });
    expect(result.months.find((m) => m.month === "2026-08")!.total).toBe(0);
    const sep = result.months.find((m) => m.month === "2026-09")!;
    expect(sep.total).toBe(1);
    expect(sep.late).toBe(1);
    expect(sep.avgDaysLate).toBe(1);
  });

  it("scopes missingExpectedDate to completions inside the range — no all-time counts under a filtered table", () => {
    const result = bucketDeliveryPrecision(
      [
        order(null, "2026-08-10T08:00:00.000Z"), // in range — counted
        order(null, "2026-03-10T08:00:00.000Z"), // outside range — NOT counted
      ],
      RANGE
    );
    expect(result.notMeasurable.missingExpectedDate).toBe(1);
  });

  it("routes unmeasurable orders to the counters instead of the buckets", () => {
    const result = bucketDeliveryPrecision(
      [
        order(null, "2026-08-10T08:00:00.000Z"), // never promised
        order("2026-08-10", null), // pre-C2: no delivery records
        order(null, null),
      ],
      RANGE
    );
    expect(result.totals.total).toBe(0);
    expect(result.notMeasurable.missingExpectedDate).toBe(1);
    expect(result.notMeasurable.noDeliveryRecords).toBe(2); // null completion wins the classification
  });

  it("emits every month in the range, empty ones with nulls", () => {
    const result = bucketDeliveryPrecision([order("2026-07-01", "2026-07-01T08:00:00.000Z")], {
      from: "2026-06",
      to: "2026-08",
    });
    expect(result.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
    const june = result.months[0]!;
    expect(june.total).toBe(0);
    expect(june.precisionPct).toBeNull();
    expect(june.avgDaysLate).toBeNull();
  });

  it("ignores completions outside the range", () => {
    const result = bucketDeliveryPrecision(
      [order("2026-05-01", "2026-05-02T08:00:00.000Z"), order("2026-08-01", "2026-08-01T08:00:00.000Z")],
      RANGE
    );
    expect(result.totals.total).toBe(1);
  });

  it("handles empty input", () => {
    const result = bucketDeliveryPrecision([], RANGE);
    expect(result.totals).toEqual({ total: 0, onTime: 0, late: 0, precisionPct: null, avgDaysLate: null });
    expect(result.months).toHaveLength(1);
  });

  it("spans a year boundary in the month axis", () => {
    const result = bucketDeliveryPrecision([], { from: "2026-11", to: "2027-02" });
    expect(result.months.map((m) => m.month)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});
