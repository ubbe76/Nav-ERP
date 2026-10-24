import { z } from "zod";
import { currencyCodeSchema, exchangeRateValueSchema, SEK } from "./currency.js";
import { listQuerySchema } from "./list.js";
import { valuationMethodSchema } from "./stock.js";

// Årsbokslut (ekonomi etapp 2, delprojekt 3).

export const yearEndAccrualKindSchema = z.enum(["prepaid_expense", "accrued_income", "accrued_expense", "prepaid_income"]);
export type YearEndAccrualKind = z.infer<typeof yearEndAccrualKindSchema>;

export const YEAR_END_ACCRUAL_KIND_LABELS: Record<YearEndAccrualKind, string> = {
  prepaid_expense: "Förutbetald kostnad",
  accrued_income: "Upplupen intäkt",
  accrued_expense: "Upplupen kostnad",
  prepaid_income: "Förutbetald intäkt",
};

// Which side the BALANCE account takes in the year's accrual verification.
// The result account takes the other side; the reversal mirrors both.
export const ACCRUAL_KIND_BALANCE_SIDE: Record<YearEndAccrualKind, "debit" | "credit"> = {
  prepaid_expense: "debit",
  accrued_income: "debit",
  accrued_expense: "credit",
  prepaid_income: "credit",
};

export const YEAR_END_STEP_LABELS = {
  inventory: "Lagerförändring",
  accruals: "Periodiseringar",
  result_transfer: "Resultatöverföring",
  profit_disposition: "Vinstdisposition",
  fx_revaluation: "Valutaomvärdering",
} as const;

export const YEAR_END_ROLE_LABELS = {
  booking: "Bokföring",
  accrual_reversal: "Återföring",
  cancellation: "Omföring",
  fx_reversal: "Återföring",
} as const;

export const listYearEndClosingsQuerySchema = listQuerySchema.extend({
  fiscalYearId: z.string().uuid().optional(),
});
export type ListYearEndClosingsQuery = z.infer<typeof listYearEndClosingsQuerySchema>;

export const startYearEndClosingSchema = z.object({
  fiscalYearId: z.string().uuid(),
  closingDate: z.string().date().optional(),
});
export type StartYearEndClosingInput = z.infer<typeof startYearEndClosingSchema>;

export const updateYearEndClosingSchema = z.object({ closingDate: z.string().date() });

export const inventoryPreviewQuerySchema = z.object({ method: valuationMethodSchema.optional() });
export const bookInventorySchema = z.object({ method: valuationMethodSchema });
export type BookInventoryInput = z.infer<typeof bookInventorySchema>;

export const accrualRowInputSchema = z
  .object({
    kind: yearEndAccrualKindSchema,
    balanceAccountId: z.string().uuid(),
    resultAccountId: z.string().uuid(),
    // At most 2 decimals: an amount that rounds to 0,00 (e.g. 0.001) would
    // otherwise reach the poster as a zero row.
    amount: z.coerce.number().positive().max(100_000_000_000).multipleOf(0.01, "amount must have at most 2 decimals"),
    description: z.string().trim().min(1).max(255),
  })
  .refine((row) => row.balanceAccountId !== row.resultAccountId, {
    message: "balanceAccountId and resultAccountId must differ",
    path: ["resultAccountId"],
  });
export type AccrualRowInput = z.infer<typeof accrualRowInputSchema>;

export const bookAccrualsSchema = z.object({ rows: z.array(accrualRowInputSchema).max(100) });
export type BookAccrualsInput = z.infer<typeof bookAccrualsSchema>;

export const reopenYearEndClosingSchema = z.object({ reason: z.string().trim().min(5).max(255) });

export const profitDispositionSchema = z.object({
  agmDate: z.string().date(),
  dividendAmount: z.coerce.number().min(0).max(100_000_000_000).default(0),
});
export type ProfitDispositionInput = z.infer<typeof profitDispositionSchema>;

// Valutaomvärdering (valuta steg 4). A rate per currency that wins over the
// step's default (the live booking's rate, else Valutakurser for the closing
// date): SEK per 1 unit, never for SEK itself. Rates for currencies without
// open items are ignored.
const fxRateMapSchema = z
  .record(currencyCodeSchema, exchangeRateValueSchema)
  .refine((rates) => !Object.keys(rates).includes(SEK), "SEK has no rate to revalue");

export const bookFxRevaluationSchema = z.object({ rates: fxRateMapSchema.default({}) });
export type BookFxRevaluationInput = z.infer<typeof bookFxRevaluationSchema>;

// The preview's query: ?rates=EUR:11.2,USD:10.15 (a decimal point; the
// query string has no nested objects).
export const fxRevaluationPreviewQuerySchema = z.object({
  rates: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value, ctx) => {
      const rates: Record<string, string> = {};
      if (!value) return rates;
      for (const part of value.split(",")) {
        const [currency, rate, ...rest] = part.split(":");
        if (!currency || rate === undefined || rest.length > 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected CCY:rate, got "${part}"` });
          return z.NEVER;
        }
        rates[currency.trim()] = rate.trim();
      }
      return rates;
    })
    .pipe(fxRateMapSchema),
});
