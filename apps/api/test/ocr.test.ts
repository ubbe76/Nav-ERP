import { describe, expect, it } from "vitest";
import { computeOcrNumber, validateOcrNumber } from "../src/modules/system/service/ocr.js";

// Bankgiro OCR: base digits + length digit + Luhn check digit. The length
// digit is (total OCR length) mod 10, counted INCLUDING the two added digits.
describe("computeOcrNumber", () => {
  it("appends length digit and Luhn check digit to the FA number's digits", () => {
    const ocr = computeOcrNumber("FA-5001");
    expect(ocr.startsWith("5001")).toBe(true);
    expect(ocr).toHaveLength(6); // 4 base + length digit + check digit
    expect(ocr[4]).toBe("6"); // 6 tecken totalt → längdsiffra 6
  });
  it("produces a Luhn-valid number (mod 10 === 0)", () => {
    const ocr = computeOcrNumber("FA-5001");
    const sum = [...ocr].reverse().reduce((acc, ch, idx) => {
      let d = Number(ch);
      if (idx % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      return acc + d;
    }, 0);
    expect(sum % 10).toBe(0);
  });
  it("strips every non-digit from the invoice number", () => {
    expect(computeOcrNumber("FA-12045").startsWith("12045")).toBe(true);
  });
});

// The inverse check (B3): what the customer types into the reskontra's OCR
// field before it is looked up as an open item.
describe("validateOcrNumber", () => {
  it("accepts what computeOcrNumber produces, for every invoice-number length", () => {
    for (const invoiceNumber of ["FA-1", "FA-5001", "FA-12045", "FA-1234567890"]) {
      expect(validateOcrNumber(computeOcrNumber(invoiceNumber))).toBe(true);
    }
  });

  it("rejects non-digits, whitespace and the empty string", () => {
    expect(validateOcrNumber("")).toBe(false);
    expect(validateOcrNumber("abc")).toBe(false);
    expect(validateOcrNumber(" 50016 4")).toBe(false);
    expect(validateOcrNumber("5001-64")).toBe(false);
  });

  it("rejects a number that is too short to carry both control digits", () => {
    expect(validateOcrNumber("12")).toBe(false);
  });

  it("rejects a wrong length digit even when Luhn passes", () => {
    const ocr = computeOcrNumber("FA-5001"); // 500164
    // Swap the length digit for another one and repair the Luhn digit, so the
    // ONLY thing wrong is the length digit itself.
    const base = ocr.slice(0, ocr.length - 2);
    const wrongLength = String((Number(ocr[ocr.length - 2]) + 1) % 10);
    const withWrongLength = base + wrongLength;
    let sum = 0;
    for (let i = 0; i < withWrongLength.length; i++) {
      let d = Number(withWrongLength[withWrongLength.length - 1 - i]);
      if (i % 2 === 0) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    expect(validateOcrNumber(withWrongLength + String((10 - (sum % 10)) % 10))).toBe(false);
  });

  it("rejects a broken check digit", () => {
    const ocr = computeOcrNumber("FA-5001");
    const broken = ocr.slice(0, -1) + String((Number(ocr.at(-1)) + 1) % 10);
    expect(validateOcrNumber(broken)).toBe(false);
  });
});
