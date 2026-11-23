// Bekräfta rader on the inköpsorder card: the supplier's Bekräftat
// leveransdatum per order row. A row is confirmed by its own date, else the
// order's — the same coalesce as the IO list's Bekräftad av leverantör
// (supplierConfirmationSql in the purchase repository), so the card's
// Bekräftat column and the list never disagree. Pure: no React, no fetch
// (test web-purchase-row-confirmation.test.ts).

export interface ConfirmationOrder {
  status: string;
  expectedDeliveryDate: string | null;
  confirmedDeliveryDate: string | null;
}

export interface ConfirmationRow {
  id: string;
  quantityOrdered: string;
  quantityReceived: string;
  expectedDeliveryDate: string | null;
  confirmedDeliveryDate: string | null;
}

// The statuses the list derives a confirmation for (a whitelist, like every
// status set): there is still something to come.
const OPEN_STATUSES: ReadonlySet<string> = new Set(["draft", "sent", "confirmed", "partially_received"]);

export function hasRest(row: ConfirmationRow): boolean {
  return Number(row.quantityReceived) < Number(row.quantityOrdered);
}

// The row's Bekräftat leveransdatum as it counts: its own, else the order's.
export function rowConfirmedDate(row: ConfirmationRow, order: ConfirmationOrder): string | null {
  return row.confirmedDeliveryDate ?? order.confirmedDeliveryDate;
}

// The row's Önskat leveransdatum as it counts: its own, else the order's —
// what Som önskat fills in.
export function rowWantedDate(row: ConfirmationRow, order: ConfirmationOrder): string | null {
  return row.expectedDeliveryDate ?? order.expectedDeliveryDate;
}

// The card's Bekräftat column: the date when there is one; "missing" for a
// row the supplier still owes a confirmation for (rest left on an open
// order, marked like the list's Nej); "none" otherwise (–).
export type RowConfirmationCell = { kind: "date"; date: string } | { kind: "missing" } | { kind: "none" };

export function rowConfirmationCell(row: ConfirmationRow, order: ConfirmationOrder): RowConfirmationCell {
  const date = rowConfirmedDate(row, order);
  if (date) return { kind: "date", date };
  return OPEN_STATUSES.has(order.status) && hasRest(row) ? { kind: "missing" } : { kind: "none" };
}

// The rows the dialog lists: the ones with something left to receive.
export function confirmableRows<T extends ConfirmationRow>(rows: readonly T[]): T[] {
  return rows.filter(hasRest);
}

// The dialog's entries start at each row's OWN date ("" = follows the order,
// as in Ändra), so an untouched row is never written.
export function initialConfirmationEntries(rows: readonly ConfirmationRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.id, r.confirmedDeliveryDate ?? ""]));
}

// Alla som önskat: every listed row gets its own wanted date. A row without
// any Önskat leveransdatum keeps what it has.
export function fillWithWantedDates(
  rows: readonly ConfirmationRow[],
  order: ConfirmationOrder,
  entries: Record<string, string>
): Record<string, string> {
  const next = { ...entries };
  for (const row of rows) {
    const wanted = rowWantedDate(row, order);
    if (wanted) next[row.id] = wanted;
  }
  return next;
}

// What Spara sends: one PATCH per row whose entry differs from its stored
// own date ("" clears it — the row follows the order again).
export function rowConfirmationPatches(
  rows: readonly ConfirmationRow[],
  entries: Record<string, string>
): { rowId: string; confirmedDeliveryDate: string | null }[] {
  const patches: { rowId: string; confirmedDeliveryDate: string | null }[] = [];
  for (const row of rows) {
    const entry = entries[row.id];
    if (entry === undefined) continue;
    const next = entry === "" ? null : entry;
    if (next !== row.confirmedDeliveryDate) patches.push({ rowId: row.id, confirmedDeliveryDate: next });
  }
  return patches;
}

// A new Bekräftat leveransdatum in the order header (the user 2026-11-22:
// confirming the whole order left rows confirmed earlier on their own
// dates): the rows still to come whose own date differs from it. Only when
// the header's date changes to a date — clearing it asks nothing. The card
// asks whether they should follow (`rowsFollowConfirmed` on the header PATCH,
// which clears the own date on every row still to come).
export function rowsKeepingOwnConfirmedDate<T extends ConfirmationRow>(
  rows: readonly T[],
  previous: string | null,
  next: string | null
): T[] {
  if (next === null || next === previous) return [];
  return rows.filter((r) => hasRest(r) && r.confirmedDeliveryDate !== null && r.confirmedDeliveryDate !== next);
}

// The question: how many rows and which dates they keep.
export function rowsFollowQuestion(rows: readonly ConfirmationRow[], next: string): string {
  const dates = [...new Set(rows.map((r) => r.confirmedDeliveryDate!))].sort().join(", ");
  const subject = rows.length === 1 ? "En rad har" : `${rows.length} rader har`;
  const them = rows.length === 1 ? "den" : "de";
  return (
    `${subject} ett eget bekräftat leveransdatum (${dates}). Ska ${them} följa orderns nya datum ${next}?\n\n` +
    `Uppdatera raderna = raderna följer ordern\nAvbryt = raderna behåller sina datum`
  );
}
