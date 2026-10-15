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
  source: "terminal" | "manual";
  note: string | null;
}

export const timeReportExportColumns: CsvColumn<TimeReportExportRow>[] = [
  { label: "Anställd", value: (r) => r.employeeName },
  { label: "Tillverkningsorder", value: (r) => r.manufacturingOrderNumber },
  { label: "Operation", value: (r) => `${r.operationSequenceNo} — ${r.workCenterName}` },
  { label: "Datum", value: (r) => r.date, format: "date" },
  { label: "Timmar", value: (r) => r.hours, format: "number" },
  { label: "Källa", value: (r) => (r.source === "terminal" ? "Stämpling" : "Manuell") },
  { label: "Anteckning", value: (r) => r.note },
];
