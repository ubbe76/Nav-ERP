// F2: CSV columns for GET /accounts/csv and GET /verifications/csv — mirror
// KontoplanPageClient.tsx's and VerifikatPageClient.tsx's Table columns
// (apps/web/components/economy/{KontoplanPageClient,VerifikatPageClient}.tsx).
import type { VerificationStatus } from "@navet/shared";
import { type CsvColumn } from "@navet/shared";

// Server-side mirror of the web's VERIFICATION_STATUS_PILL labels
// (apps/web/lib/types.ts) — duplicated rather than shared across the app boundary.
const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  draft: "Utkast",
  booked: "Bokförd",
};

export interface AccountExportRow {
  number: string;
  name: string;
  vatBox: string | null;
  active: boolean;
}

export const accountExportColumns: CsvColumn<AccountExportRow>[] = [
  { label: "Nummer", value: (r) => r.number },
  { label: "Namn", value: (r) => r.name },
  { label: "Momsruta", value: (r) => (r.vatBox === "none" ? "Ingen ruta" : (r.vatBox ?? "")) },
  { label: "Status", value: (r) => (r.active ? "Aktiv" : "Inaktiv") },
];

export interface VerificationExportRow {
  displayNumber: string;
  date: string;
  description: string;
  seriesCode: string;
  yearLabel: string;
  status: VerificationStatus;
}

export const verificationExportColumns: CsvColumn<VerificationExportRow>[] = [
  { label: "Nummer", value: (r) => r.displayNumber },
  { label: "Datum", value: (r) => r.date, format: "date" },
  { label: "Beskrivning", value: (r) => r.description },
  { label: "Serie", value: (r) => r.seriesCode },
  { label: "Räkenskapsår", value: (r) => r.yearLabel },
  { label: "Status", value: (r) => VERIFICATION_STATUS_LABELS[r.status] },
];
