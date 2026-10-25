import { z } from "zod";

// Budget (bokföringsgranskningen etapp 5 del B, migration 0150): a budget
// per räkenskapsår, lines per (account, period ordinal, cost center). The
// API contract is private/superpowers/specs/2026-10-25-etapp5b-kontrakt.md.
// Permission: read and write `ekonomi` — the budget is management's planning
// data, not office data.

const budgetNameSchema = z.string().trim().min(1).max(100);
const budgetAccountNumberSchema = z.string().regex(/^[0-9]{4}$/, "Account number must be exactly 4 digits");

// |amount| < 1e12 keeps numeric(14,2) safe; zero is allowed on input (the grid
// sends every month) but never stored.
export const BUDGET_AMOUNT_LIMIT = 1e12;
const budgetAmountSchema = z.number().finite().refine((value) => Math.abs(value) < BUDGET_AMOUNT_LIMIT, "Amount out of range");

export const listBudgetsQuerySchema = z.object({ fiscalYearId: z.string().uuid().optional() });
export type ListBudgetsQuery = z.infer<typeof listBudgetsQuerySchema>;

export const createBudgetSchema = z.object({
  fiscalYearId: z.string().uuid(),
  name: budgetNameSchema,
});
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;

// `isDefault: false` is allowed — a year may have no default budget.
export const updateBudgetSchema = z
  .object({
    name: budgetNameSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;

// PUT /budgets/:id/lines — replaces the set for ONE cost center (null = Ej
// fördelat); `amounts` has one entry per period of the year (validated in
// the service against the year's period count, 400 budget-month-invalid).
export const budgetGridLineInputSchema = z.object({
  accountNumber: budgetAccountNumberSchema,
  amounts: z.array(budgetAmountSchema).max(24),
});
export type BudgetGridLineInput = z.infer<typeof budgetGridLineInputSchema>;

export const replaceBudgetLinesSchema = z.object({
  costCenterId: z.string().uuid().nullable(),
  lines: z.array(budgetGridLineInputSchema),
});
export type ReplaceBudgetLinesInput = z.infer<typeof replaceBudgetLinesSchema>;

export const copyBudgetSchema = z.object({
  fiscalYearId: z.string().uuid(),
  name: budgetNameSchema,
});
export type CopyBudgetInput = z.infer<typeof copyBudgetSchema>;

// A cost center filter that also takes "none" (the lines/actuals without a
// cost center); omitted = everything.
export const budgetCostCenterFilterSchema = z.union([z.literal("none"), z.string().uuid()]).optional();

// GET /budgets/:id/actuals — Kopiera utfall från föregående år: nothing is
// saved, the grid is filled with the source year's actuals × (1 + percent/100).
export const budgetActualsQuerySchema = z.object({
  sourceFiscalYearId: z.string().uuid().optional(),
  percent: z.coerce.number().finite().min(-100).max(1000).default(0),
  costCenterId: budgetCostCenterFilterSchema,
});
export type BudgetActualsQuery = z.infer<typeof budgetActualsQuerySchema>;

export const budgetCsvQuerySchema = z.object({ costCenterId: budgetCostCenterFilterSchema });
export type BudgetCsvQuery = z.infer<typeof budgetCsvQuerySchema>;
