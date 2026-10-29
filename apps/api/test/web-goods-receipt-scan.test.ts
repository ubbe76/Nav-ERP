import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import {
  countScan,
  enteredQuantity,
  hasCounted,
  resolveReceiptScan,
  type ReceiptCountState,
  type ReceiptScanMatch,
  type ReceiptScanRow,
} from "../../web/lib/goodsReceiptScan.js";

// Inleverans med skanning (#4, etapp 2): what a scan means on the receipt and
// how an article scan counts.

const rows: ReceiptScanRow[] = [
  { id: "r1", articleId: "screw", remaining: 2 },
  { id: "r2", articleId: "nut", remaining: 10 },
  { id: "r3", articleId: "screw", remaining: 3 },
];
const fresh: ReceiptCountState = { counting: false, quantities: {} };
const order = { openRows: rows, articleIds: ["screw", "nut", "washer"] };

describe("resolveReceiptScan", () => {
  const location: ReceiptScanMatch = { kind: "location", id: "lp" };
  const screw: ReceiptScanMatch = { kind: "article", id: "screw" };
  const washer: ReceiptScanMatch = { kind: "article", id: "washer" };
  const bolt: ReceiptScanMatch = { kind: "article", id: "bolt" };
  const po: ReceiptScanMatch = { kind: "purchaseOrder", id: "io" };
  const ko: ReceiptScanMatch = { kind: "salesOrder", id: "ko" };

  it("prefers a lagerplats, then an article it can count, then the inköpsorder", () => {
    expect(resolveReceiptScan([screw, location], order).kind).toBe("location");
    expect(resolveReceiptScan([po, screw], order)).toEqual({ kind: "count", match: screw });
    // Same code, no order chosen: the order wins over looking the article up.
    expect(resolveReceiptScan([po, screw], null)).toEqual({ kind: "order", match: po });
    // An article the order cannot take does not hide an order of the same number.
    expect(resolveReceiptScan([bolt, po], order)).toEqual({ kind: "order", match: po });
  });

  it("explains an article it cannot count", () => {
    expect(resolveReceiptScan([washer], order)).toEqual({ kind: "articleReceived", match: washer });
    expect(resolveReceiptScan([bolt], order)).toEqual({ kind: "articleNotOnOrder", match: bolt });
    expect(resolveReceiptScan([screw], null)).toEqual({ kind: "findOrders", match: screw });
  });

  it("names a sales or manufacturing order as the wrong kind, and nothing as unknown", () => {
    expect(resolveReceiptScan([ko], order)).toEqual({ kind: "wrongKind", match: ko });
    expect(resolveReceiptScan([], order)).toEqual({ kind: "unknown" });
  });
});

describe("countScan", () => {
  it("prefills the remaining amount until the first scan, then counts from zero", () => {
    expect(rows.map((r) => enteredQuantity(r, fresh))).toEqual(["2", "10", "3"]);
    const first = countScan(rows, fresh, "nut");
    if (!first.counted) throw new Error("not counted");
    expect(first.rowId).toBe("r2");
    expect(rows.map((r) => enteredQuantity(r, first.state))).toEqual(["0", "1", "0"]);
    expect(hasCounted(fresh)).toBe(false);
    expect(hasCounted(first.state)).toBe(true);
  });

  it("keeps a typed quantity when counting starts", () => {
    const typed = { counting: false, quantities: { r2: "4" } };
    const next = countScan(rows, typed, "screw");
    if (!next.counted) throw new Error("not counted");
    expect(rows.map((r) => enteredQuantity(r, next.state))).toEqual(["1", "4", "0"]);
  });

  it("fills the article's rows in order and flags what goes over", () => {
    let state = fresh;
    const hits: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = countScan(rows, state, "screw");
      if (!next.counted) throw new Error("not counted");
      hits.push(`${next.rowId}:${next.quantity}${next.over ? "!" : ""}`);
      state = next.state;
    }
    expect(hits).toEqual(["r1:1", "r1:2", "r3:1", "r3:2", "r3:3", "r1:3!"]);
  });

  it("does not count an article without a row, and adds to a typed fraction", () => {
    expect(countScan(rows, fresh, "bolt")).toEqual({ counted: false });
    const next = countScan(rows, { counting: true, quantities: { r2: "0.5" } }, "nut");
    expect(next.counted && next.quantity).toBe(1.5);
  });
});
