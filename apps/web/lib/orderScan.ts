import { round4 } from "./format";

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
  | { kind: "manufacturingOrder"; id: string }
  // A batch or serienummer that exists under the scanned number — never an
  // article, order or place of its own; the GS1 rules below read it.
  | { kind: "batch"; id: string };

// What a GS1 code carried next to its GTIN (GET /scan's `gs1`).
export interface OrderScanGs1 {
  batch: string | null;
  serial: string | null;
  expiresOn: string | null;
}

type OrderKind = "purchaseOrder" | "salesOrder";

// A row the routine can book against: an open row of the chosen order, its
// remaining amount in the row's own unit (what the field shows). A row that
// is not `scannable` — a tjänst or a ställkostnad, nothing to pick up — is
// left out of the counting and keeps its remaining amount. `max` is the most
// this booking may hold, in the row's unit: Utleverans' remaining amount plus
// the customer's Tillåten överleverans (#24); null = no cap here, the server
// decides (Inleverans, or a customer without limit). `date` is the row's
// effective delivery date (YYYY-MM-DD; purchase: coalesce(row confirmed,
// order confirmed, row requested, order requested), sales: coalesce(row,
// order)) — with the same article on several rows, the earliest date is
// counted first; null/omitted = undated, counted last.
export interface OrderScanRow {
  id: string;
  articleId: string;
  remaining: number;
  scannable: boolean;
  max: number | null;
  date?: string | null;
}

// Only tjänster have nothing to scan; a ställkostnadsrad follows the order
// whatever article the setting points at.
export function isScannableRow(row: { articleType?: string; setupForRowId?: string | null }): boolean {
  return row.articleType !== "service" && !row.setupForRowId;
}

// The row's effective delivery date for the scan order (see OrderScanRow.date).
// Purchase: the confirmed date wins over the requested one, the row's own over
// the order's.
export function purchaseScanDate(
  row: { confirmedDeliveryDate?: string | null; expectedDeliveryDate?: string | null },
  order: { confirmedDeliveryDate?: string | null; expectedDeliveryDate?: string | null } | null
): string | null {
  return (
    row.confirmedDeliveryDate ??
    order?.confirmedDeliveryDate ??
    row.expectedDeliveryDate ??
    order?.expectedDeliveryDate ??
    null
  );
}

// Sales: the row's own Önskat leveransdatum, else the order's.
export function salesScanDate(
  row: { expectedDeliveryDate?: string | null },
  order: { expectedDeliveryDate?: string | null } | null
): string | null {
  return row.expectedDeliveryDate ?? order?.expectedDeliveryDate ?? null;
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
  return Math.max(0, round4(left));
}

export type CountOutcome =
  | { counted: false; full?: undefined }
  // Every row of the article already holds its `max`: nothing was added
  // (överplock).
  | { counted: false; full: true; rowId: string; quantity: number; remaining: number }
  | { counted: true; state: OrderCountState; rowId: string; quantity: number; remaining: number; over: boolean };

// Rows in the order a scan takes them: earliest effective date first,
// undated last. Array.prototype.sort is stable, so equal dates keep the row
// order.
function byScanDate<R extends { date?: string | null }>(rows: R[]): R[] {
  return [...rows].sort((a, b) => {
    const da = a.date ?? null;
    const db = b.date ?? null;
    if (da === db) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  });
}

// One article scan adds 1 (in the row's unit) to the article's row. With the
// same article on several open rows, the rows are taken by effective date
// (earliest first, undated last, then the row order): the first such row
// still short of its remaining amount takes it; when all are full, the first
// row with room under its `max` takes it, flagged `over` (past the remaining
// amount). No row with room: the scan is refused (överplock). A fractional
// step fills up to `max` (2.5 tillåtet, 2 räknade ⇒ 2.5).
// `onlyRowId` counts on that row and no other (a scan that already chose
// its row, e.g. by the batch it carries).
export function countScan(rows: OrderScanRow[], state: OrderCountState, articleId: string, onlyRowId?: string): CountOutcome {
  const candidates = byScanDate(
    rows.filter((r) => r.articleId === articleId && r.scannable && (onlyRowId === undefined || r.id === onlyRowId))
  );
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
  const quantity = round4(next);
  return {
    counted: true,
    state: { counting: true, quantities: { ...state.quantities, [row.id]: String(quantity) } },
    rowId: row.id,
    quantity,
    remaining: row.remaining,
    over: quantity > row.remaining,
  };
}

// --- GS1: batch, utgångsdatum and serienummer in a scanned code (#8 etapp 2
// steg 6). The server reads the code (parseGs1, GET /scan's `gs1`); these are
// the rules for what the routines do with it. A scanned value is only ever
// put in a field the user sees before saving — a scanner that drops the
// group separator splits two fields wrong, and that must be visible.

