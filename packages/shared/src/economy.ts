import { z } from "zod";
import { listQuerySchema, statusListParam } from "./list.js";
import { blankSafe } from "./coerce.js";
import { postingVatRateSchema } from "./vat.js";

// --- Kontoplan (chart of accounts) ---
// Momsruta per konto (ekonomi etapp 2, delprojekt 1): the VAT declaration
// box an account's movements are reported in. Box 49 is computed, never
// stored. "none" = deliberately no box (fee/utjämning accounts, 2650 …);
// null = not classified yet — the VAT report warns when such an account in
// class 3 or 26xx has movements.
export const VAT_BOXES = ["05", "10", "11", "12", "35", "36", "42", "48"] as const;
export type VatBox = (typeof VAT_BOXES)[number];
export const vatBoxSettingSchema = z.enum([...VAT_BOXES, "none"]);
export type VatBoxSetting = z.infer<typeof vatBoxSettingSchema>;

// Same wording as the VAT report's rows (MomsrapportPageClient RUTA_ROWS);
// mirrored in apps/web/lib/vatBoxes.ts, kept in sync by vat-box.shared.test.ts.
export const VAT_BOX_LABELS: Record<VatBox, string> = {
  "05": "Momspliktig försäljning",
  "10": "Utgående moms 25 %",
  "11": "Utgående moms 12 %",
  "12": "Utgående moms 6 %",
  "35": "Varor till annat EU-land",
  "36": "Export av varor utanför EU",
  "42": "Momsfri försäljning",
  "48": "Ingående moms att dra av",
};

