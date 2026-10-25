// F2: CSV versions of the B6a financial reports. Pure builders (no DB, no
// pdfkit) — they flatten the hierarchical report bodies to semicolon rows in
// the same visual order as the web pages and the PDFs, using the shared
// Excel-friendly CSV conventions from @navet/shared.
import { buildCsv, type CsvColumn, type DimensionRef } from "@navet/shared";
import { dimensionText } from "./dimension-check.js";
import type {
  BalanceSheetBody,
  GeneralLedgerResponse,
  IncomeStatementBody,
  IncomeStatementColumn,
  VerificationListResponse,
} from "./financial-reports.service.js";

// All three-column reports share the row shape { konto, label, amount }.
interface FlatRow {
  konto: string;
  label: string;
  amount: number | null;
}

const FLAT_COLUMNS: CsvColumn<FlatRow>[] = [
  { label: "Konto", value: (r) => r.konto },
  { label: "Benämning", value: (r) => r.label },
  { label: "Belopp", value: (r) => r.amount, format: "money" },
];

export function buildBalanceSheetCsv(report: BalanceSheetBody): string {
  const rows: FlatRow[] = [];
  const section = (label: string, groups: BalanceSheetBody["assets"]["groups"], total: number, sumLabel: string) => {
    rows.push({ konto: "", label, amount: null }); // section heading, like the PDF/web page
    for (const group of groups) {
      rows.push({ konto: "", label: group.label, amount: null });
      for (const line of group.lines) {
        for (const account of line.accounts) {
          rows.push({ konto: account.accountNumber, label: account.accountName, amount: account.amount });
        }
        if (line.computed || line.accounts.length !== 1) {
          rows.push({ konto: "", label: line.label, amount: line.total });
        }
      }
      rows.push({ konto: "", label: `Summa ${group.label.toLowerCase()}`, amount: group.total });
    }
    rows.push({ konto: "", label: sumLabel, amount: total });
  };
  section("Tillgångar", report.assets.groups, report.assets.total, "Summa tillgångar");
  section(
    "Eget kapital och skulder",
    report.equityAndLiabilities.groups,
    report.equityAndLiabilities.total,
    "Summa eget kapital och skulder"
  );
  return buildCsv(FLAT_COLUMNS, rows);
}

export function buildIncomeStatementCsv(report: IncomeStatementBody): string {
  const rows: FlatRow[] = [];
  for (const entry of report.entries) {
    if (entry.kind === "line") {
      for (const account of entry.accounts) {
        rows.push({ konto: account.accountNumber, label: account.accountName, amount: account.amount });
      }
      if (entry.accounts.length !== 1) {
        rows.push({ konto: "", label: entry.label, amount: entry.total });
      }
    } else {
      rows.push({ konto: "", label: entry.label, amount: entry.total });
    }
  }
  rows.push({ konto: "", label: "Periodens resultat", amount: report.result });
  return buildCsv(FLAT_COLUMNS, rows);
}

// Resultaträkningen per objekt: Konto, Benämning, one column per objekt
// (code and name as the heading) and Totalt — the same rows as the flat CSV.
export function buildGroupedIncomeStatementCsv(report: IncomeStatementBody, columns: IncomeStatementColumn[]): string {
  type GroupedRow = FlatRow & { amounts: (number | null)[] };
  const csvColumns: CsvColumn<GroupedRow>[] = [
    { label: "Konto", value: (r) => r.konto },
    { label: "Benämning", value: (r) => r.label },
    ...columns.map(
      (column, index): CsvColumn<GroupedRow> => ({
        label: column.id === null ? column.name : `${column.code} ${column.name}`,
        value: (r) => r.amounts[index] ?? null,
        format: "money",
      })
    ),
    { label: "Totalt", value: (r) => r.amount, format: "money" },
  ];
  const rows: GroupedRow[] = [];
  const amountsOf = (amounts: number[] | undefined) => columns.map((_, index) => amounts?.[index] ?? 0);
  for (const entry of report.entries) {
    if (entry.kind === "line") {
      for (const account of entry.accounts) {
        rows.push({ konto: account.accountNumber, label: account.accountName, amount: account.amount, amounts: amountsOf(account.amounts) });
      }
      if (entry.accounts.length !== 1) rows.push({ konto: "", label: entry.label, amount: entry.total, amounts: amountsOf(entry.amounts) });
    } else {
      rows.push({ konto: "", label: entry.label, amount: entry.total, amounts: amountsOf(entry.amounts) });
    }
  }
  const resultEntry = [...report.entries].reverse().find((entry) => entry.kind === "subtotal");
  rows.push({ konto: "", label: "Periodens resultat", amount: report.result, amounts: amountsOf(resultEntry?.amounts) });
  return buildCsv(csvColumns, rows);
}

