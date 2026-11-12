import { z } from "zod";
import { blankSafe } from "./coerce.js";

// E-faktura via Peppol (B2Brouter) — shared zod and vocabularies. Spec:
// private/superpowers/specs/2026-10-21-e-faktura-peppol-design.md.

export const INVOICE_DELIVERIES = ["email", "peppol"] as const;
export type InvoiceDelivery = (typeof INVOICE_DELIVERIES)[number];
export const invoiceDeliverySchema = z.enum(INVOICE_DELIVERIES);

// Nav's own transmission states (einvoice_transmissions.status).
export const EINVOICE_STATUSES = ["sending", "sent", "delivered", "rejected", "failed"] as const;
export type EinvoiceStatus = (typeof EINVOICE_STATUSES)[number];

export const EINVOICE_ENVIRONMENTS = ["sandbox", "production"] as const;
export type EinvoiceEnvironment = (typeof EINVOICE_ENVIRONMENTS)[number];

// Peppol-id as "scheme:value" — a four-digit ICD scheme (0007 =
// organisationsnummer, 0088 = GLN, 0192 = norskt organisasjonsnummer …) and
// the identifier itself. Trimmed; "" or null clears the field (= derived
// from the organisationsnummer in SE, NO, DK and BE).
export const PEPPOL_ID_PATTERN = /^\d{4}:[A-Za-z0-9]{1,50}$/;
export const peppolIdSchema = z
  .string()
  .trim()
  .max(60)
  .regex(PEPPOL_ID_PATTERN, "Peppol-id skrivs som schema:värde, t.ex. 0007:5560000000");
// For the customer forms: "" and null both mean "no Peppol-id".
export const peppolIdFieldSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  peppolIdSchema.nullable()
);

// Why an invoice cannot be sent as an e-invoice right now (the card shows the
// Swedish sentence; the API refuses with einvoice-not-allowed + reason).
export const EINVOICE_BLOCKED_REASONS = [
  "invoice-not-issued",
  "private-person",
  "missing-company-data",
  "missing-recipient-id",
  // Momskoder: a row's code has no Peppol category (UTM — räntefakturans
  // rader — or a code the catalog does not know).
  "vat-code-unsupported",
  // Export av tjänster (EXT ⇒ O) next to any other code: Peppol allows
  // "Not subject to VAT" only alone on its invoice (BR-O-11..14).
  "vat-code-mixed",
] as const;
export type EinvoiceBlockedReason = (typeof EINVOICE_BLOCKED_REASONS)[number];

// Skicka e-faktura automatiskt vid Utfärda: what happened to the invoice
// just issued — the transmission's status, "blocked" (the document cannot
// be sent; reason says why) or "error" (the send failed before a status was
// known). Null on the issue answer = the automation did not apply (switched
// off, not configured, or the customer gets its invoices by e-mail).
export interface EinvoiceAutoSendOutcome {
  status: EinvoiceStatus | "blocked" | "error";
  // Swedish, shown as-is on the invoice card and the samlingsfakturering result.
  message: string;
  transmissionId: string | null;
  reason: EinvoiceBlockedReason | null;
  // "error" because the access point did not answer — samlingsfaktureringen
  // stops waiting on it for the rest of the run (review 2026-11-10).
  unavailable?: boolean;
}

// --- Settings (System → E-faktura, admin) ---

export const EINVOICE_STATUS_INTERVAL_DEFAULT = 30;
// Mottagning: how often the job lists received documents at the access point.
export const EINVOICE_RECEIVE_INTERVAL_DEFAULT = 15;

export const updateEinvoiceSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    environment: z.enum(EINVOICE_ENVIRONMENTS).optional(),
    // "" = keep the stored key, null = delete it — same contract as the
    // freight settings. Printable ASCII only: a control character would
    // otherwise reach an HTTP header.
    apiKey: z
      .string()
      .trim()
      .max(500)
      .regex(/^[\x20-\x7E]*$/, "API-nyckeln får bara innehålla vanliga tecken")
      .nullable()
      .optional(),
    // Both come from Testa anslutning (the form never types them); a new
    // accountId without a name, or null, clears the stored name.
    accountId: z.string().trim().max(100).nullable().optional(),
    accountName: z.string().trim().max(200).nullable().optional(),
    statusIntervalMinutes: blankSafe(z.coerce.number().int().min(5).max(1440)).optional(),
    // Skicka e-faktura automatiskt vid Utfärda (saknas = på).
    autoSend: z.boolean().optional(),
    receiveIntervalMinutes: blankSafe(z.coerce.number().int().min(5).max(1440)).optional(),
  })
  .strict();
