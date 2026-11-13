import { z } from "zod";
import { listQuerySchema, statusListParam } from "./list.js";
import { blankSafe } from "./coerce.js";
import { businessDateSchema } from "./business-date.js";

// Spärrade lagerplatser as a list filter: "true" = only blocked places,
// "false" = without them, absent = all. NOT z.coerce.boolean() — that turns
// "false" into true.
const blockedFilterParam = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === "true"));

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
  blocked: blockedFilterParam,
});
export type ListStockBalancesQuery = z.infer<typeof listStockBalancesQuerySchema>;

// GET /stock/batch-balances (#8): the cells of the batchstyrda among these
// articles, optionally on one place.
export const listStockBatchBalancesQuerySchema = z.object({
  articleIds: z
    .string()
    .transform((raw) => raw.split(",").map((p) => p.trim()).filter((p) => p !== ""))
    .pipe(z.array(z.string().uuid()).min(1).max(200)),
  locationId: z.string().uuid().optional(),
});

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
  // Batch (#8): only the rows booked in this batch.
  batchId: z.string().uuid().optional(),
});
export type ListStockTransactionsQuery = z.infer<typeof listStockTransactionsQuerySchema>;

// Källa: the document a log row came from (null when unresolvable).
export type StockTransactionReference =
  | { kind: "purchase_order" | "sales_order" | "manufacturing_order" | "stock_count"; id: string; number: string }
  | { kind: "manual" }
  | { kind: "transfer"; counterpartLocation: string };

// Batch (#8). An INFLOW names its batch by number (the supplier's batch on
// an inleverans, a number typed on a justering): trimmed, at most 50
// characters, "" = left out — an empty field means the routine's default
// (the IO number, or Okänd). Compared case-insensitively per article.
export const batchNumberSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(50).optional()
);
// Utgångsdatum / Batchdatum on a write (etapp 2): an ISO day, "" = left out.
export const batchDayInputSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  businessDateSchema.optional()
);
// GET /stock/batches (#8, Spårbarhet): the batch register — search on the
// batch number or the article's number/name, optionally one article.
// `expiry` (etapp 2) is the avisering Utgångna batcher's "Visa alla" — the
// SAME rows: `due` = batches of spårade articles with stock on a place that
// is not blocked and an utgångsdatum within the setting's window (expired
// ones included), `expired` = only those already past it. Sorted on the date.
export const STOCK_BATCH_EXPIRY_FILTERS = ["due", "expired"] as const;
export const listStockBatchesQuerySchema = listQuerySchema.extend({
  articleId: z.string().uuid().optional(),
  expiry: z.enum(STOCK_BATCH_EXPIRY_FILTERS).optional(),
});

// PATCH /stock/batches/:id (etapp 2): correct a batch's utgångsdatum,
// Batchdatum (null clears either) or a mistyped number. The batch row is not
// part of the append-only log; archived documents are not changed.
export const updateStockBatchSchema = z
  .object({
    expiresOn: businessDateSchema.nullable().optional(),
    batchDate: businessDateSchema.nullable().optional(),
    batchNumber: z.string().trim().min(1).max(50).optional(),
  })
  .strict()
  .refine((input) => input.expiresOn !== undefined || input.batchDate !== undefined || input.batchNumber !== undefined, {
    message: "Nothing to change",
  });
export type UpdateStockBatchInput = z.infer<typeof updateStockBatchSchema>;
export type ListStockBatchesQuery = z.infer<typeof listStockBatchesQuerySchema>;

export const STOCK_BATCH_ORIGINS = ["purchase_receipt", "manufacturing_order", "manual", "import"] as const;
export type StockBatchOrigin = (typeof STOCK_BATCH_ORIGINS)[number];

export interface StockBatchListRow {
  id: string;
  batchNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unitCode: string;
  origin: StockBatchOrigin;
  createdAt: string;
  // Etapp 2: Utgångsdatum (the last usable day), Batchdatum (null = the day
  // of createdAt) and whether the batch is utgången today (Stockholm day).
  expiresOn: string | null;
  batchDate: string | null;
  expired: boolean;
  // Physical balance over every place (blocked ones included), base unit.
  quantity: number;
}

