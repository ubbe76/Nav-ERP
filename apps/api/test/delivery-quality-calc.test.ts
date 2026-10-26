import { describe, expect, it } from "vitest";
import {
  groupPrecisionByCounterparty,
  measuredOrderIds,
  monthRangeDates,
  type QualityDeviationInput,
} from "../src/modules/reports/service/delivery-quality-calc.js";
import type { PrecisionOrderInput } from "../src/modules/reports/service/delivery-precision-calc.js";

// Leveransprecision, Gruppera: Motpart — the pure quality calc.

const RANGE = { from: "2026-03", to: "2026-04" };
const order = (id: string, party: string, expected: string | null, completed: string | null): PrecisionOrderInput => ({
  orderId: id,
  counterpartyId: party,
  counterpartyName: party === "s1" ? "Stål AB" : "Fäste AB",
  expectedDeliveryDate: expected,
  completedAt: completed,
});
const dev = (party: string, over: Partial<QualityDeviationInput> = {}): QualityDeviationInput => ({
  counterpartyId: party,
  counterpartyName: party === "s1" ? "Stål AB" : party === "s3" ? "Ny AB" : "Fäste AB",
  articleId: "a1",
  articleNumber: "A-1",
  articleName: "Plåt",
  unitCode: "st",
  quantity: 2,
  netCost: 100,
  ...over,
});

describe("delivery-quality-calc", () => {
  const orders = [
    order("o1", "s1", "2026-03-10", "2026-03-10T08:00:00Z"), // on time
    order("o2", "s1", "2026-03-10", "2026-03-13T08:00:00Z"), // 3 days late
    order("o3", "s2", "2026-04-01", "2026-04-01T08:00:00Z"), // on time
    order("o4", "s2", null, "2026-04-02T08:00:00Z"), // not measured (no promise)
    order("o5", "s2", "2026-01-05", "2026-01-05T08:00:00Z"), // outside the range
  ];

  it("measures the same orders as the month view", () => {
    expect(measuredOrderIds(orders, RANGE)).toEqual(["o1", "o2", "o3"]);
    expect(monthRangeDates(RANGE)).toEqual({ fromDate: "2026-03-01", toDate: "2026-04-30" });
    expect(monthRangeDates({ from: "2028-02", to: "2028-02" })).toEqual({ fromDate: "2028-02-01", toDate: "2028-02-29" });
  });

  it("groups per counterparty with deviations, defect-free share, claimed quantity and cost", () => {
    const result = groupPrecisionByCounterparty(
      orders,
      RANGE,
      {
        deviations: [
          dev("s1", { quantity: 2, netCost: 150.5 }),
          dev("s1", { quantity: 3, netCost: -20 }),
          dev("s2", { articleId: "a2", articleNumber: "A-2", unitCode: "m", quantity: 1.5, netCost: 0 }),
          dev("s2", { quantity: 4 }),
          dev("s3", { quantity: null, articleId: null, articleNumber: null, articleName: null, unitCode: null }),
        ],
        ordersWithDeviation: new Set(["o2", "o5"]),
      },
      { seePrices: true }
    );
    expect(result.rows.map((r) => r.counterpartyName)).toEqual(["Fäste AB", "Ny AB", "Stål AB"]);
    const steel = result.rows.find((r) => r.counterpartyId === "s1")!;
    expect(steel).toMatchObject({
      total: 2,
      onTime: 1,
      late: 1,
      precisionPct: 50,
      avgDaysLate: 3,
      deviations: 2,
      ordersWithDeviation: 1,
      defectFreePct: 50,
      claimedQuantity: 5,
      claimedUnit: "st",
      deviationCost: 130.5,
    });
    expect(steel.claimedByArticle).toEqual([{ articleId: "a1", articleNumber: "A-1", articleName: "Plåt", unitCode: "st", quantity: 5 }]);
    // Mixed units: no total, the detail per article.
    const fasteners = result.rows.find((r) => r.counterpartyId === "s2")!;
    expect(fasteners).toMatchObject({ total: 1, deviations: 2, ordersWithDeviation: 0, defectFreePct: 100, claimedQuantity: null, claimedUnit: null });
    expect(fasteners.claimedByArticle.map((c) => [c.articleNumber, c.unitCode, c.quantity])).toEqual([
      ["A-1", "st", 4],
      ["A-2", "m", 1.5],
    ]);
    // A counterparty with cases but no measured orders still shows.
    expect(result.rows.find((r) => r.counterpartyId === "s3")).toMatchObject({ total: 0, precisionPct: null, defectFreePct: null, deviations: 1, claimedQuantity: null });
    expect(result.totals).toMatchObject({
      total: 3,
      onTime: 2,
      late: 1,
      deviations: 5,
      ordersWithDeviation: 1,
      defectFreePct: 67,
      claimedQuantity: null,
      deviationCost: 330.5,
    });
  });

  it("hides the cost without prices", () => {
    const result = groupPrecisionByCounterparty(orders, RANGE, { deviations: [dev("s1")], ordersWithDeviation: new Set() }, { seePrices: false });
    expect(result.rows.every((r) => r.deviationCost === null)).toBe(true);
    expect(result.totals.deviationCost).toBeNull();
  });
});
