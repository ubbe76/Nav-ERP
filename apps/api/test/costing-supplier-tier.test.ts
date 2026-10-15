import { describe, expect, it } from "vitest";
import { resolveUnitCost } from "../src/modules/costing/service/markup.js";

// Pure — stafflade leverantörspriser in the calculation. The tier choice
// (System → Kalkyler: Grundpris / Staffelpris för kalkylantalet) only matters
// for material source "supplier"; "base" is the pre-staffel behaviour.

const basis = {
  standardCost: "10.0000",
  supplierPrice: "25.0000",
  supplierPriceBreaks: [
    { fromQuantity: 100, price: 20 },
    { fromQuantity: 10, price: 22 },
  ],
};

describe("resolveUnitCost — stafflat leverantörspris", () => {
  it("defaults to the grundpris (no tier argument = base)", () => {
    expect(resolveUnitCost(basis, "supplier")).toEqual({ cost: 25, used: "supplier", warning: null });
  });

  it("ignores the staffel with tier base whatever the quantity", () => {
    expect(resolveUnitCost(basis, "supplier", { supplierPriceTier: "base", quantity: 1000 }).cost).toBe(25);
  });

  it("uses the step for the row quantity with tier tiered", () => {
    expect(resolveUnitCost(basis, "supplier", { supplierPriceTier: "tiered", quantity: 9 }).cost).toBe(25);
    expect(resolveUnitCost(basis, "supplier", { supplierPriceTier: "tiered", quantity: 10 })).toEqual({
      cost: 22,
      used: "supplier",
      warning: null,
    });
    expect(resolveUnitCost(basis, "supplier", { supplierPriceTier: "tiered", quantity: 250 }).cost).toBe(20);
  });

  it("a step applies even when the grundpris is missing", () => {
    const result = resolveUnitCost(
      { ...basis, supplierPrice: null },
      "supplier",
      { supplierPriceTier: "tiered", quantity: 10 }
    );
    expect(result).toEqual({ cost: 22, used: "supplier", warning: null });
  });

  it("falls back to the standard cost below the lowest step when the grundpris is missing", () => {
    const result = resolveUnitCost(
      { ...basis, supplierPrice: null },
      "supplier",
      { supplierPriceTier: "tiered", quantity: 5 }
    );
    expect(result.cost).toBe(10);
    expect(result.used).toBe("standard");
    expect(result.warning).toBe("inget leverantörspris, använder standardpris");
  });

  it("never touches the standard-cost and actual-cost sources", () => {
    expect(resolveUnitCost(basis, "standard", { supplierPriceTier: "tiered", quantity: 1000 }).cost).toBe(10);
    expect(
      resolveUnitCost({ ...basis, actualCost: 7 }, "actual", { supplierPriceTier: "tiered", quantity: 1000 }).cost
    ).toBe(7);
  });
});
