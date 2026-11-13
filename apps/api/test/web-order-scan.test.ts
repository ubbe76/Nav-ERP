import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import {
  countScan,
  enteredQuantity,
  hasCounted,
  isScannableRow,
  leftToCount,
  matchBatchScan,
  matchSerialScan,
  placeBatchScan,
  purchaseScanDate,
  receiptScanFields,
  serialScanDuplicate,
  serialScanRow,
  salesScanDate,
  resolveOrderScan,
  type OrderCountState,
  type OrderScanMatch,
  type OrderScanRow,
} from "../../web/lib/orderScan.js";

// Skanning mot en order (#4): what a scan means in Inleverans (etapp 2) and
// Utleverans (etapp 3), and how an article scan counts.

// No cap on the client (Inleverans: the server's tolerance decides).
const rows: OrderScanRow[] = [
  { id: "r1", articleId: "screw", remaining: 2, scannable: true, max: null },
  { id: "r2", articleId: "nut", remaining: 10, scannable: true, max: null },
  { id: "r3", articleId: "screw", remaining: 3, scannable: true, max: null },
  { id: "r4", articleId: "setup", remaining: 1, scannable: false, max: null },
];
// Capped at the remaining amount (Utleverans, no överleverans allowed).
const capped = rows.map((r) => ({ ...r, max: r.remaining }));
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
    const first = countScan(rows, fresh, "nut");
    if (!first.counted) throw new Error("not counted");
    expect(first.rowId).toBe("r2");
    expect(rows.map((r) => enteredQuantity(r, first.state))).toEqual(["0", "1", "0", "1"]);
    expect(hasCounted(fresh)).toBe(false);
    expect(hasCounted(first.state)).toBe(true);
    expect(rows.map((r) => leftToCount(r, first.state))).toEqual([2, 9, 3, null]);
  });

  it("keeps a typed quantity when counting starts", () => {
    const next = countScan(rows, { counting: false, quantities: { r2: "4" } }, "screw");
    if (!next.counted) throw new Error("not counted");
    expect(rows.map((r) => enteredQuantity(r, next.state))).toEqual(["1", "4", "0", "1"]);
  });

  it("fills the article's rows in order; without a cap it flags what goes over", () => {
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

  it("capped refuses an överplock and fills a fractional remainder", () => {
    const full: OrderCountState = { counting: true, quantities: { r1: "2", r3: "3" } };
    expect(countScan(capped, full, "screw")).toEqual({
      counted: false,
      full: true,
      rowId: "r1",
      quantity: 2,
      remaining: 2,
    });
    expect(rows.map((r) => leftToCount(r, full))).toEqual([0, 10, 0, null]);
    const fraction: OrderScanRow[] = [{ id: "k", articleId: "plate", remaining: 2.5, scannable: true, max: 2.5 }];
    const next = countScan(fraction, { counting: true, quantities: { k: "2" } }, "plate");
    expect(next.counted && [next.quantity, next.over]).toEqual([2.5, false]);
  });

  it("counts past the remaining amount up to the allowed överleverans, then refuses", () => {
    // 10 kvar, 10 % tillåtet ⇒ max 11.
    const allowed: OrderScanRow[] = [{ id: "k", articleId: "plate", remaining: 10, scannable: true, max: 11 }];
    const over = countScan(allowed, { counting: true, quantities: { k: "10" } }, "plate");
    expect(over.counted && [over.quantity, over.over]).toEqual([11, true]);
    expect(countScan(allowed, { counting: true, quantities: { k: "11" } }, "plate")).toMatchObject({ counted: false, full: true });
  });

  it("does not count an article without a scannable row", () => {
    expect(countScan(rows, fresh, "bolt")).toEqual({ counted: false });
    expect(countScan(capped, fresh, "setup")).toEqual({ counted: false });
  });

  it("with the same article on several rows counts the earliest effective date first, undated last, then the row order", () => {
    // Listed later but due earlier: r3 takes the first scans; the undated
    // r5 comes after both dated rows; the stable sort keeps r1 before r6.
    const dated: OrderScanRow[] = [
      { id: "r1", articleId: "screw", remaining: 1, scannable: true, max: null, date: "2030-03-20" },
      { id: "r5", articleId: "screw", remaining: 1, scannable: true, max: null, date: null },
      { id: "r3", articleId: "screw", remaining: 2, scannable: true, max: null, date: "2030-03-10" },
      { id: "r6", articleId: "screw", remaining: 1, scannable: true, max: null, date: "2030-03-20" },
    ];
    let state = fresh;
    const hits: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = countScan(dated, state, "screw");
      if (!next.counted) throw new Error("not counted");
      hits.push(`${next.rowId}:${next.quantity}${next.over ? "!" : ""}`);
      state = next.state;
    }
    expect(hits).toEqual(["r3:1", "r3:2", "r1:1", "r6:1", "r5:1", "r3:3!"]);
    // The input order is untouched.
    expect(dated.map((r) => r.id)).toEqual(["r1", "r5", "r3", "r6"]);
    // Without dates the old rule stands (the row order).
    const plain = countScan(rows, fresh, "screw");
    expect(plain.counted && plain.rowId).toBe("r1");
  });
});

