import type { PurchaseOrderRow, PurchaseReceipt } from "./types";
import { toUnitQuantity } from "./units";

// Etikett och pallkort vid inleverans: one printable entry is one receipt, or
// the serial receipts of one receive call (a serial receipt is one styck),
// always on one IO row. The labels print one per receipt id; the pallkort
// INLEVERANS prints one card per kolli of the entry.
export interface ReceiptPrintEntry {
  key: string;
  receiptIds: string[];
  articleNumber: string;
  articleName: string;
  // In the row's unit.
  quantity: number;
  unit: string;
  // "Batch L-778" / "3 serienummer" — the dialog's line under the article.
  detail: string | null;
}

// An entry from a head receipt and its group (ReceiptsSection's grouping):
// only the live receipts — an undone one put nothing on the shelf — and
// never a service row, which receives no goods. Null = nothing to print.
export function receiptPrintEntry(receipts: PurchaseReceipt[], row: PurchaseOrderRow | undefined): ReceiptPrintEntry | null {
  const live = receipts.filter((r) => r.undoneAt === null);
  if (live.length === 0 || !row || row.articleType === "service") return null;
  const base = live.reduce((sum, r) => sum + Number(r.quantity), 0);
  const serials = live.filter((r) => r.batchKind === "serial").length;
  const batch = live.find((r) => r.batchKind !== "serial" && r.batchNumber)?.batchNumber ?? null;
  return {
    key: live[0]!.id,
    receiptIds: live.map((r) => r.id),
    articleNumber: row.articleNumber,
    articleName: row.articleName,
    quantity: toUnitQuantity(base, row.unitFactor),
    unit: row.unitCode,
    detail: serials > 0 ? `${serials} serienummer` : batch ? `Batch ${batch}` : null,
  };
}
