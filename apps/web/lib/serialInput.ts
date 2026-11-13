import type { BatchBalanceRow } from "./types";

// Serienummer (#8 etapp 2) — pure helpers for the serial number fields.

// Most numbers in one movement — the API refuses more (serial-numbers-too-many).
export const SERIAL_NUMBERS_MAX = 1000;

// Whether the numbers are created at the receipt (the stock is per number) or
// at the delivery (the stock is untracked, the number is given when it leaves).
export type SerialAssignedAt = "receipt" | "delivery";

// A pasted or scanned text into numbers: one per line (or tab), trimmed,
// empty lines dropped.
export function parseSerialText(text: string): string[] {
  return text
    .split(/[\r\n\t]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// Adds numbers to a list. Postgres compares the numbers with lower(), so a
// number that differs only in case is the same one. Returns the new list and
// the ones that were left out as already there.
export function addSerialNumbers(list: string[], incoming: string[]): { list: string[]; duplicates: string[] } {
  const seen = new Set(list.map((s) => s.toLowerCase()));
  const next = [...list];
  const duplicates: string[] = [];
  for (const raw of incoming) {
    const s = raw.trim();
    if (s === "") continue;
    const key = s.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(s);
      continue;
    }
    seen.add(key);
    next.push(s);
  }
  return { list: next, duplicates };
}

// A quantity (in the article's base unit) as a count of styck, or null when it
// is not a whole number of at least 1 — the API asks for whole numbers.
export function serialCountOf(quantity: number): number | null {
  if (!Number.isFinite(quantity) || quantity < 1 || !Number.isInteger(quantity)) return null;
  return quantity;
}

// The cells (place × number) of one article with a number in stock — the
// choices of a serienummerval. Blocked places can be seen but not chosen.
export function serialCells(rows: BatchBalanceRow[], articleId: string, locationId?: string | null): BatchBalanceRow[] {
  return rows.filter(
    (r) => r.articleId === articleId && r.batchId !== null && r.batchKind !== "batch" && Number(r.quantity) > 0 && (!locationId || r.locationId === locationId)
  );
}

// "Serienummer A, B och C" for a dialog; long lists are cut.
export function serialListText(numbers: string[], max = 10): string {
  if (numbers.length === 0) return "";
  const shown = numbers.slice(0, max);
  const rest = numbers.length - shown.length;
  const joined = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} och ${shown[shown.length - 1]}` : shown[0]!;
  return rest > 0 ? `${shown.join(", ")} och ${rest} till` : joined;
}

// The articles among the cells that have a serial number in stock — their
// choice is a serienummerval (serialIds), never a batch choice.
export function serialArticleIds(rows: BatchBalanceRow[]): Set<string> {
  return new Set(rows.filter((r) => r.batchKind === "serial").map((r) => r.articleId));
}
