import { describe, expect, it } from "vitest";
import {
  calculatedUnitPrice,
  calculationMarkups,
  effectiveMarkups,
  hasOwnMarkups,
  orderRowMarkups,
  percentOrNull,
  roundPercent,
} from "../src/modules/costing/service/markup-levels.js";

// Påslag per nivå (#16): the one rule for the price markups — field by field,
// null inherits, 0 is explicitly 0 %, most specific level first.

const COMPANY = { generalMarkupPercent: 25, materialMarkupPercent: 10 };

describe("effectiveMarkups — påslag per nivå", () => {
  it("is the company's when no level has a value", () => {
    expect(effectiveMarkups({ company: COMPANY })).toEqual({
      generalMarkup: { percent: 25, level: "company" },
      materialMarkup: { percent: 10, level: "company" },
    });
    // Empty levels inherit just the same.
    expect(effectiveMarkups({ order: {}, customer: null, group: { generalMarkupPercent: null }, company: COMPANY })).toEqual({
      generalMarkup: { percent: 25, level: "company" },
      materialMarkup: { percent: 10, level: "company" },
    });
  });

  it("resolves each field on its own: an empty field inherits, a set one wins", () => {
    // The spec's example: varugrupp 3 has general 40 % and material empty.
    expect(effectiveMarkups({ group: { generalMarkupPercent: 40, materialMarkupPercent: null }, company: COMPANY })).toEqual({
      generalMarkup: { percent: 40, level: "group" },
      materialMarkup: { percent: 10, level: "company" },
    });
  });

  it("takes 0 as an explicit 0 %, never as empty", () => {
    expect(effectiveMarkups({ group: { generalMarkupPercent: 0, materialMarkupPercent: 0 }, company: COMPANY })).toEqual({
      generalMarkup: { percent: 0, level: "group" },
      materialMarkup: { percent: 0, level: "group" },
    });
    // A company at 0 % is a value too.
    expect(effectiveMarkups({ company: { generalMarkupPercent: 0, materialMarkupPercent: 0 } }).generalMarkup).toEqual({
      percent: 0,
      level: "company",
    });
  });

  it("orders the levels order → customer → varugrupp → company, field by field", () => {
    const group = { generalMarkupPercent: 40, materialMarkupPercent: 15 };
    const customer = { generalMarkupPercent: 20, materialMarkupPercent: null };
    const order = { generalMarkupPercent: null, materialMarkupPercent: 0 };

    // The spec's example: a row on order O for customer K.
    expect(effectiveMarkups({ order, customer, group, company: COMPANY })).toEqual({
      generalMarkup: { percent: 20, level: "customer" },
      materialMarkup: { percent: 0, level: "order" },
    });
    // Another order for K: the material falls past the customer to the group.
    expect(effectiveMarkups({ order: {}, customer, group, company: COMPANY })).toEqual({
      generalMarkup: { percent: 20, level: "customer" },
      materialMarkup: { percent: 15, level: "group" },
    });
    // The customer comes before the group even when the group's is higher.
    expect(effectiveMarkups({ customer: { generalMarkupPercent: 5 }, group, company: COMPANY }).generalMarkup).toEqual({
      percent: 5,
      level: "customer",
    });
    // The order before everything below it.
    expect(
      effectiveMarkups({ order: { generalMarkupPercent: 1 }, customer, group, company: COMPANY }).generalMarkup
    ).toEqual({ percent: 1, level: "order" });
  });

  it("puts Pröva påslag before every other level", () => {
    expect(
      effectiveMarkups({
        trial: { generalMarkupPercent: 35 },
        order: { generalMarkupPercent: 1, materialMarkupPercent: 2 },
        group: { generalMarkupPercent: 40 },
        company: COMPANY,
      })
    ).toEqual({
      generalMarkup: { percent: 35, level: "trial" },
      materialMarkup: { percent: 2, level: "order" },
    });
    // A tried value equal to the inherited one is still a trial: it was given.
    expect(effectiveMarkups({ trial: { generalMarkupPercent: 25 }, company: COMPANY }).generalMarkup.level).toBe("trial");
  });

  // The review of etapp 1: the percentages the calculation prices with are
  // the ones its header stores (numeric(6,2)), on every level.
  it("answers each percentage at the header's two decimals", () => {
    expect(effectiveMarkups({ trial: { generalMarkupPercent: 12.345 }, company: { generalMarkupPercent: 25.125, materialMarkupPercent: 7.125 } })).toEqual({
      generalMarkup: { percent: 12.35, level: "trial" },
      materialMarkup: { percent: 7.13, level: "company" },
    });
    expect(effectiveMarkups({ customer: { materialMarkupPercent: 0.004 }, company: COMPANY }).materialMarkup).toEqual({ percent: 0, level: "customer" });
    expect(roundPercent(40)).toBe(40);
    expect(roundPercent(roundPercent(12.345))).toBe(12.35);
  });
});

