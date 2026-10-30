import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import { resolveCountScan, type CountScanMatch } from "../../web/lib/countScan.js";

// Skanning vid inventering (#4, etapp 4): what a scanned code means on
// Lager → Inventering.

const here: CountScanMatch = { kind: "location", id: "lp-a" };
const there: CountScanMatch = { kind: "location", id: "lp-b" };
const screw: CountScanMatch = { kind: "article", id: "screw" };
const bolt: CountScanMatch = { kind: "article", id: "bolt" };
const ko: CountScanMatch = { kind: "salesOrder", id: "ko" };
const count = { locationId: "lp-a", open: true, rows: [{ id: "r1", articleId: "screw" }] };

describe("resolveCountScan", () => {
  it("tells the count's own place from another one, before any article", () => {
    expect(resolveCountScan([screw, here], count)).toEqual({ kind: "thisLocation", match: here });
    expect(resolveCountScan([there], count)).toEqual({ kind: "otherLocation", match: there });
    // On the list there is no count: every place is another one.
    expect(resolveCountScan([here], null)).toEqual({ kind: "otherLocation", match: here });
  });

  it("marks an article's row, prefers an article that has one, and adds the rest", () => {
    expect(resolveCountScan([screw], count)).toEqual({ kind: "row", match: screw, rowId: "r1" });
    expect(resolveCountScan([bolt, screw], count)).toEqual({ kind: "row", match: screw, rowId: "r1" });
    expect(resolveCountScan([bolt], count)).toEqual({ kind: "addArticle", match: bolt });
  });

  it("counts nothing on a closed count or before one is open", () => {
    expect(resolveCountScan([screw], { ...count, open: false })).toEqual({ kind: "articleNotCounting", match: screw });
    expect(resolveCountScan([screw], null)).toEqual({ kind: "articleNotCounting", match: screw });
  });

  it("names an order and an unknown code", () => {
    expect(resolveCountScan([ko], count)).toEqual({ kind: "order", match: ko });
    expect(resolveCountScan([], count)).toEqual({ kind: "unknown" });
  });
});
