import { describe, expect, it } from "vitest";
import {
  CODE128_PATTERNS,
  CODE128_START_B,
  CODE128_STOP,
  code128Symbols,
  code128TotalModules,
  encodeCode128,
} from "../src/modules/mail/service/code128.js";

// Pallkort: the hand-written Code 128 (set B) encoder. Pure — no database.

// A minimal decoder: walks the module widths back into symbols through the
// pattern table, verifies the checksum and returns the text. Independent of
// the encoder's internals (it only shares the table), so a wrong width or a
// wrong checksum weight shows up as a decode failure.
function decodeCode128(widths: number[]): string {
  const byPattern = new Map(CODE128_PATTERNS.map((p, i) => [p, i]));
  const symbols: number[] = [];
  let i = 0;
  while (i < widths.length) {
    const take = widths.length - i === 7 ? 7 : 6;
    const key = widths.slice(i, i + take).join("");
    const symbol = byPattern.get(key);
    if (symbol === undefined) throw new Error(`Unknown pattern ${key} at ${i}`);
    symbols.push(symbol);
    i += take;
  }
  expect(symbols[0]).toBe(CODE128_START_B);
  expect(symbols.at(-1)).toBe(CODE128_STOP);
  const data = symbols.slice(1, -2);
  const check = symbols.at(-2)!;
  let sum = CODE128_START_B;
  data.forEach((v, idx) => (sum += v * (idx + 1)));
  expect(check).toBe(sum % 103);
  return data.map((v) => String.fromCharCode(v + 32)).join("");
}

describe("Code 128 — pattern table", () => {
  it("has 107 distinct patterns, 11 modules wide (stop 13), each starting with a bar", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((pattern, symbol) => {
      const sum = [...pattern].reduce((acc, d) => acc + Number(d), 0);
      expect(sum, `symbol ${symbol}`).toBe(symbol === CODE128_STOP ? 13 : 11);
      expect(pattern.length).toBe(symbol === CODE128_STOP ? 7 : 6);
    });
  });
});

describe("Code 128 — symbols and checksum", () => {
  it("encodes the Wikipedia example 'Wikipedia' with check symbol 88", () => {
    expect(code128Symbols("Wikipedia")).toEqual([104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88, 106]);
  });

  it("encodes 'PJJ123C' with check symbol 55", () => {
    expect(code128Symbols("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
  });

  it("refuses the empty string and characters outside ASCII 32–126", () => {
    expect(code128Symbols("")).toBeNull();
    expect(encodeCode128("")).toBeNull();
    expect(encodeCode128("Diskbänk")).toBeNull();
    expect(encodeCode128("ÅÄÖ")).toBeNull();
    expect(encodeCode128("TO-1\n")).toBeNull();
    expect(encodeCode128("DB-1200 RF")).not.toBeNull();
  });
});

describe("Code 128 — module widths", () => {
  it("decodes back to the text for article/order numbers, with the right total width", () => {
    for (const text of ["TO-2087", "KO-1042", "DB-1200-RF", "A", " ~!", "Wikipedia", "PJJ123C"]) {
      const widths = encodeCode128(text)!;
      expect(widths[0]).toBeGreaterThan(0);
      // start + data + check (11 each) + stop (13), plus 2 × 10 quiet zone.
      expect(code128TotalModules(widths)).toBe(11 * (text.length + 2) + 13 + 20);
      expect(decodeCode128(widths)).toBe(text);
    }
  });

  it("starts and ends with a bar: an odd number of elements", () => {
    const widths = encodeCode128("TO-1")!;
    expect(widths.length % 2).toBe(1);
  });
});
