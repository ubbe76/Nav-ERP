import { z } from "zod";

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
// organisationsnummer, 0088 = GLN …) and the identifier itself. Trimmed;
// "" or null clears the field (= derived from the organisationsnummer).
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
  "foreign-customer",
  "currency",
  "missing-company-data",
  "missing-recipient-id",
  // Momskoder: a row's code has no Peppol category in etapp 1 (only svensk
  // moms, momsfritt and omvänd betalningsskyldighet in Sverige do).
  "vat-code-unsupported",
] as const;
export type EinvoiceBlockedReason = (typeof EINVOICE_BLOCKED_REASONS)[number];

// --- Settings (System → E-faktura, admin) ---

export const EINVOICE_STATUS_INTERVAL_DEFAULT = 30;

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
    statusIntervalMinutes: z.coerce.number().int().min(5).max(1440).optional(),
  })
  .strict();
export type UpdateEinvoiceSettingsInput = z.infer<typeof updateEinvoiceSettingsSchema>;

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
