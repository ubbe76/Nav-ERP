import { z } from "zod";
import { businessDateSchema } from "./business-date.js";
import { dimensionFields } from "./dimensions.js";
import { verificationRowInputSchema } from "./economy.js";
import { DOMESTIC_VAT_CODES } from "./vat-codes.js";

// Bankavstämning (bokföringsgranskningen etapp 4) — the API contract shared
// by the banking module and the web. Amounts are numbers, dates
// "YYYY-MM-DD", statement amounts SIGNED (+ = money in on the account).

// IBAN or BBAN as a statement's Acct/Id writes it: upper case, no spaces or
// hyphens — the same normalisation on the account register and on the file,
// so "SE45 5000 0000 0583 9825 7466" and the bank's "SE4550000000058398257466"
// are one identifier.
export function normalizeBankIdentifier(raw: string): string {
  return raw.toUpperCase().replace(/[\s\- ]/g, "");
}

export const BANK_IDENTIFIER_MAX = 40;
const bankIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeBankIdentifier)
  .pipe(z.string().min(1).max(BANK_IDENTIFIER_MAX).regex(/^[A-Z0-9]+$/, "Bara bokstäver och siffror"));

export const CSV_DELIMITERS = [";", ",", "\t"] as const;

// How a CSV export from the internet bank maps onto a statement entry
// (column = header name as it stands in the file's first row, after
// `skipRows`). Saved on the bank account by the import.
const csvColumn = z.string().trim().min(1).max(100);
export const bankCsvMappingSchema = z.object({
  delimiter: z.enum(CSV_DELIMITERS).optional(),
  dateColumn: csvColumn,
  amountColumn: csvColumn,
  textColumn: csvColumn,
  balanceColumn: csvColumn.optional(),
  valueDateColumn: csvColumn.optional(),
  referenceColumn: csvColumn.optional(),
  decimalComma: z.boolean().optional(),
  skipRows: z.number().int().min(0).max(50).optional(),
});
export type BankCsvMappingInput = z.infer<typeof bankCsvMappingSchema>;

// The preview's mapping: the three required columns may still be unchosen
// (the dialog's **Läs om rubriker** re-reads the header row with another
// delimiter or skipRows before any column can be picked) — an empty string
// counts as unchosen. The import requires the full mapping.
const draftColumn = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v === "" ? undefined : v));
export const bankCsvMappingDraftSchema = bankCsvMappingSchema.extend({
  dateColumn: draftColumn,
  amountColumn: draftColumn,
  textColumn: draftColumn,
  balanceColumn: draftColumn,
  valueDateColumn: draftColumn,
  referenceColumn: draftColumn,
});
export type BankCsvMappingDraft = z.infer<typeof bankCsvMappingDraftSchema>;

export function isCompleteCsvMapping(draft: BankCsvMappingDraft): draft is BankCsvMappingInput {
  return draft.dateColumn !== undefined && draft.amountColumn !== undefined && draft.textColumn !== undefined;
}

const accountNumberSchema = z.string().regex(/^[0-9]{4}$/, "Kontonummer är fyra siffror");

export const createBankAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  identifier: bankIdentifierSchema,
  ledgerAccount: accountNumberSchema,
  currency: z.string().trim().toUpperCase().length(3).default("SEK"),
  csvMapping: bankCsvMappingSchema.nullable().optional(),
});
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;

export const updateBankAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    identifier: bankIdentifierSchema.optional(),
    ledgerAccount: accountNumberSchema.optional(),
    currency: z.string().trim().toUpperCase().length(3).optional(),
    csvMapping: bankCsvMappingSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;

export const listBankAccountsQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
});
export type ListBankAccountsQuery = z.infer<typeof listBankAccountsQuerySchema>;

// The multipart text fields beside the file on preview/import. csvMapping
// travels as a JSON string in the form.
const jsonField = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw === "") return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "csvMapping är inte giltig JSON" });
      return z.NEVER;
    }
  });

export const bankStatementPreviewFieldsSchema = z.object({
  bankAccountId: z.string().uuid().optional(),
  csvMapping: jsonField.pipe(bankCsvMappingDraftSchema.optional()),
});
export type BankStatementPreviewFields = z.infer<typeof bankStatementPreviewFieldsSchema>;

export const bankStatementImportFieldsSchema = z.object({
  bankAccountId: z.string().uuid().optional(),
  csvMapping: jsonField.pipe(bankCsvMappingSchema.optional()),
  autoMatch: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === undefined || v === true || v === "true"),
});
export type BankStatementImportFields = z.infer<typeof bankStatementImportFieldsSchema>;

export const BANK_STATEMENT_FORMATS = ["camt.053", "csv"] as const;
export type BankStatementFormat = (typeof BANK_STATEMENT_FORMATS)[number];