describe("calculationMarkups — a calculation's levels", () => {
  it("resolves trial → varugrupp → company", () => {
    expect(calculationMarkups(COMPANY, { generalMarkupPercent: 40, materialMarkupPercent: null })).toEqual({
      generalMarkup: { percent: 40, level: "group" },
      materialMarkup: { percent: 10, level: "company" },
    });
    expect(calculationMarkups(COMPANY, null, { materialMarkupPercent: 0 })).toEqual({
      generalMarkup: { percent: 25, level: "company" },
      materialMarkup: { percent: 0, level: "trial" },
    });
    expect(calculationMarkups(COMPANY, { generalMarkupPercent: 40 }, { generalMarkupPercent: 35, materialMarkupPercent: null })).toEqual({
      generalMarkup: { percent: 35, level: "trial" },
      materialMarkup: { percent: 10, level: "company" },
    });
  });

  it("reads a nullable numeric column", () => {
    expect(percentOrNull("40.00")).toBe(40);
    expect(percentOrNull("0.00")).toBe(0);
    expect(percentOrNull(null)).toBeNull();
    expect(percentOrNull(undefined)).toBeNull();
  });
});

// Kalkylpris (#16 etapp 2): the spec's example — 50 st, SVK 10 000, B 6 000,
// TO 500, g₀ 40 %, m₀ 10 % ⇒ F₀ 15 100 (302 kr/st).
const CALCULATION = {
  salesPrice: 15100,
  selfCost: 10000,
  materialMarkupBase: 6000,
  generalMarkupPercent: 40,
  materialMarkupPercent: 10,
  quantity: 50,
};

describe("orderRowMarkups and hasOwnMarkups — the row's levels", () => {
  it("resolves order → customer → varugrupp → company, typed without trial", () => {
    expect(
      orderRowMarkups({
        order: { materialMarkupPercent: 0 },
        customer: { generalMarkupPercent: 20, materialMarkupPercent: null },
        group: { generalMarkupPercent: 40, materialMarkupPercent: 15 },
        company: COMPANY,
      })
    ).toEqual({ generalMarkup: { percent: 20, level: "customer" }, materialMarkup: { percent: 0, level: "order" } });
  });

  it("says whether the customer or the order has a markup of its own — 0 counts, null and absent do not", () => {
    expect(hasOwnMarkups(null, undefined)).toBe(false);
    expect(hasOwnMarkups({ generalMarkupPercent: null, materialMarkupPercent: null }, {})).toBe(false);
    expect(hasOwnMarkups({ generalMarkupPercent: null, materialMarkupPercent: 0 })).toBe(true);
    expect(hasOwnMarkups(null, { generalMarkupPercent: 5 })).toBe(true);
  });
});

describe("calculatedUnitPrice — the Kalkylpris as a delta against the calculation", () => {
  it("is exactly Sätt försäljningspris's round4(F₀ / q) with the calculation's own percentages", () => {
    expect(calculatedUnitPrice(CALCULATION, 40, 10)).toEqual({ unitPrice: 302 });
    const odd = { ...CALCULATION, salesPrice: 1240.6414, quantity: 7 };
    expect(calculatedUnitPrice(odd, 40, 10)).toEqual({ unitPrice: Math.round((1240.6414 / 7) * 10000) / 10000 });
  });

  it("moves with the general markup on SVK and the material markup on the base (the spec's example)", () => {
    // 15 100 − 10 000 × 20 % − 6 000 × 10 % = 12 500 ⇒ 250.
    expect(calculatedUnitPrice(CALCULATION, 20, 0)).toEqual({ unitPrice: 250 });
    // Only the material: 15 100 + 6 000 × 5 % = 15 400 ⇒ 308.
    expect(calculatedUnitPrice(CALCULATION, 40, 15)).toEqual({ unitPrice: 308 });
  });

  it("needs the base only when the material markup moves", () => {
    const noBase = { ...CALCULATION, materialMarkupBase: null };
    expect(calculatedUnitPrice(noBase, 20, 0)).toEqual({ unavailable: "material-base-missing" });
    expect(calculatedUnitPrice(noBase, 20, 10)).toEqual({ unitPrice: 262 }); // 15 100 − 2 000
  });

  it("is unavailable on a calculation without a usable quantity", () => {
    expect(calculatedUnitPrice({ ...CALCULATION, quantity: 0 }, 20, 0)).toEqual({ unavailable: "no-calculation" });
    expect(calculatedUnitPrice({ ...CALCULATION, quantity: -1 }, 20, 0)).toEqual({ unavailable: "no-calculation" });
  });
});
