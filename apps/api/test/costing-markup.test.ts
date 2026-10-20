import { describe, expect, it } from "vitest";
import { applyMarkups, resolveUnitCost } from "../src/modules/costing/service/markup.js";

const DIRECT = { materialCost: 100, laborCost: 60, overhead: 6, subcontractCost: 40, semiFinishedCost: 0, liftedMaterialMarkup: 0 };
const NO_MARKUPS = { moPercent: 0, loPercent: 0, affoPercent: 0, generalMarkupPercent: 0, materialMarkupPercent: 0 };

describe("applyMarkups — påläggskalkyl", () => {
  it("applies MO on material, LO on lego, Affo on TVK, the general markup on SVK and TO last", () => {
    const costs = applyMarkups(DIRECT, { ...NO_MARKUPS, moPercent: 10, loPercent: 5, affoPercent: 12, generalMarkupPercent: 20 });

    expect(costs.materialOverhead).toBe(10); // MO: 100 * 10%
    expect(costs.subcontractOverhead).toBe(2); // LO: 40 * 5%
    // TVK: 100 + 10 + 60 + 40 + 2 — TO (6) is NOT in it
    expect(costs.manufacturingCost).toBe(212);
    expect(costs.businessOverhead).toBeCloseTo(25.44, 10); // Affo: 212 * 12%
    expect(costs.selfCost).toBeCloseTo(237.44, 10); // SVK
    expect(costs.generalMarkup).toBeCloseTo(47.488, 10); // 237.44 * 20%
    // SVK + generellt påslag + TO
    expect(costs.salesPrice).toBeCloseTo(237.44 + 47.488 + 6, 10);
  });

  it("adds TO to the sales price after the general markup, with no Affo or profit on it", () => {
    const withTo = applyMarkups(DIRECT, { ...NO_MARKUPS, affoPercent: 50, generalMarkupPercent: 100 });
    const withoutTo = applyMarkups({ ...DIRECT, overhead: 0 }, { ...NO_MARKUPS, affoPercent: 50, generalMarkupPercent: 100 });

    // Every figure up to and including the general markup is blind to TO …
    expect(withTo.manufacturingCost).toBe(withoutTo.manufacturingCost);
    expect(withTo.businessOverhead).toBe(withoutTo.businessOverhead);
    expect(withTo.selfCost).toBe(withoutTo.selfCost);
    expect(withTo.generalMarkup).toBe(withoutTo.generalMarkup);
    // … and the price differs by exactly the TO amount, not by TO × 1.5 × 2.
    expect(withTo.salesPrice - withoutTo.salesPrice).toBe(6);
    expect(withTo.overhead).toBe(6);
  });

  it("leaves the direct costs untouched and prices at self cost when every markup is zero", () => {
    const costs = applyMarkups(DIRECT, NO_MARKUPS);

    expect(costs.materialOverhead).toBe(0);
    expect(costs.subcontractOverhead).toBe(0);
    expect(costs.businessOverhead).toBe(0);
    expect(costs.generalMarkup).toBe(0);
    // 100 + 60 + 40 — no markup anywhere, so TVK = SVK; the price is SVK + TO
    expect(costs.manufacturingCost).toBe(200);
    expect(costs.selfCost).toBe(200);
    expect(costs.salesPrice).toBe(206);
  });

  it("takes no markup of its own on the halvfabrikat bucket, but Affo still reaches it", () => {
    // The sub-assembly's own MO/LO are already inside the 300 — applying MO
    // again here would be markup on markup. (Its TO is not in the 300: TO
    // travels up separately, into `overhead`, see sub-assembly.ts.) Affo and the general markup are
    // meant to reach it, exactly once, which is why the sub-level hands its
    // manufacturing cost (TVK) upwards rather than its self cost.
    const costs = applyMarkups(
      { ...DIRECT, semiFinishedCost: 300 },
      { ...NO_MARKUPS, moPercent: 10, loPercent: 5, affoPercent: 10 }
    );

    expect(costs.materialOverhead).toBe(10); // still only 100 * 10%
    expect(costs.subcontractOverhead).toBe(2); // still only 40 * 5%
    // TVK: 100 + 10 + 60 + 40 + 2 + 300
    expect(costs.manufacturingCost).toBe(512);
    expect(costs.businessOverhead).toBeCloseTo(51.2, 10); // Affo DOES reach it
    expect(costs.selfCost).toBeCloseTo(563.2, 10);
  });

  it("is identical to the pre-multi-level result when there is no halvfabrikat", () => {
    // The regression that matters: a single-level run must produce exactly the
    // numbers it produced before the bucket existed.
    const costs = applyMarkups(DIRECT, { ...NO_MARKUPS, moPercent: 10, loPercent: 5, affoPercent: 12, generalMarkupPercent: 20 });
    expect(costs.manufacturingCost).toBe(212);
    expect(costs.salesPrice).toBeCloseTo(290.928, 10);
  });

  it("puts the materialpåslag on dM + MO, outside TVK/SVK and beside the general markup", () => {
    const markups = { moPercent: 10, loPercent: 5, affoPercent: 12, generalMarkupPercent: 20 };
    const withMaterial = applyMarkups(DIRECT, { ...markups, materialMarkupPercent: 30 });
    const without = applyMarkups(DIRECT, { ...markups, materialMarkupPercent: 0 });

    // 30 % of dM 100 + MO 10 — not of labor, lego or LO
    expect(withMaterial.materialMarkup).toBeCloseTo(33, 10);
    // The self cost and the general markup are blind to it — no stacking …
    expect(withMaterial.manufacturingCost).toBe(without.manufacturingCost);
    expect(withMaterial.selfCost).toBe(without.selfCost);
    expect(withMaterial.generalMarkup).toBe(without.generalMarkup);
    // … and the price differs by exactly the markup.
    expect(withMaterial.salesPrice - without.salesPrice).toBeCloseTo(33, 10);
    expect(without.materialMarkup).toBe(0);
  });

  it("adds the sub-assemblies' lifted materialpåslag without marking up the halvfabrikat's TVK", () => {
    const costs = applyMarkups(
      { ...DIRECT, semiFinishedCost: 300, liftedMaterialMarkup: 12 },
      { ...NO_MARKUPS, materialMarkupPercent: 10 }
    );
    // 10 % of dM 100 (no MO) + 12 lifted — the 300 gets nothing here
    expect(costs.materialMarkup).toBeCloseTo(22, 10);
    expect(costs.salesPrice).toBeCloseTo(100 + 60 + 40 + 300 + 22 + 6, 10);
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
