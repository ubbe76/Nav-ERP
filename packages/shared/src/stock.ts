import { z } from "zod";
import { listQuerySchema, statusListParam } from "./list.js";

// articleIds: the Utleverans page asks for the locations (with balances) of
// every article on the order in ONE call — `?articleIds=<uuid>,<uuid>`.
export const listStockBalancesQuerySchema = listQuerySchema.extend({
  articleId: z.string().uuid().optional(),
  articleIds: z
    .string()
    .optional()
    .transform((raw) => (raw === undefined ? undefined : raw.split(",").map((p) => p.trim()).filter((p) => p !== "")))
    .pipe(z.array(z.string().uuid()).min(1).max(200).optional()),
  locationId: z.string().uuid().optional(),
});
export type ListStockBalancesQuery = z.infer<typeof listStockBalancesQuerySchema>;

export const stockTransactionTypeSchema = z.enum([
  "purchase_receipt",
  "sales_delivery",
  "mo_consumption",
  "mo_receipt",
  "inventory_adjustment",
  "stock_transfer",
]);
export type StockTransactionType = z.infer<typeof stockTransactionTypeSchema>;

// Lagerloggen (/lager/transaktioner): the plain list base plus the log's
// filters. from/to are Stockholm calendar days, inclusive on both ends.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum måste vara ÅÅÅÅ-MM-DD")
  .refine((d) => {
    const parsed = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(d);
  }, "Ogiltigt datum");