// GET /stock/batches/:id/trace (#8). Everything is derived from the stock
// log and the documents' own links; quantities are in the article's base
// unit, moments ISO strings.
export interface TraceBatchRef {
  // null = Okänd (stock without a batch) — always a leaf.
  batchId: string | null;
  batchNumber: string | null;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unitCode: string;
  // The article's flag NOW — a leaf without a batch is "Okänd" on a
  // batchstyrd article and "ej batchstyrd" otherwise.
  batchTracked: boolean;
  // Etapp 2: the article's Spårning now (batchTracked = it is "batch"), and
  // the batch's utgångsdatum (null = none, or Okänd).
  tracking: "none" | "batch" | "serial";
  expiresOn: string | null;
  origin: StockBatchOrigin | null;
  createdAt: string | null;
}
// Why a node has no children of its own: null = it is expanded here;
// "unknown" = Okänd (never followed); "repeated" = the same batch is already
// expanded elsewhere in this tree (a diamond, or a cycle such as rework);
// "limit" = the depth/node ceiling stopped the trace (truncated is true).
export type TraceStop = null | "unknown" | "repeated" | "limit";
export interface TraceEvent {
  // A Lagerjustering (incl. the saldoimport) or an inventering's difference.
  kind: "adjustment" | "stock_count";
  stockCountId: string | null;
  stockCountNumber: string | null;
  at: string;
  // Signed: positive under backward (a source), negative under forward.
  quantity: number;
  note: string | null;
}
export interface TraceReceipt {
  purchaseOrderId: string;
  orderNumber: string;
  supplierId: string;
  supplierName: string;
  receivedAt: string;
  quantity: number;
}
export interface TraceDelivery {
  deliveryId: string;
  deliveryNumber: string;
  salesOrderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  deliveredAt: string;
  quantity: number;
}
export interface TraceOnHand {
  locationId: string;
  warehouseName: string;
  locationName: string;
  blocked: boolean;
  quantity: number;
}
export interface BackwardTraceNode {
  batch: TraceBatchRef;
  stop: TraceStop;
  // How much of this batch the TO above it drew; null on the root.
  quantity: number | null;
  // Inleveranser (not undone) the batch came in through.
  receipts: TraceReceipt[];
  // The TO(s) whose finished goods are this batch, each with what it drew.
  manufacturingOrders: {
    manufacturingOrderId: string;
    orderNumber: string;
    // Received into this batch, net of undone reports.
    quantity: number;
    materials: BackwardTraceNode[];
  }[];
  // Positive adjustments / stock-count differences into the batch.
  events: TraceEvent[];
}
export interface ForwardTraceNode {
  batch: TraceBatchRef;
  stop: TraceStop;
  // How much the TO above it received into this batch; null on the root.
  quantity: number | null;
  // TOs that drew from the batch, each with the batch(es) it produced.
  consumedBy: {
    manufacturingOrderId: string;
    orderNumber: string;
    articleId: string;
    articleNumber: string;
    articleName: string;
    // Drawn from this batch, net of undone/returned.
    quantity: number;
    // Empty = nothing received yet.
    produced: ForwardTraceNode[];
  }[];
  // Utleveranser (rows not undone) the batch left in.
  deliveries: TraceDelivery[];
  // Negative adjustments / stock-count differences (kassation, svinn).
  events: TraceEvent[];
  // What is still in stock, per place.
  onHand: TraceOnHand[];
}
export interface BatchTrace {
  batch: TraceBatchRef;
  backward: BackwardTraceNode;
  forward: ForwardTraceNode;
  // The ceiling (depth 12, 500 nodes per direction) cut something off.
  truncated: boolean;
}

