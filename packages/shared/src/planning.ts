import { z } from "zod";
import { orderRowConfigurationInputSchema } from "./configurator.js";
import { listQuerySchema } from "./list.js";
import { businessDateSchema } from "./business-date.js";

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

// Leveranstidskontroll: POST /delivery-time-check. salesOrderId = check an
// existing order (its own rows are not existing demand; without `rows` the
// order's open rows are checked). A configured row carries its selection.
// `rows`, when given, is never empty — an empty list with a salesOrderId
// would check nothing and answer with an empty result.
export const deliveryTimeCheckSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    salesOrderId: z.string().uuid().optional(),
    rows: z
      .array(
        z.object({
          articleId: z.string().uuid(),
          quantity: z.coerce.number().positive(),
          configuration: orderRowConfigurationInputSchema.optional(),
        })
      )
      .min(1)
      .max(200)
      .optional(),
  })
  .refine((d) => d.salesOrderId !== undefined || d.rows !== undefined, {
    message: "rows or salesOrderId required",
    path: ["rows"],
  });
export type DeliveryTimeCheckRequest = z.infer<typeof deliveryTimeCheckSchema>;

// Produktionsplanering: a week is identified by its Monday (YYYY-MM-DD).
// The date arithmetic is UTC on purpose — the Monday is a calendar date the
// client took from the API's own `weeks[].monday`, never a local Date.
export const isMonday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
export const planWeekSchema = businessDateSchema.refine(isMonday, { message: "week must be a Monday" });

// POST /planning/operations/:opId/move — Flytta: the operation starts in
// weekMonday (whole-week capacity, overload allowed) and is locked; with
// moveFollowing the TO's later unlocked operations are replanned after it.
export const moveOperationSchema = z.object({
  weekMonday: planWeekSchema,
  moveFollowing: z.boolean().default(true),
});
export type MoveOperationInput = z.infer<typeof moveOperationSchema>;

// POST /delivery-time-check/apply — the reservation: Leveranstidskontrollen is
// run again inside one transaction, the TOs for every shortage batch are
// created with the weeks the check booked, and the order's Förväntat
// leveransdatum is set. deliveryDate is the date the client was shown — a
// different outcome under the lock is refused (delivery-time-changed).
// expectedOrders: the number of TOs the client showed (the check's
// batches.length) — a different count under the lock is refused the same
// way. Left out, only the date is compared.
export const applyDeliveryTimeSchema = z.object({
  salesOrderId: z.string().uuid(),
  deliveryDate: businessDateSchema,
  expectedOrders: z.number().int().min(0).optional(),
});
export type ApplyDeliveryTimeInput = z.infer<typeof applyDeliveryTimeSchema>;