describe("scan dates", () => {
  it("purchase: confirmed beats requested, the row's own beats the order's", () => {
    const order = { confirmedDeliveryDate: "2030-05-02", expectedDeliveryDate: "2030-05-01" };
    expect(purchaseScanDate({ confirmedDeliveryDate: "2030-06-01", expectedDeliveryDate: "2030-04-01" }, order)).toBe("2030-06-01");
    expect(purchaseScanDate({ confirmedDeliveryDate: null, expectedDeliveryDate: "2030-04-01" }, order)).toBe("2030-05-02");
    expect(purchaseScanDate({ confirmedDeliveryDate: null, expectedDeliveryDate: "2030-04-01" }, { confirmedDeliveryDate: null, expectedDeliveryDate: "2030-05-01" })).toBe("2030-04-01");
    expect(purchaseScanDate({ confirmedDeliveryDate: null, expectedDeliveryDate: null }, { confirmedDeliveryDate: null, expectedDeliveryDate: "2030-05-01" })).toBe("2030-05-01");
    expect(purchaseScanDate({ confirmedDeliveryDate: null, expectedDeliveryDate: null }, null)).toBeNull();
  });

  it("sales: the row's date, else the order's, else none", () => {
    expect(salesScanDate({ expectedDeliveryDate: "2030-03-01" }, { expectedDeliveryDate: "2030-04-01" })).toBe("2030-03-01");
    expect(salesScanDate({ expectedDeliveryDate: null }, { expectedDeliveryDate: "2030-04-01" })).toBe("2030-04-01");
    expect(salesScanDate({ expectedDeliveryDate: null }, { expectedDeliveryDate: null })).toBeNull();
    expect(salesScanDate({ expectedDeliveryDate: null }, null)).toBeNull();
  });
});

// GS1 (#8 etapp 2 steg 6): batch, utgångsdatum and serienummer in a scanned code.
describe("resolveOrderScan with a batch match", () => {
  const number: OrderScanMatch = { kind: "batch", id: "b1" };
  const screw: OrderScanMatch = { kind: "article", id: "screw" };

  it("is never an article, an order or a place of its own", () => {
    expect(resolveOrderScan([number], "purchaseOrder", order)).toEqual({ kind: "unknown" });
    expect(resolveOrderScan([screw, number], "salesOrder", order)).toEqual({ kind: "count", match: screw });
  });
});

describe("countScan on one row", () => {
  it("counts on the named row only", () => {
    const counted = countScan(rows, fresh, "screw", "r3");
    expect(counted).toMatchObject({ counted: true, rowId: "r3", quantity: 1 });
    expect(countScan(rows, fresh, "screw", "r2")).toEqual({ counted: false });
  });
});

describe("Inleverans: receiptScanFields", () => {
  const gs1 = { batch: "LOT-1", serial: "SN-1", expiresOn: "2027-03-01" };

  it("reads the field the row's article is tracked by", () => {
    expect(receiptScanFields("batch", gs1)).toEqual({ kind: "batch", batchNumber: "LOT-1", expiresOn: "2027-03-01" });
    expect(receiptScanFields("serial", gs1)).toEqual({ kind: "serial", serialNumber: "SN-1" });
    expect(receiptScanFields(null, gs1)).toEqual({ kind: "plain" });
  });

  it("counts as always without the field, and never counts a serienummerrad without a number", () => {
    expect(receiptScanFields("batch", null)).toEqual({ kind: "plain" });
    expect(receiptScanFields("batch", { batch: null, serial: "SN-1", expiresOn: "2027-03-01" })).toEqual({ kind: "plain" });
    expect(receiptScanFields("serial", null)).toEqual({ kind: "awaitSerial" });
    expect(receiptScanFields("serial", { batch: "LOT-1", serial: null, expiresOn: null })).toEqual({ kind: "awaitSerial" });
  });
});

