import { z } from "zod";
import { listQuerySchema } from "./list.js";

// Behovsberäkning (MRP light) — query and order-creation schemas. The
// requirements list itself is fully derived (never stored), so there is no
// create/update schema for requirement rows.

export const listRequirementsQuerySchema = listQuerySchema.extend({
  type: z.enum(["purchased", "manufactured"]).optional(),
  groupId: z.string().uuid().optional(),
  // Default (absent/false) shows only rows with a proposal; true shows every
  // article with any demand/supply/stock/reorder point.
  // NOT z.coerce.boolean() — that turns the string "false" into true.
  showAll: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  // Uppdatera: recompute now instead of reading the cached result (the
  // computed rows are cached for a minute so paging/search/filter don't
  // re-run the whole netting).
  refresh: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListRequirementsQuery = z.infer<typeof listRequirementsQuerySchema>;

// Beläggning (E2) — the capacity matrix is a whole-dataset derivation, not a
// paged list; the only knobs are the horizon and an optional group filter.
export const capacityQuerySchema = z.object({
  weeks: z.coerce.number().int().min(1).max(26).default(8),
  productionGroupId: z.string().uuid().optional(),
});
export type CapacityQuery = z.infer<typeof capacityQuerySchema>;

export const createPlanningOrdersSchema = z.object({
  proposals: z
    .array(
      z
        .object({
          articleId: z.string().uuid(),
          // User-editable before creation — Monitor lets the planner override.
          quantity: z.coerce.number().positive(),
          // "subcontract" = a lego operation needs buying: the proposal is
          // keyed by moOperationId (an operation, not an article-level need).
          // "configured" = a configured (beställningsvara) sales order row
          // needs its own TO: keyed by salesOrderRowId (konfigurator 4c).
          kind: z.enum(["purchase", "manufacture", "subcontract", "configured"]),
          moOperationId: z.string().uuid().optional(),
          salesOrderRowId: z.string().uuid().optional(),
        })
        .refine((p) => p.kind !== "subcontract" || p.moOperationId !== undefined, {
          message: "moOperationId is required for subcontract proposals",
          path: ["moOperationId"],
        })
        .refine((p) => p.kind !== "configured" || p.salesOrderRowId !== undefined, {
          message: "salesOrderRowId is required for configured proposals",
          path: ["salesOrderRowId"],
        })
    )
    .min(1),
});
export type CreatePlanningOrdersInput = z.infer<typeof createPlanningOrdersSchema>;

// GET /articles/:id/due-date-suggestion — färdigdatumsförslag for a new TO.
// salesOrderRowId: the KO row the TO is made for (its own delivery date is
// then the firm demand).
export const dueDateSuggestionQuerySchema = z.object({
  salesOrderRowId: z.string().uuid().optional(),
});
export type DueDateSuggestionQuery = z.infer<typeof dueDateSuggestionQuerySchema>;
