// CSV export of a payroll period — the human-readable sibling of the PAXml
// file, meant to be opened in Excel and eyeballed (or handed to an accountant
// whose payroll program cannot import PAXml).
//
// Swedish conventions throughout: `;` as the separator (Excel's list
// separator in a Swedish locale, where `,` is the decimal mark), a decimal
// COMMA on every number, and a UTF-8 BOM so Excel detects the encoding
// instead of mangling åäö.

import {
  CSV_BOM as BOM,
  CSV_NEWLINE as NEWLINE,
  CSV_SEPARATOR as SEPARATOR,
  csvCell,
  guardFormulaInjection,
} from "@navet/shared";
import type { PeriodEmployeeSummary, PeriodSummary } from "./payroll.service.js";

const FIXED_HEADERS = [
  "Anställningsnr",
  "Namn",
  "Anställningsform",
  "Schema (h)",
  "Arbetad tid (h)",
  "Övertid utbet. (h)",
  "Övertid komp (h)",
  "Övertid helg utbet. (h)",
  "Övertid helg komp (h)",
  "ATF (h)",
  "Ofördelat (h)",
];

const EMPLOYMENT_LABELS: Record<string, string> = { hourly: "Timlön", monthly: "Månadslön" };

// Minutes as hours with a decimal comma, e.g. 510 -> "8,50".
function hours(minutes: number): string {
  return (minutes / 60).toFixed(2).replace(".", ",");
}

function sortedCodes(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, "sv"));
}

function minutesByCode(entries: { code: string; minutes: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) map.set(entry.code, (map.get(entry.code) ?? 0) + entry.minutes);
  return map;
}

export function buildPayrollCsv(summary: PeriodSummary): string {
  // The absence/OB columns are dynamic: only the codes actually used in this
  // period get a column, in a stable (code-sorted) order so two exports of
  // the same period always line up.
  const absenceCodes = sortedCodes(summary.employees.flatMap((e) => e.absence.map((a) => a.code)));
  const obCodes = sortedCodes(summary.employees.flatMap((e) => e.ob.map((o) => o.code)));

  const headers = [
    ...FIXED_HEADERS,
    ...absenceCodes.map((code) => `Frånvaro ${code} (h)`),
    ...obCodes.map((code) => `OB ${code} (h)`),
  ];

  const row = (employee: PeriodEmployeeSummary): string => {
    const absence = minutesByCode(employee.absence);
    const ob = minutesByCode(employee.ob);
    return [
      employee.employeeNumber,
      // Free-text field — formula-injection guard, same as the generic export.
      guardFormulaInjection(employee.name),
      employee.employmentType === null ? "" : (EMPLOYMENT_LABELS[employee.employmentType] ?? ""),
      hours(employee.scheduledMinutes),
      hours(employee.workedMinutes),
      hours(employee.overtimeMinutes - (employee.overtimeCompMinutes ?? 0)),
      hours(employee.overtimeCompMinutes ?? 0),
      hours(employee.overtimeOffScheduleMinutes - (employee.overtimeOffScheduleCompMinutes ?? 0)),
      hours(employee.overtimeOffScheduleCompMinutes ?? 0),
      hours(employee.atfMinutes),
      hours(employee.unaccountedMinutes),
      ...absenceCodes.map((code) => hours(absence.get(code) ?? 0)),
      ...obCodes.map((code) => hours(ob.get(code) ?? 0)),
    ]
      .map(csvCell)
      .join(SEPARATOR);
  };

  const lines = [headers.map(csvCell).join(SEPARATOR), ...summary.employees.map(row)];
  return BOM + lines.join(NEWLINE) + NEWLINE;
}
