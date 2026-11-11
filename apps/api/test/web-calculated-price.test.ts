import { describe, expect, it } from "vitest";
import {
  calculatedPriceText,
  calculatedUnavailableText,
  omitUnitPriceOnCreate,
  omitUnitPriceOnEdit,
  type CalculatedQuoteLike,
} from "../../web/lib/priceQuote";

const calculated: CalculatedQuoteLike = {
  price: { source: "calculated" },
  calculated: {
    calculationId: "c1",
    calculatedAt: "2026-11-07T10:00:00Z",
    quantity: 10,
    generalMarkup: { percent: 25, level: "customer" },
    materialMarkup: { percent: 0, level: "company" },
  },
};
const articlePrice: CalculatedQuoteLike = { price: { source: "article" } };
const date = () => "2026-11-07";

describe("Kalkylpris helpers (web)", () => {
  // Prisets ursprung (0197): any chain suggestion is omitted, so the row gets
  // the chain's origin and follows the order's markups; no suggestion (none
  // fetched, a configured row, no price) is sent as typed.
  it("omits the price on create when untouched and the chain suggested it, whatever its step", () => {
    expect(omitUnitPriceOnCreate(false, calculated)).toBe(true);
    expect(omitUnitPriceOnCreate(false, articlePrice)).toBe(true);
    expect(omitUnitPriceOnCreate(true, calculated)).toBe(false);
    expect(omitUnitPriceOnCreate(true, articlePrice)).toBe(false);
    expect(omitUnitPriceOnCreate(false, { price: null })).toBe(false);
    expect(omitUnitPriceOnCreate(false, null)).toBe(false);
  });

  it("omits untouched price fields on edit — the server keeps or re-prices", () => {
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: true, quote: calculated })).toBe(true);
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: true, quote: articlePrice })).toBe(true);
    // Same quantity: the server keeps price, rabatt and origin (webbgranskningen
    // 2026-11-11 — re-sending went through the display unit and drifted).
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: false, quote: calculated })).toBe(true);
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: false, quote: null })).toBe(true);
    expect(omitUnitPriceOnEdit({ priceTouched: true, quantityChanged: true, quote: calculated })).toBe(false);
    expect(omitUnitPriceOnEdit({ priceTouched: true, quantityChanged: false, quote: null })).toBe(false);
    // A new quantity without a chain suggestion sends the shown price.
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: true, quote: null })).toBe(false);
  });

  it("texts the source with level, and the warning", () => {
    expect(calculatedPriceText(calculated, date)).toBe(
      "Kalkylpris: förkalkyl 2026-11-07, generellt påslag 25 % (kunden), materialpåslag 0 % (företaget)"
    );
    expect(calculatedPriceText({ price: { source: "calculated" } }, date)).toBe("Kalkylpris");
    expect(calculatedPriceText(articlePrice, date)).toBeNull();
    expect(calculatedUnavailableText({ price: null, calculatedPriceUnavailable: "no-calculation" })).toContain("saknar sparad förkalkyl");
    expect(calculatedUnavailableText({ price: null, calculatedPriceUnavailable: "material-base-missing" })).toContain("spara en ny förkalkyl");
    expect(calculatedUnavailableText(articlePrice)).toBeNull();
  });
});
