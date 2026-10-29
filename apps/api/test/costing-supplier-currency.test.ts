import { describe, expect, it } from "vitest";
import { toSekUnitPrice } from "@navet/shared";
import { resolveUnitCost } from "../src/modules/costing/service/markup.js";

// Pure — leverantörspris i valuta (#1). The catalog price is in the supplier
// row's currency; the calculation costs it in SEK at the rate the caller
// looked up, and a currency without a rate is never read as kronor.

describe("toSekUnitPrice", () => {
  it("converts at four decimals, not to the öre", () => {
    expect(toSekUnitPrice(2.5, 11.5)).toBe(28.75);
    // 0.0123 × 11.4523 = 0.14086329 — toSek would say 0.14.
    expect(toSekUnitPrice(0.0123, 11.4523)).toBe(0.1409);
    expect(toSekUnitPrice(100, 0.068917)).toBe(6.8917);
  });

  it("rounds half away from zero", () => {
    expect(toSekUnitPrice(0.0001, 0.5)).toBe(0.0001);
    expect(toSekUnitPrice(0, 11.5)).toBe(0);
  });
});

const basis = { standardCost: "10.0000", supplierPrice: "2.5000" };

describe("resolveUnitCost — leverantörspris i valuta", () => {
  it("leaves a SEK price as it is, with or without a currency on the basis", () => {
    expect(resolveUnitCost(basis, "supplier")).toEqual({ cost: 2.5, used: "supplier", warning: null });
    const sek = resolveUnitCost({ ...basis, supplierCurrency: "SEK", supplierExchangeRate: null }, "supplier");
    expect(sek).toEqual({ cost: 2.5, used: "supplier", warning: null });
    expect(sek.foreign).toBeUndefined();
  });

  it("converts a foreign price at the rate and reports what it came from", () => {
    expect(resolveUnitCost({ ...basis, supplierCurrency: "EUR", supplierExchangeRate: 11.5 }, "supplier")).toEqual({
      cost: 28.75,
      used: "supplier",
      warning: null,
      foreign: { currency: "EUR", unitPrice: 2.5, rate: 11.5 },
    });
  });

  it("converts the staffel step, not the grundpris, with tier tiered", () => {
    const result = resolveUnitCost(
      { ...basis, supplierPriceBreaks: [{ fromQuantity: 10, price: 2 }], supplierCurrency: "EUR", supplierExchangeRate: 11.5 },
      "supplier",
      { supplierPriceTier: "tiered", quantity: 10 }
    );
    expect(result.cost).toBe(23);
    expect(result.foreign).toEqual({ currency: "EUR", unitPrice: 2, rate: 11.5 });
  });

  it("falls back to the standard cost when the currency has no rate", () => {
    expect(resolveUnitCost({ ...basis, supplierCurrency: "EUR", supplierExchangeRate: null }, "supplier")).toEqual({
      cost: 10,
      used: "standard",
      warning: "ingen kurs för leverantörspriset i EUR, använder standardpris",
    });
  });

  it("assumes 0 and says why when there is neither a rate nor a standard cost", () => {
    expect(
      resolveUnitCost({ standardCost: null, supplierPrice: "2.5000", supplierCurrency: "EUR", supplierExchangeRate: null }, "supplier")
    ).toEqual({ cost: 0, used: "none", warning: "ingen kurs för leverantörspriset i EUR och inget standardpris, antar 0" });
  });

  it("keeps the old wording when there is no supplier price at all", () => {
    expect(resolveUnitCost({ standardCost: "10.0000", supplierPrice: null, supplierCurrency: "EUR" }, "supplier").warning).toBe(
      "inget leverantörspris, använder standardpris"
    );
  });

  it("never converts for the standard-cost and actual-cost sources", () => {
    const foreign = { ...basis, supplierCurrency: "EUR", supplierExchangeRate: 11.5 };
    expect(resolveUnitCost(foreign, "standard")).toEqual({ cost: 10, used: "standard", warning: null });
    expect(resolveUnitCost({ ...foreign, actualCost: 7 }, "actual")).toEqual({ cost: 7, used: "moving_average", warning: null });
  });
});
