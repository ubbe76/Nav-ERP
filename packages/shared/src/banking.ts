import { z } from "zod";
import { blankSafe } from "./coerce.js";
import { listQuerySchema } from "./list.js";

// Bankfiler (ISO 20022, ekonomi etapp 2 delprojekt 4) — the shared constants,
// validators and zod schemas. The web mirror (apps/web/lib/banking.ts, Task 9)
// repeats the labels; banking.shared.test.ts keeps them in sync.

export const SUPPLIER_PAYMENT_METHODS = ["bankgiro", "plusgiro", "bank_account", "iban"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];
export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  bankgiro: "Bankgiro",
  plusgiro: "Plusgiro",
  bank_account: "Bankkonto",
  iban: "IBAN",
};

export const PAYMENT_REFERENCE_KINDS = ["ocr", "message"] as const;
export type PaymentReferenceKind = (typeof PAYMENT_REFERENCE_KINDS)[number];

export const BANK_PROFILE_IDS = ["handelsbanken", "seb", "swedbank", "nordea"] as const;
export type BankProfileId = (typeof BANK_PROFILE_IDS)[number];

export const DEBIT_ACCOUNT_KINDS = ["iban", "bankgiro", "plusgiro"] as const;
export type DebitAccountKind = (typeof DEBIT_ACCOUNT_KINDS)[number];

export const OCR_REFERENCE_MAX = 25;
export const BIC_PATTERN = /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/;

export function normalizeDigits(value: string): string {
  return value.replace(/[\s-]/g, "");
}

// Mod 10 (Luhn) over the whole number, check digit last — bankgiro, plusgiro
// and Bankgirot OCR references (whose length digit is optional, so Navs own
// validateOcrNumber in ocr.ts does not fit supplier references).
export function isLuhnValid(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function isValidOcrReference(value: string): boolean {
  return /^\d{2,25}$/.test(value) && isLuhnValid(value);
}

// ISO 13616 mod 97 on an already normalized (upper case, no spaces) IBAN.
export function isValidIban(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export interface SupplierPaymentDetails {
  paymentMethod: SupplierPaymentMethod | null;
  bankgiro: string | null;
  plusgiro: string | null;
  bankClearing: string | null;
  bankAccountNumber: string | null;
  iban: string | null;
  bic: string | null;
}

type DetailInput = Partial<Record<keyof SupplierPaymentDetails, string | null | undefined>>;

// "" → null; digits without spaces/hyphens; IBAN/BIC upper case without
// spaces. Untouched keys stay absent (a PATCH only sends what it changes).
export function normalizeSupplierPaymentDetails<T extends DetailInput>(input: T): T {
  const out: DetailInput = { ...input };
  for (const key of ["bankgiro", "plusgiro", "bankClearing", "bankAccountNumber"] as const) {
    const v = out[key];
    if (typeof v === "string") out[key] = normalizeDigits(v) === "" ? null : normalizeDigits(v);
  }
  for (const key of ["iban", "bic"] as const) {
    const v = out[key];
    if (typeof v === "string") out[key] = v.replace(/\s/g, "") === "" ? null : v.replace(/\s/g, "").toUpperCase();
  }
  return out as T;
}

// Field → Swedish problem. Empty object = valid. Runs on the MERGED state
// (existing row + patch) in the service, so a PATCH that only switches the
// method is checked against the stored numbers.
export function supplierPaymentDetailsProblems(d: SupplierPaymentDetails): Record<string, string> {
  const problems: Record<string, string> = {};
  if (d.bankgiro !== null && !(/^\d{7,8}$/.test(d.bankgiro) && isLuhnValid(d.bankgiro))) {
    problems.bankgiro = "Bankgironumret ska vara 7–8 siffror med giltig kontrollsiffra";
  }
  if (d.plusgiro !== null && !(/^\d{2,8}$/.test(d.plusgiro) && isLuhnValid(d.plusgiro))) {
    problems.plusgiro = "Plusgironumret ska vara 2–8 siffror med giltig kontrollsiffra";
  }
  if (d.bankClearing !== null && !/^\d{4,5}$/.test(d.bankClearing)) problems.bankClearing = "Clearingnumret ska vara 4–5 siffror";
  // Swedbank's 8-series carries a fifth (check) digit: "8CCCC". The same rule
  // runs in the payment file's structural check (pain001-check.ts).
  else if (d.bankClearing !== null && d.bankClearing.startsWith("8") && d.bankClearing.length !== 5) {
    problems.bankClearing = "Clearingnummer i 8-serien (Swedbank) ska vara 5 siffror";
  }
  if (d.bankAccountNumber !== null && !/^\d{1,15}$/.test(d.bankAccountNumber)) {
    problems.bankAccountNumber = "Kontonumret ska vara högst 15 siffror";
  }
  if (d.iban !== null && !isValidIban(d.iban)) problems.iban = "IBAN är ogiltigt";
  if (d.bic !== null && !BIC_PATTERN.test(d.bic)) problems.bic = "BIC ska vara 8 eller 11 tecken";
  if (d.paymentMethod === "bankgiro" && d.bankgiro === null) problems.bankgiro = "Bankgiro saknas";
  if (d.paymentMethod === "plusgiro" && d.plusgiro === null) problems.plusgiro = "Plusgiro saknas";
  if (d.paymentMethod === "bank_account") {
    if (d.bankClearing === null) problems.bankClearing = "Clearingnummer saknas";
    if (d.bankAccountNumber === null) problems.bankAccountNumber = "Kontonummer saknas";
  }
  if (d.paymentMethod === "iban" && d.iban === null) problems.iban = "IBAN saknas";
  return problems;
}

// Spread into createSupplierSchema/updateSupplierSchema (purchase.ts). Kept
// loose on purpose: normalization and the combined check run in the service.
export const supplierPaymentDetailsFields = {
  paymentMethod: z.enum(SUPPLIER_PAYMENT_METHODS).nullable().optional(),
  bankgiro: z.string().trim().max(20).nullable().optional(),
  plusgiro: z.string().trim().max(20).nullable().optional(),
  bankClearing: z.string().trim().max(10).nullable().optional(),
  bankAccountNumber: z.string().trim().max(30).nullable().optional(),
  iban: z.string().trim().max(42).nullable().optional(),
  bic: z.string().trim().max(11).nullable().optional(),
};

export const paymentReferenceSchema = z
  .object({
    kind: z.enum(PAYMENT_REFERENCE_KINDS),
    value: z.string().trim().min(1).max(140),
  })
  .superRefine((ref, ctx) => {
    if (ref.kind === "ocr" && !isValidOcrReference(normalizeDigits(ref.value))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "OCR-numret ska vara 2–25 siffror med giltig kontrollsiffra" });
    }
  })
  .transform((ref) => (ref.kind === "ocr" ? { kind: ref.kind, value: normalizeDigits(ref.value) } : ref));
