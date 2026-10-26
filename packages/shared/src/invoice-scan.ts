import { z } from "zod";
import { listQuerySchema } from "./list.js";

// Fakturaskanning (Fakturainkorgen) — the shared contract. Spec
// private/superpowers/specs/2026-10-26-fakturaskanning-design.md §3.1/§5.
// The interpretation's result is a PROPOSAL: a person reviews it beside the
// original and creates the supplier invoice draft. The zod schema below
// validates the jsonb on read (an unknown version is interpreted again) and,
// from step 2, the AI's answer.

export const INVOICE_SCAN_STATUSES = ["new", "interpreted", "converted", "rejected"] as const;
export type InvoiceScanStatus = (typeof INVOICE_SCAN_STATUSES)[number];

export const INVOICE_SCAN_SOURCES = ["upload", "email"] as const;
export type InvoiceScanSource = (typeof INVOICE_SCAN_SOURCES)[number];

export const INVOICE_SCAN_ENGINES = ["rules", "ai"] as const;
export type InvoiceScanEngine = (typeof INVOICE_SCAN_ENGINES)[number];

// The list's tabs: pending = Att granska (new + interpreted, derived).
export const INVOICE_SCAN_LIST_STATUSES = ["pending", "converted", "rejected", "all"] as const;
export type InvoiceScanListStatus = (typeof INVOICE_SCAN_LIST_STATUSES)[number];

// The label fields the leverantörsinlärning learns (invoice_scan_hints.field).
export const INVOICE_SCAN_HINT_FIELDS = [
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "paymentReference",
  "grossAmount",
  "netAmount",
  "vatAmount",
  "purchaseOrderReference",
] as const;
export type InvoiceScanHintField = (typeof INVOICE_SCAN_HINT_FIELDS)[number];

export const INVOICE_SCAN_MAIL_OUTCOMES = ["imported", "no_attachment", "duplicate", "too_large", "unsupported", "error"] as const;
export type InvoiceScanMailOutcome = (typeof INVOICE_SCAN_MAIL_OUTCOMES)[number];

// Same formats and cap as the supplier invoice's underlag (the file moves
// there on conversion).
export const INVOICE_SCAN_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export const INVOICE_SCAN_MAX_FILE_BYTES = 20 * 1024 * 1024;
// Files per upload request.
export const INVOICE_SCAN_MAX_FILES_PER_UPLOAD = 20;

// --- The result (InvoiceScanResult, version 1) ---

export const SCAN_CONFIDENCES = ["high", "low"] as const;
export type ScanConfidence = (typeof SCAN_CONFIDENCES)[number];
export const SCAN_FIELD_SOURCES = ["rules", "learned", "ai", "supplier", "purchase_order"] as const;
export type ScanFieldSource = (typeof SCAN_FIELD_SOURCES)[number];

function scanField<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value: value.nullable(),
    confidence: z.enum(SCAN_CONFIDENCES),
    source: z.enum(SCAN_FIELD_SOURCES),
  });
}
export type ScanField<T> = { value: T | null; confidence: ScanConfidence; source: ScanFieldSource };

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const SUPPLIER_MATCHED_BY = ["org_number", "vat_number", "bankgiro", "plusgiro", "iban", "name"] as const;
export type SupplierMatchedBy = (typeof SUPPLIER_MATCHED_BY)[number];

export const invoiceScanSupplierSchema = z.object({
  // Matched locally against the supplier register, never taken from the AI.
  matchedSupplierId: z.string().uuid().nullable(),
  matchedBy: z.enum(SUPPLIER_MATCHED_BY).nullable(),
  // high = one supplier on an identifier; low = name match, or several
  // candidates (then matchedSupplierId is null and candidates lists them).
  confidence: z.enum(SCAN_CONFIDENCES),
  candidates: z.array(z.string().uuid()),
  // What stood on the invoice — for Skapa leverantör when there is no match.
  name: scanField(z.string()),
  orgNumber: scanField(z.string()),
  vatNumber: scanField(z.string()),
  bankgiro: scanField(z.string()),
  plusgiro: scanField(z.string()),
  iban: scanField(z.string()),
  bic: scanField(z.string()),
  address: scanField(z.string()),
  postalCode: scanField(z.string()),
  city: scanField(z.string()),
  country: scanField(z.string()),
});

