// Inleverans med skanning (#4, etapp 2) — the pure rules of the scanning
// routine: what a scanned code means for the receipt in progress, and how an
// article scan counts. No imports, so the API test suite loads it directly
// (test/web-goods-receipt-scan.test.ts).

// What GET /scan answered, narrowed to what the receipt looks at.
export type ReceiptScanMatch =
  | { kind: "location"; id: string }
  | { kind: "article"; id: string }
  | { kind: "purchaseOrder"; id: string }
  | { kind: "salesOrder"; id: string }
  | { kind: "manufacturingOrder"; id: string };

// A row the routine can receive against: an open row of the chosen order,
// its remaining amount in the row's own unit (what the field shows).
export interface ReceiptScanRow {
  id: string;
  articleId: string;
  remaining: number;
}

export type ReceiptScanIntent<M extends ReceiptScanMatch> =
  | { kind: "location"; match: Extract<M, { kind: "location" }> }
  // An article with an open row on the chosen order.
  | { kind: "count"; match: Extract<M, { kind: "article" }> }
  | { kind: "order"; match: Extract<M, { kind: "purchaseOrder" }> }
  // On the order, but every row of it is already received.
  | { kind: "articleReceived"; match: Extract<M, { kind: "article" }> }
  | { kind: "articleNotOnOrder"; match: Extract<M, { kind: "article" }> }
  // No order chosen yet: find the receivable orders waiting for it.
  | { kind: "findOrders"; match: Extract<M, { kind: "article" }> }
  | { kind: "wrongKind"; match: Extract<M, { kind: "salesOrder" | "manufacturingOrder" }> }
  | { kind: "unknown" };

// One code can name several things (GET /scan answers every match); the
// receipt prefers, in order: a lagerplats label, an article it can count, an
// inköpsorder, and only then explains why an article cannot be counted.
export function resolveReceiptScan<M extends ReceiptScanMatch>(
  matches: M[],
  order: { openRows: ReceiptScanRow[]; articleIds: string[] } | null
): ReceiptScanIntent<M> {
  const location = matches.find((m): m is Extract<M, { kind: "location" }> => m.kind === "location");
  if (location) return { kind: "location", match: location };
  const articles = matches.filter((m): m is Extract<M, { kind: "article" }> => m.kind === "article");
  if (order) {
    const countable = articles.find((a) => order.openRows.some((r) => r.articleId === a.id));
    if (countable) return { kind: "count", match: countable };
  }
  const purchaseOrder = matches.find((m): m is Extract<M, { kind: "purchaseOrder" }> => m.kind === "purchaseOrder");
  if (purchaseOrder) return { kind: "order", match: purchaseOrder };
  if (articles.length > 0) {
    if (!order) return { kind: "findOrders", match: articles[0]! };
    const received = articles.find((a) => order.articleIds.includes(a.id));
    return received ? { kind: "articleReceived", match: received } : { kind: "articleNotOnOrder", match: articles[0]! };
  }
  const other = matches.find(
    (m): m is Extract<M, { kind: "salesOrder" | "manufacturingOrder" }> =>
      m.kind === "salesOrder" || m.kind === "manufacturingOrder"
  );
  return other ? { kind: "wrongKind", match: other } : { kind: "unknown" };
}

// The quantities being received. Before the first article scan every row
// shows its remaining amount (receive the whole order in one click); the
// first scan starts counting, and from then on a row nobody scanned or typed
// is 0 and is not received. Typed values are kept either way.
export interface ReceiptCountState {
  counting: boolean;
  quantities: Record<string, string>; // rowId → entered, in the row's unit
}

export function enteredQuantity(row: ReceiptScanRow, state: ReceiptCountState): string {
  return state.quantities[row.id] ?? (state.counting ? "0" : String(row.remaining));
}

export function hasCounted(state: ReceiptCountState): boolean {
  return state.counting && Object.values(state.quantities).some((q) => Number(q) > 0);
}

export type CountOutcome =
  | { counted: false }
  | { counted: true; state: ReceiptCountState; rowId: string; quantity: number; remaining: number; over: boolean };

// One article scan adds 1 (in the row's unit) to the article's row. With the same article on
// several open rows, the first row still short of its remaining amount takes
// it; when all are full the first row does, flagged `over` — whether that
// much may be received is the server's over-receipt tolerance, not the scan's.
export function countScan(
  rows: ReceiptScanRow[],
  state: ReceiptCountState,
  articleId: string
): CountOutcome {
  const candidates = rows.filter((r) => r.articleId === articleId);
  if (candidates.length === 0) return { counted: false };
  const current = (row: ReceiptScanRow) => Number(state.quantities[row.id] ?? 0) || 0;
  const row = candidates.find((r) => current(r) < r.remaining) ?? candidates[0]!;
  const quantity = Math.round((current(row) + 1) * 10000) / 10000;
  return {
    counted: true,
    state: { counting: true, quantities: { ...state.quantities, [row.id]: String(quantity) } },
    rowId: row.id,
    quantity,
    remaining: row.remaining,
    over: quantity > row.remaining,
  };
}
