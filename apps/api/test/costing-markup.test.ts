import { describe, expect, it } from "vitest";
import { applyMarkups, resolveUnitCost } from "../src/modules/costing/service/markup.js";

const DIRECT = { materialCost: 100, laborCost: 60, overhead: 6, subcontractCost: 40, semiFinishedCost: 0 };
const NO_MARKUPS = { moPercent: 0, loPercent: 0, affoPercent: 0, generalMarkupPercent: 0 };

describe("applyMarkups — påläggskalkyl", () => {
  it("applies MO on material, LO on lego, Affo on TVK and the general markup on SVK", () => {
    const costs = applyMarkups(DIRECT, { moPercent: 10, loPercent: 5, affoPercent: 12, generalMarkupPercent: 20 });

    expect(costs.materialOverhead).toBe(10); // MO: 100 * 10%
    expect(costs.subcontractOverhead).toBe(2); // LO: 40 * 5%
    // TVK: 100 + 10 + 60 + 6 + 40 + 2
    expect(costs.manufacturingCost).toBe(218);
    expect(costs.businessOverhead).toBeCloseTo(26.16, 10); // Affo: 218 * 12%
    expect(costs.selfCost).toBeCloseTo(244.16, 10); // SVK
    expect(costs.generalMarkup).toBeCloseTo(48.832, 10); // 244.16 * 20%
    expect(costs.salesPrice).toBeCloseTo(292.992, 10);
  });

  it("leaves the direct costs untouched and prices at self cost when every markup is zero", () => {
    const costs = applyMarkups(DIRECT, NO_MARKUPS);

    expect(costs.materialOverhead).toBe(0);
    expect(costs.subcontractOverhead).toBe(0);
    expect(costs.businessOverhead).toBe(0);
    expect(costs.generalMarkup).toBe(0);
    // 100 + 60 + 6 + 40 — no markup anywhere, so TVK = SVK = price
    expect(costs.manufacturingCost).toBe(206);
    expect(costs.selfCost).toBe(206);
    expect(costs.salesPrice).toBe(206);
  });

  it("takes no markup of its own on the halvfabrikat bucket, but Affo still reaches it", () => {
    // The sub-assembly's own MO/TO/LO are already inside the 300 — applying MO
    // again here would be markup on markup. Affo and the general markup are
    // meant to reach it, exactly once, which is why the sub-level hands its
    // manufacturing cost (TVK) upwards rather than its self cost.
    const costs = applyMarkups(
      { ...DIRECT, semiFinishedCost: 300 },
      { ...NO_MARKUPS, moPercent: 10, loPercent: 5, affoPercent: 10 }
    );

    expect(costs.materialOverhead).toBe(10); // still only 100 * 10%
    expect(costs.subcontractOverhead).toBe(2); // still only 40 * 5%
    // TVK: 100 + 10 + 60 + 6 + 40 + 2 + 300
    expect(costs.manufacturingCost).toBe(518);
    expect(costs.businessOverhead).toBeCloseTo(51.8, 10); // Affo DOES reach it
    expect(costs.selfCost).toBeCloseTo(569.8, 10);
  });

  it("is identical to the pre-multi-level result when there is no halvfabrikat", () => {
    // The regression that matters: a single-level run must produce exactly the
    // numbers it produced before the bucket existed.
    const costs = applyMarkups(DIRECT, { moPercent: 10, loPercent: 5, affoPercent: 12, generalMarkupPercent: 20 });
    expect(costs.manufacturingCost).toBe(218);
    expect(costs.salesPrice).toBeCloseTo(292.992, 10);
  });

  it("does not put the MO markup on lego or the LO markup on material", () => {
    const materialOnly = applyMarkups({ ...DIRECT, subcontractCost: 0 }, { ...NO_MARKUPS, moPercent: 10, loPercent: 50 });
    expect(materialOnly.materialOverhead).toBe(10);
    expect(materialOnly.subcontractOverhead).toBe(0);

    const legoOnly = applyMarkups({ ...DIRECT, materialCost: 0 }, { ...NO_MARKUPS, moPercent: 50, loPercent: 5 });
    expect(legoOnly.materialOverhead).toBe(0);
    expect(legoOnly.subcontractOverhead).toBe(2);
  });
});

describe("resolveUnitCost — material source", () => {
  it("uses the primary supplier's price when the source is supplier", () => {
    expect(resolveUnitCost({ standardCost: "10.0000", supplierPrice: "25.0000" }, "supplier")).toEqual({
      cost: 25,
      used: "supplier",
      warning: null,
    });
  });

  it("falls back to the standard cost and warns when there is no supplier price", () => {
    const result = resolveUnitCost({ standardCost: "10.0000", supplierPrice: null }, "supplier");
    expect(result.cost).toBe(10);
    // `used` records the fallback, so the saved row can be marked as estimated
    // without re-parsing the warning text.
    expect(result.used).toBe("standard");
    expect(result.warning).toBe("inget leverantörspris, använder standardpris");
  });

  it("assumes 0 and warns when neither price exists", () => {
    const result = resolveUnitCost({ standardCost: null, supplierPrice: null }, "supplier");
    expect(result.cost).toBe(0);
    expect(result.used).toBe("none");
    expect(result.warning).toBe("varken leverantörspris eller standardpris, antar 0");
  });

  it("ignores the supplier price when the source is standard", () => {
    expect(resolveUnitCost({ standardCost: "10.0000", supplierPrice: "25.0000" }, "standard")).toEqual({
      cost: 10,
      used: "standard",
      warning: null,
    });
  });

  it("assumes 0 and warns when the standard cost is missing", () => {
    const result = resolveUnitCost({ standardCost: null, supplierPrice: "25.0000" }, "standard");
    expect(result.cost).toBe(0);
    expect(result.used).toBe("none");
    expect(result.warning).toBe("saknar standardpris, antar 0");
  });

  it("treats a missing article row as 0 rather than NaN", () => {
    expect(resolveUnitCost(undefined, "supplier")).toEqual({
      cost: 0,
      used: "none",
      warning: "varken leverantörspris eller standardpris, antar 0",
    });
    expect(resolveUnitCost(undefined, "standard").cost).toBe(0);
  });
});
