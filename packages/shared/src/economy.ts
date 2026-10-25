import { z } from "zod";
import { listQuerySchema, statusListParam } from "./list.js";
import { blankSafe } from "./coerce.js";
import { dimensionFields, dimensionFilterQuery, incomeStatementGroupBySchema } from "./dimensions.js";

// --- Kontoplan (chart of accounts) ---
// Momsruta per konto (ekonomi etapp 2, delprojekt 1; every box of the
// declaration since Momskoder, migration 0142): the VAT declaration box an
// account's movements are reported in. Box 49 is computed, never stored.
// "none" = deliberately no box (fee/utjämning accounts, 2650 …); null = not
// classified yet — the VAT report warns when such an account in class 3,
// 26xx, 44xx or 45xx has movements.
export const VAT_BOXES = [
  "05",
  "06",
  "07",
  "08",
  "10",
  "11",
  "12",
  "20",
  "21",
  "22",
  "23",
  "24",
  "30",
  "31",
  "32",
  "35",
  "36",
  "37",
  "38",
  "39",
  "40",
  "41",
  "42",
  "48",
  "50",
  "60",
  "61",
  "62",
] as const;
export type VatBox = (typeof VAT_BOXES)[number];
export const vatBoxSettingSchema = z.enum([...VAT_BOXES, "none"]);
export type VatBoxSetting = z.infer<typeof vatBoxSettingSchema>;

// Skatteverket's headings on the momsdeklaration; mirrored in
// apps/web/lib/vatBoxes.ts, kept in sync by vat-box.shared.test.ts.
export const VAT_BOX_LABELS: Record<VatBox, string> = {
  "05": "Momspliktig försäljning som inte ingår i ruta 06, 07 eller 08",
  "06": "Momspliktiga uttag",
  "07": "Beskattningsunderlag vid vinstmarginalbeskattning",
  "08": "Hyresinkomster vid frivillig skattskyldighet",
  "10": "Utgående moms 25 %",
  "11": "Utgående moms 12 %",
  "12": "Utgående moms 6 %",
  "20": "Inköp av varor från ett annat EU-land",
  "21": "Inköp av tjänster från ett annat EU-land enligt huvudregeln",
  "22": "Inköp av tjänster från ett land utanför EU",
  "23": "Inköp av varor i Sverige som köparen är skattskyldig för",
  "24": "Övriga inköp av tjänster",
  "30": "Utgående moms 25 %",
  "31": "Utgående moms 12 %",
  "32": "Utgående moms 6 %",
  "35": "Försäljning av varor till ett annat EU-land",
  "36": "Försäljning av varor utanför EU",
  "37": "Mellanmans inköp av varor vid trepartshandel",
  "38": "Mellanmans försäljning av varor vid trepartshandel",
  "39": "Försäljning av tjänster till en näringsidkare i ett annat EU-land enligt huvudregeln",
  "40": "Övrig försäljning av tjänster omsatta utanför Sverige",
  "41": "Försäljning när köparen är skattskyldig i Sverige",
  "42": "Övrig försäljning m.m.",
  "48": "Ingående moms att dra av",
  "50": "Beskattningsunderlag vid import",
  "60": "Utgående moms 25 %",
  "61": "Utgående moms 12 %",
  "62": "Utgående moms 6 %",
};

// The declaration as reported: every stored box plus the computed ruta 49.
export type VatDeclarationBox = VatBox | "49";
export const VAT_BOX_49_LABEL = "Moms att betala eller få tillbaka";
export type VatDeclarationBoxes = Record<VatDeclarationBox, number>;

// Boxes whose ACCOUNTS the momsomföring empties: every VAT box that enters
// ruta 49 (utgående moms on sales, on purchases with omvänd moms and on
// import, and the ingående moms). Shared so the report, the settlement and
// the web's omföring card agree.
export const VAT_SETTLED_BOXES = ["10", "11", "12", "30", "31", "32", "48", "60", "61", "62"] as const satisfies readonly VatBox[];