export const listStockTransactionsQuerySchema = listQuerySchema.extend({
  articleId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  type: stockTransactionTypeSchema.optional(),
  direction: z.enum(["in", "out"]).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type ListStockTransactionsQuery = z.infer<typeof listStockTransactionsQuerySchema>;

// Källa: the document a log row came from (null when unresolvable).
export type StockTransactionReference =
  | { kind: "purchase_order" | "sales_order" | "manufacturing_order" | "stock_count"; id: string; number: string }
  | { kind: "manual" }
  | { kind: "transfer"; counterpartLocation: string };

export const createStockTransactionSchema = z.object({
  articleId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  quantityDelta: z.coerce.number().refine((n) => n !== 0, "quantityDelta cannot be zero"),
  // A transfer is always two paired rows, so it can only be booked through
  // POST /stock/transfers — never one leg at a time through this endpoint.
  transactionType: stockTransactionTypeSchema.exclude(["stock_transfer"]),
  referenceId: z.string().uuid().optional(),
  note: z.string().max(2000).optional(),
});
export type CreateStockTransactionInput = z.infer<typeof createStockTransactionSchema>;

// Lagerflytt — move balances from one stock location to another. Both legs of
// every row are written in one transaction; see stock.repository.transferStock.
export const createStockTransferSchema = z
  .object({
    fromLocationId: z.string().uuid(),
    toLocationId: z.string().uuid(),
    note: z.string().max(2000).optional(),
    rows: z
      .array(
        z.object({
          articleId: z.string().uuid(),
          quantity: z.coerce.number().positive(),
        })
      )
      .min(1),
  })
  .refine(
    (data) => data.fromLocationId !== data.toLocationId,
    "Från- och till-lagerplats måste skilja sig"
  );
export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;

export const createWarehouseSchema = z.object({
  name: z.string().min(1).max(100),
  active: z.boolean().default(true),
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const updateWarehouseSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

// Emptied locations are deactivated rather than deleted, so the register page
// needs a way to see them. Everything else (form dropdowns) gets active only.
// NOT z.coerce.boolean() — that turns the string "false" into true.
export const listStockLocationsQuerySchema = z.object({
  includeInactive: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListStockLocationsQuery = z.infer<typeof listStockLocationsQuerySchema>;

// fixed (Fast lagerplats): stays active when emptied; a temporary location
// (false) is deactivated automatically the moment it is empty.
export const createStockLocationSchema = z.object({
  warehouseId: z.string().uuid(),
  name: z.string().min(1).max(100),
  active: z.boolean().default(true),
  fixed: z.boolean().default(true),
});
export type CreateStockLocationInput = z.infer<typeof createStockLocationSchema>;

export const updateStockLocationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    warehouseId: z.string().uuid().optional(),
    active: z.boolean().optional(),
    fixed: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateStockLocationInput = z.infer<typeof updateStockLocationSchema>;

// Lagervärdering (D1) — GET /stock/valuation[/pdf]. asOf defaults to today
// (server-side, sv-SE) when omitted; groupId narrows to one varugrupp and
// articleCodeId to one artikelkod; groupBy picks what the report is
// subtotalled on (default the varugrupp).
// fifo (#19): what is left is priced from the newest inflows back (fifo.ts).
export const valuationMethodSchema = z.enum(["standard", "latest_purchase", "moving_average", "fifo"]);
export type ValuationMethod = z.infer<typeof valuationMethodSchema>;

export const valuationGroupBySchema = z.enum(["group", "articleCode"]);
export type ValuationGroupBy = z.infer<typeof valuationGroupBySchema>;

export const valuationQuerySchema = z.object({
  asOf: z.string().date().optional(),
  method: valuationMethodSchema,
  groupId: z.string().uuid().optional(),
  articleCodeId: z.string().uuid().optional(),
  groupBy: valuationGroupBySchema.default("group"),
});
// Input type: groupBy may be omitted by direct callers (the year-end closing).
export type ValuationQuery = z.input<typeof valuationQuerySchema>;

// --- Inventering (D2) — stock-count sessions ---

export const stockCountStatusSchema = z.enum(["open", "posted", "cancelled"]);
export type StockCountStatus = z.infer<typeof stockCountStatusSchema>;

export const createStockCountSchema = z.object({
  locationId: z.string().uuid(),
  blocksTransactions: z.boolean(),
  note: z.string().max(2000).optional(),
});
export type CreateStockCountInput = z.infer<typeof createStockCountSchema>;

export const listStockCountsQuerySchema = listQuerySchema.extend({
  status: statusListParam(stockCountStatusSchema.options),
  // One place's counts — a scanned lagerplats label opens its open count.
  locationId: z.string().uuid().optional(),
});
export type ListStockCountsQuery = z.infer<typeof listStockCountsQuerySchema>;

export const addStockCountRowSchema = z.object({
  articleId: z.string().uuid(),
});
export type AddStockCountRowInput = z.infer<typeof addStockCountRowSchema>;

// countedQuantity: a number >= 0 sets the count, explicit null clears it back
// to "not counted". NOT z.coerce...nullable() — coercion turns null into 0,
// and a phantom 0 would post the whole balance away at registration. Blank
// strings are the same trap ("" coerces to 0), hence the preprocess step —
// same idiom as postingVatRateSchema in vat.ts: NaN fails the coercion.
export const updateStockCountRowSchema = z
  .object({
    countedQuantity: z
      .union([
        z.null(),
        z.preprocess(
          (value) => (typeof value === "string" && value.trim() === "" ? Number.NaN : value),
          z.coerce.number().min(0)
        ),
      ])
      .optional(),
    note: z.union([z.null(), z.string().max(2000)]).optional(),
  })
  .refine(
    (data) => data.countedQuantity !== undefined || data.note !== undefined,
    "At least one field must be provided"
  );
export type UpdateStockCountRowInput = z.infer<typeof updateStockCountRowSchema>;

// POST /stock-counts/:id/post (#26). count_date = book the differences per
// the moment the underlag was created, today = per the registration. Omitted
// = count_date when allowed (GET's backdating.allowed), else today.
export const STOCK_COUNT_BOOK_ON = ["count_date", "today"] as const;
export type StockCountBookOn = (typeof STOCK_COUNT_BOOK_ON)[number];
export const postStockCountSchema = z.object({ bookOn: z.enum(STOCK_COUNT_BOOK_ON).optional() }).strict();
export type PostStockCountInput = z.infer<typeof postStockCountSchema>;

// Blind count is the default — booked balances print only on request.
// Same "NOT z.coerce.boolean()" reasoning as listStockLocationsQuerySchema.
export const stockCountPdfQuerySchema = z.object({
  showBalances: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type StockCountPdfQuery = z.infer<typeof stockCountPdfQuerySchema>;
