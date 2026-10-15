import { z } from "zod";
import { vatRateSchema } from "./vat.js";
import { listQuerySchema, statusListParam } from "./list.js";
import { configuratorSelectionSchema, orderRowConfigurationInputSchema } from "./configurator.js";

import { blankSafe } from "./coerce.js";

export const salesOrderStatusSchema = z.enum([
  "quote",
  "confirmed",
  "in_production",
  "delivered",
  "invoiced",
  "cancelled",
]);
export type SalesOrderStatus = z.infer<typeof salesOrderStatusSchema>;

export const listSalesOrdersQuerySchema = listQuerySchema.extend({
  status: statusListParam(salesOrderStatusSchema.options),
  // Adds openRowCount (rows still short of their ordered quantity) to each
  // row — an extra correlated subquery, so it's opt-in. Mirrors
  // listPurchaseOrdersQuerySchema's withOpenRows (see its comment for the
  // "true"/"false" string rationale — NOT z.coerce.boolean()).
  withOpenRows: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});
export type ListSalesOrdersQuery = z.infer<typeof listSalesOrdersQuerySchema>;

// Manual status override — any status, any direction, no transition guard.
// Bypasses the state machine on purpose (Monitor-style); never books stock
// and never assigns an invoice number.
export const setSalesOrderStatusSchema = z.object({
  status: salesOrderStatusSchema,
});
export type SetSalesOrderStatusInput = z.infer<typeof setSalesOrderStatusSchema>;

// ISO 3166-1 alpha-2, upper-cased on input ("se" → "SE"). Customers default
// to SE; documents print the country only when it differs.
export const countryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "Country must be an ISO 3166-1 alpha-2 code");

