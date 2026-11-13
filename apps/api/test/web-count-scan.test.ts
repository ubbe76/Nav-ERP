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

  // GS1 and batch/serienummer rows (#8 etapp 2 steg 6).
  describe("batch- och serienummerrader", () => {
    const pump: CountScanMatch = { kind: "article", id: "pump", stockTracking: "serial" };
    const glue: CountScanMatch = { kind: "article", id: "glue", stockTracking: "batch" };
    const sn7: CountScanMatch = { kind: "batch", id: "b-sn7", articleId: "pump", batchKind: "serial", batchNumber: "SN-7" };
    const sn9: CountScanMatch = { kind: "batch", id: "b-sn9", articleId: "pump", batchKind: "serial", batchNumber: "SN-9" };
    const lotA: CountScanMatch = { kind: "batch", id: "b-a", articleId: "glue", batchKind: "batch", batchNumber: "LOT-A" };
    const lotC: CountScanMatch = { kind: "batch", id: "b-c", articleId: "glue", batchKind: "batch", batchNumber: "LOT-C" };
    const sheet = {
      locationId: "lp-a",
      open: true,
      rows: [
        { id: "r1", articleId: "screw" },
        { id: "p7", articleId: "pump", batchId: "b-sn7", batchNumber: "SN-7", batchKind: "serial" as const },
        { id: "g0", articleId: "glue", batchId: null, batchNumber: null, batchKind: null },
        { id: "ga", articleId: "glue", batchId: "b-a", batchNumber: "LOT-A", batchKind: "batch" as const },
      ],
    };
    const gs1 = (fields: { batch?: string; serial?: string }) => ({ batch: fields.batch ?? null, serial: fields.serial ?? null });

    it("counts a serienummer that has a row, and adds one that has none", () => {
      // GS1: article + AI 21 (the number compared as Postgres does, lower()).
      expect(resolveCountScan([pump, sn7], sheet, gs1({ serial: "sn-7" }))).toEqual({ kind: "serialRow", articleId: "pump", rowId: "p7", serialNumber: "sn-7" });
      expect(resolveCountScan([pump], sheet, gs1({ serial: "SN-8" }))).toEqual({ kind: "addSerial", articleId: "pump", serialNumber: "SN-8" });
      // The number itself, as an ordinary code.
      expect(resolveCountScan([sn7], sheet)).toEqual({ kind: "serialRow", articleId: "pump", rowId: "p7", serialNumber: "SN-7" });
      expect(resolveCountScan([sn9], sheet)).toEqual({ kind: "addSerial", articleId: "pump", serialNumber: "SN-9" });
    });

    it("marks the batch's own row, and adds a batch the sheet lacks", () => {
      expect(resolveCountScan([glue, lotA], sheet, gs1({ batch: "LOT-A" }))).toEqual({ kind: "batchRow", articleId: "glue", rowId: "ga", batchNumber: "LOT-A" });
      expect(resolveCountScan([glue], sheet, gs1({ batch: "LOT-B" }))).toEqual({ kind: "addBatch", articleId: "glue", batchNumber: "LOT-B" });
      expect(resolveCountScan([lotA], sheet)).toEqual({ kind: "batchRow", articleId: "glue", rowId: "ga", batchNumber: "LOT-A" });
      expect(resolveCountScan([lotC], sheet)).toEqual({ kind: "addBatch", articleId: "glue", batchNumber: "LOT-C" });
    });

    it("reads the field the article is tracked by, and neither on an untracked article", () => {
      // A code with both: the serienummerstyrda article takes AI 21, the batchstyrda AI 10.
      expect(resolveCountScan([pump], sheet, gs1({ batch: "LOT-A", serial: "SN-7" }))).toMatchObject({ kind: "serialRow", rowId: "p7" });
      expect(resolveCountScan([glue], sheet, gs1({ batch: "LOT-A", serial: "SN-7" }))).toMatchObject({ kind: "batchRow", rowId: "ga" });
      expect(resolveCountScan([screw], sheet, gs1({ batch: "LOT-A", serial: "SN-7" }))).toEqual({ kind: "row", match: screw, rowId: "r1" });
    });

    it("lets the user choose when only the article is scanned and it has several rows", () => {
      expect(resolveCountScan([glue], sheet)).toEqual({ kind: "chooseRow", match: glue, rowIds: ["g0", "ga"], serial: false });
      // Serienummer: always the number, also with one row or none.
      expect(resolveCountScan([pump], sheet)).toEqual({ kind: "chooseRow", match: pump, rowIds: ["p7"], serial: true });
      expect(resolveCountScan([pump], { ...sheet, rows: [] }, gs1({ batch: "X" }))).toEqual({ kind: "chooseRow", match: pump, rowIds: [], serial: true });
      // A batchstyrd article with one row is that row; with none it is added (the Okänd row).
      expect(resolveCountScan([glue], { ...sheet, rows: [sheet.rows[3]!] })).toEqual({ kind: "row", match: glue, rowId: "ga" });
      expect(resolveCountScan([glue], { ...sheet, rows: [] })).toEqual({ kind: "addArticle", match: glue });
    });

    it("lets a place and an article win over a number, and prefers the number that has a row", () => {
      expect(resolveCountScan([sn7, here], sheet)).toEqual({ kind: "thisLocation", match: here });
      expect(resolveCountScan([screw, sn7], sheet)).toEqual({ kind: "row", match: screw, rowId: "r1" });
      const other: CountScanMatch = { kind: "batch", id: "b-x", articleId: "bolt", batchKind: "batch", batchNumber: "LOT-A" };
      expect(resolveCountScan([other, lotA], sheet)).toMatchObject({ kind: "batchRow", rowId: "ga" });
      // On several articles and none of them on the sheet: not guessed.
      expect(resolveCountScan([other, { ...lotC, batchNumber: "LOT-A" }], sheet)).toEqual({ kind: "ambiguousNumber", batchNumber: "LOT-A" });
    });

    it("counts no number on a closed count or before one is open", () => {
      expect(resolveCountScan([sn7], { ...sheet, open: false })).toEqual({ kind: "numberNotCounting" });
      expect(resolveCountScan([sn7], null)).toEqual({ kind: "numberNotCounting" });
      expect(resolveCountScan([pump], { ...sheet, open: false }, gs1({ serial: "SN-7" }))).toEqual({ kind: "articleNotCounting", match: pump });
    });
  });
});
