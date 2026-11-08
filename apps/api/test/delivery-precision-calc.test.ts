import { describe, expect, it } from "vitest";
import {
  bucketDeliveryPrecision,
  classifyDelivery,
  type PrecisionOrderInput,
} from "../src/modules/reports/service/delivery-precision-calc.js";
import {
  decodePrecisionMargins,
  NO_PRECISION_MARGINS,
  PRECISION_MARGIN_KEYS,
} from "../src/modules/system/service/precision-settings.js";

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
      RANGE,
      NO_PRECISION_MARGINS
    );
    const aug = result.months.find((m) => m.month === "2026-08")!;
    expect(aug.total).toBe(3);
    expect(aug.onTime).toBe(2);
    expect(aug.late).toBe(1);
    expect(aug.precisionPct).toBe(67); // 2/3
    expect(aug.avgDaysLate).toBe(3);
    expect(result.totals).toMatchObject({ total: 3, early: 0, onTime: 2, late: 1, precisionPct: 67, avgDaysLate: 3 });
    expect(result.margins).toEqual(NO_PRECISION_MARGINS);
  });

  it("averages days late over late orders only, one decimal", () => {
    const result = bucketDeliveryPrecision(
      [
        order("2026-08-10", "2026-08-11T08:00:00.000Z"), // 1 day
        order("2026-08-10", "2026-08-14T08:00:00.000Z"), // 4 days
        order("2026-08-10", "2026-08-10T08:00:00.000Z"), // on time — excluded from avg
      ],
      RANGE,
      NO_PRECISION_MARGINS
    );
    expect(result.totals.avgDaysLate).toBe(2.5);
  });

  it("converts timestamps to Stockholm dates — a late-evening UTC delivery lands the next local day", () => {
    // 2026-08-31T22:30Z is 2026-09-01 00:30 in Stockholm — September, and one
    // day late against an Aug 31 promise.
    const result = bucketDeliveryPrecision(
      [order("2026-08-31", "2026-08-31T22:30:00.000Z")],
      { from: "2026-08", to: "2026-09" },
      NO_PRECISION_MARGINS
    );
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
      RANGE,
      NO_PRECISION_MARGINS
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
      RANGE,
      NO_PRECISION_MARGINS
    );
    expect(result.totals.total).toBe(0);
    expect(result.notMeasurable.missingExpectedDate).toBe(1);
    expect(result.notMeasurable.noDeliveryRecords).toBe(2); // null completion wins the classification
  });

  it("emits every month in the range, empty ones with nulls", () => {
    const result = bucketDeliveryPrecision(
      [order("2026-07-01", "2026-07-01T08:00:00.000Z")],
      { from: "2026-06", to: "2026-08" },
      NO_PRECISION_MARGINS
    );
    expect(result.months.map((m) => m.month)).toEqual(["2026-06", "2026-07", "2026-08"]);
    const june = result.months[0]!;
    expect(june.total).toBe(0);
    expect(june.precisionPct).toBeNull();
    expect(june.avgDaysLate).toBeNull();
  });

  it("ignores completions outside the range", () => {
    const result = bucketDeliveryPrecision(
      [order("2026-05-01", "2026-05-02T08:00:00.000Z"), order("2026-08-01", "2026-08-01T08:00:00.000Z")],
      RANGE,
      NO_PRECISION_MARGINS
    );
    expect(result.totals.total).toBe(1);
  });

  it("handles empty input", () => {
    const result = bucketDeliveryPrecision([], RANGE, NO_PRECISION_MARGINS);
    expect(result.totals).toEqual({ total: 0, early: 0, onTime: 0, late: 0, precisionPct: null, avgDaysLate: null });
    expect(result.months).toHaveLength(1);
  });

  it("spans a year boundary in the month axis", () => {
    const result = bucketDeliveryPrecision([], { from: "2026-11", to: "2027-02" }, NO_PRECISION_MARGINS);
    expect(result.months.map((m) => m.month)).toEqual(["2026-11", "2026-12", "2027-01", "2027-02"]);
  });
});

// Marginal i leveransprecisionen (#29): the one rule both views share.
describe("classifyDelivery", () => {
  it("without margins: same day or earlier is on time, the day after is late (the rule before #29)", () => {
    expect(classifyDelivery(-30, NO_PRECISION_MARGINS)).toBe("onTime");
    expect(classifyDelivery(0, NO_PRECISION_MARGINS)).toBe("onTime");
    expect(classifyDelivery(1, NO_PRECISION_MARGINS)).toBe("late");
  });

  it("late only MORE than lateDays after the promise", () => {
    const margins = { lateDays: 2, earlyDays: null };
    expect(classifyDelivery(2, margins)).toBe("onTime");
    expect(classifyDelivery(3, margins)).toBe("late");
    expect(classifyDelivery(-10, margins)).toBe("onTime"); // early margin off
  });

  it("early only MORE than earlyDays before the promise; 0 = any day before", () => {
    expect(classifyDelivery(-3, { lateDays: 0, earlyDays: 3 })).toBe("onTime");
    expect(classifyDelivery(-4, { lateDays: 0, earlyDays: 3 })).toBe("early");
    expect(classifyDelivery(-1, { lateDays: 0, earlyDays: 0 })).toBe("early");
    expect(classifyDelivery(0, { lateDays: 0, earlyDays: 0 })).toBe("onTime");
  });
});

describe("bucketDeliveryPrecision with margins (#29)", () => {
  it("counts early, on time and late; precision = on time of all; avg days late from the promise", () => {
    const margins = { lateDays: 2, earlyDays: 3 };
    const result = bucketDeliveryPrecision(
      [
        order("2026-08-20", "2026-08-12T08:00:00.000Z"), // 8 days early — early
        order("2026-08-20", "2026-08-17T08:00:00.000Z"), // 3 days early — on time (not MORE than 3)
        order("2026-08-20", "2026-08-22T08:00:00.000Z"), // 2 days late — on time (within the margin)
        order("2026-08-20", "2026-08-25T08:00:00.000Z"), // 5 days late — late
      ],
      RANGE,
      margins
    );
    expect(result.margins).toEqual(margins);
    expect(result.totals).toEqual({ total: 4, early: 1, onTime: 2, late: 1, precisionPct: 50, avgDaysLate: 5 });
    expect(result.months[0]).toMatchObject({ month: "2026-08", early: 1, onTime: 2, late: 1 });
  });
});

describe("decodePrecisionMargins", () => {
  it("defaults to late 0 and early off; reads both sides; junk decodes to the default", () => {
    expect(decodePrecisionMargins(() => undefined)).toEqual({ sales: NO_PRECISION_MARGINS, purchase: NO_PRECISION_MARGINS });
    const stored: Record<string, string> = {
      [PRECISION_MARGIN_KEYS.salesLate]: "2",
      [PRECISION_MARGIN_KEYS.salesEarly]: "0",
      [PRECISION_MARGIN_KEYS.purchaseLate]: "abc",
      [PRECISION_MARGIN_KEYS.purchaseEarly]: "",
    };
    expect(decodePrecisionMargins((key) => stored[key])).toEqual({
      sales: { lateDays: 2, earlyDays: 0 },
      purchase: { lateDays: 0, earlyDays: null },
    });
    expect(
      decodePrecisionMargins((key) => ({ [PRECISION_MARGIN_KEYS.salesLate]: "1.5", [PRECISION_MARGIN_KEYS.salesEarly]: "366" })[key])
        .sales
    ).toEqual(NO_PRECISION_MARGINS);
  });
});
