import { createHash } from "node:crypto";
import { round2, type BankCsvMappingInput } from "@navet/shared";
import { decodeBuffer, detectDelimiter, parseRecords } from "../../import/service/csv.js";
import { BankStatementCsvMappingError } from "./banking.errors.js";
import { STATEMENT_DEDUPE_KEY_MAX, type ParsedStatement, type ParsedStatementEntry } from "./iso20022/camt053-parser.js";

// Bankavstämning: the CSV alternative to camt.053 — an export from the
// internet bank with a column mapping (header names) saved per bank account.
// Pure: bytes + mapping → the same ParsedStatement the camt.053 parser gives,
// so the import has one shape to store. No bank reference exists in a CSV, so
// the dedupe key is a content hash (day, amount, text, reference) with a
// per-file counter — the same export twice, or an overlapping one, skips
// what is already read.

export interface ParsedBankCsv {
  headers: string[];
  statement: ParsedStatement;
  warnings: string[];
}

const MAX_ROWS = 10_000;

// Accepts the date formats Swedish bank exports use: 2026-09-30, 20260930,
// 30.09.2026, 30/09/2026, 2026/09/30 (and a time after the date).
export function parseBankCsvDate(raw: string): string | null {
  const value = raw.trim().slice(0, 10);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return checkDate(m[1]!, m[2]!, m[3]!);
  m = /^(\d{4})\/(\d{2})\/(\d{2})/.exec(value);
  if (m) return checkDate(m[1]!, m[2]!, m[3]!);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.slice(0, 8));
  if (m && value.length === 8) return checkDate(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(value);
  if (m) return checkDate(m[3]!, m[2]!.padStart(2, "0"), m[1]!.padStart(2, "0"));
  return null;
}

