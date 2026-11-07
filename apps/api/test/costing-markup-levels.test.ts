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

// Kalkylpris (#16 etapp 2): the spec's example — 50 st, SVK 10 000 (TVK
// 8 000 + Affo 25 % = 2 000), B 6 000, TO 500, g₀ 40 % (4 000), m₀ 10 % ⇒
// F₀ 15 100 (302 kr/st).
const CALCULATION = {
  salesPrice: 15100,
  selfCost: 10000,
  materialMarkupBase: 6000,
  generalMarkupPercent: 40,
  materialMarkupPercent: 10,
  quantity: 50,
  generalMarkup: 4000,
  businessOverhead: 2000,
  affoPercent: 25,
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

  // The review of etapp 2: before 0130 (931f4d1) TO sat inside TVK and SVK,
  // so the stored generellt påslag and Affo were taken on TO too and
  // SVK × (g − g₀) re-prices such a calculation some kronor wrong.
  it("refuses a calculation from before 0130 when the general markup moves — and only then", () => {
    // TO 500 inside: Affo 25 % × 8 500 = 2 125, SVK then 10 625, generellt 40 % = 4 250.
    const before0130 = { ...CALCULATION, selfCost: 10125, businessOverhead: 2125, generalMarkup: 4250, salesPrice: 14875 };
    expect(calculatedUnitPrice(before0130, 20, 10)).toEqual({ unavailable: "calculation-outdated" });
    // g = g₀: SVK is not needed, the material delta is on the base alone.
    expect(calculatedUnitPrice(before0130, 40, 10)).toEqual({ unitPrice: 297.5 });
    expect(calculatedUnitPrice(before0130, 40, 0)).toEqual({ unitPrice: 285.5 }); // 14 875 − 600
    // Generellt 0 % says nothing — the Affo on TO gives it away.
    const noGeneral = { ...before0130, generalMarkupPercent: 0, generalMarkup: 0 };
    expect(calculatedUnitPrice(noGeneral, 20, 10)).toEqual({ unavailable: "calculation-outdated" });
    // Percentages never snapshotted (0) under an amount.
    expect(calculatedUnitPrice({ ...CALCULATION, generalMarkupPercent: 0 }, 20, 10)).toEqual({ unavailable: "calculation-outdated" });
  });

  it("accepts today's chain within the four-decimal rounding of the stored buckets and an Affo setting with more decimals", () => {
    // 0.004 off on the generellt påslag: rounding, not TO.
    expect(calculatedUnitPrice({ ...CALCULATION, generalMarkup: 4000.004 }, 20, 0)).toEqual({ unitPrice: 250 });
    // Affo set to 12.346 %, stored as 12.35 %: 8 000 × 12.346 % = 987.68 vs 988 — within half a hundredth of a percent.
    const affo = { ...CALCULATION, affoPercent: 12.35, businessOverhead: 987.68, selfCost: 8987.68, generalMarkup: 3595.072 };
    expect(calculatedUnitPrice(affo, 40, 10)).toEqual({ unitPrice: 302 });
    expect("unitPrice" in calculatedUnitPrice(affo, 20, 0)).toBe(true);
    // TO 500 × 25 % = 125 is far outside.
    expect(calculatedUnitPrice({ ...CALCULATION, businessOverhead: 2125, selfCost: 10125, generalMarkup: 4050 }, 20, 0)).toEqual({
      unavailable: "calculation-outdated",
    });
  });

  // The review of etapp 3: Affo set to exactly half a hundredth of a percent
  // (12.345 %, stored as 12.34 %) is off by the whole second term of the
  // tolerance, and the bucket's four-decimal rounding came on top of it —
  // a false calculation-outdated with max(0.01, …).
  it("accepts an Affo setting of exactly half a hundredth of a percent, with the bucket's rounding on top", () => {
    // TVK 7 777.7777 × 12.345 % = 960.166657… ⇒ 960.1667; × 12.34 % = 959.7778 — 0.38893 off, ½ hundredth is 0.38889.
    const tvk = 7777.7777;
    const businessOverhead = 960.1667;
    const selfCost = tvk + businessOverhead;
    const halfHundredth = {
      ...CALCULATION,
      affoPercent: 12.34,
      businessOverhead,
      selfCost,
      generalMarkup: 3495.1778, // 40 % of SVK at four decimals
      salesPrice: selfCost + 3495.1778 + 600 + 500,
    };
    expect(Math.abs(businessOverhead - (tvk * 12.34) / 100)).toBeGreaterThan((tvk * 0.005) / 100);
    expect("unitPrice" in calculatedUnitPrice(halfHundredth, 20, 10)).toBe(true);
    // Still far from a calculation with TO inside (TO 500 × 12.34 % ≈ 62).
    expect(calculatedUnitPrice({ ...halfHundredth, businessOverhead: businessOverhead + 61.7 }, 20, 10)).toEqual({
      unavailable: "calculation-outdated",
    });
  });
});
