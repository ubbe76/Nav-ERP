import type { Status } from "../components/ui/StatusPill";

// Fakturaskanning (Fakturainkorgen) — wire types and labels. Mirrors
// packages/shared/src/invoice-scan.ts and the routes in
// apps/api/src/modules/purchase/routes/invoice-scan.routes.ts (the web cannot
// import @navet/shared). Keep the names in step with the shared file.

export type InvoiceScanStatus = "new" | "interpreted" | "converted" | "rejected";
export type InvoiceScanSource = "upload" | "email";
export type InvoiceScanEngine = "rules" | "ai";
export type InvoiceScanListStatus = "pending" | "converted" | "rejected" | "all";

export const INVOICE_SCAN_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const INVOICE_SCAN_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const INVOICE_SCAN_MAX_FILES_PER_UPLOAD = 20;
export const INVOICE_SCAN_ACCEPT = "application/pdf,image/jpeg,image/png";

export type ScanConfidence = "high" | "low";
export type ScanFieldSource = "rules" | "learned" | "ai" | "supplier" | "purchase_order";
export interface ScanField<T> {
  value: T | null;
  confidence: ScanConfidence;
  source: ScanFieldSource;
}

export type SupplierMatchedBy = "org_number" | "vat_number" | "bankgiro" | "plusgiro" | "iban" | "name";

export interface InvoiceScanSupplier {
  matchedSupplierId: string | null;
  matchedBy: SupplierMatchedBy | null;
  confidence: ScanConfidence;
  candidates: string[];
  name: ScanField<string>;
  orgNumber: ScanField<string>;
  vatNumber: ScanField<string>;
  bankgiro: ScanField<string>;
  plusgiro: ScanField<string>;
  iban: ScanField<string>;
  bic: ScanField<string>;
  address: ScanField<string>;
  postalCode: ScanField<string>;
  city: ScanField<string>;
  country: ScanField<string>;
}

export interface InvoiceScanRow {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  lineAmount: number | null;
  vatRate: number | null;
  supplierArticleNumber: string | null;
  articleId: string | null;
  purchaseOrderRowId: string | null;
  confidence: ScanConfidence;
}

export interface InvoiceScanResult {
  version: 1;
  supplier: InvoiceScanSupplier;
  invoiceNumber: ScanField<string>;
  invoiceDate: ScanField<string>;
  dueDate: ScanField<string>;
  currency: ScanField<string>;
  netAmount: ScanField<number>;
  vatAmount: ScanField<number>;
  grossAmount: ScanField<number>;
  vatRate: ScanField<number>;
  paymentReference: ScanField<{ kind: "ocr" | "message"; value: string }>;
  isCreditNote: ScanField<boolean>;
  purchaseOrderReference: ScanField<string>;
  purchaseOrderId: ScanField<string>;
  rows: InvoiceScanRow[];
  checks: string[];
  duplicateOf: { supplierInvoiceId: string; registrationNumber: string } | null;
}

// A row of GET /invoice-scans (the file's bytes are never in a listing).
export interface InvoiceScanListRow {
  id: string;
  scanNumber: string;
  source: InvoiceScanSource;
  status: InvoiceScanStatus;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  hasTextLayer: boolean | null;
  pageCount: number | null;
  interpretedBy: InvoiceScanEngine | null;
  interpretedAt: string | null;
  aiStartedAt: string | null;
  aiError: string | null;
  supplierInvoiceId: string | null;
  emailFrom: string | null;
  emailSubject: string | null;
  emailReceivedAt: string | null;
  rejectedReason: string | null;
  rejectedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // The matched supplier, null when none.
  supplierName: string | null;
  supplierInvoiceRegistrationNumber: string | null;
  supplierId: string | null;
  invoiceNumber: string | null;
  grossAmount: number | null;
  currency: string | null;
  uncertain: boolean;
}

// GET /invoice-scans/:id.
export interface InvoiceScanDetail extends Omit<InvoiceScanListRow, "supplierId" | "invoiceNumber" | "grossAmount" | "currency"> {
  result: InvoiceScanResult | null;
  // A stored result in an unknown shape — Tolka igen replaces it.
  resultOutdated: boolean;
  aiAvailable: boolean;
  // Inställningen Matcha mot inköpsorder.
  poMatching: boolean;
  rejectedByName: string | null;
}

export interface InvoiceScanUploadResult {
  created: InvoiceScanListRow[];
  duplicates: { filename: string; existing: { id: string; scanNumber: string; status: InvoiceScanStatus } }[];
  rejected: { filename: string; reason: string }[];
}

// --- Display ---

export const INVOICE_SCAN_TABS: { value: InvoiceScanListStatus; label: string }[] = [
  { value: "pending", label: "Att granska" },
  { value: "converted", label: "Skapade" },
  { value: "rejected", label: "Avvisade" },
  { value: "all", label: "Alla" },
];

export const INVOICE_SCAN_SOURCE_LABELS: Record<InvoiceScanSource, string> = {
  upload: "Uppladdad",
  email: "E-post",
};

