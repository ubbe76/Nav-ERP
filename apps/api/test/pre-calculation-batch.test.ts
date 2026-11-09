import { describe, expect, it } from "vitest";
import { batchQuantity, manufacturingCostChange, perUnitFigures } from "../src/modules/costing/service/pre-calculation-batch.js";

// Förkalkylera flera (#27) — the pure rules. The DB side is
// pre-calculation-batch.db.test.ts, the routes pre-calculation-batch.route.test.ts.

const buckets = {
  materialCost: "300.0000",
  materialOverhead: "30.0000",
  laborCost: "100.0000",
  overhead: "7.0000",
  subcontractCost: "0.0000",
  subcontractOverhead: "0.0000",
  semiFinishedCost: "20.0000",
  businessOverhead: "45.0000",
  salesPrice: "600.0000",
};

describe("batchQuantity", () => {
  it("takes the latest calculation's quantity, else the fallback", () => {
    expect(batchQuantity({ quantity: "5.0000" }, 1)).toEqual({ quantity: 5, quantitySource: "latest" });
    expect(batchQuantity({ quantity: 12 }, 1)).toEqual({ quantity: 12, quantitySource: "latest" });
    expect(batchQuantity(null, 7)).toEqual({ quantity: 7, quantitySource: "fallback" });
    expect(batchQuantity(undefined, 7)).toEqual({ quantity: 7, quantitySource: "fallback" });
  });

  it("an Antal typed on the row wins over the latest calculation and the fallback", () => {
    expect(batchQuantity({ quantity: 5 }, 1, 25)).toEqual({ quantity: 25, quantitySource: "manual" });
    expect(batchQuantity(null, 7, 0.5)).toEqual({ quantity: 0.5, quantitySource: "manual" });
    // Not a quantity: falls through to the usual rule.
    expect(batchQuantity({ quantity: 5 }, 1, 0)).toEqual({ quantity: 5, quantitySource: "latest" });
    expect(batchQuantity(null, 7, Number.NaN)).toEqual({ quantity: 7, quantitySource: "fallback" });
  });

  it("treats an unusable latest quantity as none", () => {
    expect(batchQuantity({ quantity: "0.0000" }, 3)).toEqual({ quantity: 3, quantitySource: "fallback" });
    expect(batchQuantity({ quantity: -1 }, 3)).toEqual({ quantity: 3, quantitySource: "fallback" });
  });
});

describe("perUnitFigures", () => {
  it("is TVK, SVK and sales price ÷ quantity, four decimals (what the apply functions write)", () => {
    // TVK = 300 + 30 + 100 + 0 + 0 + 20 = 450 (no TO, no Affo); SVK = 495.
    expect(perUnitFigures({ ...buckets, quantity: "3.0000" })).toEqual({
      manufacturingCostPerUnit: 150,
      selfCostPerUnit: 165,
      salesPricePerUnit: 200,
    });
    // 450 / 7 = 64.285714… → 64.2857
    expect(perUnitFigures({ ...buckets, quantity: 7 })!.manufacturingCostPerUnit).toBe(64.2857);
  });

  it("is null when the quantity cannot carry a per-unit figure", () => {
    expect(perUnitFigures({ ...buckets, quantity: "0.0000" })).toBeNull();
    expect(perUnitFigures({ ...buckets, quantity: "abc" })).toBeNull();
  });
});

describe("manufacturingCostChange", () => {
  it("is the difference in kronor and in percent of the previous, two decimals", () => {
    expect(manufacturingCostChange(330, 300)).toEqual({ amount: 30, percent: 10 });
    expect(manufacturingCostChange(100, 150)).toEqual({ amount: -50, percent: -33.33 });
    expect(manufacturingCostChange(64.2857, 64.2857)).toEqual({ amount: 0, percent: 0 });
    expect(manufacturingCostChange(10.005, 10)).toEqual({ amount: 0.01, percent: 0.05 });
  });

  it("is null without a previous, with an unknown previous, and when the previous TVK/st is 0", () => {
    expect(manufacturingCostChange(100, null)).toBeNull();
    expect(manufacturingCostChange(100, undefined)).toBeNull();
    expect(manufacturingCostChange(100, 0)).toBeNull();
  });
});