export const createAccountSchema = z.object({
  number: z.string().regex(/^[0-9]{4}$/, "Account number must be exactly 4 digits"),
  name: z.string().trim().min(1).max(100),
  // Omitted = the BAS default for the number (defaultVatBox); null = not
  // classified; a box or "none" = explicit.
  vatBox: vatBoxSettingSchema.nullable().optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    active: z.boolean().optional(),
    vatBox: vatBoxSettingSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

// NOT z.coerce.boolean() — that turns the string "false" into true (same
// pitfall as stock locations' includeInactive query param).
export const listAccountsQuerySchema = listQuerySchema.extend({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

// --- Räkenskapsår & periods ---
export const createFiscalYearSchema = z
  .object({
    label: z.string().trim().min(1).max(20),
    startDate: z.string().date(),
    endDate: z.string().date(),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "endDate must be after startDate",
    path: ["endDate"],
  });
export type CreateFiscalYearInput = z.infer<typeof createFiscalYearSchema>;

// Reopening a locked period is deliberately allowed but always leaves a
// trail — the reason is mandatory and audited in the service.
export const unlockPeriodSchema = z.object({
  reason: z.string().trim().min(5).max(255),
});
export type UnlockPeriodInput = z.infer<typeof unlockPeriodSchema>;

// --- Verifikatserier (verification series) ---
export const createVerificationSeriesSchema = z.object({
  code: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(100),
});
export type CreateVerificationSeriesInput = z.infer<typeof createVerificationSeriesSchema>;

export const updateVerificationSeriesSchema = z
  .object({
    code: z.string().trim().min(1).max(10).optional(),
    name: z.string().trim().min(1).max(100).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateVerificationSeriesInput = z.infer<typeof updateVerificationSeriesSchema>;

// --- Verifikat (verifications) ---
export const verificationStatusSchema = z.enum(["draft", "booked"]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const listVerificationsQuerySchema = listQuerySchema.extend({
  fiscalYearId: z.string().uuid().optional(),
  seriesId: z.string().uuid().optional(),
  status: statusListParam(verificationStatusSchema.options),
});
export type ListVerificationsQuery = z.infer<typeof listVerificationsQuerySchema>;

// Debit/credit as two always-nonnegative fields (mirrors the column split in
// the schema) with an XOR refine: exactly one of the two must be > 0, never
// both and never neither.
export const verificationRowInputSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: blankSafe(z.coerce.number().nonnegative()),
    credit: blankSafe(z.coerce.number().nonnegative()),
    description: z.string().max(255).optional(),
  })
  .refine((data) => (data.debit > 0) !== (data.credit > 0), {
    message: "Exactly one of debit or credit must be greater than zero",
    path: ["debit"],
  });
export type VerificationRowInput = z.infer<typeof verificationRowInputSchema>;

// fiscalYearId is not accepted here — the service derives it from `date`
// (the fiscal year that date falls within), same as verificationNumber is
// only allocated at booking time.
export const createVerificationSchema = z.object({
  seriesId: z.string().uuid(),
  date: z.string().date(),
  description: z.string().trim().min(1).max(255),
  rows: z.array(verificationRowInputSchema).default([]),
});
export type CreateVerificationInput = z.infer<typeof createVerificationSchema>;

// Header fields editable only while the verification is draft — the status
// guard lives in the service, not here (booked verifications are append-only).
export const updateVerificationSchema = z
  .object({
    seriesId: z.string().uuid().optional(),
    date: z.string().date().optional(),
    description: z.string().trim().min(1).max(255).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateVerificationInput = z.infer<typeof updateVerificationSchema>;

// --- Huvudbok (general ledger, derived — never stored) ---
export const ledgerQuerySchema = z.object({
  accountId: z.string().uuid(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

// --- Konteringsregler (B2 posting rules) ---
// postingVatRateSchema (the blank-string-rejecting variant) moved to vat.ts
// in B5 — imported here for the rule schemas below, re-exported via index.ts.

// vatRate null = the catch-all rule for the group (all rates); revenue/cost
// account are independently nullable so a rule can post revenue only, cost
// only, or both — but not neither, hence the refine.
export const createPostingRuleSchema = z
  .object({
    articleGroupId: z.string().uuid(),
    vatRate: postingVatRateSchema.nullable().default(null),
    revenueAccountId: z.string().uuid().nullable().default(null),
    costAccountId: z.string().uuid().nullable().default(null),
  })
  .refine((data) => data.revenueAccountId !== null || data.costAccountId !== null, {
    message: "At least one of revenueAccountId or costAccountId must be set",
    path: ["revenueAccountId"],
  });
export type CreatePostingRuleInput = z.infer<typeof createPostingRuleSchema>;

// Partial, but the same "at least one account" invariant must hold on the
// resulting row — checked here on the patch itself (all three fields
// optional) so a PATCH can't null out both accounts at once; the service
// still re-validates against the merged row since a partial payload alone
// can't see the existing values.
export const updatePostingRuleSchema = z
  .object({
    articleGroupId: z.string().uuid().optional(),
    vatRate: postingVatRateSchema.nullable().optional(),
    revenueAccountId: z.string().uuid().nullable().optional(),
    costAccountId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided")
  .refine((data) => data.revenueAccountId !== null || data.costAccountId !== null, {
    message: "At least one of revenueAccountId or costAccountId must be set",
    path: ["revenueAccountId"],
  });
export type UpdatePostingRuleInput = z.infer<typeof updatePostingRuleSchema>;

// --- Momsrapport (B5) ---
// from/to must exactly cover a contiguous run of accounting periods (one
// month or a calendar quarter in practice) — validated in the service, the
// schema only guards shape and order.
export const vatReportQuerySchema = z
  .object({ from: z.string().date(), to: z.string().date() })
  .refine((range) => range.to >= range.from, { message: "to must not be before from", path: ["to"] });
export type VatReportQuery = z.infer<typeof vatReportQuerySchema>;

// Identical shape by design — the settle takes exactly the range the report
// showed. Aliased so the two can never drift apart.
export const settleVatReportSchema = vatReportQuerySchema;
export type SettleVatReportInput = z.infer<typeof settleVatReportSchema>;

// --- Ekonomirapporter (B6a) ---
// Unlike the VAT report, these ranges do NOT have to tile whole accounting
// periods: the reports never write anything, so there is no settlement
// integrity to protect. Requiring it would block legitimate uses (a balance
// sheet mid-month, a rolling 12, a printout spanning a year boundary).

// The balance sheet is a point-in-time report: every booked row up to and
// including asOf, with no lower bound. The fiscal year is derived from asOf
// in the service — it is only needed to split the result into retained and
// current year.
export const balanceSheetQuerySchema = z.object({ asOf: z.string().date() });
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuerySchema>;

// The income statement is strictly period-bound — class 3–8 is never closed,
// so accumulating would make year 2 show year 1's revenue.
export const incomeStatementQuerySchema = z
  .object({ from: z.string().date(), to: z.string().date() })
  .refine((range) => range.to >= range.from, { message: "to must not be before from", path: ["to"] });
export type IncomeStatementQuery = z.infer<typeof incomeStatementQuerySchema>;

const reportAccountNumberSchema = z
  .string()
  .regex(/^[0-9]{4}$/, "Account number must be exactly 4 digits");

export const generalLedgerQuerySchema = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
    accountFrom: reportAccountNumberSchema.optional(),
    accountTo: reportAccountNumberSchema.optional(),
    // Hides accounts with neither rows in the interval nor an opening balance
    // ("Endast konton med rörelse eller saldo"). NOT z.coerce.boolean() (same
    // pitfall as listAccountsQuerySchema's includeInactive) — and the default
    // here is TRUE, so only the literal string "false" turns it off.
    onlyWithMovement: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value !== "false"),
  })
  .refine((range) => range.to >= range.from, { message: "to must not be before from", path: ["to"] })
  .refine((range) => !range.accountFrom || !range.accountTo || range.accountTo >= range.accountFrom, {
    message: "accountTo must not be before accountFrom",
    path: ["accountTo"],
  });
export type GeneralLedgerQuery = z.infer<typeof generalLedgerQuerySchema>;

// Mirrors the verification page's own filters so the printout shows exactly
// what the list shows, plus an optional date range for API consumers.
export const verificationListReportQuerySchema = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    fiscalYearId: z.string().uuid().optional(),
    seriesId: z.string().uuid().optional(),
    status: statusListParam(verificationStatusSchema.options),
    search: z.string().trim().optional(),
  })
  .refine((range) => !range.from || !range.to || range.to >= range.from, {
    message: "to must not be before from",
    path: ["to"],
  });
export type VerificationListReportQuery = z.infer<typeof verificationListReportQuerySchema>;

// --- SIE (B6b) ---
// Both endpoints are keyed on the fiscal year: SIE is a year-oriented format
// (#RAR), not a free date range.
export const sieExportQuerySchema = z.object({ fiscalYearId: z.string().uuid() });
export type SieExportQuery = z.infer<typeof sieExportQuerySchema>;

export const sieImportQuerySchema = z.object({ fiscalYearId: z.string().uuid() });
export type SieImportQuery = z.infer<typeof sieImportQuerySchema>;
