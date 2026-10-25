// Bankavstämning — pure helpers for the reconciliation page, the statement
// import dialog and the Bokför dialog. Types live in lib/types.ts.
import { API_URL, ApiError } from "./api";
import { round2 } from "./format";
import { splitVat, splitVatApplies } from "./splitVat";
import { emptyRow, type EditorRow } from "./verificationRows";
import type { BankAccount, BankCsvMapping, BankMatchKind, BankStatementEntry } from "./types";
import type { VatCodeView } from "./vatCodes";

export const BANK_MATCH_KIND_LABELS: Record<BankMatchKind, string> = {
  auto: "Automatisk",
  manual: "Manuell",
  created: "Bokförd från posten",
  opening: "Startpunkt",
};

export const BANK_RULE_DIRECTION_LABELS = { in: "In", out: "Ut", both: "Båda" } as const;

export function sumAmounts(items: readonly { amount: number }[]): number {
  return round2(items.reduce((sum, item) => sum + item.amount, 0));
}

// "yyyy-mm-dd" of the current day in Swedish local time.
export function todayIso(): string {
  return new Date().toLocaleDateString("sv-SE");
}

// The default period of the reconciliation page: the current calendar year up
// to today.
export function defaultPeriod(): { from: string; to: string } {
  const to = todayIso();
  return { from: `${to.slice(0, 4)}-01-01`, to };
}

export function isIsoDate(value: string | undefined | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

// POST of a multipart form (the file upload endpoints). apiFetch always sets
// a JSON Content-Type for a body, which would break the multipart boundary.
export async function postMultipart<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { method: "POST", body: form, credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code, body);
  return body as T;
}

// Header names the banks' CSV exports use, lower-cased, tried in order.
const CSV_GUESSES = {
  dateColumn: ["bokföringsdag", "bokföringsdatum", "bokf.dag", "datum", "transaktionsdatum", "date"],
  amountColumn: ["belopp", "summa", "amount"],
  textColumn: ["text", "transaktion", "beskrivning", "meddelande", "referens/text", "description"],
  balanceColumn: ["saldo", "bokfört saldo", "balance"],
  valueDateColumn: ["valutadag", "valutadatum", "valuta dag"],
  referenceColumn: ["referens", "ocr", "meddelande/ocr", "reference"],
} as const;

export type CsvColumnKey = keyof typeof CSV_GUESSES;

// A starting mapping for the Importera kontoutdrag dialog: the account's saved
// mapping when it is still valid for these headers, otherwise a guess from the
// header names.
export function initialCsvMapping(headers: readonly string[], saved: BankCsvMapping | null): BankCsvMapping {
  if (saved && [saved.dateColumn, saved.amountColumn, saved.textColumn].every((h) => headers.includes(h))) {
    return { ...saved };
  }
  const lower = headers.map((h) => h.trim().toLowerCase());
  const pick = (key: CsvColumnKey): string => {
    for (const guess of CSV_GUESSES[key]) {
      const index = lower.indexOf(guess);
      if (index >= 0) return headers[index]!;
    }
    return "";
  };
  const mapping: BankCsvMapping = {
    delimiter: saved?.delimiter ?? ";",
    dateColumn: pick("dateColumn"),
    amountColumn: pick("amountColumn"),
    textColumn: pick("textColumn"),
    decimalComma: saved?.decimalComma ?? true,
    skipRows: saved?.skipRows ?? 0,
  };
  for (const key of ["balanceColumn", "valueDateColumn", "referenceColumn"] as const) {
    const hit = pick(key);
    if (hit) mapping[key] = hit;
  }
  return mapping;
}

// What the API gets: optional columns left empty are dropped.
export function cleanCsvMapping(mapping: BankCsvMapping): BankCsvMapping {
  const out: BankCsvMapping = {
    dateColumn: mapping.dateColumn,
    amountColumn: mapping.amountColumn,
    textColumn: mapping.textColumn,
    decimalComma: mapping.decimalComma ?? true,
    skipRows: mapping.skipRows ?? 0,
  };
  if (mapping.delimiter) out.delimiter = mapping.delimiter;
  for (const key of ["balanceColumn", "valueDateColumn", "referenceColumn"] as const) {
    if (mapping[key]) out[key] = mapping[key];
  }
  return out;
}

export function csvMappingComplete(mapping: BankCsvMapping): boolean {
  return mapping.dateColumn !== "" && mapping.amountColumn !== "" && mapping.textColumn !== "";
}

// The Bokför dialog's starting rows: row 1 is the bank account with the
// entry's amount (in = debet, out = kredit); row 2 is the counter account from
// the entry's bank rule (empty when no rule fits). A rule with a Momskod
// splits row 2 with the same help as the verification table, so the amount on
// the bank row stays the gross amount. A second blank row is left to type in.
export function bookRowsForEntry(
  entry: Pick<BankStatementEntry, "amount" | "text" | "ruleSuggestion">,
  bankAccount: Pick<BankAccount, "ledgerAccount" | "ledgerAccountName">,
  vatCodes: readonly VatCodeView[],
  accountName: (number: string) => string
): { rows: EditorRow[]; notice: string | null } {
  const gross = round2(Math.abs(entry.amount));
  const incoming = entry.amount > 0;
  const bankSide = incoming ? "debit" : "credit";
  const counterSide = incoming ? "credit" : "debit";
  const rows: EditorRow[] = [
    emptyRow({
      accountNumber: bankAccount.ledgerAccount,
      accountName: bankAccount.ledgerAccountName ?? accountName(bankAccount.ledgerAccount),
      description: entry.text.slice(0, 255),
      [bankSide]: String(gross),
    }),
  ];
  const rule = entry.ruleSuggestion;
  if (!rule) {
    rows.push(emptyRow({ [counterSide]: String(gross) }));
    return { rows, notice: null };
  }

  const description = (rule.description ?? entry.text).slice(0, 255);
  const code = rule.vatCode ? vatCodes.find((c) => c.code === rule.vatCode) : undefined;
  let notice: string | null = null;
  let counterAmount = gross;
  const extra: EditorRow[] = [];
  if (code && splitVatApplies(code)) {
    const split = splitVat(gross, code, counterSide);
    if (split.error) {
      notice = split.error;
    } else {
      counterAmount = split.net;
      for (const r of split.rows) {
        extra.push(
          emptyRow({
            accountNumber: r.accountNumber,
            accountName: accountName(r.accountNumber),
            description: r.description,
            [r.side]: String(r.amount),
          })
        );
      }
    }
  } else if (rule.vatCode && !code) {
    notice = `Regelns momskod ${rule.vatCode} finns inte längre — välj moms för hand.`;
  }
  rows.push(
    emptyRow({
      accountNumber: rule.accountNumber,
      accountName: accountName(rule.accountNumber),
      description,
      [counterSide]: String(counterAmount),
      costCenterId: rule.costCenterId ?? "",
      projectId: rule.projectId ?? "",
    }),
    ...extra
  );
  return { rows, notice };
}