// An OUTFLOW chooses among the article's batches by id: left out =
// Automatiskt (oldest first), null = Okänd.
export const batchChoiceSchema = z.string().uuid().nullable().optional();
// What a row without a batch is called everywhere — reserved as a number.
export const UNKNOWN_BATCH_LABEL = "Okänd";

export const createStockTransactionSchema = z.object({
  articleId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  quantityDelta: blankSafe(z.coerce.number().refine((n) => n !== 0, "quantityDelta cannot be zero")),
  // A transfer is always two paired rows, so it can only be booked through
  // POST /stock/transfers — never one leg at a time through this endpoint.
  transactionType: stockTransactionTypeSchema.exclude(["stock_transfer"]),
  referenceId: z.string().uuid().optional(),
  note: z.string().max(2000).optional(),
  // Batch (#8): only on an inflow (positive delta) of a batchstyrd article
  // — left out, the goods are Okänd.
  batchNumber: batchNumberSchema,
  // Etapp 2: the new batch's Utgångsdatum — only with batchNumber (an
  // existing batch with another date is refused, 409 batch-expiry-mismatch).
  expiresOn: batchDayInputSchema,
  // …and on a decrease (negative delta) the batch to take from: left out =
  // the place's batches oldest first (Okänd first, the rest as Okänd), null
  // = Okänd, an id = that batch, which must cover the quantity.
  batchId: batchChoiceSchema,
});
export type CreateStockTransactionInput = z.infer<typeof createStockTransactionSchema>;

// POST /stock/transactions — Lagerjustering: the only movement the route
// books by itself. Inleverans, utleverans, TO-uttag/-inleverans and flytt
// belong to their own routines, which link the movement to its document and
// price it; a free row typed as one of them would count as that document's
// in FIFO, the latest purchase price and the stock log (granskningen
// 2026-11-10). Omitted = inventory_adjustment; anything else is 400.
export const createStockAdjustmentSchema = createStockTransactionSchema
  .extend({
    transactionType: z.literal("inventory_adjustment").default("inventory_adjustment"),
  })
  .refine((input) => input.batchNumber === undefined || input.quantityDelta > 0, {
    message: "batchNumber names the batch of an inflow — only with a positive quantityDelta",
    path: ["batchNumber"],
  })
  .refine((input) => input.batchId === undefined || input.quantityDelta < 0, {
    message: "batchId chooses the batch of a decrease — only with a negative quantityDelta",
    path: ["batchId"],
  })
  .refine((input) => input.expiresOn === undefined || input.batchNumber !== undefined, {
    message: "expiresOn is the utgångsdatum of the batch named by batchNumber",
    path: ["expiresOn"],
  });

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
          quantity: blankSafe(z.coerce.number().positive()),
          // Batch (#8), a batchstyrd article: the batch follows the goods.
          // Left out = Automatiskt (the source's batches, oldest first, one
          // pair of legs each), null = Okänd, an id = that batch for the
          // row's whole quantity — two chosen batches are two rows.
          batchId: batchChoiceSchema,
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

// Lagerplatsregistret (/lager/platser) — GET /stock/locations/register[/csv].
// GET /stock/locations keeps its array form for the place pickers. search
// matches the place's name, the warehouse's name and the etikettkod (LP0042
// = label_number 42); status defaults to the active places.
export const STOCK_LOCATION_REGISTER_STATUSES = ["active", "inactive", "all"] as const;
export const listStockLocationRegisterQuerySchema = listQuerySchema.extend({
  warehouseId: z.string().uuid().optional(),
  status: z.enum(STOCK_LOCATION_REGISTER_STATUSES).default("active"),
  blocked: blockedFilterParam,
});
export type ListStockLocationRegisterQuery = z.infer<typeof listStockLocationRegisterQuerySchema>;

// A place's balance summed per unit (the articles' base unit) — a sum over
// st and kg means nothing. Articles netting to 0 are left out; a negative
// balance is included. quantity is numeric as text ("120.0000").
export interface StockLocationUnitBalance {
  unitCode: string;
  quantity: string;
}

