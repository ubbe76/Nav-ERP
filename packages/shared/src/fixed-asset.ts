import { z } from "zod";
import { listQuerySchema } from "./list.js";

// Anläggningsregister (ekonomi etapp 2, delprojekt 2). Months travel as
// "YYYY-MM"; the API stores them as the month's first day.
export const monthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");
export type MonthKey = z.infer<typeof monthKeySchema>;

export const fixedAssetStatusSchema = z.enum(["active", "disposed"]);
export type FixedAssetStatus = z.infer<typeof fixedAssetStatusSchema>;
export const FIXED_ASSET_STATUS_LABELS: Record<FixedAssetStatus, string> = {
  active: "Aktiv",
  disposed: "Avyttrad",
};

export const fixedAssetDisposalTypeSchema = z.enum(["sale", "scrap"]);
export type FixedAssetDisposalType = z.infer<typeof fixedAssetDisposalTypeSchema>;
export const FIXED_ASSET_DISPOSAL_TYPE_LABELS: Record<FixedAssetDisposalType, string> = {
  sale: "Försäljning",
  scrap: "Utrangering",
};

// 1200 months = 100 years; nothing in K2 depreciates slower.
const usefulLifeSchema = z.coerce.number().int().positive().max(1200);

// --- Tillgångsgrupper ---
export const createFixedAssetCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  assetAccountId: z.string().uuid(),
  accumulatedDepreciationAccountId: z.string().uuid(),
  depreciationExpenseAccountId: z.string().uuid(),
  disposalGainAccountId: z.string().uuid(),
  disposalLossAccountId: z.string().uuid(),
  defaultUsefulLifeMonths: usefulLifeSchema,
});
export type CreateFixedAssetCategoryInput = z.infer<typeof createFixedAssetCategorySchema>;

export const updateFixedAssetCategorySchema = createFixedAssetCategorySchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateFixedAssetCategoryInput = z.infer<typeof updateFixedAssetCategorySchema>;

// --- Anläggningar ---
export const listFixedAssetsQuerySchema = listQuerySchema.extend({
  status: fixedAssetStatusSchema.optional(),
  categoryId: z.string().uuid().optional(),
});
export type ListFixedAssetsQuery = z.infer<typeof listFixedAssetsQuerySchema>;

const acquisitionMonth = (date: string) => date.slice(0, 7);

// Ingående avskrivning (öre precision — it is a bookkeeping amount) and the
// month it is valid through. Both or neither: the amount is meaningless
// without knowing which months it covers, and a month without an amount is
// a typo.
const openingDepreciationSchema = z.coerce.number().min(0).multipleOf(0.01, "openingDepreciation must have at most 2 decimals");
const OPENING_PAIR_MESSAGE = "openingDepreciation and openingDepreciationThroughMonth must be set together";
const openingPairConsistent = (data: { openingDepreciation?: number; openingDepreciationThroughMonth?: string | null }) =>
  ((data.openingDepreciation ?? 0) > 0) === (data.openingDepreciationThroughMonth != null);

export const createFixedAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).nullable().optional(),
    categoryId: z.string().uuid(),
    acquisitionDate: z.string().date(),
    acquisitionCost: z.coerce.number().positive(),
    residualValue: z.coerce.number().min(0).default(0),
    // Omitted = the category's default useful life.
    usefulLifeMonths: usefulLifeSchema.optional(),
    // Omitted = the acquisition month (spec decision b).
    depreciationStartMonth: monthKeySchema.optional(),
    openingDepreciation: openingDepreciationSchema.default(0),
    openingDepreciationThroughMonth: monthKeySchema.nullable().optional(),
    supplierInvoiceId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => data.residualValue <= data.acquisitionCost, {
    message: "residualValue must not exceed acquisitionCost",
    path: ["residualValue"],
  })
  .refine((data) => !data.depreciationStartMonth || data.depreciationStartMonth >= acquisitionMonth(data.acquisitionDate), {
    message: "depreciationStartMonth must not be before the acquisition month",
    path: ["depreciationStartMonth"],
  })
  .refine(openingPairConsistent, { message: OPENING_PAIR_MESSAGE, path: ["openingDepreciationThroughMonth"] });
export type CreateFixedAssetInput = z.infer<typeof createFixedAssetSchema>;

// Partial by shape; the field locks (after the first booked depreciation)
// and the merged-row invariants are the service's job, since a patch alone
// cannot see the existing values. The opening pair is checked here only when
// the patch carries both halves.
export const updateFixedAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    categoryId: z.string().uuid().optional(),
    acquisitionDate: z.string().date().optional(),
    acquisitionCost: z.coerce.number().positive().optional(),
    residualValue: z.coerce.number().min(0).optional(),
    usefulLifeMonths: usefulLifeSchema.optional(),
    depreciationStartMonth: monthKeySchema.optional(),
    openingDepreciation: openingDepreciationSchema.optional(),
    openingDepreciationThroughMonth: monthKeySchema.nullable().optional(),
    supplierInvoiceId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided")
  .refine(
    (data) =>
      data.openingDepreciation === undefined || data.openingDepreciationThroughMonth === undefined || openingPairConsistent(data),
    { message: OPENING_PAIR_MESSAGE, path: ["openingDepreciationThroughMonth"] }
  );
export type UpdateFixedAssetInput = z.infer<typeof updateFixedAssetSchema>;

// --- Avskrivningskörningar ---
export const depreciationRunQuerySchema = z.object({ throughMonth: monthKeySchema });
export type DepreciationRunQuery = z.infer<typeof depreciationRunQuerySchema>;

export const listDepreciationRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListDepreciationRunsQuery = z.infer<typeof listDepreciationRunsQuerySchema>;

// --- Avyttring ---
// A sale carries a price and the mellankonto the invoice will credit; a
// scrap carries neither. Also used as the disposal-preview query schema
// (query strings coerce the same way).
export const disposeFixedAssetSchema = z.discriminatedUnion("disposalType", [
  z.object({
    disposalType: z.literal("sale"),
    disposalDate: z.string().date(),
    disposalPrice: z.coerce.number().min(0),
    intermediateAccountId: z.string().uuid(),
  }),
  // strict: a scrap must not smuggle in a price or a mellankonto.
  z
    .object({
      disposalType: z.literal("scrap"),
      disposalDate: z.string().date(),
    })
    .strict(),
]);
export type DisposeFixedAssetInput = z.infer<typeof disposeFixedAssetSchema>;

// --- Avskrivningsplan ---
export const fixedAssetPlanQuerySchema = z.object({ fiscalYearId: z.string().uuid() });
export type FixedAssetPlanQuery = z.infer<typeof fixedAssetPlanQuerySchema>;
