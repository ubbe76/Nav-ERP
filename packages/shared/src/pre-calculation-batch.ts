import { z } from "zod";
import { articleTypeSchema } from "./article.js";

// Its own file: article.ts imports costing.ts (markupPercentSchema), so the
// batch schema, which needs the article type enum, cannot live in costing.ts
// without an import cycle.
// Förkalkylera flera (#27): a batch of pre-calculations over a selection of
// articles — first a preview (nothing written), then a save of the rows the
// user ticked. The server runs the card's own preCalculate per article; the
// web never sends a figure back.
export const PRE_CALCULATION_BATCH_MAX = 500;

// The selection: the user's Kopierat list (#28) in its order, or the
// register's filter. Article number from/to are inclusive and compared in
// BYTE order (collate "C" — "A-10" sorts before "A-9", the register's own
// sort), so the range is what the sorted list shows between the two. `type`
// absent = all types. Configurator templates never take part. Both forms
// strict, so a filter field beside `copied: true` is a 400, not ignored.
const articleNumberBound = z.string().trim().min(1).max(50);
export const preCalculationBatchSelectionSchema = z.union([
  z.object({ copied: z.literal(true) }).strict(),
  z
    .object({
      articleNumberFrom: articleNumberBound.optional(),
      articleNumberTo: articleNumberBound.optional(),
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
  fallbackQuantity: z.coerce.number().positive(),
  // Räkna om underliggande nivåer, as on the card (plain z.boolean(), see
  // preCalculateSchema).
  multiLevel: z.boolean().default(false),
});
export type PreCalculationBatchInput = z.infer<typeof preCalculationBatchSchema>;

// The save: the ticked rows with the quantity each was previewed at. Each
// article is saved on its own (preCalculate with save, recomputed — prices
// changed since the preview come along), then optionally Sätt standardpris
// and/or Sätt försäljningspris with the card's own functions.
export const preCalculationBatchSaveSchema = z.object({
  items: z
    .array(z.object({ articleId: z.string().uuid(), quantity: z.coerce.number().positive() }))
    .min(1)
    .max(PRE_CALCULATION_BATCH_MAX),
  multiLevel: z.boolean().default(false),
  setStandardCost: z.boolean().default(false),
  setSalesPrice: z.boolean().default(false),
});
export type PreCalculationBatchSaveInput = z.infer<typeof preCalculationBatchSaveSchema>;