interface LedgerFlatRow {
  konto: string;
  kontonamn: string;
  datum: string;
  verifikat: string;
  text: string;
  kostnadsstalle: DimensionRef | null;
  projekt: DimensionRef | null;
  debet: number | null;
  kredit: number | null;
  saldo: number | null;
}

const LEDGER_COLUMNS: CsvColumn<LedgerFlatRow>[] = [
  { label: "Konto", value: (r) => r.konto },
  { label: "Kontonamn", value: (r) => r.kontonamn },
  { label: "Datum", value: (r) => r.datum },
  { label: "Verifikat", value: (r) => r.verifikat },
  { label: "Text", value: (r) => r.text },
  { label: "Kostnadsställe", value: (r) => dimensionText(r.kostnadsstalle) },
  { label: "Projekt", value: (r) => dimensionText(r.projekt) },
  { label: "Debet", value: (r) => r.debet, format: "money" },
  { label: "Kredit", value: (r) => r.kredit, format: "money" },
  { label: "Saldo", value: (r) => r.saldo, format: "money" },
];

export function buildGeneralLedgerCsv(report: GeneralLedgerResponse): string {
  const rows: LedgerFlatRow[] = [];
  for (const account of report.accounts) {
    rows.push({
      konto: account.accountNumber,
      kontonamn: account.accountName,
      datum: "",
      verifikat: "",
      text: "Ingående saldo",
      kostnadsstalle: null,
      projekt: null,
      debet: null,
      kredit: null,
      saldo: account.openingBalance,
    });
    for (const row of account.rows) {
      rows.push({
        konto: account.accountNumber,
        kontonamn: account.accountName,
        datum: row.date,
        verifikat: row.displayNumber,
        text: row.description,
        kostnadsstalle: row.costCenter,
        projekt: row.project,
        debet: Number(row.debit),
        kredit: Number(row.credit),
        saldo: row.balance,
      });
    }
    rows.push({
      konto: account.accountNumber,
      kontonamn: account.accountName,
      datum: "",
      verifikat: "",
      text: "Utgående saldo",
      kostnadsstalle: null,
      projekt: null,
      debet: account.totalDebit,
      kredit: account.totalCredit,
      saldo: account.closingBalance,
    });
  }
  return buildCsv(LEDGER_COLUMNS, rows);
}

interface VerificationFlatRow {
  verifikat: string;
  datum: string;
  text: string;
  konto: string;
  kontonamn: string;
  kostnadsstalle: DimensionRef | null;
  projekt: DimensionRef | null;
  debet: number;
  kredit: number;
}

const VERIFICATION_COLUMNS: CsvColumn<VerificationFlatRow>[] = [
  { label: "Verifikat", value: (r) => r.verifikat },
  { label: "Datum", value: (r) => r.datum },
  { label: "Text", value: (r) => r.text },
  { label: "Konto", value: (r) => r.konto },
  { label: "Kontonamn", value: (r) => r.kontonamn },
  { label: "Kostnadsställe", value: (r) => dimensionText(r.kostnadsstalle) },
  { label: "Projekt", value: (r) => dimensionText(r.projekt) },
  { label: "Debet", value: (r) => r.debet, format: "money" },
  { label: "Kredit", value: (r) => r.kredit, format: "money" },
];

export function buildVerificationListCsv(report: VerificationListResponse): string {
  const rows: VerificationFlatRow[] = [];
  for (const verification of report.verifications) {
    for (const row of verification.rows) {
      rows.push({
        verifikat: verification.displayNumber,
        datum: verification.date,
        text: verification.description,
        konto: row.accountNumber,
        kontonamn: row.accountName,
        kostnadsstalle: row.costCenter,
        projekt: row.project,
        debet: Number(row.debit),
        kredit: Number(row.credit),
      });
    }
  }
  return buildCsv(VERIFICATION_COLUMNS, rows);
}