export const invoiceScanRowSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  lineAmount: z.number().nullable(),
  vatRate: z.number().nullable(),
  supplierArticleNumber: z.string().nullable(),
  articleId: z.string().uuid().nullable(),
  purchaseOrderRowId: z.string().uuid().nullable(),
  confidence: z.enum(SCAN_CONFIDENCES),
});
export type InvoiceScanRow = z.infer<typeof invoiceScanRowSchema>;

export const INVOICE_SCAN_RESULT_VERSION = 1;

export const invoiceScanResultSchema = z.object({
  version: z.literal(INVOICE_SCAN_RESULT_VERSION),
  supplier: invoiceScanSupplierSchema,
  invoiceNumber: scanField(z.string()),
  invoiceDate: scanField(isoDate),
  dueDate: scanField(isoDate),
  // ISO 4217.
  currency: scanField(z.string()),
  netAmount: scanField(z.number()),
  vatAmount: scanField(z.number()),
  grossAmount: scanField(z.number()),
  // 25/12/6/0 when it can be decided. The momskod is NOT chosen by the
  // interpretation — the supplier invoice's own förval chain applies.
  vatRate: scanField(z.number()),
  paymentReference: scanField(z.object({ kind: z.enum(["ocr", "message"]), value: z.string() })),
  isCreditNote: scanField(z.boolean()),
  // What stood on the invoice (Er order, Ert ordernr …) and, only with
  // Matcha mot inköpsorder, the matched purchase order.
  purchaseOrderReference: scanField(z.string()),
  purchaseOrderId: scanField(z.string().uuid()),
  rows: z.array(invoiceScanRowSchema),
  // Swedish sentences: "Netto + moms stämmer inte med att betala (diff 0,40)".
  checks: z.array(z.string()),
  // The matched supplier already has a supplier invoice with this number.
  duplicateOf: z.object({ supplierInvoiceId: z.string().uuid(), registrationNumber: z.string() }).nullable(),
});
export type InvoiceScanResult = z.infer<typeof invoiceScanResultSchema>;
export type InvoiceScanSupplier = z.infer<typeof invoiceScanSupplierSchema>;

// The fields whose `low` makes a scan Osäker in the list.
export const INVOICE_SCAN_MAIN_FIELDS = ["invoiceNumber", "invoiceDate", "dueDate", "grossAmount"] as const;

export function emptyScanField<T>(source: ScanFieldSource = "rules"): ScanField<T> {
  return { value: null, confidence: "low", source };
}

// A result with nothing found — the starting point of every interpretation
// and what an unreadable file or an image (no local OCR) gets.
export function emptyInvoiceScanResult(checks: string[] = []): InvoiceScanResult {
  return {
    version: INVOICE_SCAN_RESULT_VERSION,
    supplier: {
      matchedSupplierId: null,
      matchedBy: null,
      confidence: "low",
      candidates: [],
      name: emptyScanField(),
      orgNumber: emptyScanField(),
      vatNumber: emptyScanField(),
      bankgiro: emptyScanField(),
      plusgiro: emptyScanField(),
      iban: emptyScanField(),
      bic: emptyScanField(),
      address: emptyScanField(),
      postalCode: emptyScanField(),
      city: emptyScanField(),
      country: emptyScanField(),
    },
    invoiceNumber: emptyScanField(),
    invoiceDate: emptyScanField(),
    dueDate: emptyScanField(),
    currency: emptyScanField(),
    netAmount: emptyScanField(),
    vatAmount: emptyScanField(),
    grossAmount: emptyScanField(),
    vatRate: emptyScanField(),
    paymentReference: emptyScanField(),
    isCreditNote: emptyScanField(),
    purchaseOrderReference: emptyScanField(),
    purchaseOrderId: emptyScanField(),
    rows: [],
    checks,
    duplicateOf: null,
  };
}

