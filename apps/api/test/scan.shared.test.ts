import { describe, expect, it } from "vitest";
import {
  articleBarcodeSchema,
  formatLocationLabelCode,
  gtinCheckDigit,
  isValidGtin,
  normalizeScanCode,
  parseGs1,
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

// GS1 (#8 etapp 2 steg 6): the one reader of a GS1 element string.
describe("parseGs1", () => {
  const GS = "\x1d";
  const GTIN = "07350000000016";
  const today = { today: "2026-11-13" };
  const none = { gtin: null, batch: null, serial: null, expiresOn: null, quantity: null, unparsed: null };

  it("reads the form with parentheses", () => {
    expect(parseGs1(`(01)${GTIN}(10)ABC-12(17)270301(21)SN/0042`, today)).toEqual({
      ...none,
      gtin: GTIN,
      batch: "ABC-12",
      serial: "SN/0042",
      expiresOn: "2027-03-01",
    });
    // No GTIN: the parentheses already say it is GS1.
    expect(parseGs1("(21)12345", today)).toEqual({ ...none, serial: "12345" });
    expect(parseGs1("(10)L1(30)24", today)).toEqual({ ...none, batch: "L1", quantity: 24 });
  });

  it("reads the element string with the group separator after a variable field", () => {
    const expected = { ...none, gtin: GTIN, batch: "ABC", serial: "123", expiresOn: "2027-03-01" };
    expect(parseGs1(`01${GTIN}10ABC${GS}17270301` + "21123", today)).toEqual(expected);
    // Fixed fields first, no separator needed at all; a separator after a
    // fixed field and a trailing one are allowed.
    expect(parseGs1(`01${GTIN}17270301` + `10ABC${GS}21123`, today)).toEqual(expected);
    expect(parseGs1(`01${GTIN}${GS}17270301${GS}10ABC${GS}21123${GS}\r\n`, today)).toEqual(expected);
  });

  it("takes the scanners' prefixes and a leading FNC1", () => {
    const expected = { ...none, gtin: GTIN, serial: "A1" };
    for (const prefix of ["]C1", "]d2", "]Q3", "]e0", GS]) expect(parseGs1(`${prefix}01${GTIN}21A1`, today)).toEqual(expected);
    // Marked as GS1: a lone GTIN, or no GTIN at all, is an answer.
    expect(parseGs1(`]C101${GTIN}`, today)).toEqual({ ...none, gtin: GTIN });
    expect(parseGs1(`${GS}01${GTIN}\t`, today)).toEqual({ ...none, gtin: GTIN });
    expect(parseGs1("]d210LOT7", today)).toEqual({ ...none, batch: "LOT7" });
  });

  it("reads a variable field to the end when no separator follows", () => {
    expect(parseGs1(`01${GTIN}10ABC`, today)).toEqual({ ...none, gtin: GTIN, batch: "ABC" });
    expect(parseGs1(`01${GTIN}21${"9".repeat(20)}`, today)).toEqual({ ...none, gtin: GTIN, serial: "9".repeat(20) });
    // Documented as it is: a scanner that drops the separator makes two
    // variable fields one — the reader cannot guess where the batch ends.
    expect(parseGs1(`01${GTIN}10ABC21123`, today)).toEqual({ ...none, gtin: GTIN, batch: "ABC21123" });
    // …and when the merged field is longer than a batch may be: nothing.
    expect(parseGs1(`01${GTIN}10${"A".repeat(15)}21${"1".repeat(10)}`, today)).toBeNull();
  });

  it("reads utgångsdatum: day 00 is the month's last day, bäst före stands in, the century is the nearest", () => {
    const expiry = (field: string, on = today) => parseGs1(`01${GTIN}${field}`, on)?.expiresOn;
    expect(expiry("17270200")).toBe("2027-02-28");
    expect(expiry("17280200")).toBe("2028-02-29");
    expect(expiry("17261200")).toBe("2026-12-31");
    expect(expiry("15270630")).toBe("2027-06-30");
    // AI 17 wins over AI 15.
    expect(expiry("1527063017270815")).toBe("2027-08-15");
    // 51–99 years ahead = last century; 50 ahead still this one.
    expect(expiry("17760101")).toBe("2076-01-01");
    expect(expiry("17770101")).toBe("1977-01-01");
    expect(expiry("17010101", { today: "2099-06-01" })).toBe("2101-01-01");
    // Produktionsdatum (11) is read past, not taken as the expiry.
    expect(parseGs1(`01${GTIN}11260101` + "10L1", today)).toEqual({ ...none, gtin: GTIN, batch: "L1" });
  });

  it("reads antal (30, else 37) and passes other known fields", () => {
    expect(parseGs1(`01${GTIN}3012${GS}10L1`, today)).toEqual({ ...none, gtin: GTIN, batch: "L1", quantity: 12 });
    expect(parseGs1(`(02)${GTIN}(37)48(10)L1`, today)).toEqual({ ...none, gtin: GTIN, batch: "L1", quantity: 48 });
    expect(parseGs1(`01${GTIN}3103001250` + "10L1", today)).toEqual({ ...none, gtin: GTIN, batch: "L1" });
    expect(parseGs1(`(00)${"1".repeat(18)}(240)ART-1(10)L1`, today)).toEqual({ ...none, batch: "L1" });
  });

  it("stops at an identifier it does not know and hands the rest back", () => {
    expect(parseGs1(`01${GTIN}10ABC${GS}99XYZ`, today)).toEqual({ ...none, gtin: GTIN, batch: "ABC", unparsed: "99XYZ" });
    expect(parseGs1(`(01)${GTIN}(21)S1(99)XYZ`, today)).toEqual({ ...none, gtin: GTIN, serial: "S1", unparsed: "(99)XYZ" });
    // Nothing read before it: no answer.
    expect(parseGs1("]C199XYZ", today)).toBeNull();
    expect(parseGs1(`01${GTIN}99XYZ`, today)).toBeNull();
  });

  it("never answers by halves: a field that does not hold makes the whole code nothing", () => {
    for (const code of [
      `(01)07350000000017(10)ABC`, // wrong check digit
      `]C10107350000000017`,
      `(01)${GTIN}(17)271301`, // month 13
      `(01)${GTIN}(17)270230`, // 30 February
      `(01)${GTIN}(17)2703`, // too short
      `01${GTIN}172703`,
      `(01)${GTIN}(10)`, // empty batch
      `01${GTIN}10${GS}21123`,
      `(01)${GTIN}(10)${"A".repeat(21)}`, // too long
      `(01)${GTIN}(10)A B`, // a space is not in GS1's character set
      `(01)${GTIN}(10)A(10)B`, // the same identifier twice
      `(01)${GTIN}(30)1X`, // antal is digits
      `(01)${GTIN}(10)ABC(`, // trailing junk
      `(01)735000000001(10)ABC`, // a GTIN is 14 digits here
    ]) {
      expect(parseGs1(code, today), code).toBeNull();
    }
  });

  it("does not take an ordinary code for GS1", () => {
    for (const code of [
      "",
      "7350000000016",
      "PL-1",
      "LP0042",
      "IO-1001",
      `01${GTIN}`, // 16 digits that could be anything: a GTIN alone is not enough unmarked
      "0112345678901234ABC", // starts with 01 but the 14 digits are no GTIN
      "010203",
      "10ABC", // no GTIN and nothing that marks it
    ]) {
      expect(parseGs1(code, today), code).toBeNull();
    }
  });
});
