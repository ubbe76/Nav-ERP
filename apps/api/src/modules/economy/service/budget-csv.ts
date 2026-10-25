// Budget CSV (etapp 5 del B): the export and the import's parser share ONE
// column form — Konto;Kontonamn;Kostnadsställe;<one column per period, the
// period's YYYY-MM>;Summa — so a file exported from one budget pastes
// straight into another. Pure: the export is buildCsv over grid lines, the
// parser turns parsed records into grid lines + per-row errors and saves
// nothing (the web fills the grid, the user presses Spara).
import { buildCsv, round2, type CsvColumn } from "@navet/shared";
import { normalizeDecimal } from "../../import/service/csv.js";
import { compareGridLines, isBudgetableAccount, type BudgetGridLine } from "./budget-calc.js";

export interface BudgetCsvLine extends BudgetGridLine {
  costCenterCode: string | null;
}

// The three leading columns before the months.
export const BUDGET_CSV_FIXED_COLUMNS = 3;

export function buildBudgetCsv(monthLabels: string[], lines: BudgetCsvLine[]): string {
  const columns: CsvColumn<BudgetCsvLine>[] = [
    { label: "Konto", value: (line) => line.accountNumber },
    { label: "Kontonamn", value: (line) => line.accountName ?? "" },
    { label: "Kostnadsställe", value: (line) => line.costCenterCode ?? "" },
    ...monthLabels.map((label, index): CsvColumn<BudgetCsvLine> => ({ label, value: (line) => line.amounts[index] ?? 0, format: "money" })),
    { label: "Summa", value: (line) => line.amounts.reduce((sum, amount) => round2(sum + amount), 0), format: "money" },
  ];
  return buildCsv(columns, lines);
}

export interface BudgetCsvParseResult {
  lines: BudgetGridLine[];
  // `row` is the 1-based line number in the file (the header is row 1).
  errors: { row: number; message: string }[];
}

export interface BudgetCsvResolvers {
  // null = the chart lacks the number.
  accountName(accountNumber: string): string | null;
  // null = no cost center with that code.
  costCenterId(code: string): string | null;
  costCenterCode(id: string): string | null;
}

// Records as parseRecords gives them (header first). Month columns are read
// by POSITION (column 4..3+N), Summa and anything after is ignored; an
// absent cell is 0. A row with an unknown account, a non-budgetable account,
// an unknown cost center or an unreadable amount is reported and left out;
// an all-zero row is silently skipped; a second row for the same
// (account, cost center) is an error.
export function parseBudgetCsv(records: string[][], monthCount: number, resolve: BudgetCsvResolvers): BudgetCsvParseResult {
  const errors: BudgetCsvParseResult["errors"] = [];
  const lines: (BudgetGridLine & { costCenterCode: string | null })[] = [];
  const seen = new Set<string>();

  records.slice(1).forEach((record, index) => {
    const row = index + 2;
    const accountNumber = (record[0] ?? "").trim();
    if (!/^[0-9]{4}$/.test(accountNumber)) {
      errors.push({ row, message: `Ogiltigt kontonummer "${accountNumber}"` });
      return;
    }
    const accountName = resolve.accountName(accountNumber);
    if (accountName === null || !isBudgetableAccount(accountNumber)) {
      errors.push({ row, message: `Okänt eller ej budgeterbart konto ${accountNumber}` });
      return;
    }
    const code = (record[2] ?? "").trim();
    let costCenterId: string | null = null;
    if (code !== "") {
      costCenterId = resolve.costCenterId(code);
      if (costCenterId === null) {
        errors.push({ row, message: `Okänt kostnadsställe "${code}"` });
        return;
      }
    }
    const key = `${accountNumber}|${costCenterId ?? ""}`;
    if (seen.has(key)) {
      errors.push({ row, message: `Konto ${accountNumber}${code ? ` på kostnadsställe ${code}` : ""} förekommer flera gånger` });
      return;
    }

    const amounts: number[] = [];
    for (let month = 0; month < monthCount; month++) {
      const cell = (record[BUDGET_CSV_FIXED_COLUMNS + month] ?? "").trim();
      if (cell === "") {
        amounts.push(0);
        continue;
      }
      const value = normalizeDecimal(cell);
      if (value === null) {
        errors.push({ row, message: `Ogiltigt belopp "${cell}" i kolumn ${BUDGET_CSV_FIXED_COLUMNS + month + 1}` });
        return;
      }
      amounts.push(round2(value));
    }
    seen.add(key);
    if (amounts.every((amount) => amount === 0)) return;
    lines.push({ accountNumber, accountName, costCenterId, amounts, costCenterCode: costCenterId ? resolve.costCenterCode(costCenterId) : null });
  });

  lines.sort(compareGridLines);
  return { lines: lines.map(({ costCenterCode: _code, ...line }) => line), errors };
}
