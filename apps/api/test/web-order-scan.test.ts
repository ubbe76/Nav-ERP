import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import {
  countScan,
  enteredQuantity,
  hasCounted,
  isScannableRow,
  leftToCount,
  resolveOrderScan,
  type OrderCountState,
  type OrderScanMatch,
  type OrderScanRow,
} from "../../web/lib/orderScan.js";

// Skanning mot en order (#4): what a scan means in Inleverans (etapp 2) and
// Utleverans (etapp 3), and how an article scan counts.

const rows: OrderScanRow[] = [
  { id: "r1", articleId: "screw", remaining: 2, scannable: true },
  { id: "r2", articleId: "nut", remaining: 10, scannable: true },
  { id: "r3", articleId: "screw", remaining: 3, scannable: true },
  { id: "r4", articleId: "setup", remaining: 1, scannable: false },
];
const fresh: OrderCountState = { counting: false, quantities: {} };
const order = { openRows: rows, articleIds: ["screw", "nut", "setup", "washer"] };

describe("resolveOrderScan", () => {
  const location: OrderScanMatch = { kind: "location", id: "lp" };
  const screw: OrderScanMatch = { kind: "article", id: "screw" };
  const setup: OrderScanMatch = { kind: "article", id: "setup" };
  const washer: OrderScanMatch = { kind: "article", id: "washer" };
  const bolt: OrderScanMatch = { kind: "article", id: "bolt" };
  const io: OrderScanMatch = { kind: "purchaseOrder", id: "io" };
  const ko: OrderScanMatch = { kind: "salesOrder", id: "ko" };
  const to: OrderScanMatch = { kind: "manufacturingOrder", id: "to" };

  it("prefers a lagerplats, then an article it can count, then its own kind of order", () => {
    expect(resolveOrderScan([screw, location], "purchaseOrder", order).kind).toBe("location");
    expect(resolveOrderScan([io, screw], "purchaseOrder", order)).toEqual({ kind: "count", match: screw });
    // Same code, no order chosen: the order wins.
    expect(resolveOrderScan([io, screw], "purchaseOrder", null)).toEqual({ kind: "order", match: io });
    // An article the order cannot take does not hide an order of the same number.
    expect(resolveOrderScan([bolt, ko], "salesOrder", order)).toEqual({ kind: "order", match: ko });
  });

  it("names the other kinds of order as the wrong kind for each routine", () => {
    expect(resolveOrderScan([ko], "purchaseOrder", order)).toEqual({ kind: "wrongKind", match: ko });
    expect(resolveOrderScan([io], "salesOrder", order)).toEqual({ kind: "wrongKind", match: io });
    expect(resolveOrderScan([to], "salesOrder", null)).toEqual({ kind: "wrongKind", match: to });
    expect(resolveOrderScan([], "salesOrder", order)).toEqual({ kind: "unknown" });
  });

  it("explains an article it cannot count", () => {
    expect(resolveOrderScan([setup], "salesOrder", order)).toEqual({ kind: "articleManual", match: setup });
    expect(resolveOrderScan([washer], "salesOrder", order)).toEqual({ kind: "articleDone", match: washer });
    expect(resolveOrderScan([bolt], "salesOrder", order)).toEqual({ kind: "articleNotOnOrder", match: bolt });
    expect(resolveOrderScan([screw], "salesOrder", null)).toEqual({ kind: "articleWithoutOrder", match: screw });
  });
});

describe("isScannableRow", () => {
  it("leaves tjänster and ställkostnadsrader out", () => {
    expect(isScannableRow({ articleType: "purchased", setupForRowId: null })).toBe(true);
    expect(isScannableRow({ articleType: "manufactured" })).toBe(true);
    expect(isScannableRow({ articleType: "service", setupForRowId: null })).toBe(false);
    expect(isScannableRow({ articleType: "purchased", setupForRowId: "r1" })).toBe(false);
  });
});

describe("countScan", () => {
  it("prefills the remaining amount until the first scan, then counts from zero — except rows it does not count", () => {
    expect(rows.map((r) => enteredQuantity(r, fresh))).toEqual(["2", "10", "3", "1"]);
    const first = countScan(rows, fresh, "nut", { capped: false });
    if (!first.counted) throw new Error("not counted");
    expect(first.rowId).toBe("r2");
    expect(rows.map((r) => enteredQuantity(r, first.state))).toEqual(["0", "1", "0", "1"]);
    expect(hasCounted(fresh)).toBe(false);
    expect(hasCounted(first.state)).toBe(true);
    expect(rows.map((r) => leftToCount(r, first.state))).toEqual([2, 9, 3, null]);
  });

  it("keeps a typed quantity when counting starts", () => {
    const next = countScan(rows, { counting: false, quantities: { r2: "4" } }, "screw", { capped: false });
    if (!next.counted) throw new Error("not counted");
    expect(rows.map((r) => enteredQuantity(r, next.state))).toEqual(["1", "4", "0", "1"]);
  });

  it("fills the article's rows in order; uncapped flags what goes over", () => {
    let state = fresh;
    const hits: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = countScan(rows, state, "screw", { capped: false });
      if (!next.counted) throw new Error("not counted");
      hits.push(`${next.rowId}:${next.quantity}${next.over ? "!" : ""}`);
      state = next.state;
    }
    expect(hits).toEqual(["r1:1", "r1:2", "r3:1", "r3:2", "r3:3", "r1:3!"]);
  });

  it("capped refuses an överplock and fills a fractional remainder", () => {
    const full: OrderCountState = { counting: true, quantities: { r1: "2", r3: "3" } };
    expect(countScan(rows, full, "screw", { capped: true })).toEqual({
      counted: false,
      full: true,
      rowId: "r1",
      quantity: 2,
      remaining: 2,
    });
    expect(rows.map((r) => leftToCount(r, full))).toEqual([0, 10, 0, null]);
    const fraction: OrderScanRow[] = [{ id: "k", articleId: "plate", remaining: 2.5, scannable: true }];
    const next = countScan(fraction, { counting: true, quantities: { k: "2" } }, "plate", { capped: true });
    expect(next.counted && [next.quantity, next.over]).toEqual([2.5, false]);
  });

  it("does not count an article without a scannable row", () => {
    expect(countScan(rows, fresh, "bolt", { capped: false })).toEqual({ counted: false });
    expect(countScan(rows, fresh, "setup", { capped: true })).toEqual({ counted: false });
  });
});