// Reglerna räcker (steers the automatic AI in `fallback`, spec §3.3):
// supplier, invoice number, invoice date and gross are high and the sum
// check went through (net, VAT and gross all high — the rules only give the
// three amounts high when net + VAT = gross).
export function rulesSufficient(result: InvoiceScanResult): boolean {
  return (
    result.supplier.matchedSupplierId !== null &&
    result.supplier.confidence === "high" &&
    result.invoiceNumber.value !== null &&
    result.invoiceNumber.confidence === "high" &&
    result.invoiceDate.value !== null &&
    result.invoiceDate.confidence === "high" &&
    result.grossAmount.value !== null &&
    result.grossAmount.confidence === "high" &&
    result.netAmount.confidence === "high" &&
    result.vatAmount.confidence === "high"
  );
}

// Osäker in the list: something in the main fields is low (a value found
// but uncertain, or not found at all) or the supplier is not a sure match.
export function isUncertain(result: InvoiceScanResult): boolean {
  if (result.supplier.matchedSupplierId === null || result.supplier.confidence === "low") return true;
  return INVOICE_SCAN_MAIN_FIELDS.some((field) => result[field].confidence === "low");
}

// --- Routes ---

export const listInvoiceScansQuerySchema = listQuerySchema.extend({
  status: z.enum(INVOICE_SCAN_LIST_STATUSES).default("pending"),
  source: z.enum(INVOICE_SCAN_SOURCES).optional(),
});
export type ListInvoiceScansQuery = z.infer<typeof listInvoiceScansQuerySchema>;

export const interpretInvoiceScanSchema = z.object({ engine: z.enum(INVOICE_SCAN_ENGINES).default("rules") }).strict();
export type InterpretInvoiceScanInput = z.infer<typeof interpretInvoiceScanSchema>;

export const rejectInvoiceScanSchema = z.object({ reason: z.string().trim().min(1).max(200) }).strict();
export type RejectInvoiceScanInput = z.infer<typeof rejectInvoiceScanSchema>;

// --- Settings (System → Fakturaskanning, admin) ---

export const INVOICE_SCAN_AI_MODES = ["off", "fallback", "manual"] as const;
export type InvoiceScanAiMode = (typeof INVOICE_SCAN_AI_MODES)[number];
export const INVOICE_SCAN_AI_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type InvoiceScanAiModel = (typeof INVOICE_SCAN_AI_MODELS)[number];
export const INVOICE_SCAN_AI_MODEL_DEFAULT: InvoiceScanAiModel = "claude-opus-5-5";
export const INVOICE_SCAN_MAIL_PORT_DEFAULT = 993;
export const INVOICE_SCAN_MAIL_FOLDER_DEFAULT = "INBOX";
export const INVOICE_SCAN_MAIL_PROCESSED_FOLDER_DEFAULT = "Nav/Inlästa";
export const INVOICE_SCAN_MAIL_INTERVAL_DEFAULT = 5;

// Mapp and Mapp för inlästa must differ: a letter moved onto its own folder
// would be read again every run. Compared level by level ("/"), trimmed and
// case-insensitive (INBOX is case-insensitive in IMAP, and a server that
// folds the rest would make them the same folder anyway).
export const INVOICE_SCAN_MAIL_FOLDERS_EQUAL_TEXT = "Mapp för inlästa får inte vara samma mapp som den som läses";
export function sameMailFolder(a: string, b: string): boolean {
  const canon = (path: string) =>
    path
      .split("/")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== "")
      .join("/");
  return canon(a) === canon(b);
}
const foldersDiffer = (v: { mailFolder?: string; mailProcessedFolder?: string }) =>
  v.mailFolder === undefined || v.mailProcessedFolder === undefined || !sameMailFolder(v.mailFolder, v.mailProcessedFolder);