const sameNumber = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// What an article scan means on an Inleverans row, by how the row's article
// is tracked in stock (`tracking`: "batch", "serial" = numbers created at the
// receipt, else untracked).
export type ReceiptScanFields =
  // +1, as a scan always did.
  | { kind: "plain" }
  // +1 in that batch (placeBatchScan says where on the row).
  | { kind: "batch"; batchNumber: string; expiresOn: string | null }
  // The number goes into the row's list; the quantity follows the list.
  | { kind: "serial"; serialNumber: string }
  // A serienummerrad scanned without a number: nothing is counted — the row
  // waits for its numbers (the next unknown code is taken as one).
  | { kind: "awaitSerial" };

export function receiptScanFields(tracking: "batch" | "serial" | null | undefined, gs1: OrderScanGs1 | null): ReceiptScanFields {
  if (tracking === "serial") return gs1?.serial ? { kind: "serial", serialNumber: gs1.serial } : { kind: "awaitSerial" };
  if (tracking === "batch" && gs1?.batch) return { kind: "batch", batchNumber: gs1.batch, expiresOn: gs1.expiresOn };
  return { kind: "plain" };
}

// The batch fields of an Inleverans row: the main part (its amount is the
// row's Ta emot nu; an empty batch = the order's number) and the extra parts
// of Dela på flera batcher.
export interface ScanBatchPart {
  quantity: string;
  batchNumber: string;
  expiresOn: string;
}
export interface ScanRowBatches<P extends ScanBatchPart = ScanBatchPart> {
  batchNumber: string;
  expiresOn: string;
  parts: P[];
}

// Where on the row a scanned batch is counted. Manuellt vinner: a typed
// batch or date is never overwritten — an empty one is filled.
//   main     the row's own batch is the scanned one, or empty (filled)
//   part     an extra part already holds the batch: +1 there
//   newPart  another batch than the row's: a new part with 1
export type BatchScanPlacement =
  | { target: "main"; batchNumber: string; expiresOn: string }
  | { target: "part"; index: number; quantity: string; expiresOn: string }
  | { target: "newPart"; quantity: string; batchNumber: string; expiresOn: string };

export function placeBatchScan(current: ScanRowBatches, scanned: { batchNumber: string; expiresOn: string | null }): BatchScanPlacement {
  const date = scanned.expiresOn ?? "";
  if (sameNumber(current.batchNumber, scanned.batchNumber)) {
    return { target: "main", batchNumber: current.batchNumber, expiresOn: current.expiresOn || date };
  }
  const index = current.parts.findIndex((p) => sameNumber(p.batchNumber, scanned.batchNumber));
  if (index >= 0) {
    const part = current.parts[index]!;
    return { target: "part", index, quantity: String(round4((Number(part.quantity) || 0) + 1)), expiresOn: part.expiresOn || date };
  }
  if (current.batchNumber.trim() === "") {
    return { target: "main", batchNumber: scanned.batchNumber, expiresOn: current.expiresOn || date };
  }
  return { target: "newPart", quantity: "1", batchNumber: scanned.batchNumber, expiresOn: date };
}

// The row (of `lists`: rowId → the numbers entered) that already holds a
// serienummer — Postgres compares them with lower(). null = it is new.
export function serialScanDuplicate(lists: Record<string, string[]>, serialNumber: string): string | null {
  for (const [rowId, list] of Object.entries(lists)) {
    if (list.some((s) => sameNumber(s, serialNumber))) return rowId;
  }
  return null;
}

// A serienummerrad as the scan rules see it — in STYCK (the base unit; one
// number is one styck): what is left on the row, and the most this booking
// may hold (null = no cap here). `locationId` = the place chosen for the
// row (Utleverans), null/omitted = any.
export interface SerialScanRow {
  id: string;
  articleId: string;
  remainingStyck: number;
  maxStyck: number | null;
  date?: string | null;
  locationId?: string | null;
}

// The row a scanned number of the article goes on — as countScan chooses:
// by date, the first row still short of its remaining amount, else the
// first with room under its cap. null = every row is full.
export function serialScanRow<R extends SerialScanRow>(rows: R[], articleId: string, counts: Record<string, number>): R | null {
  const candidates = byScanDate(rows.filter((r) => r.articleId === articleId));
  const current = (r: R) => counts[r.id] ?? 0;
  return (
    candidates.find((r) => current(r) < r.remainingStyck && (r.maxStyck === null || current(r) < r.maxStyck)) ??
    candidates.find((r) => r.maxStyck === null || current(r) < r.maxStyck) ??
    null
  );
}

