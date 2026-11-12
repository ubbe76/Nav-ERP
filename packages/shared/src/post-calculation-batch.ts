import { z } from "zod";
import { businessDateSchema } from "./business-date.js";
import { manufacturingOrderStatusSchema } from "./manufacturing.js";

// Efterkalkylera flera (#34): a batch of efterkalkyler over a selection of
// manufacturing orders — first a preview (nothing written), then a save of
// the orders the user ticked. The server runs the TO card's own
// postCalculate per order; the web never sends a figure back, and no price
// is ever set from here (the user's decision 2026-11-12).
export const POST_CALCULATION_BATCH_MAX = 500;

// The selection, every filter and:ed.
// - receivedFrom/receivedTo: the order's LATEST live receipt of finished
//   goods (an undone one does not count), as a Stockholm day, inclusive on
//   both ends. An order without a receipt (e.g. Makulerad) is outside any
//   date selection.
// - articleNumberFrom/To: inclusive, compared in BYTE order (collate "C"),
//   as Förkalkylera flera's ranges; an absent bound is open on that side.
// - statuses: a whitelist out of the TO's status enum, at least one. The web
//   starts with Klar + Stängd; an open order gives a preliminary efterkalkyl.
// Strict, so a misspelt filter is a 400 and never silently "everything".
const articleNumberBound = z.string().trim().min(1).max(50);
export const postCalculationBatchSelectionSchema = z
  .object({
    receivedFrom: businessDateSchema.optional(),
    receivedTo: businessDateSchema.optional(),
    articleNumberFrom: articleNumberBound.optional(),
    articleNumberTo: articleNumberBound.optional(),
    articleId: z.string().uuid().optional(),
    groupId: z.string().uuid().optional(),
    statuses: z
      .array(manufacturingOrderStatusSchema)
      .min(1)
      .max(manufacturingOrderStatusSchema.options.length)
      .refine((list) => new Set(list).size === list.length, { message: "Statuses must be unique" }),
  })
  .strict();
export type PostCalculationBatchSelection = z.infer<typeof postCalculationBatchSelectionSchema>;

// The preview and Visa urval take the same body: the selection, nothing else.
export const postCalculationBatchSchema = z.object({ selection: postCalculationBatchSelectionSchema }).strict();
export type PostCalculationBatchInput = z.infer<typeof postCalculationBatchSchema>;

// The save: the ticked orders. Each is saved on its own (postCalculate with
// save, recomputed — like the card's Spara).
export const postCalculationBatchSaveSchema = z
  .object({
    manufacturingOrderIds: z
      .array(z.string().uuid())
      .min(1)
      .max(POST_CALCULATION_BATCH_MAX)
      .refine((list) => new Set(list).size === list.length, { message: "Manufacturing order ids must be unique" }),
  })
  .strict();
export type PostCalculationBatchSaveInput = z.infer<typeof postCalculationBatchSaveSchema>;