export type UpdateEinvoiceSettingsInput = z.infer<typeof updateEinvoiceSettingsSchema>;

// --- Mottagning (spec 2026-11-05-e-faktura-mottagning) ---

// Ta emot e-faktura: turns the access point's reception on or off. The
// migration code is sent only together with enabled: true, when another
// access point already publishes the organisation number.
export const setEinvoiceReceptionSchema = z
  .object({
    enabled: z.boolean(),
    migrationCode: z
      .string()
      .trim()
      .max(100)
      .regex(/^[\x20-\x7E]*$/, "Migreringskoden får bara innehålla vanliga tecken")
      .optional(),
  })
  .strict();
export type SetEinvoiceReceptionInput = z.infer<typeof setEinvoiceReceptionSchema>;

// What the access point says about the participant's publication.
export const EINVOICE_PUBLICATION_STATUSES = ["not_published", "processing", "published"] as const;
export type EinvoicePublicationStatus = (typeof EINVOICE_PUBLICATION_STATUSES)[number];

// GET /einvoice-settings → reception. The transport fields are read live
// from the access point and null when that is not possible (no key, no
// account, or it did not answer).
export interface EinvoiceReceptionView {
  enabled: boolean;
  smlStatus: EinvoicePublicationStatus | null;
  directoryStatus: EinvoicePublicationStatus | null;
  migrationPending: boolean | null;
  // The document type codes the transport receives (xml.ubl.invoice.bis3 …).
  documentTypes: string[];
  // "0007:<orgnr>" as the transport publishes it, null without a transport.
  participantId: string | null;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

// dismissed: an unreadable document closed by hand (Markera som hanterad —
// acknowledged at the access point, the invoice registered another way).
export const EINVOICE_RECEPTION_OUTCOMES = ["imported", "duplicate", "unreadable", "dismissed"] as const;
export type EinvoiceReceptionOutcome = (typeof EINVOICE_RECEPTION_OUTCOMES)[number];

// Mottagningslogg (GET /einvoice-settings/reception-log), newest first,
// never the XML itself.
export const listEinvoiceReceptionLogQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
export type ListEinvoiceReceptionLogQuery = z.infer<typeof listEinvoiceReceptionLogQuerySchema>;

export interface EinvoiceReceptionLogRow {
  id: string;
  environment: EinvoiceEnvironment;
  receivedAt: string;
  documentType: "invoice" | "credit_note" | null;
  documentNumber: string | null;
  issueDate: string | null;
  senderEndpoint: string | null;
  senderName: string | null;
  currency: string | null;
  payableAmount: number | null;
  outcome: EinvoiceReceptionOutcome;
  detail: string | null;
  // The inbox post (FI-n) the document became, or the live one it duplicated.
  invoiceScanId: string | null;
  scanNumber: string | null;
}

// POST /einvoice-settings/receive-now.
export interface EinvoiceReceiveResult {
  imported: number;
  duplicates: number;
  unreadable: number;
}

// "Testa anslutning": the key typed in the form (not yet saved) and the
// environment chosen there; omitted/"" = the saved values.
export const testEinvoiceConnectionSchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .max(500)
      .regex(/^[\x20-\x7E]*$/, "API-nyckeln får bara innehålla vanliga tecken")
      .optional(),
    environment: z.enum(EINVOICE_ENVIRONMENTS).optional(),
  })
  .strict();
export type TestEinvoiceConnectionInput = z.infer<typeof testEinvoiceConnectionSchema>;

// "Validera": one invoice's document checked at the access point, never sent.
export const validateEinvoiceDocumentSchema = z.object({ invoiceId: z.string().uuid() }).strict();
export type ValidateEinvoiceDocumentInput = z.infer<typeof validateEinvoiceDocumentSchema>;

// "Kontrollera" on the customer card: an unsaved value typed in the form, or
// nothing (= the saved/derived Peppol-id).
export const peppolLookupSchema = z.object({ peppolId: peppolIdFieldSchema.optional() }).strict();
export type PeppolLookupInput = z.infer<typeof peppolLookupSchema>;