// A cell of GET /stock/batch-balances, narrowed: one batch or serienummer on
// one place.
export interface ScanStockCell {
  articleId: string;
  locationId: string | null;
  blocked: boolean;
  batchId: string | null;
  batchNumber: string | null;
  batchKind?: "batch" | "serial" | null;
  quantity: string | number;
}

function cellsNamed<C extends ScanStockCell>(cells: C[], number: string, serial: boolean, articleIds: Set<string>): C[] {
  return cells.filter(
    (c) =>
      c.batchId !== null &&
      c.batchNumber !== null &&
      (c.batchKind === "serial") === serial &&
      sameNumber(c.batchNumber, number) &&
      Number(c.quantity) > 0 &&
      articleIds.has(c.articleId)
  );
}

// Utleverans: a scanned serienummer picks that number on its article's row
// — without the article being scanned first. `picked`: rowId → the chosen
// serial ids. `articleIds` narrows to the article a GS1 code named.
// null = the number does not stand in stock for any serienummerrad here.
export type SerialScanOutcome<C extends ScanStockCell> =
  | { kind: "picked"; rowId: string; serialId: string; cell: C; count: number; over: boolean }
  | { kind: "already"; rowId: string; cell: C }
  // On a spärrad lagerplats: never drawn from.
  | { kind: "blocked"; cell: C }
  // On another place than the one chosen for the row.
  | { kind: "otherLocation"; rowId: string; cell: C }
  // Every row of the article already holds all it may (överplock).
  | { kind: "full"; cell: C };

export function matchSerialScan<C extends ScanStockCell>(
  serialNumber: string,
  cells: C[],
  rows: SerialScanRow[],
  picked: Record<string, string[]>,
  articleIds?: string[] | null
): SerialScanOutcome<C> | null {
  const onOrder = new Set(rows.map((r) => r.articleId).filter((id) => !articleIds || articleIds.includes(id)));
  const cell = cellsNamed(cells, serialNumber, true, onOrder)[0];
  if (!cell) return null;
  const serialId = cell.batchId!;
  const holder = rows.find((r) => (picked[r.id] ?? []).includes(serialId));
  if (holder) return { kind: "already", rowId: holder.id, cell };
  if (cell.blocked) return { kind: "blocked", cell };
  const counts = Object.fromEntries(rows.map((r) => [r.id, (picked[r.id] ?? []).length]));
  const row = serialScanRow(rows, cell.articleId, counts);
  if (!row) return { kind: "full", cell };
  if (row.locationId && row.locationId !== cell.locationId) return { kind: "otherLocation", rowId: row.id, cell };
  const count = (counts[row.id] ?? 0) + 1;
  return { kind: "picked", rowId: row.id, serialId, cell, count, over: count > row.remainingStyck };
}

// Utleverans: a scanned batch chooses that batch on its article's row — one
// chosen batch per row. `chosen` is the row's batch choice ("" =
// Automatiskt). Rows are tried by date: one that already has the batch, else
// the first still on Automatiskt. null = the batch does not stand in stock
// for any batchstyrd rad here.
export interface BatchScanRow {
  id: string;
  articleId: string;
  chosen: string;
  date?: string | null;
  locationId?: string | null;
}
export type BatchScanOutcome<C extends ScanStockCell> =
  | { kind: "chosen"; rowId: string; batchId: string; cell: C }
  // Every row of the article has another batch chosen.
  | { kind: "otherBatch"; rowId: string; cell: C }
  | { kind: "blocked"; cell: C }
  | { kind: "otherLocation"; rowId: string; cell: C };

export function matchBatchScan<C extends ScanStockCell>(
  batchNumber: string,
  cells: C[],
  rows: BatchScanRow[],
  articleIds?: string[] | null
): BatchScanOutcome<C> | null {
  const onOrder = new Set(rows.map((r) => r.articleId).filter((id) => !articleIds || articleIds.includes(id)));
  const named = cellsNamed(cells, batchNumber, false, onOrder);
  const first = named[0];
  if (!first) return null;
  const batchId = first.batchId!;
  const candidates = byScanDate(rows.filter((r) => r.articleId === first.articleId));
  const row = candidates.find((r) => r.chosen === batchId) ?? candidates.find((r) => r.chosen === "");
  if (!row) return { kind: "otherBatch", rowId: candidates[0]!.id, cell: first };
  const reachable = named.filter((c) => c.batchId === batchId && (!row.locationId || c.locationId === row.locationId));
  if (reachable.length === 0) return { kind: "otherLocation", rowId: row.id, cell: first };
  const open = reachable.find((c) => !c.blocked);
  if (!open) return { kind: "blocked", cell: reachable[0]! };
  return { kind: "chosen", rowId: row.id, batchId, cell: open };
}
