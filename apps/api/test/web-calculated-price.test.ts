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
  it("omits the price on create only when untouched and calculated", () => {
    expect(omitUnitPriceOnCreate(false, calculated)).toBe(true);
    expect(omitUnitPriceOnCreate(true, calculated)).toBe(false);
    expect(omitUnitPriceOnCreate(false, articlePrice)).toBe(false);
    expect(omitUnitPriceOnCreate(false, null)).toBe(false);
  });

  it("omits the price on edit only with a changed quantity", () => {
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: true, quote: calculated })).toBe(true);
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: false, quote: calculated })).toBe(false);
    expect(omitUnitPriceOnEdit({ priceTouched: true, quantityChanged: true, quote: calculated })).toBe(false);
    expect(omitUnitPriceOnEdit({ priceTouched: false, quantityChanged: true, quote: articlePrice })).toBe(false);
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