describe("Inleverans: placeBatchScan", () => {
  const empty = { batchNumber: "", expiresOn: "", parts: [] };
  const scanned = { batchNumber: "LOT-1", expiresOn: "2027-03-01" };

  it("fills an empty batch and date on the row", () => {
    expect(placeBatchScan(empty, scanned)).toEqual({ target: "main", batchNumber: "LOT-1", expiresOn: "2027-03-01" });
    expect(placeBatchScan(empty, { batchNumber: "LOT-1", expiresOn: null })).toEqual({ target: "main", batchNumber: "LOT-1", expiresOn: "" });
  });

  it("lets what was typed win", () => {
    // The same batch (lower()), a typed date: the date stays.
    expect(placeBatchScan({ batchNumber: "lot-1", expiresOn: "2027-01-31", parts: [] }, scanned)).toEqual({
      target: "main",
      batchNumber: "lot-1",
      expiresOn: "2027-01-31",
    });
    // A typed date on an empty batch stays too.
    expect(placeBatchScan({ batchNumber: "", expiresOn: "2027-01-31", parts: [] }, scanned)).toMatchObject({ target: "main", expiresOn: "2027-01-31" });
  });

  it("puts another batch than the row's in a part of its own, one more per scan", () => {
    const row = { batchNumber: "LOT-0", expiresOn: "", parts: [] as { quantity: string; batchNumber: string; expiresOn: string }[] };
    expect(placeBatchScan(row, scanned)).toEqual({ target: "newPart", quantity: "1", batchNumber: "LOT-1", expiresOn: "2027-03-01" });
    row.parts.push({ quantity: "1", batchNumber: "LOT-1", expiresOn: "" });
    expect(placeBatchScan(row, scanned)).toEqual({ target: "part", index: 0, quantity: "2", expiresOn: "2027-03-01" });
    // A part that already has the batch wins over filling an empty row batch.
    expect(placeBatchScan({ ...row, batchNumber: "" }, scanned)).toMatchObject({ target: "part", index: 0 });
  });
});

describe("serienummer: the list and the row", () => {
  it("finds a number already entered on any row, as Postgres compares", () => {
    expect(serialScanDuplicate({ r1: ["SN-1"], r2: ["SN-2"] }, "sn-2")).toBe("r2");
    expect(serialScanDuplicate({ r1: ["SN-1"] }, "SN-3")).toBeNull();
  });

  it("takes the rows by date, the first one short, then one with room", () => {
    const serialRows = [
      { id: "late", articleId: "pump", remainingStyck: 2, maxStyck: 2, date: "2026-12-10" },
      { id: "early", articleId: "pump", remainingStyck: 1, maxStyck: 2, date: "2026-12-01" },
    ];
    expect(serialScanRow(serialRows, "pump", {})?.id).toBe("early");
    expect(serialScanRow(serialRows, "pump", { early: 1 })?.id).toBe("late");
    // Both hold what is left: the first with room under its cap.
    expect(serialScanRow(serialRows, "pump", { early: 1, late: 2 })?.id).toBe("early");
    expect(serialScanRow(serialRows, "pump", { early: 2, late: 2 })).toBeNull();
    expect(serialScanRow(serialRows, "valve", {})).toBeNull();
  });
});

