// Skanning mot en order (#4) — the pure rules the scanning routines share:
// Inleverans counts what arrives against an inköpsorder (etapp 2), Utleverans
// counts what is picked against a kundorder (etapp 3). What a scanned code
// means for the order in progress, and how an article scan counts. No
// imports, so the API test suite loads it directly
// (test/web-order-scan.test.ts).

// What GET /scan answered, narrowed to what the routines look at.
export type OrderScanMatch =
  | { kind: "location"; id: string }
  | { kind: "article"; id: string }
  | { kind: "purchaseOrder"; id: string }
  | { kind: "salesOrder"; id: string }
  | { kind: "manufacturingOrder"; id: string };

type OrderKind = "purchaseOrder" | "salesOrder";

// A row the routine can book against: an open row of the chosen order, its
// remaining amount in the row's own unit (what the field shows). A row that
// is not `scannable` — a tjänst or a ställkostnad, nothing to pick up — is
// left out of the counting and keeps its remaining amount. `max` is the most
// this booking may hold, in the row's unit: Utleverans' remaining amount plus
// the customer's Tillåten överleverans (#24); null = no cap here, the server
// decides (Inleverans, or a customer without limit).
export interface OrderScanRow {
  id: string;
  articleId: string;
  remaining: number;
  scannable: boolean;
  max: number | null;
}

// Only tjänster have nothing to scan; a ställkostnadsrad follows the order
// whatever article the setting points at.
export function isScannableRow(row: { articleType?: string; setupForRowId?: string | null }): boolean {
  return row.articleType !== "service" && !row.setupForRowId;
}

export type OrderScanIntent<M extends OrderScanMatch, K extends OrderKind> =
  | { kind: "location"; match: Extract<M, { kind: "location" }> }
  // An article with an open, scannable row on the chosen order.
  | { kind: "count"; match: Extract<M, { kind: "article" }> }
  | { kind: "order"; match: Extract<M, { kind: K }> }
  // Open on the order, but only on rows that are not counted (tjänst).
  | { kind: "articleManual"; match: Extract<M, { kind: "article" }> }
  // On the order, but every row of it is already received/delivered.
  | { kind: "articleDone"; match: Extract<M, { kind: "article" }> }
  | { kind: "articleNotOnOrder"; match: Extract<M, { kind: "article" }> }
  // No order chosen yet.
  | { kind: "articleWithoutOrder"; match: Extract<M, { kind: "article" }> }
  // An order of another kind than the routine books against.
  | { kind: "wrongKind"; match: Extract<M, { kind: Exclude<OrderKind, K> | "manufacturingOrder" }> }
  | { kind: "unknown" };

// One code can name several things (GET /scan answers every match); the
// routine prefers, in order: a lagerplats label, an article it can count, an
// order of its own kind, and only then explains why an article cannot be
// counted.
export function resolveOrderScan<M extends OrderScanMatch, K extends OrderKind>(
  matches: M[],
  orderKind: K,
  order: { openRows: OrderScanRow[]; articleIds: string[] } | null
): OrderScanIntent<M, K> {
  const location = matches.find((m): m is Extract<M, { kind: "location" }> => m.kind === "location");
  if (location) return { kind: "location", match: location };
  const articles = matches.filter((m): m is Extract<M, { kind: "article" }> => m.kind === "article");
  if (order) {
    const countable = articles.find((a) => order.openRows.some((r) => r.articleId === a.id && r.scannable));
    if (countable) return { kind: "count", match: countable };
  }
  const own = matches.find((m): m is Extract<M, { kind: K }> => m.kind === orderKind);
  if (own) return { kind: "order", match: own };
  if (articles.length > 0) {
    if (!order) return { kind: "articleWithoutOrder", match: articles[0]! };
    const manual = articles.find((a) => order.openRows.some((r) => r.articleId === a.id));
    if (manual) return { kind: "articleManual", match: manual };
    const done = articles.find((a) => order.articleIds.includes(a.id));
    return done ? { kind: "articleDone", match: done } : { kind: "articleNotOnOrder", match: articles[0]! };
  }
  const other = matches.find(
    (m): m is Extract<M, { kind: Exclude<OrderKind, K> | "manufacturingOrder" }> =>
      m.kind !== orderKind && (m.kind === "purchaseOrder" || m.kind === "salesOrder" || m.kind === "manufacturingOrder")
  );
  return other ? { kind: "wrongKind", match: other } : { kind: "unknown" };
}

// The quantities being booked. Before the first article scan every row
// shows its remaining amount (book the whole order in one click); the first
// scan starts counting, and from then on a scannable row nobody scanned or
// typed is 0 and is not booked. Typed values are kept either way, and rows
// that are not scannable keep their remaining amount.
export interface OrderCountState {
  counting: boolean;
  quantities: Record<string, string>; // rowId → entered, in the row's unit
}

export function enteredQuantity(row: OrderScanRow, state: OrderCountState): string {
  return state.quantities[row.id] ?? (state.counting && row.scannable ? "0" : String(row.remaining));
}

export function hasCounted(state: OrderCountState): boolean {
  return state.counting && Object.values(state.quantities).some((q) => Number(q) > 0);
}

// What is left to count on a row once counting has started (Kvar att
// plocka): remaining − entered, never below 0; null for a row that is not
// counted.
export function leftToCount(row: OrderScanRow, state: OrderCountState): number | null {
  if (!row.scannable) return null;
  const left = row.remaining - (Number(enteredQuantity(row, state)) || 0);
  return Math.max(0, Math.round(left * 10000) / 10000);
}

export type CountOutcome =
  | { counted: false; full?: undefined }
  // Every row of the article already holds its `max`: nothing was added
  // (överplock).
  | { counted: false; full: true; rowId: string; quantity: number; remaining: number }
  | { counted: true; state: OrderCountState; rowId: string; quantity: number; remaining: number; over: boolean };

// One article scan adds 1 (in the row's unit) to the article's row. With the
// same article on several open rows, the first row still short of its
// remaining amount takes it; when all are full, the first row with room
// under its `max` takes it, flagged `over` (past the remaining amount). No
// row with room: the scan is refused (överplock). A fractional step fills up
// to `max` (2.5 tillåtet, 2 räknade ⇒ 2.5).
export function countScan(rows: OrderScanRow[], state: OrderCountState, articleId: string): CountOutcome {
  const candidates = rows.filter((r) => r.articleId === articleId && r.scannable);
  if (candidates.length === 0) return { counted: false };
  const current = (row: OrderScanRow) => Number(state.quantities[row.id] ?? 0) || 0;
  const row =
    candidates.find((r) => current(r) < r.remaining && (r.max === null || current(r) < r.max)) ??
    candidates.find((r) => r.max === null || current(r) < r.max);
  if (!row) {
    const first = candidates[0]!;
    return { counted: false, full: true, rowId: first.id, quantity: current(first), remaining: first.remaining };
  }
  const next = row.max === null ? current(row) + 1 : Math.min(current(row) + 1, row.max);
  const quantity = Math.round(next * 10000) / 10000;
  return {
    counted: true,
    state: { counting: true, quantities: { ...state.quantities, [row.id]: String(quantity) } },
    rowId: row.id,
    quantity,
    remaining: row.remaining,
    over: quantity > row.remaining,
  };
}