export type PaymentReferenceInput = z.infer<typeof paymentReferenceSchema>;

export const updatePaymentReferenceSchema = z.object({ paymentReference: paymentReferenceSchema.nullable() });
export type UpdatePaymentReferenceInput = z.infer<typeof updatePaymentReferenceSchema>;

export const updateBankSettingsSchema = z
  .object({
    profile: z.enum(BANK_PROFILE_IDS).nullable().optional(),
    initiatingPartyId: z.string().trim().max(35).nullable().optional(),
    debtorAgreementId: z.string().trim().max(35).nullable().optional(),
    debitAccountKind: z.enum(DEBIT_ACCOUNT_KINDS).optional(),
  })
  .strict();
export type UpdateBankSettingsInput = z.infer<typeof updateBankSettingsSchema>;

// Betalningsomgångar (spec §4, §7.2).
export const PAYMENT_BATCH_STATUSES = ["draft", "exported", "confirmed", "cancelled"] as const;
export type PaymentBatchStatus = (typeof PAYMENT_BATCH_STATUSES)[number];

export const listPaymentBatchesQuerySchema = listQuerySchema.extend({ status: z.enum(PAYMENT_BATCH_STATUSES).optional() });
export type ListPaymentBatchesQuery = z.infer<typeof listPaymentBatchesQuerySchema>;

export const createPaymentBatchSchema = z.object({
  invoiceIds: z.array(z.string().uuid()).min(1).max(500),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CreatePaymentBatchInput = z.infer<typeof createPaymentBatchSchema>;

export const addPaymentBatchItemsSchema = z.object({ invoiceIds: z.array(z.string().uuid()).min(1).max(500) });
export type AddPaymentBatchItemsInput = z.infer<typeof addPaymentBatchItemsSchema>;

export const updatePaymentBatchItemSchema = z
  .object({
    amount: blankSafe(z.coerce.number().positive()).optional(),
    executionDate: z.string().date().optional(),
  })
  .refine((v) => v.amount !== undefined || v.executionDate !== undefined, "At least one field must be provided");
export type UpdatePaymentBatchItemInput = z.infer<typeof updatePaymentBatchItemSchema>;

export const confirmPaymentBatchSchema = z.object({
  paymentDate: z.string().date(),
  itemIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});
export type ConfirmPaymentBatchInput = z.infer<typeof confirmPaymentBatchSchema>;

export const rejectPaymentBatchItemSchema = z.object({ reason: z.string().trim().min(1).max(255) });
export type RejectPaymentBatchItemInput = z.infer<typeof rejectPaymentBatchItemSchema>;

export type NotPayableReason =
  | "not_found"
  | "not_approved"
  | "not_open"
  | "credit_note"
  | "not_sek"
  | "no_payment_details"
  | "foreign_iban"
  | "already_in_batch";

// Bankfiler (camt.054). `direction` filters on files with entries in that
// direction: credit = incoming payments, debit = our payments and returns.
export const listBankFilesQuerySchema = listQuerySchema.extend({ direction: z.enum(["credit", "debit"]).optional() });
export type ListBankFilesQuery = z.infer<typeof listBankFilesQuerySchema>;

export const bookIncomingEntriesSchema = z.object({
  entries: z
    .array(
      z.object({
        entryId: z.string().uuid(),
        customerId: z.string().uuid(),
        rows: z.array(z.object({ invoiceId: z.string().uuid(), appliedAmount: blankSafe(z.coerce.number()) })).min(1).max(50),
      })
    )
    .min(1)
    .max(500),
});
export type BookIncomingEntriesInput = z.infer<typeof bookIncomingEntriesSchema>;

export const bookOutgoingEntriesSchema = z.object({ entryIds: z.array(z.string().uuid()).min(1).max(500) });
export type BookOutgoingEntriesInput = z.infer<typeof bookOutgoingEntriesSchema>;

export const ignoreBankEntrySchema = z.object({ reason: z.string().trim().min(1).max(255) });
export type IgnoreBankEntryInput = z.infer<typeof ignoreBankEntrySchema>;
