import { describe, expect, it } from "vitest";
import {
  articleBarcodeSchema,
  formatLocationLabelCode,
  gtinCheckDigit,
  isValidGtin,
  normalizeScanCode,
  parseLocationLabelCode,
} from "@navet/shared";

// Pure — skanning (#4): the cleaned scan, the GTIN rule and the lagerplats
// label code.

describe("normalizeScanCode", () => {
  it("drops the scanner's Enter, tabs and the GS1 group separator", () => {
    expect(normalizeScanCode(" 7350000000016\r\n")).toBe("7350000000016");
    expect(normalizeScanCode("\x1d0107350000000016\t")).toBe("0107350000000016");
  });
});

describe("GTIN", () => {
  it("computes the mod-10 check digit", () => {
    expect(gtinCheckDigit("735000000001")).toBe(6);
    expect(gtinCheckDigit("9638507")).toBe(4);
  });

  it("accepts EAN-8, UPC-A, EAN-13 and GTIN-14 with a valid check digit", () => {
    for (const code of ["96385074", "036000291452", "7350000000016", "17350000000013"]) expect(isValidGtin(code)).toBe(true);
  });

  it("refuses a wrong check digit, other lengths and non-digits", () => {
    for (const code of ["7350000000017", "1234567", "73500000000161", "735000000001A", ""]) expect(isValidGtin(code)).toBe(false);
  });

  it("parses the article field: empty clears, junk is refused", () => {
    expect(articleBarcodeSchema.parse(" 7350000000016 ")).toBe("7350000000016");
    expect(articleBarcodeSchema.parse("")).toBeNull();
    expect(articleBarcodeSchema.safeParse("7350000000017").success).toBe(false);
  });
});

describe("lagerplatsens etikettkod", () => {
  it("is LP and at least four digits, read back case-insensitively", () => {
    expect(formatLocationLabelCode(42)).toBe("LP0042");
    expect(formatLocationLabelCode(123456)).toBe("LP123456");
    expect(parseLocationLabelCode("LP0042")).toBe(42);
    expect(parseLocationLabelCode("lp0042")).toBe(42);
    expect(parseLocationLabelCode("LP42")).toBeNull();
    expect(parseLocationLabelCode("A1-03")).toBeNull();
  });
});
