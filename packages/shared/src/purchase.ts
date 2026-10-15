import { z } from "zod";
import { materialShortageOverrideSchema } from "./manufacturing.js";
import { listQuerySchema, statusListParam } from "./list.js";
import { blankSafe } from "./coerce.js";
import { vatRateSchema } from "./vat.js";
import { paymentReferenceSchema, supplierPaymentDetailsFields } from "./banking.js";

export const purchaseOrderStatusSchema = z.enum([
  "draft",
  "confirmed",
  "partially_received",
  "received",
  "closed",
  "cancelled",
]);
export type PurchaseOrderStatus = z.infer<typeof purchaseOrderStatusSchema>;

export const listPurchaseOrdersQuerySchema = listQuerySchema.extend({
  status: statusListParam(purchaseOrderStatusSchema.options),
  // Restricts the list to one supplier's orders (e.g. picking a received
  // order as invoice basis on a supplier invoice).
  supplierId: z.string().uuid().optional(),
  // Legoinköp: "lego" = orders with at least one row linked to a TO operation
  // (moOperationId), "regular" = orders without one.
  kind: z.enum(["lego", "regular"]).optional(),
  // Adds openRowCount (rows still short of their ordered quantity) to each
  // row — an extra correlated subquery, so it's opt-in. NOT z.coerce.boolean()
  // — see listUsersQuerySchema's includeDeleted for the "false" string pitfall.
  // .optional() comes AFTER .transform() here (unlike includeDeleted) so the
  // inferred field stays optional (boolean | undefined) instead of a required
  // boolean — callers that build ListPurchaseOrdersQuery by hand (tests, other
  // modules) don't have to pass it.
  withOpenRows: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type ListPurchaseOrdersQuery = z.infer<typeof listPurchaseOrdersQuerySchema>;

// Förfrågan (RFQ) — state machine: draft → sent → answered → ordered,
// cancellable until ordered. Validated in the purchase service.
export const inquiryStatusSchema = z.enum(["draft", "sent", "answered", "ordered", "cancelled"]);
export type InquiryStatus = z.infer<typeof inquiryStatusSchema>;

export const listInquiriesQuerySchema = listQuerySchema.extend({
  status: statusListParam(inquiryStatusSchema.options),
});
export type ListInquiriesQuery = z.infer<typeof listInquiriesQuerySchema>;

const inquiryRowSchema = z
  .object({
    articleId: z.string().uuid(),
    // quantity/unitPrice are entered in the chosen unit (the article's base
    // unit when unitId is omitted/null) and stored converted to the base unit.
    quantity: z.coerce.number().positive(),
    // Left out until the supplier has answered with a price.
    unitPrice: z.coerce.number().nonnegative().optional(),
    unitId: z.string().uuid().nullable().optional(),
    // Lego (subcontract) link — at most one of the two; the service derives
    // the routing operation from the MO operation. A TO operation comes
    // from the behovsberäkning, a bare routing operation from the article
    // card (TO-less price inquiry) or the inquiry card's "Legooperation".
    moOperationId: z.string().uuid().optional(),
    routingOperationId: z.string().uuid().optional(),
    // Ställpris — omitted = defaulted from the operation by the service.
    setupPrice: blankSafe(z.coerce.number().nonnegative()).optional(),
  })
  .refine((r) => !(r.moOperationId && r.routingOperationId), {
    message: "Ange antingen moOperationId eller routingOperationId",
    path: ["routingOperationId"],
  })
  .refine((r) => r.setupPrice === undefined || Boolean(r.moOperationId || r.routingOperationId), {
    message: "setupPrice kräver en legooperation",
    path: ["setupPrice"],
  });

export const createInquirySchema = z.object({
  supplierId: z.string().uuid(),
  expectedDeliveryDate: z.string().date().optional(),
  note: z.string().optional(),
  rows: z.array(inquiryRowSchema).min(1),
});
export type CreateInquiryInput = z.infer<typeof createInquirySchema>;

export const createInquiryRowSchema = inquiryRowSchema;
export type CreateInquiryRowInput = z.infer<typeof createInquiryRowSchema>;

export const updateInquiryRowSchema = z
  .object({
    // Interpreted in the row's unit (or the newly provided unitId; null
    // switches the row back to the article's base unit).
    quantity: z.coerce.number().positive().optional(),
    unitPrice: z.coerce.number().nonnegative().nullable().optional(),
    unitId: z.string().uuid().nullable().optional(),
    // Lego rows only (the service rejects it elsewhere); null clears. The
    // operation link itself is fixed after creation, like PO rows.
    setupPrice: blankSafe(z.coerce.number().nonnegative()).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateInquiryRowInput = z.infer<typeof updateInquiryRowSchema>;

// Terms on the inquiry header (snapshotted from the supplier at creation) —
// editable with the same status rule as the rows (not ordered/cancelled).
export const updateInquiryHeaderSchema = z
  .object({
    deliveryTermId: z.string().uuid().nullable().optional(),
    paymentTermId: z.string().uuid().nullable().optional(),
    carrierId: z.string().uuid().nullable().optional(),
    // "Frakt på vårt konto" — carried to the PO on convert, printed on the PDF.
    freightPaidByUs: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateInquiryHeaderInput = z.infer<typeof updateInquiryHeaderSchema>;

export const createSupplierSchema = z.object({
  name: z.string().min(1).max(255),
  // Leverantörsnummer — omitted = allocated from the "supplier" number
  // series. Manually chosen numbers must be unique (409 on duplicates).
  supplierNumber: z.string().trim().min(1).max(50).optional(),
  contactName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  address: z.string().optional(),
  postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  orgNumber: z.string().max(20).optional(),
  vatNumber: z.string().max(30).optional(),
  deliveryTermId: z.string().uuid().optional(),
  paymentTermId: z.string().uuid().optional(),
  carrierId: z.string().uuid().optional(),
  carrierCustomerNumber: z.string().max(50).optional(),
  // Our customer number at this supplier — printed on inquiry/PO.
  ourCustomerNumber: z.string().max(50).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "3 stora bokstäver, t.ex. SEK").default("SEK"),
  active: z.boolean().default(true),
  ...supplierPaymentDetailsFields,
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    // Optional but NOT nullable — a supplier always has a number.
    supplierNumber: z.string().trim().min(1).max(50).optional(),
    contactName: z.string().max(255).nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    address: z.string().nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    orgNumber: z.string().max(20).nullable().optional(),
    vatNumber: z.string().max(30).nullable().optional(),
    deliveryTermId: z.string().uuid().nullable().optional(),
    paymentTermId: z.string().uuid().nullable().optional(),
    carrierId: z.string().uuid().nullable().optional(),
    carrierCustomerNumber: z.string().max(50).nullable().optional(),
    ourCustomerNumber: z.string().max(50).nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "3 stora bokst\u00e4ver, t.ex. SEK").optional(),
    active: z.boolean().optional(),
    ...supplierPaymentDetailsFields,
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

// Header only — rows are added separately via createPurchaseOrderRowSchema,
// mirroring the article/BOM pattern (create article, then add BOM rows).
// No `currency` here — it's always snapshotted from the supplier, never
// chosen per order. `exchangeRate` is set manually (no external rate source).
export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  expectedDeliveryDate: z.string().date().optional(),
  note: z.string().optional(),
  exchangeRate: z.coerce.number().positive().default(1),
  // Er referens (the supplier's contact) / Vår referens (our buyer) —
  // printed on the PO document when set.
  yourReference: z.string().max(100).optional(),
  ourReference: z.string().max(100).optional(),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;

// quantity/unitPrice are entered in the chosen unit (base unit when unitId
// is omitted/null) and stored converted to the article's base unit.
// `bumpRevision: false` saves without bumping the order's revision — the
// UI asks on every save; omitted means bump (external callers unchanged).
export const createPurchaseOrderRowSchema = z.object({
  articleId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
  unitId: z.string().uuid().nullable().optional(),
  bumpRevision: z.boolean().optional(),
  // Lego (subcontract) row: the MO operation this row buys. Receiving the
  // row auto-reports the operation. setupPrice (ställpris) is added ONCE to
  // the row amount: qty × unitPrice + setupPrice.
  moOperationId: z.string().uuid().nullable().optional(),
  setupPrice: z.coerce.number().nonnegative().nullable().optional(),
  // Önskat leveransdatum for this row; omitted/null = the order's date.
  expectedDeliveryDate: z.string().date().nullable().optional(),
});
export type CreatePurchaseOrderRowInput = z.infer<typeof createPurchaseOrderRowSchema>;

// Rows stay editable until the order is fully received/closed — the
// repository additionally guards quantity against what's already received.
export const updatePurchaseOrderRowSchema = z
  .object({
    // Interpreted in the row's unit (or the newly provided unitId; null
    // switches the row back to the article's base unit).
    quantity: z.coerce.number().positive().optional(),
    unitPrice: z.coerce.number().nonnegative().optional(),
    unitId: z.string().uuid().nullable().optional(),
    bumpRevision: z.boolean().optional(),
    // Nullable so a lego row's setup price can be cleared. The operation
    // link itself (moOperationId) is set at creation and not editable here.
    setupPrice: z.coerce.number().nonnegative().nullable().optional(),
    // null clears the row's own date (the row follows the order again).
    expectedDeliveryDate: z.string().date().nullable().optional(),
  })
  .refine(
    (data) => Object.keys(data).some((key) => key !== "bumpRevision"),
    "At least one field must be provided"
  );
export type UpdatePurchaseOrderRowInput = z.infer<typeof updatePurchaseOrderRowSchema>;

// PO header fields — editable with the same status rule as the rows
// (draft/confirmed/partially_received). The currency stays locked to the
// snapshot taken from the supplier at creation.
export const updatePurchaseOrderHeaderSchema = z
  .object({
    expectedDeliveryDate: z.string().date().nullable().optional(),
    note: z.string().nullable().optional(),
    // Not nullable — an order always has an exchange rate.
    exchangeRate: z.coerce.number().positive().optional(),
    yourReference: z.string().max(100).nullable().optional(),
    ourReference: z.string().max(100).nullable().optional(),
    deliveryTermId: z.string().uuid().nullable().optional(),
    paymentTermId: z.string().uuid().nullable().optional(),
    carrierId: z.string().uuid().nullable().optional(),
    // "Frakt på vårt konto" — prints our carrier customer number on the PO.
    freightPaidByUs: z.boolean().optional(),
    bumpRevision: z.boolean().optional(),
  })
  .refine(
    (data) => Object.keys(data).some((key) => key !== "bumpRevision"),
    "At least one field must be provided"
  );
export type UpdatePurchaseOrderHeaderInput = z.infer<typeof updatePurchaseOrderHeaderSchema>;

// Manual status override — any status, any direction, no transition guard.
// Bypasses the state machine on purpose (Monitor-style); never books stock.
export const setPurchaseOrderStatusSchema = z.object({
  status: purchaseOrderStatusSchema,
});
export type SetPurchaseOrderStatusInput = z.infer<typeof setPurchaseOrderStatusSchema>;

export const receiveGoodsSchema = z.object({
  locationId: z.string().uuid().optional(),
  quantity: z.coerce.number().positive(),
  // Materialbrist: a lego row's receipt reports the TO operation, which
  // draws its linked material — report anyway after a 409 material-shortage
  // in mode "warn" (see materialShortageOverrideSchema in manufacturing.ts).
  allowMaterialShortage: materialShortageOverrideSchema,
});
export type ReceiveGoodsInput = z.infer<typeof receiveGoodsSchema>;

// --- Article supplier catalog (leverantörskatalog per artikel) ---
// A purchased article can list several suppliers, each with the supplier's own
// article number, price and lead time, and at most one huvudleverantör.
const currencyField = z.string().regex(/^[A-Z]{3}$/, "3 stora bokstäver, t.ex. SEK");

// Stafflade priser: a break is an absolute price valid from its quantity.
// Quantity 1 is the row's own `price` (grundpriset), so a break must start
// above 1 — the DB CHECK says the same. The whole set is sent at once and
// REPLACES the stored set (`[]` clears it), so duplicates are caught here
// rather than by the unique constraint.
export const supplierPriceBreakSchema = z.object({
  fromQuantity: z.coerce.number().gt(1, "Från antal måste vara större än 1"),
  price: z.coerce.number().nonnegative(),
});
export type SupplierPriceBreakInput = z.infer<typeof supplierPriceBreakSchema>;

const priceBreaksField = z
  .array(supplierPriceBreakSchema)
  .max(50)
  .superRefine((rows, ctx) => {
    const seen = new Set<number>();
    rows.forEach((row, index) => {
      if (seen.has(row.fromQuantity)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "fromQuantity"], message: "Från antal måste vara unikt" });
      }
      seen.add(row.fromQuantity);
    });
  });

export const createArticleSupplierSchema = z.object({
  supplierId: z.string().uuid(),
  supplierArticleNumber: z.string().max(100).optional(),
  price: z.coerce.number().nonnegative().optional(),
  currency: currencyField.default("SEK"),
  leadTimeDays: z.coerce.number().int().nonnegative().optional(),
  isPrimary: z.boolean().default(false),
  priceBreaks: priceBreaksField.optional(),
});
export type CreateArticleSupplierInput = z.infer<typeof createArticleSupplierSchema>;

// The supplier link itself is fixed after creation (change = remove + add) —
// only the catalog details are editable.
export const updateArticleSupplierSchema = z
  .object({
    supplierArticleNumber: z.string().max(100).nullable().optional(),
    price: z.coerce.number().nonnegative().nullable().optional(),
    currency: currencyField.optional(),
    leadTimeDays: z.coerce.number().int().nonnegative().nullable().optional(),
    isPrimary: z.boolean().optional(),
    priceBreaks: priceBreaksField.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateArticleSupplierInput = z.infer<typeof updateArticleSupplierSchema>;

// GET /supplier-price-quote — the catalog price of ONE supplier for an
// article at a quantity (base unit), for the purchase order card's à-pris
// prefill. Mirrors the sales side's /price-quote.
export const supplierPriceQuoteQuerySchema = z.object({
  supplierId: z.string().uuid(),
  articleId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
});
export type SupplierPriceQuoteQuery = z.infer<typeof supplierPriceQuoteQuerySchema>;

export interface SupplierPriceQuote {
  articleNumber: string;
  // null = the supplier has no catalog row / no price for the article.
  price: { unitPrice: number; currency: string; fromQuantity: number; source: "break" | "base" } | null;
}

// --- Supplier invoices (leverantörsfaktura / AP) ---
// State machine: draft → approved → paid, cancellable from draft/approved.
// Validated in the supplier-invoice service.
export const supplierInvoiceStatusSchema = z.enum(["draft", "approved", "paid", "cancelled"]);
export type SupplierInvoiceStatus = z.infer<typeof supplierInvoiceStatusSchema>;

export const listSupplierInvoicesQuerySchema = listQuerySchema.extend({
  status: statusListParam(supplierInvoiceStatusSchema.options),
  supplierId: z.string().uuid().optional(),
  // Restricts the list to invoices with a row for this article (article card).
  articleId: z.string().uuid().optional(),
});
export type ListSupplierInvoicesQuery = z.infer<typeof listSupplierInvoicesQuerySchema>;

// Row amounts (lineAmount/vatAmount) are computed in the service from
// quantity × unitPrice (and vatRate) — never sent by the client — so a row
// can never contradict itself. Header net/vat/gross come straight from the
// physical invoice and stay authoritative.
const supplierInvoiceRowInputSchema = z.object({
  // Null on freight/fee/rounding lines.
  articleId: z.string().uuid().nullable().optional(),
  // Optional PO row to match this line against (price/quantity deviation).
  purchaseOrderRowId: z.string().uuid().nullable().optional(),
  description: z.string().min(1).max(255),
  quantity: z.coerce.number().positive().default(1),
  // Signed — a credit line can be negative.
  unitPrice: z.coerce.number(),
  // Enum-locked to the Swedish set since B5 (was free 0-100) — same
  // vatRateSchema as the sales side. Omitted/null = no rate: the row is only
  // a posting-rule lookup key, its VAT is never posted (header is
  // authoritative).
  vatRate: vatRateSchema.optional(),
});
export const createSupplierInvoiceRowSchema = supplierInvoiceRowInputSchema;
export type CreateSupplierInvoiceRowInput = z.infer<typeof createSupplierInvoiceRowSchema>;

export const updateSupplierInvoiceRowSchema = z
  .object({
    articleId: z.string().uuid().nullable().optional(),
    purchaseOrderRowId: z.string().uuid().nullable().optional(),
    description: z.string().min(1).max(255).optional(),
    quantity: z.coerce.number().positive().optional(),
    unitPrice: z.coerce.number().optional(),
    vatRate: vatRateSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateSupplierInvoiceRowInput = z.infer<typeof updateSupplierInvoiceRowSchema>;

export const createSupplierInvoiceSchema = z.object({
  supplierId: z.string().uuid(),
  invoiceNumber: z.string().min(1).max(50),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  invoiceDate: z.string().date(),
  dueDate: z.string().date().nullable().optional(),
  netAmount: blankSafe(z.coerce.number()).default(0),
  vatAmount: blankSafe(z.coerce.number()).default(0),
  grossAmount: blankSafe(z.coerce.number()).default(0),
  note: z.string().nullable().optional(),
  paymentReference: paymentReferenceSchema.nullable().optional(),
  rows: z.array(supplierInvoiceRowInputSchema).default([]),
});
export type CreateSupplierInvoiceInput = z.infer<typeof createSupplierInvoiceSchema>;

// The supplier stays locked after creation (identity for matching + the
// unique invoice number per supplier).
export const updateSupplierInvoiceHeaderSchema = z
  .object({
    invoiceNumber: z.string().min(1).max(50).optional(),
    purchaseOrderId: z.string().uuid().nullable().optional(),
    invoiceDate: z.string().date().optional(),
    dueDate: z.string().date().nullable().optional(),
    netAmount: blankSafe(z.coerce.number()).optional(),
    vatAmount: blankSafe(z.coerce.number()).optional(),
    grossAmount: blankSafe(z.coerce.number()).optional(),
    note: z.string().nullable().optional(),
    paymentReference: paymentReferenceSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateSupplierInvoiceHeaderInput = z.infer<typeof updateSupplierInvoiceHeaderSchema>;

// --- Leverantörsreskontra (B4): open items and payments ---

// Open items = approved supplier invoices/credit notes with a non-zero open
// amount. NOT z.coerce.boolean() for overdueOnly — that turns the string
// "false" into true (same pitfall as the kontoplan's includeInactive query
// param).
export const listOpenSupplierInvoicesQuerySchema = listQuerySchema.extend({
  supplierId: z.string().uuid().optional(),
  overdueOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListOpenSupplierInvoicesQuery = z.infer<typeof listOpenSupplierInvoicesQuerySchema>;

export const listSupplierPaymentsQuerySchema = listQuerySchema.extend({
  supplierId: z.string().uuid().optional(),
});
export type ListSupplierPaymentsQuery = z.infer<typeof listSupplierPaymentsQuerySchema>;

// One settled open item. appliedAmount is the CASH part applied to it —
// positive settles a debit invoice (pengar UT), negative settles a credit
// invoice (kvittning). The write-off is NEVER client-supplied: the service
// derives it from the invoice's open amount and the tolerance setting.
const supplierPaymentRowInputSchema = z.object({
  supplierInvoiceId: z.string().uuid(),
  appliedAmount: blankSafe(z.coerce.number()),
});

// amount is the BANK part (0 = pure kvittning) and must equal Σ appliedAmount —
// checked in the service, where the message can name both figures. No OCR:
// supplier invoices are matched manually via supplierInvoiceId, not parsed
// from a betalningsreferens.
export const createSupplierPaymentSchema = z.object({
  supplierId: z.string().uuid(),
  paymentDate: z.string().date(),
  // The betalkonto, chosen per payment from the ACTIVE chart of accounts
  // (/account-options); the posting validates that it exists and is active.
  bankAccountNumber: z.string().regex(/^[0-9]{4}$/),
  amount: blankSafe(z.coerce.number()),
  note: z.string().nullable().optional(),
  rows: z.array(supplierPaymentRowInputSchema).min(1),
});
export type SupplierPaymentInput = z.infer<typeof createSupplierPaymentSchema>;

// --- Per-article purchase logs (read-only, keyed by articleId) ---
export const listGoodsReceiptsQuerySchema = listQuerySchema.extend({
  articleId: z.string().uuid(),
});
export type ListGoodsReceiptsQuery = z.infer<typeof listGoodsReceiptsQuerySchema>;

export const listPriceHistoryQuerySchema = listQuerySchema.extend({
  articleId: z.string().uuid(),
});
export type ListPriceHistoryQuery = z.infer<typeof listPriceHistoryQuerySchema>;

// Fakturaunderlag: received purchase orders awaiting a supplier invoice.
// `invoiced` filters on a linked non-cancelled supplier invoice — omitted
// defaults to "uninvoiced" (the worklist).
export const listPurchaseInvoiceBasisQuerySchema = listQuerySchema.extend({
  supplierId: z.string().uuid().optional(),
  invoiced: z.enum(["invoiced", "uninvoiced", "all"]).optional(),
});
export type ListPurchaseInvoiceBasisQuery = z.infer<typeof listPurchaseInvoiceBasisQuerySchema>;