const foldersDifferIssue = { message: INVOICE_SCAN_MAIL_FOLDERS_EQUAL_TEXT, path: ["mailProcessedFolder"] };

// Write-only secrets: "" = keep the stored value (the form never sees it),
// null = remove it. Printable characters only — they reach a header or an
// IMAP command.
const secretSchema = (max: number, message: string) =>
  z.string().max(max).regex(/^[\x20-\x7E]*$/, message).nullable().optional();

export const updateInvoiceScanSettingsSchema = z
  .object({
    aiMode: z.enum(INVOICE_SCAN_AI_MODES).optional(),
    aiApiKey: secretSchema(500, "API-nyckeln får bara innehålla vanliga tecken"),
    aiModel: z.enum(INVOICE_SCAN_AI_MODELS).optional(),
    poMatching: z.boolean().optional(),
    mailEnabled: z.boolean().optional(),
    mailHost: z.string().trim().max(255).nullable().optional(),
    mailPort: z.coerce.number().int().min(1).max(65535).optional(),
    mailTls: z.boolean().optional(),
    mailUser: z.string().trim().max(320).nullable().optional(),
    mailPassword: secretSchema(500, "Lösenordet får bara innehålla vanliga tecken"),
    mailFolder: z.string().trim().min(1).max(200).optional(),
    mailProcessedFolder: z.string().trim().min(1).max(200).optional(),
    mailIntervalMinutes: z.coerce.number().int().min(1).max(60).optional(),
  })
  .strict()
  .refine(foldersDiffer, foldersDifferIssue);
export type UpdateInvoiceScanSettingsInput = z.infer<typeof updateInvoiceScanSettingsSchema>;

// Testa anslutning (AI): the key typed in the form (omitted or "" = the
// saved one) and the model (omitted = the saved one). Saves nothing.
export const testInvoiceScanAiSchema = z
  .object({
    apiKey: z.string().max(500).regex(/^[\x20-\x7E]*$/, "API-nyckeln får bara innehålla vanliga tecken").optional(),
    model: z.enum(INVOICE_SCAN_AI_MODELS).optional(),
  })
  .strict();
export type TestInvoiceScanAiInput = z.infer<typeof testInvoiceScanAiSchema>;

// Testa anslutning (e-postlådan): the form's mail fields — each omitted one
// is the saved value (the password too; "" counts as omitted). Saves nothing.
export const testInvoiceScanMailSchema = z
  .object({
    mailHost: z.string().trim().max(255).nullable().optional(),
    mailPort: z.coerce.number().int().min(1).max(65535).optional(),
    mailTls: z.boolean().optional(),
    mailUser: z.string().trim().max(320).nullable().optional(),
    mailPassword: z.string().max(500).regex(/^[\x20-\x7E]*$/, "Lösenordet får bara innehålla vanliga tecken").optional(),
    mailFolder: z.string().trim().min(1).max(200).optional(),
    mailProcessedFolder: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine(foldersDiffer, foldersDifferIssue);
export type TestInvoiceScanMailInput = z.infer<typeof testInvoiceScanMailSchema>;

// Senast lästa brev (GET /settings/invoice-scan/mail-log).
export const listInvoiceScanMailLogQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
export type ListInvoiceScanMailLogQuery = z.infer<typeof listInvoiceScanMailLogQuerySchema>;

export interface InvoiceScanMailLogRow {
  id: string;
  runAt: string;
  messageId: string | null;
  emailFrom: string | null;
  emailSubject: string | null;
  receivedAt: string | null;
  outcome: InvoiceScanMailOutcome;
  detail: string | null;
  // The scans the letter created (outcome imported).
  scanIds: string[];
}

export interface InvoiceScanSettingsView {
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
