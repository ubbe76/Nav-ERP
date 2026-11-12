// CSV export of a payroll period — the human-readable sibling of the PAXml
// file, meant to be opened in Excel and eyeballed (or handed to an accountant
// whose payroll program cannot import PAXml).
//
// Swedish conventions throughout: `;` as the separator (Excel's list
// separator in a Swedish locale, where `,` is the decimal mark), a decimal
// COMMA on every number, and a UTF-8 BOM so Excel detects the encoding
// instead of mangling åäö.

// #35: the file is described once as an export table — the CSV and the Excel
// twin (…/xlsx) render the same one, the hours as real numbers in Excel.

import { exportTable, tableCsv, type CsvColumn, type ExportTable } from "@navet/shared";
import type { PeriodEmployeeSummary, PeriodSummary } from "./payroll.service.js";

const EMPLOYMENT_LABELS: Record<string, string> = { hourly: "Timlön", monthly: "Månadslön" };

type Column = CsvColumn<PeriodEmployeeSummary>;

// Minutes as hours with two decimals, e.g. 510 -> "8,50" (the money format
// is exactly that: two decimals, decimal comma).
function hoursColumn(label: string, minutes: (employee: PeriodEmployeeSummary) => number): Column {
  return { label, value: (employee) => minutes(employee) / 60, format: "money" };
}

function sortedCodes(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "sv"));
}

function minutesOfCode(entries: { code: string; minutes: number }[], code: string): number {
  return entries.reduce((sum, entry) => (entry.code === code ? sum + entry.minutes : sum), 0);
}

export function buildPayrollTable(summary: PeriodSummary): ExportTable {
  // The absence/OB columns are dynamic: only the codes actually used in this
  // period get a column, in a stable (code-sorted) order so two exports of
  // the same period always line up.
  const absenceCodes = sortedCodes(summary.employees.flatMap((e) => e.absence.map((a) => a.code)));
  const obCodes = sortedCodes(summary.employees.flatMap((e) => e.ob.map((o) => o.code)));

  const columns: Column[] = [
    // Both are free text (the number too: any string up to 50 characters) —
    // the CSV's formula-injection guard applies, same as the generic export.
    { label: "Anställningsnr", value: (e) => e.employeeNumber, cell: "text" },
    { label: "Namn", value: (e) => e.name },
    { label: "Anställningsform", value: (e) => (e.employmentType === null ? "" : (EMPLOYMENT_LABELS[e.employmentType] ?? "")) },
    hoursColumn("Schema (h)", (e) => e.scheduledMinutes),
    hoursColumn("Arbetad tid (h)", (e) => e.workedMinutes),
    hoursColumn("Övertid utbet. (h)", (e) => e.overtimeMinutes - (e.overtimeCompMinutes ?? 0)),
    hoursColumn("Övertid komp (h)", (e) => e.overtimeCompMinutes ?? 0),
    hoursColumn("Övertid helg utbet. (h)", (e) => e.overtimeOffScheduleMinutes - (e.overtimeOffScheduleCompMinutes ?? 0)),
    hoursColumn("Övertid helg komp (h)", (e) => e.overtimeOffScheduleCompMinutes ?? 0),
    hoursColumn("ATF (h)", (e) => e.atfMinutes),
    hoursColumn("Ofördelat (h)", (e) => e.unaccountedMinutes),
    ...absenceCodes.map((code) => hoursColumn(`Frånvaro ${code} (h)`, (e) => minutesOfCode(e.absence, code))),
    ...obCodes.map((code) => hoursColumn(`OB ${code} (h)`, (e) => minutesOfCode(e.ob, code))),
  ];
  return exportTable(columns, summary.employees);
}

export function buildPayrollCsv(summary: PeriodSummary): string {
  return tableCsv(buildPayrollTable(summary));
}
