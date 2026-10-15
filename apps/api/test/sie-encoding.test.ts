import { describe, expect, it } from "vitest";
import { decodeCp437, encodeCp437 } from "../src/modules/economy/service/sie-encoding.js";

// Pure codec tests — no database, must stay millisecond-fast.

describe("encodeCp437", () => {
  it("encodes ASCII unchanged", () => {
    expect([...encodeCp437("Konto 1930")]).toEqual([...Buffer.from("Konto 1930", "ascii")]);
  });

  it("encodes the Swedish letters at their CP437 code points", () => {
    // å=0x86 ä=0x84 ö=0x94 Å=0x8F Ä=0x8E Ö=0x99
    expect([...encodeCp437("åäöÅÄÖ")]).toEqual([0x86, 0x84, 0x94, 0x8f, 0x8e, 0x99]);
  });

  it("encodes other Latin-1 letters CP437 actually has", () => {
    // é=0x82 ü=0x81 è=0x8a ç=0x87 ñ=0x a4
    expect([...encodeCp437("éüèçñ")]).toEqual([0x82, 0x81, 0x8a, 0x87, 0xa4]);
  });

  it("transliterates characters CP437 lacks rather than emitting garbage", () => {
    // The en dash and the typographic quotes turn up in pasted company names.
    expect(encodeCp437("A–B").toString("ascii")).toBe("A-B");
    expect(encodeCp437("”Hej”").toString("ascii")).toBe('"Hej"');
  });

  it("keeps the Greek/maths glyphs CP437 does have", () => {
    // Ω really is in CP437 (0xEA) — it is not a fallback case.
    expect([...encodeCp437("Ω")]).toEqual([0xea]);
  });

  it("falls back to ? for anything with no glyph and no transliteration", () => {
    expect([...encodeCp437("漢")]).toEqual([0x3f]);
    expect([...encodeCp437("→")]).toEqual([0x3f]);
  });

  it("never emits a byte above 255", () => {
    const bytes = [...encodeCp437("åäöÅÄÖéü漢–")];
    for (const byte of bytes) expect(byte).toBeLessThanOrEqual(255);
  });
});

describe("decodeCp437", () => {
  it("round-trips the Swedish letters", () => {
    expect(decodeCp437(encodeCp437("Räkenskapsår 2026 Öre"))).toBe("Räkenskapsår 2026 Öre");
  });

  it("decodes a hand-built CP437 byte sequence", () => {
    expect(decodeCp437(Buffer.from([0x4b, 0x86, 0x94]))).toBe("Kåö");
  });

  it("round-trips every byte 0–255 without loss", () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    expect([...encodeCp437(decodeCp437(all))]).toEqual([...all]);
  });
});
