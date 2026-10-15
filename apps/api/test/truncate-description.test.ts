import { describe, expect, it } from "vitest";
import { truncateDescription } from "../src/modules/economy/service/verification-poster.js";

// Pure truncation tests — no database. varchar(255) counts CODE POINTS, so
// the truncation must never split a surrogate pair (an emoji straddling the
// boundary would otherwise produce a lone surrogate that breaks encoding).

describe("truncateDescription", () => {
  it("passes short strings through untouched", () => {
    expect(truncateDescription("Hyra januari")).toBe("Hyra januari");
  });

  it("truncates to 255 code points", () => {
    const long = "x".repeat(300);
    expect(truncateDescription(long)).toHaveLength(255);
  });

  it("never splits a surrogate pair at the boundary", () => {
    // 254 ASCII chars + an emoji (2 UTF-16 units) — a naive slice(0, 255)
    // would cut the emoji in half and leave a lone high surrogate.
    const input = "a".repeat(254) + "😀" + "resten";
    const out = truncateDescription(input);
    expect(out).toBe("a".repeat(254) + "😀");
    expect(Array.from(out)).toHaveLength(255);
    expect(out).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
  });

  it("counts emoji as single code points", () => {
    const emojis = "😀".repeat(255);
    expect(Array.from(truncateDescription(emojis + "överflöd"))).toHaveLength(255);
  });
});