export const createCustomerSchema = z.object({
  name: z.string().min(1).max(255),
  // Kundnummer — omitted = allocated from the "customer" number series.
  // Manually chosen numbers must be unique (409 on duplicates).
  customerNumber: z.string().trim().min(1).max(50).optional(),
  contactName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(50).optional(),
  // Besöksadress — invoice and delivery addresses are separate.
  address: z.string().optional(),
  postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  country: countryCodeSchema.default("SE"),
  invoiceName: z.string().max(255).optional(),
  invoiceAddress: z.string().optional(),
  invoicePostalCode: z.string().max(20).optional(),
  invoiceCity: z.string().max(100).optional(),
  invoiceCountry: countryCodeSchema.optional(),
  invoiceEmail: z.string().email().max(255).optional(),
  orgNumber: z.string().max(20).optional(),
  vatNumber: z.string().max(30).optional(),
  deliveryTermId: z.string().uuid().optional(),
  paymentTermId: z.string().uuid().optional(),
  carrierId: z.string().uuid().optional(),
  priceListId: z.string().uuid().optional(),
  carrierCustomerNumber: z.string().max(50).optional(),
  // Kundrabatt — blanket percentage, the price chain's last fallback.
  discountPercent: blankSafe(z.coerce.number().min(0).max(100)).default(0),
  // Vårt leverantörsnummer — the customer's number for us as their supplier.
  ourSupplierNumber: z.string().max(50).optional(),
  // Samlingsfaktura — billed via the collective invoicing routine only.
  collectiveInvoicing: z.boolean().default(false),
  // Privatperson — documents print prices including VAT.
  privatePerson: z.boolean().default(false),
  // Visa tilläggspriser — default for the configured rows' price split on
  // quote/order confirmation (and what the invoice follows).
  showConfigurationPrices: z.boolean().default(false),
  website: z.string().max(255).optional(),
  defaultFreightProductId: z.string().uuid().optional(),
  active: z.boolean().default(true),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    // Optional but NOT nullable — a customer always has a number.
    customerNumber: z.string().trim().min(1).max(50).optional(),
    contactName: z.string().max(255).nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    address: z.string().nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    // Not nullable — a customer always has a country.
    country: countryCodeSchema.optional(),
    invoiceName: z.string().max(255).nullable().optional(),
    invoiceAddress: z.string().nullable().optional(),
    invoicePostalCode: z.string().max(20).nullable().optional(),
    invoiceCity: z.string().max(100).nullable().optional(),
    invoiceCountry: countryCodeSchema.nullable().optional(),
    invoiceEmail: z.string().email().max(255).nullable().optional(),
    orgNumber: z.string().max(20).nullable().optional(),
    vatNumber: z.string().max(30).nullable().optional(),
    deliveryTermId: z.string().uuid().nullable().optional(),
    paymentTermId: z.string().uuid().nullable().optional(),
    carrierId: z.string().uuid().nullable().optional(),
    // C3: the customer's assigned price list (chain level 3).
    priceListId: z.string().uuid().nullable().optional(),
    carrierCustomerNumber: z.string().max(50).nullable().optional(),
    discountPercent: blankSafe(z.coerce.number().min(0).max(100)).optional(),
    ourSupplierNumber: z.string().max(50).nullable().optional(),
    collectiveInvoicing: z.boolean().optional(),
    privatePerson: z.boolean().optional(),
    showConfigurationPrices: z.boolean().optional(),
    website: z.string().max(255).nullable().optional(),
    defaultFreightProductId: z.string().uuid().nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

const quoteRowSchema = z.object({
  articleId: z.string().uuid(),
  // quantity/unitPrice are entered in the chosen unit (the article's base
  // unit when unitId is omitted/null) and stored converted to the base unit.
  quantity: z.coerce.number().positive(),
  // C3: omitted ⇒ the server resolves price AND discount via the price
  // chain (customer price → price list → base price). Sent ⇒ used verbatim,
  // including 0 (0 means free, never "look it up").
  unitPrice: blankSafe(z.coerce.number().nonnegative()).optional(),
  discountPercent: blankSafe(z.coerce.number().min(0).max(100)).optional(),
  unitId: z.string().uuid().nullable().optional(),
  // Konfigurator 4b: the choices for a beställningsvara row (the article is
  // the template). Omitted on an ordinary row; the server derives the rest.
  configuration: orderRowConfigurationInputSchema.optional(),
});

// Creates the order and all its rows atomically, per architecture.md §5's
// "skapa offert med rader" contract for the external configurator.
// Multiple delivery addresses per customer; at most one default.
export const createDeliveryAddressSchema = z.object({
  label: z.string().min(1).max(100),
  address: z.string().min(1),
  postalCode: z.string().max(20).optional(),
  city: z.string().max(100).optional(),
  country: countryCodeSchema.default("SE"),
  isDefault: z.boolean().default(false),
});
export type CreateDeliveryAddressInput = z.infer<typeof createDeliveryAddressSchema>;

export const updateDeliveryAddressSchema = z
  .object({
    label: z.string().min(1).max(100).optional(),
    address: z.string().min(1).optional(),
    postalCode: z.string().max(20).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    country: countryCodeSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateDeliveryAddressInput = z.infer<typeof updateDeliveryAddressSchema>;

// Header fields editable while the order is quote/confirmed/in_production.
export const updateSalesOrderHeaderSchema = z
  .object({
    customerOrderNumber: z.string().max(50).nullable().optional(),
    customerReference: z.string().max(100).nullable().optional(),
    deliveryAddressId: z.string().uuid().nullable().optional(),
    deliveryTermId: z.string().uuid().nullable().optional(),
    paymentTermId: z.string().uuid().nullable().optional(),
    carrierId: z.string().uuid().nullable().optional(),
    // `false` saves without bumping the order's revision — the UI asks on
    // every save; omitted means bump (external callers unchanged).
    bumpRevision: z.boolean().optional(),
  })
  .refine(
    (data) => Object.keys(data).some((key) => key !== "bumpRevision"),
    "At least one field must be provided"
  );
export type UpdateSalesOrderHeaderInput = z.infer<typeof updateSalesOrderHeaderSchema>;

export const createQuoteSchema = z.object({
  customerId: z.string().uuid(),
  expectedDeliveryDate: z.string().date().optional(),
  note: z.string().optional(),
  rows: z.array(quoteRowSchema).min(1),
  // The customer's own PO number, their reference, and which of their
  // delivery addresses the order ships to.
  customerOrderNumber: z.string().max(50).optional(),
  customerReference: z.string().max(100).optional(),
  deliveryAddressId: z.string().uuid().optional(),
  // Create as a confirmed order directly ("Ny kundorder") instead of a
  // quote — the order is confirmed via the normal status transition.
  confirm: z.boolean().default(false),
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

// For adding further rows to a quote before it's confirmed. Extends (not
// mutates) quoteRowSchema — bumpRevision must not leak into createQuoteSchema.
export const createSalesOrderRowSchema = quoteRowSchema.extend({
  bumpRevision: z.boolean().optional(),
});
export type CreateSalesOrderRowInput = z.infer<typeof createSalesOrderRowSchema>;

// Rows stay editable until the order is delivered/invoiced — the
// repository additionally guards quantity against what's already delivered.
export const updateSalesOrderRowSchema = z
  .object({
    // Interpreted in the row's unit (or the newly provided unitId; null
    // switches the row back to the article's base unit).
    quantity: z.coerce.number().positive().optional(),
    unitPrice: blankSafe(z.coerce.number().nonnegative()).optional(),
    discountPercent: blankSafe(z.coerce.number().min(0).max(100)).optional(),
    unitId: z.string().uuid().nullable().optional(),
    bumpRevision: z.boolean().optional(),
  })
  .refine(
    (data) => Object.keys(data).some((key) => key !== "bumpRevision"),
    "At least one field must be provided"
  );
export type UpdateSalesOrderRowInput = z.infer<typeof updateSalesOrderRowSchema>;

// Ändra konfiguration — PUT /sales-orders/:id/rows/:rowId/configuration
// (konfigurator 4b). Replaces the row's choices; price is re-derived.
export const setRowConfigurationSchema = z.object({
  selection: configuratorSelectionSchema.default({}),
  bumpRevision: z.boolean().optional(),
});
export type SetRowConfigurationInput = z.infer<typeof setRowConfigurationSchema>;

export const deliverGoodsSchema = z.object({
  locationId: z.string().uuid().optional(),
  quantity: z.coerce.number().positive(),
});
export type DeliverGoodsInput = z.infer<typeof deliverGoodsSchema>;

// Leveranstillfälle (delivery occasion) — C2. One location for the whole
// batch; each row is delivered with the same per-row semantics as the single
// row deliver endpoint (over-delivery guard etc.), but grouped into one
// följesedel-worthy delivery record.
export const deliverBatchSchema = z.object({
  locationId: z.string().uuid().optional(),
  rows: z
    .array(
      z.object({
        rowId: z.string().uuid(),
        quantity: z.coerce.number().positive(),
      })
    )
    .min(1),
});
export type DeliverBatchInput = z.infer<typeof deliverBatchSchema>;

// --- Kundfakturor (customer invoices) — C1 ---
// State machine: draft → issued → paid; cancelled only from draft (post-issue
// corrections go through a credit note). Validated in the invoice service.
export const invoiceStatusSchema = z.enum(["draft", "issued", "paid", "cancelled"]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;
export const invoiceTypeSchema = z.enum(["invoice", "credit"]);
export type InvoiceType = z.infer<typeof invoiceTypeSchema>;

export const listInvoicesQuerySchema = listQuerySchema.extend({
  status: statusListParam(invoiceStatusSchema.options),
  type: invoiceTypeSchema.optional(),
  customerId: z.string().uuid().optional(),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

// Row amounts (lineAmount/vatAmount) are computed in the service from
// quantity × unitPrice and vatRate — never sent by the client. vatRate
// omitted ⇒ inherit the article's rate (free rows default to 25).
export const invoiceRowInputSchema = z.object({
  articleId: z.string().uuid().nullable().optional(),
  salesOrderRowId: z.string().uuid().nullable().optional(),
  shipmentId: z.string().uuid().optional(),
  description: z.string().min(1).max(255),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number(),
  discountPercent: blankSafe(z.coerce.number().min(0).max(100)).optional(),
  vatRate: vatRateSchema.optional(),
});
export const createInvoiceRowSchema = invoiceRowInputSchema;
export type CreateInvoiceRowInput = z.infer<typeof createInvoiceRowSchema>;

export const updateInvoiceRowSchema = invoiceRowInputSchema
  .omit({ shipmentId: true })
  .partial()
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateInvoiceRowInput = z.infer<typeof updateInvoiceRowSchema>;

export const createInvoiceSchema = z.object({
  customerId: z.string().uuid(),
  paymentTermId: z.string().uuid().nullable().optional(),
  note: z.string().nullable().optional(),
  rows: z.array(invoiceRowInputSchema).default([]),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

// Samlingsfakturering: one invoice per selected customer covering every
// delivered-but-uninvoiced order row. `issue` also issues each invoice
// (FA number + F verification) right away.
export const runCollectiveInvoicingSchema = z.object({
  customerIds: z.array(z.string().uuid()).min(1),
  issue: z.boolean().default(false),
});
export type RunCollectiveInvoicingInput = z.infer<typeof runCollectiveInvoicingSchema>;

// The customer stays locked after creation (identity for the delfakturering
// links and the eventual snapshot).
export const updateInvoiceHeaderSchema = z
  .object({
    paymentTermId: z.string().uuid().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateInvoiceHeaderInput = z.infer<typeof updateInvoiceHeaderSchema>;

// Credit note: created as a draft prefilled from the source invoice; rows
// may be overridden at create (partial credit) or edited afterwards.
export const createCreditInvoiceSchema = z.object({
  rows: z.array(invoiceRowInputSchema).optional(),
});
export type CreateCreditInvoiceInput = z.infer<typeof createCreditInvoiceSchema>;

// --- Kundreskontra (B3): öppna poster och betalningar ---

// Open items = issued invoices/credit notes with a non-zero open amount. NOT
// z.coerce.boolean() for overdueOnly — that turns the string "false" into true
// (same pitfall as the kontoplan's includeInactive query param).
export const listOpenInvoicesQuerySchema = listQuerySchema.extend({
  customerId: z.string().uuid().optional(),
  overdueOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
export type ListOpenInvoicesQuery = z.infer<typeof listOpenInvoicesQuerySchema>;

export const listPaymentsQuerySchema = listQuerySchema.extend({
  customerId: z.string().uuid().optional(),
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

// One settled open item. appliedAmount is the CASH part applied to it —
// positive settles an invoice, negative settles a credit note (kvittning). The
// write-off is NEVER client-supplied: the service derives it from the invoice's
// open amount and the tolerance setting.
const paymentRowInputSchema = z.object({
  invoiceId: z.string().uuid(),
  appliedAmount: blankSafe(z.coerce.number()),
});

// amount is the BANK part (0 = pure kvittning) and must equal Σ appliedAmount —
// checked in the service, where the message can name both figures.
export const createPaymentSchema = z.object({
  customerId: z.string().uuid(),
  paymentDate: z.string().date(),
  // The betalkonto, chosen per payment from the ACTIVE chart of accounts
  // (/account-options); the posting validates that it exists and is active.
  bankAccountNumber: z.string().regex(/^[0-9]{4}$/),
  amount: blankSafe(z.coerce.number()),
  note: z.string().nullable().optional(),
  rows: z.array(paymentRowInputSchema).min(1),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

// Betalningspåminnelse: the same to/subject/message trio as every other
// document email (sendDocumentEmailSchema minus attachDrawings, which a
// reminder never carries), plus the one decision that makes this more than an
// email — whether to charge the statutory påminnelseavgift. It defaults to
// FALSE: the fee can only ever be charged once per invoice, so it must be an
// explicit choice, never something a caller gets by omitting a field.
export const sendReminderSchema = z.object({
  to: z.string().trim().email().max(255),
  subject: z.string().trim().min(1).max(255),
  message: z.string().trim().max(5000).default(""),
  withFee: z.boolean().default(false),
});
export type SendReminderInput = z.infer<typeof sendReminderSchema>;

// --- C3 Kundpriser ---
// customer_discount = the customer's blanket discount applied on the price
// list / base price (last fallback, below every customer-specific rule).
export const priceSourceSchema = z.enum([
  "customer_article",
  "customer_group",
  "price_list",
  "customer_discount",
  "article",
]);
export type PriceSource = z.infer<typeof priceSourceSchema>;

export const createPriceListSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});
export type CreatePriceListInput = z.infer<typeof createPriceListSchema>;

// description is nullable here (unlike create's plain-optional string) so
// PATCH can actually clear it back to NULL — the column is nullable text,
// and without this the web form's only way to "clear" it was to send "",
// leaving a stored empty string instead of NULL (broke the `?? "–"`
// placeholder in the list view).
export const updatePriceListSchema = createPriceListSchema
  .partial()
  .extend({ description: z.string().max(500).nullable().optional() })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdatePriceListInput = z.infer<typeof updatePriceListSchema>;

export const listPriceListsQuerySchema = listQuerySchema;
export type ListPriceListsQuery = z.infer<typeof listPriceListsQuerySchema>;

// Row prices are entered and stored in the article's BASE unit.
export const priceListRowInputSchema = z.object({
  articleId: z.string().uuid(),
  fromQuantity: blankSafe(z.coerce.number().positive()).default(1),
  unitPrice: blankSafe(z.coerce.number().nonnegative()),
});
export type PriceListRowInput = z.infer<typeof priceListRowInputSchema>;

export const updatePriceListRowSchema = z
  .object({
    fromQuantity: blankSafe(z.coerce.number().positive()).optional(),
    unitPrice: blankSafe(z.coerce.number().nonnegative()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdatePriceListRowInput = z.infer<typeof updatePriceListRowSchema>;

// Exactly one target (article XOR group) and exactly one value
// (special price XOR discount%) — mirrors the DB CHECK constraints.
export const customerPriceInputSchema = z
  .object({
    articleId: z.string().uuid().nullable().optional(),
    articleGroupId: z.string().uuid().nullable().optional(),
    fromQuantity: blankSafe(z.coerce.number().positive()).default(1),
    unitPrice: blankSafe(z.coerce.number().nonnegative()).nullable().optional(),
    discountPercent: blankSafe(z.coerce.number().min(0).max(100)).nullable().optional(),
  })
  .refine((data) => (data.articleId != null) !== (data.articleGroupId != null), {
    message: "Exactly one of articleId and articleGroupId must be set",
    path: ["articleId"],
  })
  .refine((data) => (data.unitPrice != null) !== (data.discountPercent != null), {
    message: "Exactly one of unitPrice and discountPercent must be set",
    path: ["unitPrice"],
  });
export type CustomerPriceInput = z.infer<typeof customerPriceInputSchema>;

// The target (article XOR group) never changes on an update — same
// immutability as price list rows' articleId. unitPrice/discountPercent stay
// nullable-but-not-both: whichever one the caller sends replaces the pair
// (the repository clears the other), so the CHECK constraint holds after an
// update too, not just at create. Sending both at once is rejected here so
// the repository never has to guess which one wins.
export const updateCustomerPriceSchema = z
  .object({
    fromQuantity: blankSafe(z.coerce.number().positive()).optional(),
    unitPrice: blankSafe(z.coerce.number().nonnegative()).optional(),
    discountPercent: blankSafe(z.coerce.number().min(0).max(100)).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided")
  .refine((data) => !(data.unitPrice !== undefined && data.discountPercent !== undefined), {
    message: "Only one of unitPrice and discountPercent may be provided",
    path: ["unitPrice"],
  });
export type UpdateCustomerPriceInput = z.infer<typeof updateCustomerPriceSchema>;

export const priceQuoteQuerySchema = z.object({
  customerId: z.string().uuid(),
  articleId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
});
export type PriceQuoteQuery = z.infer<typeof priceQuoteQuerySchema>;