export const createAccountSchema = z.object({
  number: z.string().regex(/^[0-9]{4}$/, "Account number must be exactly 4 digits"),
  name: z.string().trim().min(1).max(100),
  // Omitted = the BAS default for the number (defaultVatBox); null = not
  // classified; a box or "none" = explicit.
  vatBox: vatBoxSettingSchema.nullable().optional(),
  // Kräver kostnadsställe (kostnadsställen och projekt).
  costCenterRequired: z.boolean().optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    active: z.boolean().optional(),
    vatBox: vatBoxSettingSchema.nullable().optional(),
    costCenterRequired: z.boolean().optional(),
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
    // Kostnadsställen och projekt: the row's SIE objects.
    ...dimensionFields,
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
  // Snabbare manuell bokföring: Spara och bokför — create and book in one
  // transaction (refused like Bokför when unbalanced / locked period).
  book: z.boolean().default(false),
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
  // Kostnadsställen och projekt: only the rows carrying the object(s); the
  // opening balance is filtered the same way.
  ...dimensionFilterQuery,
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

// --- Konteringsregler (B2 posting rules) ---
// vatCodeId null = the catch-all rule for the group ("Alla momskoder" — the
// poster applies it to the domestic codes only, see verification-poster.ts);
// revenue/cost account are independently nullable so a rule can post revenue
// only, cost only, or both — but not neither, hence the refine.
export const createPostingRuleSchema = z
  .object({
    articleGroupId: z.string().uuid(),
    vatCodeId: z.string().uuid().nullable().default(null),
    revenueAccountId: z.string().uuid().nullable().default(null),
    costAccountId: z.string().uuid().nullable().default(null),
  })
  .strict()
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
    vatCodeId: z.string().uuid().nullable().optional(),
    revenueAccountId: z.string().uuid().nullable().optional(),
    costAccountId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided")
  .refine((data) => data.revenueAccountId !== null || data.costAccountId !== null, {
    message: "At least one of revenueAccountId or costAccountId must be set",
    path: ["revenueAccountId"],
  });
export type UpdatePostingRuleInput = z.infer<typeof updatePostingRuleSchema>;

// --- Momsrapport (B5) ---
// from/to must exactly cover a contiguous run of accounting periods (one
// month, a calendar quarter or a whole fiscal year in practice) — validated
// in the service, the schema only guards shape and order.
export const vatReportQuerySchema = z
  .object({ from: z.string().date(), to: z.string().date() })
  .refine((range) => range.to >= range.from, { message: "to must not be before from", path: ["to"] });
export type VatReportQuery = z.infer<typeof vatReportQuerySchema>;

// Identical shape by design — the settle takes exactly the range the report
// showed. Aliased so the two can never drift apart.
export const settleVatReportSchema = vatReportQuerySchema;
export type SettleVatReportInput = z.infer<typeof settleVatReportSchema>;

// Redovisningsperiod för moms + the contact for the periodisk sammanställning
// (system_settings vat_reporting_period / vat_contact_*). PATCH is partial;
// "" and null clear a contact field.
export const VAT_REPORTING_PERIODS = ["month", "quarter", "year"] as const;
export type VatReportingPeriod = (typeof VAT_REPORTING_PERIODS)[number];

const vatContactField = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

export const updateVatReportingSettingsSchema = z
  .object({
    period: z.enum(VAT_REPORTING_PERIODS).optional(),
    contactName: vatContactField(35),
    contactPhone: vatContactField(17),
    contactEmail: z
      .union([z.literal(""), z.string().trim().max(255).email()])
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value)),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateVatReportingSettingsInput = z.infer<typeof updateVatReportingSettingsSchema>;

export type VatReportingSettings = {
  period: VatReportingPeriod;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
};

// --- Periodisk sammanställning (Momskoder steg 3) ---
// from/to must be exactly one calendar month or one calendar quarter —
// checked in the service (400 periodic-summary-period-invalid), the schema
// only guards the date shape.
export const periodicSummaryQuerySchema = z.object({ from: z.string().date(), to: z.string().date() });
export type PeriodicSummaryQuery = z.infer<typeof periodicSummaryQuerySchema>;

export const PERIODIC_SUMMARY_WARNING_KINDS = [
  "missing_vat_number",
  "invalid_vat_number",
  "non_eu_country",
  "ledger_difference",
] as const;
export type PeriodicSummaryWarningKind = (typeof PERIODIC_SUMMARY_WARNING_KINDS)[number];

// What the file needs from Företagsuppgifter / the VAT reporting settings
// that is absent or not in Skatteverket's format.
export const PERIODIC_SUMMARY_MISSING_FIELDS = ["vatNumber", "contactName", "contactPhone"] as const;
export type PeriodicSummaryMissingField = (typeof PERIODIC_SUMMARY_MISSING_FIELDS)[number];

export type PeriodicSummaryInvoiceRef = { id: string; invoiceNumber: string };

export type PeriodicSummaryRow = {
  // Normalized, with the country prefix (Greece EL).
  vatNumber: string;
  customers: { id: string; name: string }[];
  // Whole kronor — the öre sum rounded per row, half away from zero.
  goods: number;
  // Trepartshandel has no momskod — always empty.
  triangular: null;
  services: number;
  invoices: PeriodicSummaryInvoiceRef[];
};

export type PeriodicSummaryWarning = {
  kind: PeriodicSummaryWarningKind;
  message: string;
  invoices: PeriodicSummaryInvoiceRef[];
};

export type PeriodicSummary = {
  from: string;
  to: string;
  kind: "month" | "quarter";
  // ÅÅMM for a month, ÅÅ-K for a quarter.
  periodCode: string;
  rows: PeriodicSummaryRow[];
  totals: { goods: number; services: number };
  // The VAT report's booked ruta 35 / 39 for the same range, whole kronor.
  ledger: { box35: number; box39: number };
  // totals − ledger compared in öre, expressed in kronor with öre (0 only
  // when the öre agree).
  differences: { goods: number; services: number };
  warnings: PeriodicSummaryWarning[];
  reporter: {
    vatNumber: string | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
  };
  missing: PeriodicSummaryMissingField[];
};

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
// Kostnadsställen och projekt: an optional object filter (one cost center
// and/or one project) and `groupBy` — one column per object plus "Utan"
// (columns + amounts[] in the response); without it the shape is unchanged.
export const incomeStatementQuerySchema = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
    ...dimensionFilterQuery,
    groupBy: incomeStatementGroupBySchema.optional(),
  })
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
    // Kostnadsställen och projekt: only the rows carrying the object(s).
    ...dimensionFilterQuery,
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
    // Kostnadsställen och projekt: verifications with at least one row on
    // the object(s); every row of those verifications is listed.
    ...dimensionFilterQuery,
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

