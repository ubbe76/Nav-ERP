import { z } from "zod";
import { articleTypeSchema } from "./article.js";
import { blankSafe, numericMax } from "./coerce.js";

// Its own file: article.ts imports costing.ts (markupPercentSchema), so the
// batch schema, which needs the article type enum, cannot live in costing.ts
// without an import cycle.
// Förkalkylera flera (#27): a batch of pre-calculations over a selection of
// articles — first a preview (nothing written), then a save of the rows the
// user ticked. The server runs the card's own preCalculate per article; the
// web never sends a figure back.
export const PRE_CALCULATION_BATCH_MAX = 500;

// The selection: the user's Kopierat list (#28) in its order, or the
// register's filter. Article number ranges: an article is taken when it lies
// in ANY of the ranges (or), the other filters apply on top (and). Each
// bound is inclusive and compared in BYTE order (collate "C" — "A-10" sorts
// before "A-9", the register's own sort), so a range is what the sorted
// list shows between the two; an absent bound is open on that side, and a
// range with neither bound restricts nothing (so the whole list stays in).
// At most PRE_CALCULATION_BATCH_MAX_RANGES rows (400 validation-failed).
// `type` absent = all types. Configurator templates never take part. Both
// forms strict, so a filter field beside `copied: true` is a 400, not
// ignored.
export const PRE_CALCULATION_BATCH_MAX_RANGES = 20;
const articleNumberBound = z.string().trim().min(1).max(50);
export const articleNumberRangeSchema = z
  .object({
    from: articleNumberBound.optional(),
    to: articleNumberBound.optional(),
  })
  .strict();
export type ArticleNumberRange = z.infer<typeof articleNumberRangeSchema>;
export const preCalculationBatchSelectionSchema = z.union([
  z.object({ copied: z.literal(true) }).strict(),
  z
    .object({
      articleNumberRanges: z.array(articleNumberRangeSchema).max(PRE_CALCULATION_BATCH_MAX_RANGES).optional(),
      groupId: z.string().uuid().optional(),
      type: articleTypeSchema.optional(),
      articleCodeId: z.string().uuid().optional(),
      activeOnly: z.boolean().default(true),
    })
    .strict(),
]);
export type PreCalculationBatchSelection = z.infer<typeof preCalculationBatchSelectionSchema>;

export const preCalculationBatchSchema = z.object({
  selection: preCalculationBatchSelectionSchema,
  // The quantity for an article WITHOUT a saved förkalkyl — one with a saved
  // one is calculated with that calculation's quantity (quantitySource
  // "latest"). The card's own quantity rule: positive.
  fallbackQuantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))),
  // Räkna om underliggande nivåer, as on the card (plain z.boolean(), see
  // preCalculateSchema).
  multiLevel: z.boolean().default(false),
  // Eget antal per rad (user's request 2026-11-09): wins over the latest
  // förkalkyl's quantity and the fallback (quantitySource "manual"). An
  // article outside the selection is ignored.
  quantities: z
    .array(z.object({ articleId: z.string().uuid(), quantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))) }))
    .max(PRE_CALCULATION_BATCH_MAX)
    .optional(),
  // Recalculate only these articles of the selection — the one row whose
  // Antal was just changed, without running the whole selection again. An id
  // outside the selection gives no row.
  onlyArticleIds: z.array(z.string().uuid()).min(1).max(PRE_CALCULATION_BATCH_MAX).optional(),
});
export type PreCalculationBatchInput = z.infer<typeof preCalculationBatchSchema>;

// Visa urval (user's request 2026-11-10): the selection's articles listed
// before anything is calculated — same selection, nothing else.
export const preCalculationBatchListSchema = z.object({ selection: preCalculationBatchSelectionSchema }).strict();
export type PreCalculationBatchListInput = z.infer<typeof preCalculationBatchListSchema>;

// The save: the ticked rows with the quantity each was previewed at. Each
// article is saved on its own (preCalculate with save, recomputed — prices
// changed since the preview come along), then optionally Sätt standardpris
// and/or Sätt försäljningspris with the card's own functions.
export const preCalculationBatchSaveSchema = z.object({
  items: z
    .array(z.object({ articleId: z.string().uuid(), quantity: blankSafe(z.coerce.number().positive().max(numericMax(14, 4))) }))
    .min(1)
    .max(PRE_CALCULATION_BATCH_MAX),
  multiLevel: z.boolean().default(false),
  setStandardCost: z.boolean().default(false),
  setSalesPrice: z.boolean().default(false),
});
export type PreCalculationBatchSaveInput = z.infer<typeof preCalculationBatchSaveSchema>;