export const bankReconciliationQuerySchema = z
  .object({
    bankAccountId: z.string().uuid(),
    from: businessDateSchema,
    to: businessDateSchema,
  })
  .refine((q) => q.from <= q.to, { message: "from must not be after to", path: ["to"] });
export type BankReconciliationQuery = z.infer<typeof bankReconciliationQuerySchema>;

// A match may pair entries with rows, or net entries against each other
// (a reversal and its original) / rows against each other — at least one
// side, the sums equal (the service checks the sum).
export const createBankMatchSchema = z
  .object({
    bankAccountId: z.string().uuid(),
    entryIds: z.array(z.string().uuid()).max(200).default([]),
    verificationRowIds: z.array(z.string().uuid()).max(200).default([]),
  })
  .refine((m) => m.entryIds.length + m.verificationRowIds.length > 0, { message: "Välj minst en post eller rad", path: ["entryIds"] });
export type CreateBankMatchInput = z.infer<typeof createBankMatchSchema>;

export const autoMatchSchema = z
  .object({
    bankAccountId: z.string().uuid(),
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to", path: ["to"] });
export type AutoMatchInput = z.infer<typeof autoMatchSchema>;

export const bookBankEntrySchema = z.object({
  description: z.string().trim().min(1).max(255),
  date: businessDateSchema.optional(),
  rows: z.array(verificationRowInputSchema).min(2).max(200),
  seriesId: z.string().uuid().optional(),
});
export type BookBankEntryInput = z.infer<typeof bookBankEntrySchema>;

export const bookBankEntriesByRuleSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(500),
});
export type BookBankEntriesByRuleInput = z.infer<typeof bookBankEntriesByRuleSchema>;

export const BANK_RULE_DIRECTIONS = ["in", "out", "both"] as const;
export type BankRuleDirection = (typeof BANK_RULE_DIRECTIONS)[number];

// A rule's momskod: only a domestic code with a rate makes sense on a bank
// entry (the gross amount is split into net + VAT on the code's account).
const ruleVatCodeSchema = z.enum(DOMESTIC_VAT_CODES);

export const createBankRuleSchema = z.object({
  textContains: z.string().trim().min(1).max(100),
  direction: z.enum(BANK_RULE_DIRECTIONS).default("both"),
  accountNumber: accountNumberSchema,
  vatCode: ruleVatCodeSchema.nullable().optional(),
  description: z.string().trim().max(255).nullable().optional(),
  autoBook: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  // Kostnadsställen och projekt: on the counter row the rule books.
  ...dimensionFields,
});
export type CreateBankRuleInput = z.infer<typeof createBankRuleSchema>;

export const updateBankRuleSchema = z
  .object({
    textContains: z.string().trim().min(1).max(100).optional(),
    direction: z.enum(BANK_RULE_DIRECTIONS).optional(),
    accountNumber: accountNumberSchema.optional(),
    vatCode: ruleVatCodeSchema.nullable().optional(),
    description: z.string().trim().max(255).nullable().optional(),
    autoBook: z.boolean().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    ...dimensionFields,
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateBankRuleInput = z.infer<typeof updateBankRuleSchema>;

export const createBankReconciliationSchema = z.object({
  bankAccountId: z.string().uuid(),
  throughDate: businessDateSchema,
});
export type CreateBankReconciliationInput = z.infer<typeof createBankReconciliationSchema>;

// Startpunkt för avstämningen (POST /bank-accounts/:id/opening): the day the
// reconciliation starts and the statement's balance per that day, as the
// user reads it off the bank. Everything on the account up to the day is
// linked by one opening matching without the sum rule; the ledger balance
// per the day must equal the statement balance.
export const createBankOpeningSchema = z.object({
  date: businessDateSchema,
  statementBalance: z.number().finite().min(-1e12).max(1e12),
});
export type CreateBankOpeningInput = z.infer<typeof createBankOpeningSchema>;

// Why Avstämd t.o.m. was refused (409 bank-reconciliation-incomplete).
export const BANK_RECONCILIATION_REASONS = ["unmatched-entries", "unmatched-rows", "no-statement-balance", "balance-mismatch"] as const;
export type BankReconciliationReason = (typeof BANK_RECONCILIATION_REASONS)[number];

// Why the Startpunkt was refused (409 bank-opening-not-allowed): the account
// already has a live mark (create), or a later mark rests on it (undo).
export const BANK_OPENING_REASONS = ["mark-exists", "later-mark"] as const;
export type BankOpeningReason = (typeof BANK_OPENING_REASONS)[number];

// Omatchade bankposter: statement entries older than this many days without
// a live matching.
export const BANK_UNRECONCILED_DAYS = 10;

// Automatic matching: a verification row within this many days of the
// entry's booking day, same amount, nothing else with that amount in the
// window.
export const BANK_MATCH_DATE_WINDOW_DAYS = 3;