// One row of the register. articleCount = the articles whose balance on the
// place is not 0 (the sum of the per-unit counts).
export interface StockLocationRegisterRow {
  id: string;
  warehouseId: string;
  warehouseName: string;
  name: string;
  labelCode: string;
  active: boolean;
  fixed: boolean;
  blocked: boolean;
  blockedAt: string | null;
  blockedNote: string | null;
  articleCount: number;
  balances: StockLocationUnitBalance[];
}

// Spärrad lagerplats: the note on a blocked place (stock_locations.blocked_note,
// varchar 200). Trimmed; blank = no note.
const blockedNoteSchema = z
  .string()
  .trim()
  .max(200, "Anteckningen får vara högst 200 tecken")
  .transform((value) => (value === "" ? null : value));

// fixed (Fast lagerplats): stays active when emptied; a temporary location
// (false) is deactivated automatically the moment it is empty.
// blocked (Spärrad lagerplats): a Karantän can be created blocked — the note
// only goes with a blocked place.
export const createStockLocationSchema = z
  .object({
    warehouseId: z.string().uuid(),
    name: z.string().min(1).max(100),
    active: z.boolean().default(true),
    fixed: z.boolean().default(true),
    blocked: z.boolean().default(false),
    blockedNote: blockedNoteSchema.nullable().optional(),
  })
  .refine((data) => data.blocked || data.blockedNote == null, {
    message: "En anteckning hör bara till en spärrad lagerplats",
    path: ["blockedNote"],
  });
export type CreateStockLocationInput = z.infer<typeof createStockLocationSchema>;

// blockedNote edits the note of a BLOCKED place (null/"" clears it); the
// flag itself only changes through POST /stock/locations/:id/block|unblock.
export const updateStockLocationSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    warehouseId: z.string().uuid().optional(),
    active: z.boolean().optional(),
    fixed: z.boolean().optional(),
    blockedNote: blockedNoteSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateStockLocationInput = z.infer<typeof updateStockLocationSchema>;

// POST /stock/locations/:id/block — Spärra lagerplats with an optional note.
export const blockStockLocationSchema = z.object({
  note: blockedNoteSchema.nullable().optional(),
});
export type BlockStockLocationInput = z.infer<typeof blockStockLocationSchema>;

// Flera lagerplatser per artikel (migration 0186) — PUT /articles/:id/locations
// replaces the whole set: the huvudplats (articles.default_location_id; null
// = none, an inflow then goes to the first usable alternative or "***") and
// the alternative places in order. The schema is only the shape: at most
// ARTICLE_ALTERNATIVE_LOCATIONS_MAX, no duplicates and the huvudplats not
// among them are the server's rules (stock/service/article-locations.ts),
// so they answer 400 article-location-invalid with Swedish text like the
// rules on the places themselves.
export const ARTICLE_ALTERNATIVE_LOCATIONS_MAX = 20;
export const articleLocationsSchema = z.object({
  primaryLocationId: z.string().uuid().nullable(),
  alternativeLocationIds: z.array(z.string().uuid()),
});
export type ArticleLocationsInput = z.infer<typeof articleLocationsSchema>;

// GET /articles/:id/locations (and PUT's answer): one of the article's places
// with the article's own balance there (numeric as text, "0.0000" when none).
export interface ArticleLocationPlace {
  locationId: string;
  warehouseId: string;
  warehouseName: string;
  name: string;
  labelCode: string;
  active: boolean;
  blocked: boolean;
  fixed: boolean;
  quantityOnHand: string;
}

// alternatives in order (Alternativ 1, 2, …). A place that is the huvudplats
// is shown only there, even if a row still lists it as an alternative.
export interface ArticleLocations {
  primary: ArticleLocationPlace | null;
  alternatives: ArticleLocationPlace[];
}

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
  // Batch (#8), a batchstyrd article: the batch the new row counts (created
  // when it is new); left out = the article's Okänd row.
  batchNumber: batchNumberSchema,
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