// --- Snabbare manuell bokföring (bokföringsgranskningen etapp 3) ---

// PUT /verifications/:id/rows: the whole row set, replace-the-set (an empty
// list clears the draft).
export const replaceVerificationRowsSchema = z.object({ rows: z.array(verificationRowInputSchema) });
export type ReplaceVerificationRowsInput = z.infer<typeof replaceVerificationRowsSchema>;

// Spara som mall of an existing verification.
export const saveVerificationTemplateSchema = z.object({ name: z.string().trim().min(1).max(100) });
export type SaveVerificationTemplateInput = z.infer<typeof saveVerificationTemplateSchema>;

// Verifikatmallar. Rows carry account NUMBERS (the template outlives chart
// edits) and optional amounts — null/omitted/0 all mean "fill in on the
// verification"; a row may not carry both sides.
const templateAmountSchema = blankSafe(z.coerce.number().nonnegative()).nullable().optional();
export const verificationTemplateRowInputSchema = z
  .object({
    accountNumber: z.string().regex(/^[0-9]{4}$/, "Account number must be exactly 4 digits"),
    description: z.string().trim().max(255).nullable().optional(),
    debit: templateAmountSchema,
    credit: templateAmountSchema,
    ...dimensionFields,
  })
  .refine((row) => !((row.debit ?? 0) > 0 && (row.credit ?? 0) > 0), {
    message: "A template row cannot have both debit and credit",
    path: ["debit"],
  });
export type VerificationTemplateRowInput = z.infer<typeof verificationTemplateRowInputSchema>;

