import { z } from "zod";
import { blankSafe } from "./coerce.js";
import { listQuerySchema } from "./list.js";
import { EU_COUNTRY_CODES } from "./vat-codes.js";

// Bankfiler (ISO 20022, ekonomi etapp 2 delprojekt 4) — the shared constants,
// validators and zod schemas. The web mirror (apps/web/lib/banking.ts, Task 9)
// repeats the labels; banking.shared.test.ts keeps them in sync.

// Valuta steg 2 (utlandsbetalningar): `iban` takes every country's IBAN and
// `foreign_account` is an account number in a country without IBAN (USA,
// Kanada, Australien …), identified by BIC and/or a national bank id.
export const SUPPLIER_PAYMENT_METHODS = ["bankgiro", "plusgiro", "bank_account", "iban", "foreign_account"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];
export const SUPPLIER_PAYMENT_METHOD_LABELS: Record<SupplierPaymentMethod, string> = {
  bankgiro: "Bankgiro",
  plusgiro: "Plusgiro",
  bank_account: "Bankkonto",
  iban: "IBAN",
  foreign_account: "Utländskt kontonummer",
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

// --- Utlandsbetalningar (valuta steg 2) ---

// The SEPA schemes' geographical scope — source: EPC409-09 "EPC List of
// Countries and Territories included in the SEPA Schemes' Geographical
// Scope" (European Payments Council): the EU member states, the EEA
// (Iceland, Liechtenstein, Norway), Switzerland, the United Kingdom, Monaco,
// San Marino, Vatican City State, Andorra and Gibraltar, plus the
// territories the list names with an ISO code of their own — Åland (AX,
// Finland), the French overseas departments and collectivities (GF, GP, MQ,
// YT, RE, BL, MF, PM) and the British Crown Dependencies (JE, GG, IM).
// Deliberately NOT included: the countries whose accession the EPC approved
// in 2024–2025 (Albania, Moldova, Montenegro, North Macedonia, Serbia) —
// their banks join one by one; a country missing here only means the
// payment goes as an ordinary international payment (NURG, SHAR/DEBT),
// which every bank accepts. Adding one is a list entry.
export const SEPA_COUNTRY_CODES = [
  ...EU_COUNTRY_CODES,
  "IS",
  "LI",
  "NO",
  "CH",
  "GB",
  "MC",
  "SM",
  "VA",
  "AD",
  "GI",
  "AX",
  "GF",
  "GP",
  "MQ",
  "YT",
  "RE",
  "BL",
  "MF",
  "PM",
  "JE",
  "GG",
  "IM",
] as const;

// EU + EEA (Nordea: "Within EU/EES area: Only SHAR or SLEV can be used").
export const EEA_COUNTRY_CODES = [...EU_COUNTRY_CODES, "IS", "LI", "NO"] as const;

export function isSepaCountry(country: string): boolean {
  return (SEPA_COUNTRY_CODES as readonly string[]).includes(country.toUpperCase());
}

export function isEeaCountry(country: string): boolean {
  return (EEA_COUNTRY_CODES as readonly string[]).includes(country.toUpperCase());
}

// National bank identifiers for an account without IBAN
// (CdtrAgt/FinInstnId/ClrSysMmbId/ClrSysId/Cd + MmbId) — the codes the four
// banks' MIGs list for the countries that have no IBAN. Which of them a bank
// takes is its profile's `foreign.clearingSystems`. Lengths: Handelsbanken's
// Country Specific Information 8.4 (USABA 9, CACPA 9, AUBSB 6, CNAPS 12,
// HKNCC 6, ZANCC 6, GBDSC 6), the IFSC format (INFSC, 11) and New Zealand's
// bank + branch (NZNCC, 6).
export const CLEARING_SYSTEMS = {
  USABA: { country: "US", label: "USA – ABA routing number", pattern: /^\d{9}$/ },
  CACPA: { country: "CA", label: "Kanada – CPA routing number", pattern: /^\d{9}$/ },
  AUBSB: { country: "AU", label: "Australien – BSB", pattern: /^\d{6}$/ },
  GBDSC: { country: "GB", label: "Storbritannien – sort code", pattern: /^\d{6}$/ },
  HKNCC: { country: "HK", label: "Hongkong – bank code", pattern: /^\d{3,6}$/ },
  INFSC: { country: "IN", label: "Indien – IFSC", pattern: /^[A-Z]{4}0[A-Z0-9]{6}$/ },
  NZNCC: { country: "NZ", label: "Nya Zeeland – bank/branch", pattern: /^\d{6}$/ },
  ZANCC: { country: "ZA", label: "Sydafrika – branch code", pattern: /^\d{6}$/ },
  CNAPS: { country: "CN", label: "Kina – CNAPS", pattern: /^\d{12}$/ },
} as const;
export type ClearingSystem = keyof typeof CLEARING_SYSTEMS;
export const CLEARING_SYSTEM_CODES = Object.keys(CLEARING_SYSTEMS) as ClearingSystem[];

export function isClearingSystem(code: string): code is ClearingSystem {
  return Object.prototype.hasOwnProperty.call(CLEARING_SYSTEMS, code);
}

// Avgiftsfördelning on an international payment: SHAR (delade avgifter,
// förval) or DEBT (vi betalar alla avgifter). CRED is never offered — Nordea
// refuses it. SEPA payments always carry SLEV, set by the builder.
export const CHARGE_BEARERS = ["SHAR", "DEBT"] as const;
export type ChargeBearer = (typeof CHARGE_BEARERS)[number];
export const CHARGE_BEARER_LABELS: Record<ChargeBearer, string> = {
  SHAR: "Delade avgifter (SHA)",
  DEBT: "Vi betalar alla avgifter (OUR)",
};

// Skatteverkets betalningskod (SKV 2328) for KU81 — 101 Varuexport/
// varuimport is the förval: a supplier invoice for goods.
export const DEFAULT_PAYMENT_REPORTING_CODE = "101";
export const PAYMENT_REPORTING_CODE_PATTERN = /^\d{3}$/;

// KU81: a payment abroad whose value EXCEEDS 150 000 kr (Skatteverket:
// "betalningar som överstiger 150 000 kronor"; the banks' MIGs: "above a
// counter value of 150.000 SEK") carries Skatteverket's betalningskod.
export const PAYMENT_REPORTING_THRESHOLD_SEK = 150_000;

export function exceedsPaymentReportingThreshold(amountSek: number): boolean {
  return amountSek > PAYMENT_REPORTING_THRESHOLD_SEK;
}

// Betalningstyp per post (spec §4):
//   domestic      — SEK to a Swedish account (bankgiro, plusgiro, svenskt
//                   bankkonto, SE-IBAN): exactly the payments of before;
//   sepa          — EUR to an IBAN in the SEPA area (the IBAN's country is
//                   where the receiving bank is);
//   international — everything else, SEK to a foreign account included.
// Bankgiro/plusgiro/bankkonto in another currency comes out international —
// the payment file's check refuses it (they only take SEK).
export const PAYMENT_KINDS = ["domestic", "sepa", "international"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export const PAYMENT_KIND_LABELS: Record<PaymentKind, string> = {
  domestic: "Inrikes",
  sepa: "SEPA",
  international: "Utland",
};

export function paymentKind(input: { currency: string; method: SupplierPaymentMethod; iban: string | null }): PaymentKind {
  const currency = input.currency.toUpperCase();
  const ibanCountry = input.method === "iban" && input.iban ? input.iban.slice(0, 2).toUpperCase() : null;
  const swedishAccount =
    input.method === "bankgiro" || input.method === "plusgiro" || input.method === "bank_account" || ibanCountry === "SE";
  if (currency === "SEK" && swedishAccount) return "domestic";
  if (currency === "EUR" && ibanCountry !== null && isSepaCountry(ibanCountry)) return "sepa";
  return "international";
}

// A payee abroad: an IBAN of another country or a foreign account number.
// Such a payee needs street, town and country (spec §4).
export function isForeignPayee(method: SupplierPaymentMethod | null, iban: string | null): boolean {
  if (method === "foreign_account") return true;
  return method === "iban" && iban !== null && !iban.toUpperCase().startsWith("SE");
}

export interface SupplierPaymentDetails {
  paymentMethod: SupplierPaymentMethod | null;
  bankgiro: string | null;
  plusgiro: string | null;
  bankClearing: string | null;
  bankAccountNumber: string | null;
  iban: string | null;
  bic: string | null;
  foreignAccountNumber: string | null;
  clearingSystem: string | null;
  clearingMemberId: string | null;
  bankName: string | null;
  chargeBearer: ChargeBearer;
  paymentReportingCode: string;
}

// What the foreign rules also look at: the supplier's country and address
// (a foreign payee needs street, town and country).
export interface SupplierPaymentContext {
  country: string;
  address: string | null;
  city: string | null;
}

type DetailInput = Partial<Record<keyof SupplierPaymentDetails, string | null | undefined>>;

// "" → null; digits without spaces/hyphens; IBAN/BIC/foreign account/bank id
// upper case without spaces (the foreign account and the bank id also without
// hyphens). Untouched keys stay absent (a PATCH only sends what it changes).
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
  for (const key of ["foreignAccountNumber", "clearingMemberId", "clearingSystem"] as const) {
    const v = out[key];
    if (typeof v === "string") out[key] = v.replace(/[\s-]/g, "") === "" ? null : v.replace(/[\s-]/g, "").toUpperCase();
  }
  if (typeof out.bankName === "string") out.bankName = out.bankName.trim() === "" ? null : out.bankName.trim();
  return out as T;
}

// Field → Swedish problem. Empty object = valid. Runs on the MERGED state
// (existing row + patch) in the service, so a PATCH that only switches the
// method is checked against the stored numbers. `context` (the supplier's
// country and address) feeds the foreign rules; without it they are skipped.
export function supplierPaymentDetailsProblems(input: SupplierPaymentDetails, context?: SupplierPaymentContext): Record<string, string> {
  // Fields a caller left out are absent, not invalid (the förval for the two
  // that always have a value).
  const d: SupplierPaymentDetails = {
    ...input,
    foreignAccountNumber: input.foreignAccountNumber ?? null,
    clearingSystem: input.clearingSystem ?? null,
    clearingMemberId: input.clearingMemberId ?? null,
    bankName: input.bankName ?? null,
    chargeBearer: input.chargeBearer ?? "SHAR",
    paymentReportingCode: input.paymentReportingCode ?? DEFAULT_PAYMENT_REPORTING_CODE,
  };
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
  // Othr/Id is Max34Text; letters and digits only after normalization.
  if (d.foreignAccountNumber !== null && !/^[A-Z0-9]{1,34}$/.test(d.foreignAccountNumber)) {
    problems.foreignAccountNumber = "Kontonumret får bara innehålla bokstäver och siffror, högst 34 tecken";
  }
  if (d.clearingSystem !== null && !isClearingSystem(d.clearingSystem)) {
    problems.clearingSystem = `Bank-id-typen ska vara en av ${CLEARING_SYSTEM_CODES.join(", ")}`;
  } else if (d.clearingSystem !== null && d.clearingMemberId === null) {
    problems.clearingMemberId = "Bank-id saknas";
  } else if (d.clearingSystem === null && d.clearingMemberId !== null) {
    problems.clearingSystem = "Ange vilken typ av bank-id det är";
  } else if (d.clearingSystem !== null && d.clearingMemberId !== null && !CLEARING_SYSTEMS[d.clearingSystem as ClearingSystem].pattern.test(d.clearingMemberId)) {
    problems.clearingMemberId = `Bank-id:t har fel format för ${d.clearingSystem}`;
  }
  if (!(CHARGE_BEARERS as readonly string[]).includes(d.chargeBearer)) problems.chargeBearer = "Avgiftsfördelningen ska vara SHAR eller DEBT";
  if (!PAYMENT_REPORTING_CODE_PATTERN.test(d.paymentReportingCode)) problems.paymentReportingCode = "Betalningskoden ska vara tre siffror (Skatteverkets betalningskod)";
  if (d.paymentMethod === "bankgiro" && d.bankgiro === null) problems.bankgiro = "Bankgiro saknas";
  if (d.paymentMethod === "plusgiro" && d.plusgiro === null) problems.plusgiro = "Plusgiro saknas";
  if (d.paymentMethod === "bank_account") {
    if (d.bankClearing === null) problems.bankClearing = "Clearingnummer saknas";
    if (d.bankAccountNumber === null) problems.bankAccountNumber = "Kontonummer saknas";
  }
  if (d.paymentMethod === "iban" && d.iban === null) problems.iban = "IBAN saknas";
  // IBAN-only applies inside the SEPA area; elsewhere the bank needs the BIC
  // (Nordea Payment Guide: "Payments to all other countries which use the
  // IBAN format must contain a beneficiary bank BIC").
  if (d.paymentMethod === "iban" && d.iban !== null && isValidIban(d.iban) && !isSepaCountry(d.iban.slice(0, 2)) && d.bic === null && !problems.bic) {
    problems.bic = "BIC krävs för IBAN utanför SEPA-området";
  }
  if (d.paymentMethod === "foreign_account") {
    if (d.foreignAccountNumber === null) problems.foreignAccountNumber = "Kontonummer saknas";
    if (d.bic === null && d.clearingSystem === null && !problems.bic && !problems.clearingSystem) {
      problems.bic = "Ange BIC eller bank-id (t.ex. ABA routing number)";
    }
  }
  if (context && isForeignPayee(d.paymentMethod, d.iban)) {
    if (d.paymentMethod === "foreign_account" && context.country.toUpperCase() === "SE") {
      problems.country = "Ett utländskt kontonummer kräver att leverantörens land inte är Sverige";
    } else if (d.paymentMethod === "foreign_account" && isSepaCountry(context.country)) {
      // Nordea: "IBAN will always be required for payments ... to a country
      // part of the SEPA area ... irrespectively of which currency".
      problems.paymentMethod = "Mottagare i SEPA-området betalas med IBAN";
    }
    if (!context.address || context.address.trim() === "") problems.address = "Gatuadress krävs för en utländsk mottagare";
    if (!context.city || context.city.trim() === "") problems.city = "Ort krävs för en utländsk mottagare";
  }
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
  // Utländskt kontonummer + bank-id (valuta steg 2).
  foreignAccountNumber: z.string().trim().max(40).nullable().optional(),
  clearingSystem: z.string().trim().max(5).nullable().optional(),
  clearingMemberId: z.string().trim().max(35).nullable().optional(),
  bankName: z.string().trim().max(70).nullable().optional(),
  // Not nullable — they always have a value (förval SHAR / 101).
  chargeBearer: z.enum(CHARGE_BEARERS).optional(),
  paymentReportingCode: z.string().trim().regex(PAYMENT_REPORTING_CODE_PATTERN, "Betalningskoden ska vara tre siffror").optional(),
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

// Bekräfta utförd. A row in another currency than SEK needs what left the
// bank account in SEK (amountSek, from the account statement) and the bank's
// fee in SEK (bankFeeSek, default 0) — `amounts`, one entry per such row; the
// difference to the SEK the payment releases is booked as kursdifferens. A
// SEK row takes no entry (its SEK amount is the amount itself).
export const confirmPaymentBatchItemAmountSchema = z.object({
  itemId: z.string().uuid(),
  amountSek: blankSafe(z.coerce.number().positive()),
  bankFeeSek: blankSafe(z.coerce.number().min(0)).optional(),
});
export type ConfirmPaymentBatchItemAmount = z.infer<typeof confirmPaymentBatchItemAmountSchema>;

export const confirmPaymentBatchSchema = z
  .object({
    paymentDate: z.string().date(),
    itemIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    amounts: z.array(confirmPaymentBatchItemAmountSchema).max(500).optional(),
  })
  .refine((v) => !v.amounts || new Set(v.amounts.map((a) => a.itemId)).size === v.amounts.length, {
    message: "Each row may have at most one SEK amount",
    path: ["amounts"],
  })
  .refine((v) => !v.amounts || !v.itemIds || v.amounts.every((a) => v.itemIds!.includes(a.itemId)), {
    message: "A SEK amount was given for a row that is not being confirmed",
    path: ["amounts"],
  });
export type ConfirmPaymentBatchInput = z.infer<typeof confirmPaymentBatchSchema>;

export const rejectPaymentBatchItemSchema = z.object({ reason: z.string().trim().min(1).max(255) });
export type RejectPaymentBatchItemInput = z.infer<typeof rejectPaymentBatchItemSchema>;

// Valuta steg 2: foreign-currency invoices and foreign IBANs are payable by
// file now — not_sek and foreign_iban are gone; what a foreign payment still
// lacks (address, BIC, a debit IBAN) is the export check's business.
export type NotPayableReason = "not_found" | "not_approved" | "not_open" | "credit_note" | "no_payment_details" | "already_in_batch";

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