// Status as the list and the card show it: Ny / Tolkad / Osäker / Skapad /
// Avvisad. Osäker is derived (some main field is low) and only applies while
// the scan is waiting to be reviewed.
export function invoiceScanDisplayStatus(scan: Pick<InvoiceScanListRow, "status" | "uncertain">): {
  status: Status;
  label: string;
} {
  switch (scan.status) {
    case "new":
      return { status: "draft", label: "Ny" };
    case "interpreted":
      return scan.uncertain ? { status: "delayed", label: "Osäker" } : { status: "running", label: "Tolkad" };
    case "converted":
      return { status: "done", label: "Skapad" };
    case "rejected":
      return { status: "stopped", label: "Avvisad" };
  }
}

// The label next to a field that did not come from the plain rules.
export const SCAN_SOURCE_LABELS: Partial<Record<ScanFieldSource, string>> = {
  ai: "AI",
  learned: "Inlärt",
  purchase_order: "Från inköpsorder",
};

export const isPendingScan = (scan: Pick<InvoiceScanListRow, "status">): boolean =>
  scan.status === "new" || scan.status === "interpreted";

// --- Settings (System → Fakturaskanning) ---

export type InvoiceScanAiMode = "off" | "fallback" | "manual";
export const INVOICE_SCAN_AI_MODE_LABELS: Record<InvoiceScanAiMode, string> = {
  off: "Av",
  fallback: "Automatiskt när reglerna inte räcker",
  manual: "Bara med knappen",
};
export type InvoiceScanAiModel = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";
export const INVOICE_SCAN_AI_MODEL_LABELS: Record<InvoiceScanAiModel, string> = {
  "claude-opus-5-5": "Claude Opus 5.5 (noggrannast)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5 (snabbast, billigast)",
};
export const INVOICE_SCAN_MAIL_PORT_DEFAULT = 993;
export const INVOICE_SCAN_MAIL_FOLDER_DEFAULT = "INBOX";
export const INVOICE_SCAN_MAIL_PROCESSED_FOLDER_DEFAULT = "Nav/Inlästa";
export const INVOICE_SCAN_MAIL_INTERVAL_DEFAULT = 5;

export interface InvoiceScanSettings {
  aiMode: InvoiceScanAiMode;
  aiApiKeySet: boolean;
  aiModel: InvoiceScanAiModel;
  poMatching: boolean;
  mailEnabled: boolean;
  mailHost: string | null;
  mailPort: number;
  mailTls: boolean;
  mailUser: string | null;
  mailPasswordSet: boolean;
  mailFolder: string;
  mailProcessedFolder: string;
  mailIntervalMinutes: number;
  mailLastRunAt: string | null;
  mailLastError: string | null;
}

export type InvoiceScanMailOutcome = "imported" | "no_attachment" | "duplicate" | "too_large" | "unsupported" | "error";
export const INVOICE_SCAN_MAIL_OUTCOME_LABELS: Record<InvoiceScanMailOutcome, string> = {
  imported: "Inläst",
  no_attachment: "Ingen bilaga",
  duplicate: "Fanns redan",
  too_large: "För stor",
  unsupported: "Filtypen stöds inte",
  error: "Fel",
};
export const INVOICE_SCAN_MAIL_OUTCOME_PILL: Record<InvoiceScanMailOutcome, Status> = {
  imported: "done",
  no_attachment: "draft",
  duplicate: "draft",
  too_large: "delayed",
  unsupported: "delayed",
  error: "stopped",
};

export interface InvoiceScanMailLogRow {
  id: string;
  runAt: string;
  messageId: string | null;
  emailFrom: string | null;
  emailSubject: string | null;
  receivedAt: string | null;
  outcome: InvoiceScanMailOutcome;
  detail: string | null;
  scanIds: string[];
}

// --- Skapa leverantör: the query string the new-supplier form reads ---

export const SUPPLIER_PREFILL_KEYS = [
  "name",
  "orgNumber",
  "vatNumber",
  "bankgiro",
  "plusgiro",
  "iban",
  "bic",
  "address",
  "postalCode",
  "city",
  "country",
] as const;
export type SupplierPrefillKey = (typeof SUPPLIER_PREFILL_KEYS)[number];
export type SupplierPrefill = Partial<Record<SupplierPrefillKey, string>>;

// /leverantorer?ny=1&name=…&returnTo=/inkop/fakturainkorg/<id> — the supplier
// list opens its Ny leverantör dialog filled in, and after Skapa leverantör
// goes back to returnTo.
export function newSupplierHref(supplier: InvoiceScanSupplier, returnTo: string): string {
  const params = new URLSearchParams();
  params.set("ny", "1");
  for (const key of SUPPLIER_PREFILL_KEYS) {
    const value = supplier[key].value?.trim();
    if (value) params.set(key, value);
  }
  params.set("returnTo", returnTo);
  return `/leverantorer?${params.toString()}`;
}

// returnTo comes from the URL: only a path inside the app is followed (no
// "//host", no scheme), anything else is dropped.
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}

// The scan's value for a main field is "uncertain" when something was found
// but the interpretation is not sure, or when nothing was found at all.
export function fieldIsLow(field: ScanField<unknown>): boolean {
  return field.confidence === "low";
}
