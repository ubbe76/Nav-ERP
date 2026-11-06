// F2: CSV columns for GET /time-reports/csv — mirrors TimeReportsPageClient.tsx's
// Table column order/labels (apps/web/components/timereport/TimeReportsPageClient.tsx).
import { type CsvColumn } from "@navet/shared";

export interface TimeReportExportRow {
  employeeName: string;
  manufacturingOrderNumber: string;
  operationSequenceNo: number;
  workCenterName: string;
  date: string;
  hours: string | number;
  // Ställ/produktion (#14 etapp 3); null = ej uppdelad.
  kind: "setup" | "run" | null;
  source: "terminal" | "manual";
  note: string | null;
}

// The Typ column's text — empty for ej uppdelad, as the list shows it.
const TIME_KIND_LABELS = { setup: "Ställ", run: "Produktion" } as const;

export const timeReportExportColumns: CsvColumn<TimeReportExportRow>[] = [
  { label: "Anställd", value: (r) => r.employeeName },
  { label: "Tillverkningsorder", value: (r) => r.manufacturingOrderNumber },
  { label: "Operation", value: (r) => `${r.operationSequenceNo} — ${r.workCenterName}` },
  { label: "Datum", value: (r) => r.date, format: "date" },
  { label: "Timmar", value: (r) => r.hours, format: "number" },
  { label: "Typ", value: (r) => (r.kind === null ? null : TIME_KIND_LABELS[r.kind]) },
  { label: "Källa", value: (r) => (r.source === "terminal" ? "Stämpling" : "Manuell") },
  { label: "Anteckning", value: (r) => r.note },
];