function checkDate(y: string, mo: string, d: string): string | null {
  const iso = `${y}-${mo}-${d}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

// "1 234,56" → 1234.56; "-1.234,56" → -1234.56; "1,234.56" (decimalComma
// false) → 1234.56. Without a stated convention the LAST separator is the
// decimal mark (Swedish exports write the comma). Trailing currency
// ("kr", "SEK") and a Unicode minus are tolerated.
function cleanAmount(raw: string): string {
  let s = raw
    .replace(/[\s  ]/g, "")
    .replace(/kr$|SEK$/i, "")
    .replace(/−/g, "-");
  // "123,45-" (some exports put the sign last).
  if (/^\d.*-$/.test(s)) s = `-${s.slice(0, -1)}`;
  return s;
}

// Without a stated convention, "1.234" is read as 1,234 — but it could be a
// thousands point (1 234). The parser warns so the user sets decimalComma.
export function isAmbiguousCsvAmount(raw: string, decimalComma?: boolean): boolean {
  return decimalComma === undefined && /^[+-]?\d{1,3}\.\d{3}$/.test(cleanAmount(raw));
}

export function parseBankCsvAmount(raw: string, decimalComma?: boolean): number | null {
  let s = cleanAmount(raw);
  if (s === "") return null;
  if (decimalComma === true) s = s.replace(/\./g, "").replace(",", ".");
  else if (decimalComma === false) s = s.replace(/,/g, "");
  else {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma !== -1 && lastDot !== -1) s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (lastComma !== -1) s = s.replace(",", ".");
  }
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const value = Number(s);
  return Number.isFinite(value) ? round2(value) : null;
}

// The headers of the file as the mapping step needs them (after skipRows).
export function readBankCsvHeaders(buf: Buffer, opts: { delimiter?: ";" | "," | "\t"; skipRows?: number } = {}): string[] {
  const { text } = decodeBuffer(buf);
  const lines = text.split(/\r\n|\r|\n/);
  const skipped = lines.slice(opts.skipRows ?? 0).join("\n");
  const firstLineEnd = skipped.search(/[\r\n]/);
  const firstLine = firstLineEnd === -1 ? skipped : skipped.slice(0, firstLineEnd);
  const delimiter = opts.delimiter ?? detectDelimiter(firstLine);
  const records = parseRecords(skipped, delimiter);
  return (records[0] ?? []).map((h) => h.trim());
}

// In which order the file lists its rows. "ascending" = oldest first (the
// last row is the latest), "descending" = newest first, "unknown" = one day
// without a balance chain that settles it (read as ascending).
export function rowOrder(rows: readonly { bookingDate: string; amount: number; balance: number | null }[]): "ascending" | "descending" | "unknown" {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last || rows.length < 2) return "unknown";
  if (first.bookingDate < last.bookingDate) return "ascending";
  if (first.bookingDate > last.bookingDate) return "descending";
  if (rows.some((r) => r.balance === null)) return "unknown";
  // Ascending: balance[i] = balance[i−1] + amount[i]. Descending: the file's
  // previous row is the later one, so balance[i−1] = balance[i] + amount[i−1].
  let ascending = true;
  let descending = true;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]!;
    const cur = rows[i]!;
    if (round2(prev.balance! + cur.amount) !== round2(cur.balance!)) ascending = false;
    if (round2(cur.balance! + prev.amount) !== round2(prev.balance!)) descending = false;
  }
  if (ascending && !descending) return "ascending";
  if (descending && !ascending) return "descending";
  return "unknown";
}

function columnIndex(headers: string[], name: string, what: string): number {
  const wanted = name.trim().toLowerCase();
  const index = headers.findIndex((h) => h.trim().toLowerCase() === wanted);
  if (index === -1) throw new BankStatementCsvMappingError(`Kolumnen "${name}" (${what}) finns inte i filen`);
  return index;
}

// `account` is the identifier the statement is reported under; `dedupeScope`
// (default the same) is what the dedupe key is hashed on — the service passes
// the bank account's id, which outlives a corrected or learned identifier.
export function parseBankStatementCsv(buf: Buffer, mapping: BankCsvMappingInput, account: string, currency: string, dedupeScope = account): ParsedBankCsv {
  const { text } = decodeBuffer(buf);
  const lines = text.split(/\r\n|\r|\n/);
  const body = lines.slice(mapping.skipRows ?? 0).join("\n");
  const firstLineEnd = body.search(/[\r\n]/);
  const firstLine = firstLineEnd === -1 ? body : body.slice(0, firstLineEnd);
  const delimiter = mapping.delimiter ?? detectDelimiter(firstLine);
  const records = parseRecords(body, delimiter);
  if (records.length === 0) throw new BankStatementCsvMappingError("Filen är tom eller saknar rubrikrad");
  if (records.length - 1 > MAX_ROWS) throw new BankStatementCsvMappingError(`Filen är för stor — max ${MAX_ROWS} rader`);
  const headers = records[0]!.map((h) => h.trim());
  const dateIx = columnIndex(headers, mapping.dateColumn, "bokföringsdag");
  const amountIx = columnIndex(headers, mapping.amountColumn, "belopp");
  const textIx = columnIndex(headers, mapping.textColumn, "text");
  const balanceIx = mapping.balanceColumn ? columnIndex(headers, mapping.balanceColumn, "saldo") : null;
  const valueDateIx = mapping.valueDateColumn ? columnIndex(headers, mapping.valueDateColumn, "valutadag") : null;
  const referenceIx = mapping.referenceColumn ? columnIndex(headers, mapping.referenceColumn, "referens") : null;

  const warnings: string[] = [];
  const errors: string[] = [];
  const ambiguousAmounts: string[] = [];
  const hashCounts = new Map<string, number>();
  const entries: (ParsedStatementEntry & { balance: number | null })[] = [];
  records.slice(1).forEach((record, i) => {
    const line = i + 2 + (mapping.skipRows ?? 0);
    const cell = (ix: number | null) => (ix === null ? "" : (record[ix] ?? "").trim());
    const rawDate = cell(dateIx);
    const rawAmount = cell(amountIx);
    if (rawDate === "" && rawAmount === "") return; // a blank line
    if (rawAmount === "") {
      // A summary/footer line ("Summa", "Saldo …") — not a transaction.
      warnings.push(`Rad ${line} saknar belopp och hoppades över`);
      return;
    }
    const bookingDate = parseBankCsvDate(rawDate);
    if (!bookingDate) {
      errors.push(`Rad ${line}: "${rawDate.slice(0, 20)}" är inget datum`);
      return;
    }
    const amount = parseBankCsvAmount(rawAmount, mapping.decimalComma);
    if (amount === null) {
      errors.push(`Rad ${line}: "${rawAmount.slice(0, 20)}" är inget belopp`);
      return;
    }
    if (amount === 0) {
      warnings.push(`Rad ${line} har belopp 0 och hoppades över`);
      return;
    }
    if (isAmbiguousCsvAmount(rawAmount, mapping.decimalComma)) ambiguousAmounts.push(`rad ${line} "${rawAmount}"`);
    const valueDate = valueDateIx === null || cell(valueDateIx) === "" ? null : parseBankCsvDate(cell(valueDateIx));
    const reference = referenceIx === null || cell(referenceIx) === "" ? null : cell(referenceIx).slice(0, 140);
    const balanceRaw = balanceIx === null ? "" : cell(balanceIx);
    const balance = balanceRaw === "" ? null : parseBankCsvAmount(balanceRaw, mapping.decimalComma);
    const lineText = (cell(textIx) || reference || "Bankpost").slice(0, 255);
    const base = createHash("sha256").update(JSON.stringify([dedupeScope, bookingDate, amount.toFixed(2), lineText, reference])).digest("hex");
    const n = (hashCounts.get(base) ?? 0) + 1;
    hashCounts.set(base, n);
    const dedupeKey = `${dedupeScope}|csv:${base}#${n}`;
    if (dedupeKey.length > STATEMENT_DEDUPE_KEY_MAX) throw new BankStatementCsvMappingError("Kontots identifierare är för lång");
    entries.push({
      bookingDate,
      valueDate,
      amount,
      currency,
      text: lineText,
      reference,
      counterparty: null,
      reversal: false,
      references: reference ? [reference] : [],
      details: { transactions: [], balance },
      dedupeKey,
      position: i,
      balance,
    });
  });
  if (errors.length > 0) {
    const shown = errors.slice(0, 5).join("; ");
    throw new BankStatementCsvMappingError(errors.length > 5 ? `${shown} … (${errors.length} rader)` : shown);
  }
  if (ambiguousAmounts.length > 0) {
    const shown = ambiguousAmounts.slice(0, 3).join(", ");
    warnings.push(
      `Beloppet på ${shown}${ambiguousAmounts.length > 3 ? ` och ${ambiguousAmounts.length - 3} rader till` : ""} har en ensam punkt följd av tre siffror och lästes som decimaltecken — ange i kolumnmappningen om filen använder decimalkomma eller decimalpunkt`
    );
  }

  // Exports come newest-first or oldest-first; the closing balance is the
  // chronologically last row's, the opening balance the first row's before
  // its own amount. The dates decide when they differ; within one day the
  // balance column's chain does (each row's balance = the previous row's +
  // its amount, read in one direction or the other).
  const order = rowOrder(entries);
  const chronoFirst = order === "descending" ? entries[entries.length - 1] : entries[0];
  const chronoLast = order === "descending" ? entries[0] : entries[entries.length - 1];
  if (order === "unknown" && entries.length > 1 && entries.every((e) => e.balance !== null)) {
    warnings.push("Saldokolumnen följer inte beloppen rad för rad — kontrollera att utgående saldo blev rätt");
  }
  const dates = entries.map((e) => e.bookingDate).sort();
  const closingBalance = chronoLast?.balance ?? null;
  const openingBalance = chronoFirst && chronoFirst.balance !== null ? round2(chronoFirst.balance - chronoFirst.amount) : null;

  return {
    headers,
    warnings,
    statement: {
      statementId: null,
      accountRaw: account,
      accountIdentifier: account,
      currency,
      fromDate: dates[0] ?? null,
      toDate: dates[dates.length - 1] ?? null,
      openingBalance,
      closingBalance,
      closingBalanceDate: closingBalance === null ? null : chronoLast!.bookingDate,
      entries: entries.map(({ balance: _balance, ...entry }) => entry),
    },
  };
}
