import { describe, expect, it } from "vitest";
import {
  pairCalculationOutcomes,
  type CalcRowInput,
} from "../src/modules/reports/service/calc-outcome-calc.js";

// Pure pairing tests — no database. Spec for för- vs efterkalkylutfall.

const RANGE = { from: "2026-08", to: "2026-08" };

function calc(overrides: Partial<CalcRowInput>): CalcRowInput {
  return {
    manufacturingOrderId: "mo-1",
    orderNumber: "TO-1",
    articleNumber: "ART-1",
    articleName: "Artikel",
    type: "pre",
    quantity: 10,
    calculatedAt: "2026-08-10T10:00:00.000Z",
    materialCost: 100,
    materialOverhead: 10,
    laborCost: 50,
    overhead: 20,
    subcontractCost: 0,
    subcontractOverhead: 0,
    semiFinishedCost: 0,
    multiLevel: false,
    ...overrides,
  };
}

describe("pairCalculationOutcomes", () => {
  it("counts the halvfabrikat bucket in TVK and flags a multi-level pre-calculation", () => {
    // The bucket is invisible in the report if tvk() forgets it: nothing
    // crashes, the deviation is simply wrong. Pre TVK 180 + 120 = 300 over 10
    // units → 30/unit, against a post at 20/unit.
    const result = pairCalculationOutcomes(
      [
        calc({ type: "pre", semiFinishedCost: 120, multiLevel: true }),
        calc({
          type: "post",
          quantity: 5,
          calculatedAt: "2026-08-15T10:00:00.000Z",
          materialCost: 60,
          materialOverhead: 0,
          laborCost: 30,
          overhead: 10,
        }),
      ],
      RANGE
    );

    expect(result.rows[0]!.preTvkPerUnit).toBe(30);
    expect(result.rows[0]!.postTvkPerUnit).toBe(20);
    expect(result.rows[0]!.preMultiLevel).toBe(true);
  });


  it("pairs latest pre with latest post and compares per-unit TVK across differing lot sizes", () => {
    // Pre: TVK 180 for 10 units → 18/unit. Post: TVK 100 for 5 units → 20/unit.
    const result = pairCalculationOutcomes(
      [
        calc({ type: "pre" }),
        calc({
          type: "post",
          quantity: 5,
          calculatedAt: "2026-08-15T10:00:00.000Z",
          materialCost: 60,
          materialOverhead: 0,
          laborCost: 30,
          overhead: 10,
        }),
      ],
      RANGE
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.preTvkPerUnit).toBe(18);
    expect(row.postTvkPerUnit).toBe(20);
    expect(row.deltaPerUnit).toBeCloseTo(2, 9);
    expect(row.deltaPct).toBeCloseTo(11.1, 1); // (20-18)/18
    expect(row.quantity).toBe(5);
    expect(result.summary.count).toBe(1);
  });

  it("uses the LATEST pre and post when several exist", () => {
    const result = pairCalculationOutcomes(
      [
        calc({ type: "pre", calculatedAt: "2026-08-01T10:00:00.000Z", materialCost: 999 }),
        calc({ type: "pre", calculatedAt: "2026-08-05T10:00:00.000Z" }), // latest pre: TVK 180
        calc({ type: "post", calculatedAt: "2026-08-10T10:00:00.000Z", materialCost: 999 }),
        calc({ type: "post", calculatedAt: "2026-08-20T10:00:00.000Z" }), // latest post: TVK 180
      ],
      RANGE
    );
    expect(result.rows[0]!.preTvkPerUnit).toBe(18);
    expect(result.rows[0]!.postTvkPerUnit).toBe(18);
    expect(result.rows[0]!.deltaPct).toBe(0);
  });

  it("counts unpaired MOs instead of emitting rows", () => {
    const result = pairCalculationOutcomes(
      [
        calc({ manufacturingOrderId: "mo-pre", type: "pre" }),
        calc({ manufacturingOrderId: "mo-post", type: "post" }),
      ],
      RANGE
    );
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPre: 1, onlyPost: 1, invalidQuantity: 0 });
  });

  it("scopes the unpaired counters to the range — no all-time counts under a filtered table", () => {
    const result = pairCalculationOutcomes(
      [
        calc({ manufacturingOrderId: "mo-old-pre", type: "pre", calculatedAt: "2024-05-01T10:00:00.000Z" }),
        calc({ manufacturingOrderId: "mo-old-post", type: "post", calculatedAt: "2024-05-01T10:00:00.000Z" }),
        calc({ manufacturingOrderId: "mo-new-pre", type: "pre" }), // in range
      ],
      RANGE
    );
    expect(result.notComparable).toEqual({ onlyPre: 1, onlyPost: 0, invalidQuantity: 0 });
  });

  it("null deltaPct when pre TVK is zero, excluded from the average", () => {
    const result = pairCalculationOutcomes(
      [
        calc({
          type: "pre",
          materialCost: 0,
          materialOverhead: 0,
          laborCost: 0,
          overhead: 0,
        }),
        calc({ type: "post", calculatedAt: "2026-08-15T10:00:00.000Z" }),
        calc({ manufacturingOrderId: "mo-2", orderNumber: "TO-2", type: "pre" }),
        calc({
          manufacturingOrderId: "mo-2",
          orderNumber: "TO-2",
          type: "post",
          calculatedAt: "2026-08-16T10:00:00.000Z",
          materialCost: 190,
          materialOverhead: 10,
          laborCost: 50,
          overhead: 20,
        }), // TVK 270 vs 180 → +50 %
      ],
      RANGE
    );
    expect(result.rows).toHaveLength(2);
    const zeroPre = result.rows.find((r) => r.orderNumber === "TO-1")!;
    expect(zeroPre.deltaPct).toBeNull();
    expect(result.summary.avgDeviationPct).toBe(50); // only TO-2 counts
  });

  it("excludes zero-quantity calculations and counts them", () => {
    const result = pairCalculationOutcomes(
      [
        calc({ type: "pre", quantity: 0 }),
        calc({ type: "post", calculatedAt: "2026-08-15T10:00:00.000Z" }),
      ],
      RANGE
    );
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable.invalidQuantity).toBe(1);
  });

  it("filters on the post calculation's Stockholm month and sorts newest first", () => {
    const result = pairCalculationOutcomes(
      [
        calc({ manufacturingOrderId: "mo-jul", orderNumber: "TO-JUL", type: "pre", calculatedAt: "2026-07-01T10:00:00.000Z" }),
        calc({ manufacturingOrderId: "mo-jul", orderNumber: "TO-JUL", type: "post", calculatedAt: "2026-07-20T10:00:00.000Z" }),
        calc({ manufacturingOrderId: "mo-a", orderNumber: "TO-A", type: "pre" }),
        calc({ manufacturingOrderId: "mo-a", orderNumber: "TO-A", type: "post", calculatedAt: "2026-08-12T10:00:00.000Z" }),
        calc({ manufacturingOrderId: "mo-b", orderNumber: "TO-B", type: "pre" }),
        calc({ manufacturingOrderId: "mo-b", orderNumber: "TO-B", type: "post", calculatedAt: "2026-08-25T10:00:00.000Z" }),
      ],
      RANGE
    );
    expect(result.rows.map((r) => r.orderNumber)).toEqual(["TO-B", "TO-A"]);
  });

  it("handles empty input", () => {
    const result = pairCalculationOutcomes([], RANGE);
    expect(result.rows).toEqual([]);
    expect(result.summary).toEqual({ count: 0, avgDeviationPct: null });
  });
});