describe("Utleverans: matchSerialScan", () => {
  const cell = (batchNumber: string, over: Partial<{ articleId: string; locationId: string; blocked: boolean; quantity: string; batchKind: "batch" | "serial" }> = {}) => ({
    articleId: "pump",
    locationId: "a",
    blocked: false,
    batchId: `id-${batchNumber}`,
    batchNumber,
    batchKind: "serial" as "batch" | "serial",
    quantity: "1",
    ...over,
  });
  const cells = [cell("SN-1"), cell("SN-2"), cell("SN-3", { locationId: "b" }), cell("SN-4", { blocked: true }), cell("SN-5", { quantity: "0" }), cell("LOT-1", { batchKind: "batch" })];
  const serialRows = [{ id: "r1", articleId: "pump", remainingStyck: 2, maxStyck: 2 }];

  it("picks the number on its article's row without the article being scanned", () => {
    expect(matchSerialScan("sn-1", cells, serialRows, {})).toMatchObject({ kind: "picked", rowId: "r1", serialId: "id-SN-1", count: 1, over: false });
    expect(matchSerialScan("SN-2", cells, serialRows, { r1: ["id-SN-1"] })).toMatchObject({ kind: "picked", count: 2 });
  });

  it("explains a number that cannot be picked", () => {
    expect(matchSerialScan("SN-1", cells, serialRows, { r1: ["id-SN-1"] })).toMatchObject({ kind: "already", rowId: "r1" });
    expect(matchSerialScan("SN-4", cells, serialRows, {})).toMatchObject({ kind: "blocked" });
    expect(matchSerialScan("SN-3", cells, [{ ...serialRows[0]!, locationId: "a" }], {})).toMatchObject({ kind: "otherLocation", rowId: "r1" });
    // Överplock is refused, as for an article scan.
    expect(matchSerialScan("SN-3", cells, serialRows, { r1: ["id-SN-1", "id-SN-2"] })).toMatchObject({ kind: "full" });
    // Tillåten överleverans: one more, flagged.
    expect(matchSerialScan("SN-3", cells, [{ ...serialRows[0]!, maxStyck: 3 }], { r1: ["id-SN-1", "id-SN-2"] })).toMatchObject({ kind: "picked", count: 3, over: true });
  });

  it("knows nothing of a number that is not in stock, a batch, or another article", () => {
    expect(matchSerialScan("SN-5", cells, serialRows, {})).toBeNull();
    expect(matchSerialScan("SN-9", cells, serialRows, {})).toBeNull();
    expect(matchSerialScan("LOT-1", cells, serialRows, {})).toBeNull();
    expect(matchSerialScan("SN-1", cells, [{ ...serialRows[0]!, articleId: "valve" }], {})).toBeNull();
    // A GS1 code named another article than the number's.
    expect(matchSerialScan("SN-1", cells, serialRows, {}, ["valve"])).toBeNull();
    expect(matchSerialScan("SN-1", cells, serialRows, {}, ["pump"])).toMatchObject({ kind: "picked" });
  });
});

describe("Utleverans: matchBatchScan", () => {
  const cell = (batchNumber: string, over: Partial<{ locationId: string; blocked: boolean; quantity: string; batchKind: "batch" | "serial" }> = {}) => ({
    articleId: "glue",
    locationId: "a",
    blocked: false,
    batchId: `id-${batchNumber}`,
    batchNumber,
    quantity: "5",
    ...over,
  });
  const cells = [cell("LOT-1"), cell("LOT-2", { locationId: "b" }), cell("LOT-3", { blocked: true }), cell("LOT-4", { quantity: "0" }), cell("SN-1", { batchKind: "serial" })];
  const row = { id: "r1", articleId: "glue", chosen: "" };

  it("chooses the batch on a row still on Automatiskt, or one that already has it", () => {
    expect(matchBatchScan("lot-1", cells, [row])).toMatchObject({ kind: "chosen", rowId: "r1", batchId: "id-LOT-1" });
    expect(matchBatchScan("LOT-1", cells, [{ ...row, chosen: "id-LOT-1" }])).toMatchObject({ kind: "chosen", rowId: "r1" });
    // Two rows of the article: the one that has the batch, else the first on Automatiskt (by date).
    const two = [
      { id: "late", articleId: "glue", chosen: "", date: "2026-12-10" },
      { id: "early", articleId: "glue", chosen: "id-LOT-2", date: "2026-12-01" },
    ];
    expect(matchBatchScan("LOT-2", cells, two)).toMatchObject({ kind: "chosen", rowId: "early" });
    expect(matchBatchScan("LOT-1", cells, two)).toMatchObject({ kind: "chosen", rowId: "late" });
  });

  it("warns for another batch than the row's — one chosen batch per row", () => {
    expect(matchBatchScan("LOT-1", cells, [{ ...row, chosen: "id-LOT-2" }])).toMatchObject({ kind: "otherBatch", rowId: "r1" });
    // Okänd chosen by hand is a choice too.
    expect(matchBatchScan("LOT-1", cells, [{ ...row, chosen: "unknown" }])).toMatchObject({ kind: "otherBatch" });
  });

  it("explains a batch on a spärrad or another place, and knows nothing of the rest", () => {
    expect(matchBatchScan("LOT-3", cells, [row])).toMatchObject({ kind: "blocked" });
    expect(matchBatchScan("LOT-2", cells, [{ ...row, locationId: "a" }])).toMatchObject({ kind: "otherLocation", rowId: "r1" });
    expect(matchBatchScan("LOT-4", cells, [row])).toBeNull();
    expect(matchBatchScan("SN-1", cells, [row])).toBeNull();
    expect(matchBatchScan("LOT-1", cells, [row], ["pump"])).toBeNull();
    expect(matchBatchScan("LOT-1", cells, [])).toBeNull();
  });
});
