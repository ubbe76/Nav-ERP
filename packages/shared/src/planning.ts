import { z } from "zod";
import { orderRowConfigurationInputSchema } from "./configurator.js";
import { listQuerySchema } from "./list.js";
import { abcClassListParam } from "./abc.js";
import { businessDateSchema } from "./business-date.js";
import { blankSafe, INT4_MAX, numericMax, numericStep } from "./coerce.js";

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
  // Tidsfasade förslag (#13): sort by article number (as before) or by the
  // earliest latest order/start date (undated last); `latest` keeps only the
  // proposals whose latest date falls inside the horizon — late = already
  // passed, the others up to and including the Sunday of this / next / the
  // fourth week (a passed date is inside every horizon).
  sort: z.enum(["article", "latest"]).default("article"),
  latest: z.enum(["late", "this_week", "next_week", "four_weeks"]).optional(),
  // The page's Alla / Artiklar / Lego toggle: "lego" = only the lego
  // operation rows (proposalKind subcontract), "article" = everything else.
  // Filtered BEFORE paging so total follows it — the web used to filter one
  // limit=1000 page itself, and the lego rows (sorted last) fell off it.
  kind: z.enum(["article", "lego"]).optional(),
});
export type ListRequirementsQuery = z.infer<typeof listRequirementsQuerySchema>;

// ABC-klassning (#10, etapp 2): GET /planning/abc — the list pattern over a
// classification that is computed for the whole selection at every read
// (the cumulative share needs the total), then filtered and paged in
// memory. `class` takes a comma-separated list ("A,B").
export const listAbcQuerySchema = listQuerySchema.extend({
  class: abcClassListParam(),
  type: z.enum(["purchased", "manufactured"]).optional(),
});
export type ListAbcQuery = z.infer<typeof listAbcQuerySchema>;

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
          quantity: blankSafe(z.coerce.number().min(numericStep(4)).max(numericMax(14, 4))),
          // "subcontract" = a lego operation needs buying: the proposal is
          // keyed by moOperationId (an operation, not an article-level need).
          // "configured" = a configured (beställningsvara) sales order row
          // needs its own TO: keyed by salesOrderRowId (konfigurator 4c).
          kind: z.enum(["purchase", "manufacture", "subcontract", "configured"]),
          moOperationId: z.string().uuid().optional(),
          salesOrderRowId: z.string().uuid().optional(),
          // Tidsfasade förslag (#13): the proposal's own need date — the TO's
          // färdigdatum and the IO row's önskade leveransdatum are counted
          // from it. Omitted (integrations) ⇒ the first firm demand decides,
          // as before.
          needDate: businessDateSchema.optional(),
          // The proposal's reason: a reorder-point proposal (and material for
          // one) is "now" for no deadline, and a forecast-only proposal
          // (Prognos #10) is for no deadline either, so Skapa ordrar never
          // warns that either is late. Omitted = an ordinary demand.
          reason: z.enum(["demand", "reorder_point", "safety_stock", "forecast", "undated"]).optional(),
          // The proposal's key as the list showed it (RequirementProposal.key,
          // e.g. "purchase:<articleId>:2026-11-16"). Given ⇒ the server
          // recomputes the behovsberäkning first and refuses the proposal
          // when the fresh result no longer has it — already covered by
          // orders someone else (another tab, a repeated click) just made.
          // Omitted (integrations, the TO card's Skapa inköpsorder) ⇒ no
          // check, as before.
          key: z.string().min(1).max(200).optional(),
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
// quantity: the TO quantity the lead time is counted for (the routing's
// setup + run × quantity when the article has no Ledtid (dagar) field);
// omitted ⇒ 1.
export const dueDateSuggestionQuerySchema = z.object({
  salesOrderRowId: z.string().uuid().optional(),
  quantity: z.coerce.number().min(numericStep(4)).max(numericMax(14, 4)).optional(),
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
          quantity: blankSafe(z.coerce.number().min(numericStep(4)).max(numericMax(14, 4))),
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

// GET /planning/run-plan — Körplan: a resource's coming work up to and
// including the week `toWeek` (a Monday; left out = next week, Stockholm).
// Without a resource the answer only carries the picker's stations.
export const runPlanQuerySchema = z.object({
  workCenterId: z.string().uuid().optional(),
  toWeek: planWeekSchema.optional(),
});
export type RunPlanQuery = z.infer<typeof runPlanQuerySchema>;

// GET /planning/run-plan/pdf — the printout is always of one resource.
export const runPlanPdfQuerySchema = runPlanQuerySchema.required({ workCenterId: true });
export type RunPlanPdfQuery = z.infer<typeof runPlanPdfQuerySchema>;

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
// useAlternatives (#15, förval true): the date the client chose when the
// check showed both — true = Med alternativa resurser (the alternatives are
// used when they give the earlier date; the TOs' operations on an
// alternative are written Vald för hand), false = Med ordinarie resurser.
// The server runs the check in that mode and compares deliveryDate with it.
// Left out = true.
export const applyDeliveryTimeSchema = z.object({
  salesOrderId: z.string().uuid(),
  deliveryDate: businessDateSchema,
  expectedOrders: z.number().int().min(0).max(INT4_MAX).optional(),
  useAlternatives: z.boolean().optional(),
});
export type ApplyDeliveryTimeInput = z.infer<typeof applyDeliveryTimeSchema>;

// POST /manufacturing-orders/:id/component-moves — Flytta halvfabrikaten
// (pegging #9): the chosen TOs from GET …/coverage's `moves` with the due
// date to set and the one the dialog showed (expectedDueDate, null = none);
// a TO whose date changed meanwhile refuses the whole request
// (component-move-changed). Each TO at most once.
export const componentMovesSchema = z.object({
  moves: z
    .array(
      z.object({
        manufacturingOrderId: z.string().uuid(),
        dueDate: businessDateSchema,
        expectedDueDate: businessDateSchema.nullable(),
      })
    )
    .min(1)
    .refine((moves) => new Set(moves.map((m) => m.manufacturingOrderId)).size === moves.length, {
      message: "A manufacturing order may only be listed once",
    }),
});
export type ComponentMovesInput = z.infer<typeof componentMovesSchema>;

// POST /manufacturing-orders/:id/missing-components — Skapa saknade
// halvfabrikat (pegging #9): the tree the client confirmed from GET
// …/missing-components, as (articleId, quantity, level) — the server
// recomputes the preview under the plan lock and refuses another tree
// (missing-components-changed) or an empty one (nothing-to-create).
export const missingComponentsSchema = z.object({
  expected: z
    .array(
      z.object({
        articleId: z.string().uuid(),
        quantity: blankSafe(z.coerce.number().min(numericStep(4)).max(numericMax(14, 4))),
        level: z.number().int().min(1).max(INT4_MAX),
      })
    )
    .min(1),
});
export type MissingComponentsInput = z.infer<typeof missingComponentsSchema>;

// Prognos (#10): PUT /articles/:id/forecast — the own quantity per month
// ("YYYY-MM"; null removes it so the average applies again). Only months in
// the horizon are accepted (400 forecast-month-outside-horizon); a month is
// given at most once.
export const forecastMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");
export const articleForecastUpdateSchema = z.object({
  months: z
    .array(z.object({ month: forecastMonthSchema, quantity: blankSafe(z.coerce.number().nonnegative().max(numericMax(14, 4))).nullable() }))
    .min(1)
    .refine((months) => new Set(months.map((m) => m.month)).size === months.length, { message: "each month at most once" }),
});
export type ArticleForecastUpdateInput = z.infer<typeof articleForecastUpdateSchema>;
