import { describe, expect, it } from "vitest";
import { DEFAULT_UNIT_CODE, isKnownUnit, unitCodeFor } from "../src/modules/einvoice/service/ubl/unit-codes.js";
import { isSupportedVatRate, VAT_EXEMPTION_REASON, vatCategoryFor } from "../src/modules/einvoice/service/ubl/vat-categories.js";

describe("unit-codes", () => {
  it("maps the seeded and common Nav units to UN/ECE Rec 20/21 codes", () => {
    expect(unitCodeFor("st")).toBe("C62");
    expect(unitCodeFor("kg")).toBe("KGM");
    expect(unitCodeFor("g")).toBe("GRM");
    expect(unitCodeFor("m")).toBe("MTR");
    expect(unitCodeFor("m2")).toBe("MTK");
    expect(unitCodeFor("m²")).toBe("MTK");
    expect(unitCodeFor("m3")).toBe("MTQ");
    expect(unitCodeFor("l")).toBe("LTR");
    expect(unitCodeFor("tim")).toBe("HUR");
    expect(unitCodeFor("h")).toBe("HUR");
    expect(unitCodeFor("förp")).toBe("XPK");
    expect(unitCodeFor("krt")).toBe("XCT");
    expect(unitCodeFor("pall")).toBe("XPX");
    expect(unitCodeFor("par")).toBe("PR");
    expect(unitCodeFor("mm")).toBe("MMT");
  });

  it("is case-insensitive and trims", () => {
    expect(unitCodeFor("ST")).toBe("C62");
    expect(unitCodeFor(" Kg ")).toBe("KGM");
    expect(unitCodeFor("TIM")).toBe("HUR");
  });

  it("falls back to C62 for unknown, empty or missing units", () => {
    expect(unitCodeFor("hink")).toBe(DEFAULT_UNIT_CODE);
    expect(unitCodeFor("")).toBe("C62");
    expect(unitCodeFor(null)).toBe("C62");
    expect(unitCodeFor(undefined)).toBe("C62");
    expect(isKnownUnit("hink")).toBe(false);
    expect(isKnownUnit("st")).toBe(true);
    expect(isKnownUnit(null)).toBe(false);
  });
});

describe("vat-categories", () => {
  it("25/12/6 ⇒ S, 0 ⇒ E with the Swedish exemption reason", () => {
    expect(vatCategoryFor(25)).toEqual({ id: "S", percent: 25 });
    expect(vatCategoryFor(12)).toEqual({ id: "S", percent: 12 });
    expect(vatCategoryFor(6)).toEqual({ id: "S", percent: 6 });
    expect(vatCategoryFor(0)).toEqual({ id: "E", percent: 0, exemptionReason: VAT_EXEMPTION_REASON });
    expect(VAT_EXEMPTION_REASON).toBe("Undantagen från mervärdesskatt");
  });

  it("refuses any other rate (ubl-check reports it first)", () => {
    expect(isSupportedVatRate(19)).toBe(false);
    expect(isSupportedVatRate(6)).toBe(true);
    expect(() => vatCategoryFor(19)).toThrow(/Unsupported VAT rate 19/);
  });
});