export const createVerificationTemplateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  seriesId: z.string().uuid(),
  description: z.string().trim().min(1).max(255),
  rows: z.array(verificationTemplateRowInputSchema).default([]),
});
export type CreateVerificationTemplateInput = z.infer<typeof createVerificationTemplateSchema>;

// `rows` replaces the whole set.
export const updateVerificationTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    seriesId: z.string().uuid().optional(),
    description: z.string().trim().min(1).max(255).optional(),
    active: z.boolean().optional(),
    rows: z.array(verificationTemplateRowInputSchema).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateVerificationTemplateInput = z.infer<typeof updateVerificationTemplateSchema>;

// NOT z.coerce.boolean() (same pitfall as listAccountsQuerySchema).
export const listVerificationTemplatesQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListVerificationTemplatesQuery = z.infer<typeof listVerificationTemplatesQuerySchema>;

// Återkommande verifikat. Months are "YYYY-MM"; the day is 1–28 (every
// month has it) or "last" (the month's last day).
export const yearMonthSchema = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");
export const recurringDayOfMonthSchema = z.union([z.literal("last"), z.number().int().min(1).max(28)]);
export type RecurringDayOfMonth = z.infer<typeof recurringDayOfMonthSchema>;
export const RECURRING_VERIFICATION_MODES = ["draft", "book"] as const;
export const recurringVerificationModeSchema = z.enum(RECURRING_VERIFICATION_MODES);
export type RecurringVerificationMode = z.infer<typeof recurringVerificationModeSchema>;

export const createRecurringVerificationSchema = z
  .object({
    templateId: z.string().uuid(),
    dayOfMonth: recurringDayOfMonthSchema,
    startMonth: yearMonthSchema,
    endMonth: yearMonthSchema.nullable().optional(),
    mode: recurringVerificationModeSchema.default("draft"),
  })
  .refine((data) => !data.endMonth || data.endMonth >= data.startMonth, {
    message: "endMonth must not be before startMonth",
    path: ["endMonth"],
  });
export type CreateRecurringVerificationInput = z.infer<typeof createRecurringVerificationSchema>;

export const updateRecurringVerificationSchema = z
  .object({
    active: z.boolean().optional(),
    dayOfMonth: recurringDayOfMonthSchema.optional(),
    endMonth: yearMonthSchema.nullable().optional(),
    mode: recurringVerificationModeSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateRecurringVerificationInput = z.infer<typeof updateRecurringVerificationSchema>;

// Fördela över perioder: amount / months per month (round2, the last month
// takes the rest), cost = debit result account / credit balance account,
// revenue the other way round.
export const ALLOCATION_KINDS = ["cost", "revenue"] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];
const allocationAccountSchema = z.string().regex(/^[0-9]{4}$/, "Account number must be exactly 4 digits");
export const createAllocationSchema = z.object({
  amount: blankSafe(z.coerce.number().positive()),
  kind: z.enum(ALLOCATION_KINDS),
  balanceAccount: allocationAccountSchema,
  resultAccount: allocationAccountSchema,
  firstMonth: yearMonthSchema,
  months: z.coerce.number().int().min(2).max(120),
  description: z.string().trim().min(1).max(200),
  seriesId: z.string().uuid().optional(),
  sourceVerificationId: z.string().uuid().optional(),
});
export type CreateAllocationInput = z.infer<typeof createAllocationSchema>;

// SIE-import av verifikat: the multipart fields beside `file` (strings, as
// form fields arrive). Omitted seriesId = the LÖ series "Lönejournal".
export const sieVerificationImportFieldsSchema = z.object({
  // An empty form field = omitted.
  seriesId: z.preprocess((value) => (value === "" ? undefined : value), z.string().uuid().optional()),
  mode: recurringVerificationModeSchema.default("draft"),
  // Skapa saknade konton och objekt: the same field also creates the cost
  // centers / projects the file's #TRANS object lists name but the registers
  // lack (kostnadsställen och projekt).
  createMissingAccounts: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type SieVerificationImportFields = z.infer<typeof sieVerificationImportFieldsSchema>;
