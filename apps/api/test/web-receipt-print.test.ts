import { describe, expect, it } from "vitest";
import { receiptPrintEntry } from "../../web/lib/receiptPrint.js";
import type { PurchaseOrderRow, PurchaseReceipt } from "../../web/lib/types.js";

// Etikett och pallkort vid inleverans — the IO card's rule for what one of
// its Inleveranser entries prints (apps/web/lib/receiptPrint.ts).

function receipt(id: string, extra: Partial<PurchaseReceipt> = {}): PurchaseReceipt {
  return {
    id,
    purchaseOrderRowId: "row",
    quantity: "10",
    locationName: "A1",
    batchNumber: null,
    expiresOn: null,
    batchKind: null,
    moReportId: null,
    receivedAt: "2026-11-16T10:00:00.000Z",
    createdAt: "2026-11-16T10:00:00.000Z",
    createdByName: "Lager",
    undoneAt: null,
    undoneByName: null,
    ...extra,
  };
}

const row = {
  id: "row",
  articleNumber: "PL-2040",
  articleName: "Plåt",
  articleType: "purchased",
  unitFactor: null,
  unitCode: "st",
} as PurchaseOrderRow;

describe("receiptPrintEntry", () => {
  it("prints one receipt in the row's unit, with its batch", () => {
    expect(receiptPrintEntry([receipt("a", { batchNumber: "L-1", batchKind: "batch" })], row)).toEqual({
      key: "a",
      receiptIds: ["a"],
      articleNumber: "PL-2040",
      articleName: "Plåt",
      quantity: 10,
      unit: "st",
      detail: "Batch L-1",
    });
    // A row entered in another unit: 10 base units at factor 0.5 = 5 of the row's unit.
    expect(receiptPrintEntry([receipt("a")], { ...row, unitFactor: "0.5", unitCode: "kartong" })).toMatchObject({ quantity: 5, unit: "kartong", detail: null });
  });

  it("takes a serial group's live numbers only and counts them", () => {
    const group = [
      receipt("s1", { quantity: "1", batchNumber: "SN-1", batchKind: "serial" }),
      receipt("s2", { quantity: "1", batchNumber: "SN-2", batchKind: "serial", undoneAt: "2026-11-16T11:00:00.000Z" }),
      receipt("s3", { quantity: "1", batchNumber: "SN-3", batchKind: "serial" }),
    ];
    expect(receiptPrintEntry(group, row)).toMatchObject({ key: "s1", receiptIds: ["s1", "s3"], quantity: 2, detail: "2 serienummer" });
  });

  it("prints nothing for an undone receipt, a service row or a deleted row", () => {
    expect(receiptPrintEntry([receipt("a", { undoneAt: "2026-11-16T11:00:00.000Z" })], row)).toBeNull();
    expect(receiptPrintEntry([receipt("a")], { ...row, articleType: "service" })).toBeNull();
    expect(receiptPrintEntry([receipt("a")], undefined)).toBeNull();
  });
});
