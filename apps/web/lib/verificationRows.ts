// State and conversions for the verification rows table
// (components/economy/VerificationRowsEditor.tsx), shared by the verifikat
// card, the new-verification page and the template page. Pure helpers — the
// editor keeps amounts as the strings the user typed.
import { round2 } from "./format";
import type { VerificationRow, VerificationTemplateRow } from "./types";

export interface EditorRow {
  // Stable React key / focus target — never sent to the server.
  key: string;
  accountNumber: string;
  // Display only (the name the card/template carried for the row's account).
  accountName: string;
  description: string;
  debit: string;
  credit: string;
  // Momskod picked on the row; the split happens when the cell is left and
  // the code is then cleared. Never stored.
  vatCode: string;
}

let rowSeq = 0;
export function newRowKey(): string {
  rowSeq += 1;
  return `r${rowSeq}`;
}

export function emptyRow(partial: Partial<EditorRow> = {}): EditorRow {
  return { key: newRowKey(), accountNumber: "", accountName: "", description: "", debit: "", credit: "", vatCode: "", ...partial };
}

export function amountOf(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function amountText(n: number): string {
  return n > 0 ? String(round2(n)) : "";
}

export function rowsFromVerification(rows: VerificationRow[]): EditorRow[] {
  return rows.map((r) =>
    emptyRow({
      accountNumber: r.accountNumber,
      accountName: r.accountName,
      description: r.description ?? "",
      debit: amountText(Number(r.debit)),
      credit: amountText(Number(r.credit)),
    })
  );
}

export function rowsFromTemplate(rows: VerificationTemplateRow[]): EditorRow[] {
  return rows.map((r) =>
    emptyRow({
      accountNumber: r.accountNumber,
      accountName: r.accountName ?? "",
      description: r.description ?? "",
      debit: r.debit ? amountText(r.debit) : "",
      credit: r.credit ? amountText(r.credit) : "",
    })
  );
}

export function isBlankRow(row: EditorRow): boolean {
  return (
    row.accountNumber === "" &&
    row.description.trim() === "" &&
    amountOf(row.debit) === 0 &&
    amountOf(row.credit) === 0
  );
}

// At least two lines to start typing in.
export function withSpareRows(rows: EditorRow[], minimum = 2): EditorRow[] {
  const out = [...rows];
  while (out.length < minimum) out.push(emptyRow());
  return out;
}

export function rowTotals(rows: EditorRow[]): { debit: number; credit: number; diff: number } {
  const debit = round2(rows.reduce((sum, r) => sum + amountOf(r.debit), 0));
  const credit = round2(rows.reduce((sum, r) => sum + amountOf(r.credit), 0));
  return { debit, credit, diff: round2(debit - credit) };
}

// Motrad: a new row carries the difference on the side that balances the
// verification (more debit so far ⇒ credit), or nothing when it balances.
export function counterRow(rows: EditorRow[]): EditorRow {
  const { diff } = rowTotals(rows);
  return emptyRow({
    debit: diff < 0 ? amountText(-diff) : "",
    credit: diff > 0 ? amountText(diff) : "",
  });
}

// Dirty detection: the filled rows only, so spare blank rows never count.
export function rowsSignature(rows: EditorRow[]): string {
  return JSON.stringify(
    rows
      .filter((r) => !isBlankRow(r))
      .map((r) => [r.accountNumber, r.description.trim(), amountOf(r.debit), amountOf(r.credit)])
  );
}

export interface ApiVerificationRow {
  accountId: string;
  debit: number;
  credit: number;
  description?: string;
}

// The body of PUT /verifications/:id/rows (and POST /verifications): blank
// rows are dropped; every other row needs a known active account and exactly
// one of Debet/Kredit above zero.
export function toVerificationApiRows(
  rows: EditorRow[],
  accounts: { id: string; number: string }[]
): { rows: ApiVerificationRow[]; error: null } | { rows: null; error: string } {
  const out: ApiVerificationRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (isBlankRow(row)) continue;
    const n = i + 1;
    if (row.accountNumber === "") return { rows: null, error: `Rad ${n}: välj ett konto.` };
    const account = accounts.find((a) => a.number === row.accountNumber);
    if (!account) return { rows: null, error: `Rad ${n}: konto ${row.accountNumber} finns inte eller är inaktivt.` };
    const debit = amountOf(row.debit);
    const credit = amountOf(row.credit);
    if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
      return { rows: null, error: `Rad ${n}: ange ett belopp i antingen Debet eller Kredit.` };
    }
    const description = row.description.trim();
    out.push({ accountId: account.id, debit: round2(debit), credit: round2(credit), description: description || undefined });
  }
  return { rows: out, error: null };
}

export interface ApiTemplateRow {
  accountNumber: string;
  description?: string;
  debit: number | null;
  credit: number | null;
}

// Template rows: an account is required, amounts may be empty (filled in when
// the template is used) but never both sides.
export function toTemplateApiRows(
  rows: EditorRow[],
  accounts: { number: string }[]
): { rows: ApiTemplateRow[]; error: null } | { rows: null; error: string } {
  const out: ApiTemplateRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (isBlankRow(row)) continue;
    const n = i + 1;
    if (row.accountNumber === "") return { rows: null, error: `Rad ${n}: välj ett konto.` };
    if (!accounts.some((a) => a.number === row.accountNumber)) {
      return { rows: null, error: `Rad ${n}: konto ${row.accountNumber} finns inte eller är inaktivt.` };
    }
    const debit = amountOf(row.debit);
    const credit = amountOf(row.credit);
    if (debit < 0 || credit < 0 || (debit > 0 && credit > 0)) {
      return { rows: null, error: `Rad ${n}: ange belopp i antingen Debet eller Kredit, inte båda.` };
    }
    const description = row.description.trim();
    out.push({
      accountNumber: row.accountNumber,
      description: description || undefined,
      debit: debit > 0 ? round2(debit) : null,
      credit: credit > 0 ? round2(credit) : null,
    });
  }
  return { rows: out, error: null };
}

// Account search for the Konto cell: digits match the number from the start,
// anything else matches the name (or a number prefix); empty shows the first
// rows. `accounts` are already the active ones, in number order.
export function matchAccounts<T extends { number: string; name: string }>(accounts: T[], query: string, limit = 60): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return accounts.slice(0, limit);
  if (/^\d+$/.test(q)) return accounts.filter((a) => a.number.startsWith(q)).slice(0, limit);
  return accounts.filter((a) => a.name.toLowerCase().includes(q) || a.number.startsWith(q)).slice(0, limit);
}
