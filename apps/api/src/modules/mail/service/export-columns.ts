// F2: CSV columns for GET /email-log/csv — mirrors EmailLogPageClient.tsx's
// Table column order/labels (apps/web/components/system/EmailLogPageClient.tsx),
// minus the "Skicka om" action column which has no CSV meaning.
import type { EmailDocumentType, EmailStatus } from "@navet/shared";
import { type CsvColumn } from "@navet/shared";

// Server-side mirror of the web's EMAIL_DOCUMENT_TYPE_LABELS/EMAIL_STATUS_PILL
// (apps/web/lib/types.ts) — duplicated rather than shared across the app boundary.
const EMAIL_DOCUMENT_TYPE_LABELS: Record<EmailDocumentType, string> = {
  inquiry: "Förfrågan",
  purchase_order: "Inköpsorder",
  quote: "Offert",
  order_confirmation: "Orderbekräftelse",
  invoice: "Faktura",
  payment_reminder: "Betalningspåminnelse",
  test: "Testmejl",
  alert_digest: "Daglig sammanställning",
  deviation: "Avvikelse",
};

const EMAIL_STATUS_LABELS: Record<EmailStatus, string> = {
  sent: "Skickat",
  failed: "Misslyckat",
};

export interface EmailLogExportRow {
  createdAt: string | Date;
  documentType: EmailDocumentType;
  recipient: string;
  subject: string;
  status: EmailStatus;
}

export const emailLogExportColumns: CsvColumn<EmailLogExportRow>[] = [
  { label: "Tid", value: (r) => (r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt), format: "datetime" },
  { label: "Dokument", value: (r) => EMAIL_DOCUMENT_TYPE_LABELS[r.documentType] },
  { label: "Mottagare", value: (r) => r.recipient },
  { label: "Ämne", value: (r) => r.subject },
  { label: "Status", value: (r) => EMAIL_STATUS_LABELS[r.status] },
];
