// SIE 4 file builder (#SIETYP 4 — chart of accounts, balances and all
// verifications). Pure: it takes a fully-resolved data shape and returns the
// CP437 bytes, so the whole file format is testable without a database.
//
// Record order follows the spec's group order (§5.11–5.13): flag,
// identification, chart of accounts, then balances and verifications.
import { encodeCp437 } from "./sie-encoding.js";
import { sieAmount, sieDate, sieField, sieText } from "./sie-format.js";
import { classifyAccount } from "./bas-report-lines.js";

// The spec's account types: Tillgång, Skuld, Kostnad, Intäkt.
export type SieAccountType = "T" | "S" | "K" | "I";

export interface SieExportData {
  program: { name: string; version: string };
  generatedDate: string;
  generatedBy: string;
  company: { name: string; orgNumber: string | null };
  // yearIndex 0 = the exported year, -1 = the comparison year.
  fiscalYears: { yearIndex: number; startDate: string; endDate: string }[];
  accounts: { number: string; name: string; type: SieAccountType }[];
  // Debit-positive throughout, which is exactly the spec's convention: an
  // asset's balance is positive, a liability's negative.
  balances: { yearIndex: number; accountNumber: string; ib: number; ub: number; res: number }[];
  verifications: {
    series: string;
    number: number;
    date: string;
    description: string;
    // Kostnadsställen och projekt: the row's SIE object codes (dimension 1
    // and 6), written as {1 "kod" 6 "kod"} in #TRANS.
    rows: { accountNumber: string; amount: number; description: string | null; costCenterCode?: string | null; projectCode?: string | null }[];
  }[];
  // The objects of the two fixed dimensions (#DIM 1 Kostnadsställe, #DIM 6
  // Projekt): every object the registers hold, inactive ones included, so
  // every code a #TRANS names is declared. Omitted/empty = no #DIM lines.
  objects?: { dimension: 1 | 6; code: string; name: string }[];
}

export const SIE_DIMENSION_NAMES = { 1: "Kostnadsställe", 6: "Projekt" } as const;

// {1 "100" 6 "P1"} — the #TRANS object list; {} when the row carries none.
export function sieObjectList(row: { costCenterCode?: string | null; projectCode?: string | null }): string {
  const parts: string[] = [];
  if (row.costCenterCode) parts.push(`1 ${sieText(row.costCenterCode)}`);
  if (row.projectCode) parts.push(`6 ${sieText(row.projectCode)}`);
  return `{${parts.join(" ")}}`;
}

// Reuses B6a's interval table so the SIE account type and the balance sheet
// can never disagree about what an account is.
export function sieAccountType(accountNumber: string): SieAccountType {
  const classification = classifyAccount(accountNumber);
  if (classification.report === "balanceSheet") {
    return classification.section === "assets" ? "T" : "S";
  }
  // Class 3 is revenue, 4–8 are costs.
  return accountNumber < "4000" ? "I" : "K";
}

export function buildSieFile(data: SieExportData): Buffer {
  const lines: string[] = [];

  // --- Flag + identification ---
  lines.push("#FLAGGA 0");
  lines.push(`#PROGRAM ${sieText(data.program.name)} ${sieField(data.program.version)}`);
  lines.push("#FORMAT PC8");
  lines.push(`#GEN ${sieDate(data.generatedDate)} ${sieField(data.generatedBy)}`);
  lines.push("#SIETYP 4");
  // An empty #ORGNR is worse than none — some importers parse the following
  // fields positionally.
  if (data.company.orgNumber) lines.push(`#ORGNR ${sieField(data.company.orgNumber)}`);
  lines.push(`#FNAMN ${sieText(data.company.name)}`);
  for (const year of data.fiscalYears) {
    lines.push(`#RAR ${year.yearIndex} ${sieDate(year.startDate)} ${sieDate(year.endDate)}`);
  }
  lines.push("#KPTYP BAS2014");

  // --- Chart of accounts ---
  for (const account of data.accounts) {
    lines.push(`#KONTO ${account.number} ${sieText(account.name)}`);
    lines.push(`#KTYP ${account.number} ${account.type}`);
  }

  // --- Dimensions (kostnadsställen och projekt): the two fixed dimensions
  // and their objects, only when there is anything to declare. ---
  const objects = data.objects ?? [];
  for (const dimension of [1, 6] as const) {
    const own = objects.filter((object) => object.dimension === dimension);
    if (own.length === 0) continue;
    lines.push(`#DIM ${dimension} ${sieText(SIE_DIMENSION_NAMES[dimension])}`);
    for (const object of own) lines.push(`#OBJEKT ${dimension} ${sieText(object.code)} ${sieText(object.name)}`);
  }

  // --- Balances. #IB/#UB are the BALANCE accounts' opening/closing balances
  // and #RES is the RESULT accounts' period movement — they are not
  // alternative views of the same account. Emitting #RES for a bank account
  // (or #UB for a revenue account) produces a file that importers misread.
  // Zero rows are omitted: the spec wants values that exist, and listing
  // every account at 0 is noise. ---
  for (const balance of data.balances) {
    const isResultAccount = classifyAccount(balance.accountNumber).report === "incomeStatement";
    if (isResultAccount) {
      if (balance.res !== 0) {
        lines.push(`#RES ${balance.yearIndex} ${balance.accountNumber} ${sieAmount(balance.res)}`);
      }
      continue;
    }
    if (balance.ib !== 0) {
      lines.push(`#IB ${balance.yearIndex} ${balance.accountNumber} ${sieAmount(balance.ib)}`);
    }
    if (balance.ub !== 0) {
      lines.push(`#UB ${balance.yearIndex} ${balance.accountNumber} ${sieAmount(balance.ub)}`);
    }
  }

  // --- Verifications, series then ascending number (the spec requires
  // ascending numbers within a series). ---
  const ordered = [...data.verifications].sort(
    (a, b) => a.series.localeCompare(b.series, "sv") || a.number - b.number
  );
  for (const verification of ordered) {
    lines.push(
      `#VER ${sieField(verification.series)} ${verification.number} ${sieDate(verification.date)} ${sieText(
        verification.description
      )}`
    );
    lines.push("{");
    for (const row of verification.rows) {
      // transdate is skipped (the row inherits the verification's date), but
      // it must still be present as an empty field when a transtext follows.
      const suffix = row.description ? ` "" ${sieText(row.description)}` : "";
      lines.push(`\t#TRANS ${row.accountNumber} ${sieObjectList(row)} ${sieAmount(row.amount)}${suffix}`);
    }
    lines.push("}");
  }

  // CRLF: the spec permits LF alone but CRLF is what the DOS-era tooling
  // emits and every importer accepts.
  return encodeCp437(lines.map((line) => `${line}\r\n`).join(""));
}
