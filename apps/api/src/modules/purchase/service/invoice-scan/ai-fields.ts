import { z } from "zod";

// Fakturaskanning — what an AI interpretation answers with (spec §3.5): the
// fields of InvoiceScanResult (§3.1) WITHOUT any matching id — the supplier,
// the purchase order and the rows' articles are matched locally on this
// answer — each with the model's own confidence, and the rows as they stand
// on the invoice. Pure: no SDK, no DB. The service validates every answer
// against this schema whatever the interpreter (claude-interpreter.ts has
// its own wire format for the model and converts to this).

const confidence = z.enum(["high", "low"]);
const text = z.object({ value: z.string().nullable(), confidence });
const amount = z.object({ value: z.number().finite().nullable(), confidence });

export const aiInvoiceRowSchema = z.object({
  description: z.string(),
  quantity: z.number().finite().nullable(),
  unitPrice: z.number().finite().nullable(),
  lineAmount: z.number().finite().nullable(),
  vatRate: z.number().finite().nullable(),
  supplierArticleNumber: z.string().nullable(),
  confidence,
});

export const aiInvoiceFieldsSchema = z.object({
  // The SELLER — never the buyer (the company itself).
  supplier: z.object({
    name: text,
    orgNumber: text,
    vatNumber: text,
    bankgiro: text,
    plusgiro: text,
    iban: text,
    bic: text,
    address: text,
    postalCode: text,
    city: text,
    // ISO 3166-1 alpha-2.
    country: text,
  }),
  invoiceNumber: text,
  // YYYY-MM-DD (checked locally).
  invoiceDate: text,
  dueDate: text,
  // ISO 4217.
  currency: text,
  netAmount: amount,
  vatAmount: amount,
  grossAmount: amount,
  vatRate: amount,
  // As printed; `kind` is what the invoice calls it. The OCR check digit is
  // verified locally.
  paymentReference: z.object({ value: z.string().nullable(), kind: z.enum(["ocr", "message"]), confidence }),
  isCreditNote: z.object({ value: z.boolean().nullable(), confidence }),
  // Er order / Ert ordernr / Your order — what stood there.
  purchaseOrderReference: text,
  rows: z.array(aiInvoiceRowSchema),
});
export type AiInvoiceFields = z.infer<typeof aiInvoiceFieldsSchema>;
export type AiInvoiceRow = z.infer<typeof aiInvoiceRowSchema>;

// --- Limits checked BEFORE a call (spec §3.5) ---

// The Claude API takes at most 10 MB per image, base64-encoded (verified
// against platform.claude.com/docs/en/build-with-claude/vision on
// 2026-10-26; the 5 MB in the spec is Amazon Bedrock's limit). Counted in
// decimal megabytes to stay on the safe side — 7.5 MB of JPEG/PNG.
export const AI_IMAGE_MAX_BASE64_CHARS = 10_000_000;
// Our own cap on a PDF (the API takes 600 pages on the 1M-context models,
// 32 MB per request — the 20 MB file cap is ~27 MB base64): a longer
// document is not one invoice.
export const AI_PDF_MAX_PAGES = 100;

export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}
