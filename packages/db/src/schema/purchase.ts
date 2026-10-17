import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { articles } from "./article";
import { users } from "./auth";
import { verifications } from "./economy";
import { carriers, deliveryDayModeEnum, deliveryTerms, paymentTerms, units } from "./register";
import { bankFileEntries, paymentBatchItems } from "./banking";
import { stockLocations, stockTransactions } from "./stock";

// Same pattern as article.ts/system.ts — no built-in bytea helper.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const purchaseOrderStatusEnum = pgEnum("purchase_order_status", [
  "draft",
  "confirmed",
  "partially_received",
  "received",
  "closed",
  "cancelled",
]);

// Bankfiler: how a supplier is paid, and what kind of reference an invoice
// carries. Defined here (not in banking.ts) because banking.ts imports this
// file; an enum used at module load must not sit on the far side of a cycle.
export const supplierPaymentMethodEnum = pgEnum("supplier_payment_method", ["bankgiro", "plusgiro", "bank_account", "iban"]);
export const paymentReferenceKindEnum = pgEnum("payment_reference_kind", ["ocr", "message"]);

export const suppliers = pgTable("suppliers", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Leverantörsnummer — 5001, 5002, ... issued by number-series.ts's
  // getNextOrderNumber (key "supplier") at insert time unless the caller
  // supplies one. Manually chosen numbers are free text (max 50) but must
  // stay unique. Internal id only — never printed on supplier-facing
  // documents (it means nothing to the supplier).
  supplierNumber: varchar("supplier_number", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  contactName: varchar("contact_name", { length: 255 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  // Street address; postal code and city are separate fields.
  address: text("address"),
  postalCode: varchar("postal_code", { length: 20 }),
  city: varchar("city", { length: 100 }),
  orgNumber: varchar("org_number", { length: 20 }),
  vatNumber: varchar("vat_number", { length: 30 }),
  deliveryTermId: uuid("delivery_term_id").references(() => deliveryTerms.id, { onDelete: "restrict" }),
  paymentTermId: uuid("payment_term_id").references(() => paymentTerms.id, { onDelete: "restrict" }),
  carrierId: uuid("carrier_id").references(() => carriers.id, { onDelete: "restrict" }),
  // Our account number with the carrier (kundnummer hos speditör).
  carrierCustomerNumber: varchar("carrier_customer_number", { length: 50 }),
  // Our customer number at this supplier (vårt kundnummer hos leverantören)
  // — printed on inquiry/PO so the supplier can find us in their system.
  // Free text, NOT unique, no snapshot: documents always print the current
  // value (same rule as the supplier address block).
  ourCustomerNumber: varchar("our_customer_number", { length: 50 }),
  currency: varchar("currency", { length: 3 }).notNull().default("SEK"),
  // Bankfiler: betalsätt + uppgifter (all may be stored; the method picks).
  // Normalized digits/upper case; check digits validated in the service.
  paymentMethod: supplierPaymentMethodEnum("payment_method"),
  bankgiro: varchar("bankgiro", { length: 8 }),
  plusgiro: varchar("plusgiro", { length: 8 }),
  bankClearing: varchar("bank_clearing", { length: 5 }),
  // The account number WITHOUT clearing number.
  bankAccountNumber: varchar("bank_account_number", { length: 15 }),
  iban: varchar("iban", { length: 34 }),
  bic: varchar("bic", { length: 11 }),
  // Fasta leveransdagar (delivery-days.ts): ISO weekdays 1–7, sorted, no
  // duplicates (normalized by zod); empty = no fixed days. Mode and transit
  // days null = the system default for the side (system_settings).
  deliveryWeekdays: smallint("delivery_weekdays").array().notNull().default(sql`'{}'::smallint[]`),
  deliveryDayMode: deliveryDayModeEnum("delivery_day_mode"),
  transitDays: smallint("transit_days"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check(
    "suppliers_payment_method_details",
    sql`${table.paymentMethod} is null
      or (${table.paymentMethod} = 'bankgiro' and ${table.bankgiro} is not null)
      or (${table.paymentMethod} = 'plusgiro' and ${table.plusgiro} is not null)
      or (${table.paymentMethod} = 'bank_account' and ${table.bankClearing} is not null and ${table.bankAccountNumber} is not null)
      or (${table.paymentMethod} = 'iban' and ${table.iban} is not null)`
  ),
  check("suppliers_delivery_weekdays", sql`${table.deliveryWeekdays} <@ '{1,2,3,4,5,6,7}'::smallint[]`),
  check("suppliers_transit_days", sql`${table.transitDays} between 0 and 60`),
]);

// Multiple contacts per supplier; at most one is the primary contact
// (huvudkontakt), enforced by the partial unique index.
export const supplierContacts = pgTable(
  "supplier_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    mobile: varchar("mobile", { length: 50 }),
    email: varchar("email", { length: 255 }),
    comment: text("comment"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplier_contacts_one_primary").on(table.supplierId).where(sql`${table.isPrimary}`),
  ]
);

// Multiple delivery addresses per supplier; at most one is the default,
// enforced by the partial unique index (same pattern as
// customer_delivery_addresses / the primary contact).
export const supplierDeliveryAddresses = pgTable(
  "supplier_delivery_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 100 }).notNull(),
    address: text("address").notNull(),
    postalCode: varchar("postal_code", { length: 20 }),
    city: varchar("city", { length: 100 }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("supplier_delivery_addresses_one_default").on(table.supplierId).where(sql`${table.isDefault}`),
  ]
);

export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  // IO-1001, IO-1002, ... — issued by number-series.ts's getNextOrderNumber
  // (key "purchase_order") at insert time, not a DB-level default.
  orderNumber: varchar("order_number", { length: 20 }).notNull().unique(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id, { onDelete: "restrict" }),
  // Snapshotted from suppliers.currency at creation — a later change to the
  // supplier's currency shouldn't retroactively change existing orders.
  currency: varchar("currency", { length: 3 }).notNull().default("SEK"),
  exchangeRate: numeric("exchange_rate", { precision: 12, scale: 6 }).notNull().default("1"),
  // Snapshotted from the supplier at creation (like currency) — editable on
  // the order, printed on the PO document when set.
  deliveryTermId: uuid("delivery_term_id").references(() => deliveryTerms.id, { onDelete: "restrict" }),
  paymentTermId: uuid("payment_term_id").references(() => paymentTerms.id, { onDelete: "restrict" }),
  carrierId: uuid("carrier_id").references(() => carriers.id, { onDelete: "restrict" }),
  status: purchaseOrderStatusEnum("status").notNull().default("draft"),
  // When true the company pays the freight, so our own carrier customer number
  // (company_carriers) for the chosen carrier is printed on the PO document.
  freightPaidByUs: boolean("freight_paid_by_us").notNull().default(false),
  expectedDeliveryDate: date("expected_delivery_date"),
  note: text("note"),
  // References printed on the PO document (Er referens = the supplier's
  // contact, Vår referens = our buyer) — like Monitor's IO header fields.
  yourReference: varchar("your_reference", { length: 100 }),
  ourReference: varchar("our_reference", { length: 100 }),
  // Bumped by 1 on every content change (header/terms/rows) — never by
  // status transitions or receipts. Printed on the PO document.
  revision: integer("revision").notNull().default(1),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Förfrågan (RFQ): a priced inquiry sent to a supplier, convertible into a
// purchase order. Own FO- number series; the state machine lives in the
// purchase service (draft → sent → answered → ordered | cancelled).
export const inquiryStatusEnum = pgEnum("inquiry_status", [
  "draft",
  "sent",
  "answered",
  "ordered",
  "cancelled",
]);

export const inquiries = pgTable("inquiries", {
  id: uuid("id").primaryKey().defaultRandom(),
  // FO-3001, FO-3002, ... — issued by number-series.ts's getNextOrderNumber
  // (key "inquiry") at insert time.
  inquiryNumber: varchar("inquiry_number", { length: 20 }).notNull().unique(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id, { onDelete: "restrict" }),
  status: inquiryStatusEnum("status").notNull().default("draft"),
  // Snapshotted from the supplier at creation; carried over to the purchase
  // order on convert.
  deliveryTermId: uuid("delivery_term_id").references(() => deliveryTerms.id, { onDelete: "restrict" }),
  paymentTermId: uuid("payment_term_id").references(() => paymentTerms.id, { onDelete: "restrict" }),
  carrierId: uuid("carrier_id").references(() => carriers.id, { onDelete: "restrict" }),
  // Carried over to the purchase order on convert — see purchase_orders.
  freightPaidByUs: boolean("freight_paid_by_us").notNull().default(false),
  expectedDeliveryDate: date("expected_delivery_date"),
  note: text("note"),
  // The purchase order created when the inquiry was converted (status ordered).
  purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inquiryRows = pgTable(
  "inquiry_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inquiryId: uuid("inquiry_id")
      .notNull()
      .references(() => inquiries.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    // Null until the supplier has answered with a price.
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
    // Display unit the row was entered in (null = the article's base unit).
    // quantity/unit_price are always stored in the base unit; unit_factor is
    // the article's quantity_per_base snapshotted at entry time.
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "restrict" }),
    unitFactor: numeric("unit_factor", { precision: 16, scale: 6 }),
    // Lego (subcontract) row — the RFQ twin of purchase_order_rows' lego
    // columns. Both FKs are declared by hand in the migration (the
    // manufacturing schema imports from this file, so a reference() here
    // would be circular). ON DELETE set null: a deleted MO/routing operation
    // degrades the row to a plain inquiry row.
    // mo_operation_id: set when the inquiry was raised for a TO operation
    // (behovsberäkningen); copied to the PO row on convert so goods receipt
    // auto-reports the operation.
    moOperationId: uuid("mo_operation_id"),
    // routing_operation_id: ALWAYS set on a lego row — derived from the MO
    // operation's snapshot, or the article's own routing operation for a
    // TO-less price inquiry from the article card — so the drawing can be
    // read via routing_operation_files and the answered price written back.
    routingOperationId: uuid("routing_operation_id"),
    // Ställpris — one-off charge, defaulted from the operation at creation.
    setupPrice: numeric("setup_price", { precision: 12, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.inquiryId, table.articleId)]
);

// One row per article per PO (simplifies stock_transactions.reference_id ->
// purchase_orders.id being unambiguous per article on receipt).
export const purchaseOrderRows = pgTable(
  "purchase_order_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    quantityOrdered: numeric("quantity_ordered", { precision: 14, scale: 4 }).notNull(),
    quantityReceived: numeric("quantity_received", { precision: 14, scale: 4 }).notNull().default("0"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).notNull(),
    // Display unit (see inquiry_rows) — quantities/price stay in base unit.
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "restrict" }),
    unitFactor: numeric("unit_factor", { precision: 16, scale: 6 }),
    // Lego (subcontract) row: the MO operation this row buys. FK to
    // mo_operations declared by hand in the migration — manufacturing.ts
    // imports suppliers from this file, so importing moOperations here would
    // be circular (same precedent as moOperationScrap.employeeId). ON DELETE
    // set null: a deleted MO degrades the row to a plain purchase row.
    // Receiving against a row with this set auto-reports the operation.
    moOperationId: uuid("mo_operation_id"),
    // Ställpris — a one-off charge added ONCE to the row amount
    // (qty × unitPrice + setupPrice). Null on ordinary rows.
    setupPrice: numeric("setup_price", { precision: 12, scale: 2 }),
    // Önskat leveransdatum for THIS row when it differs from the order's —
    // null = follow purchase_orders.expected_delivery_date. Effective date =
    // coalesce(row, header); printed per row on the IO PDF only when set.
    expectedDeliveryDate: date("expected_delivery_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.purchaseOrderId, table.articleId)]
);

// Inleveranslogg per inköpsorder: one row per receipt (Ta emot leverans /
// Inleverans), with exactly what it booked so Ångra inleverans can reverse
// it — the stock movement (null on a lego row, which buys an operation and
// books no purchase stock) and, for a lego row, the TO report the receipt
// made. quantity is in the article's base unit, like the row. An undone
// receipt stays, stamped undone_at/undone_by. Rows cascade: a row can only
// be deleted with nothing received, i.e. when every receipt on it is undone.
export const purchaseReceipts = pgTable(
  "purchase_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    purchaseOrderRowId: uuid("purchase_order_row_id")
      .notNull()
      .references(() => purchaseOrderRows.id, { onDelete: "cascade" }),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    locationId: uuid("location_id").references(() => stockLocations.id, { onDelete: "restrict" }),
    stockTransactionId: uuid("stock_transaction_id").references(() => stockTransactions.id, { onDelete: "restrict" }),
    // Lego: the mo_reports row the receipt's operation report wrote. FK by
    // hand in the migration — manufacturing.ts imports this file. Null when
    // the report failed (the receipt stands anyway) or predates the log.
    moReportId: uuid("mo_report_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: uuid("undone_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("purchase_receipts_by_order").on(table.purchaseOrderId, table.createdAt),
    index("purchase_receipts_by_stock_transaction").on(table.stockTransactionId),
  ]
);

// Per-artikel leverantörskatalog — an article can list several suppliers,
// each with the supplier's own article number (leverantörens artikelnummer),
// price and lead time, and at most one marked huvudleverantör. Shown on the
// article card's Inköp tab. Same one-primary pattern as supplier_contacts.
export const articleSuppliers = pgTable(
  "article_suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    // Leverantörens artikelnummer — how the supplier refers to this article.
    supplierArticleNumber: varchar("supplier_article_number", { length: 100 }),
    price: numeric("price", { precision: 14, scale: 4 }),
    currency: varchar("currency", { length: 3 }).notNull().default("SEK"),
    // Ledtid in days.
    leadTimeDays: integer("lead_time_days"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("article_suppliers_article_supplier_unique").on(table.articleId, table.supplierId),
    uniqueIndex("article_suppliers_one_primary").on(table.articleId).where(sql`${table.isPrimary}`),
    index("idx_article_suppliers_article").on(table.articleId),
  ]
);

// Stafflade leverantörspriser — quantity breaks on a catalog row. Each row
// is an ABSOLUTE price valid from `from_quantity`; quantity 1 IS the
// catalog row's own `price` (grundpriset), hence the > 1 CHECK. Prices are
// in the article's base unit and the catalog row's currency. Resolution
// (highest break <= quantity, else grundpris) lives in
// purchase/service/supplier-price.ts.
export const articleSupplierPriceBreaks = pgTable(
  "article_supplier_price_breaks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleSupplierId: uuid("article_supplier_id")
      .notNull()
      .references(() => articleSuppliers.id, { onDelete: "cascade" }),
    fromQuantity: numeric("from_quantity", { precision: 14, scale: 4 }).notNull(),
    price: numeric("price", { precision: 14, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("article_supplier_price_breaks_unique").on(table.articleSupplierId, table.fromQuantity),
    index("idx_article_supplier_price_breaks_supplier").on(table.articleSupplierId),
    check("article_supplier_price_breaks_from_quantity_check", sql`${table.fromQuantity} > 1`),
  ]
);

// Leverantörsfaktura (accounts payable). The state machine lives in the
// supplier-invoice service: draft → approved → paid, cancellable from
// draft/approved. paid/cancelled are terminal.
export const supplierInvoiceStatusEnum = pgEnum("supplier_invoice_status", [
  "draft",
  "approved",
  "paid",
  "cancelled",
]);

export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // LF-1, LF-2, ... — internal handle issued by number-series.ts
    // (key "supplier_invoice") at insert time; the supplier's own invoice
    // number is only unique per supplier.
    registrationNumber: varchar("registration_number", { length: 20 }).notNull().unique(),
    // Leverantörens fakturanummer.
    invoiceNumber: varchar("invoice_number", { length: 50 }).notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    // Optional link to the purchase order the invoice settles (a convenience
    // default for row matching; matching itself is per-row).
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    invoiceDate: date("invoice_date").notNull(),
    dueDate: date("due_date"),
    // Snapshotted from the supplier at creation.
    currency: varchar("currency", { length: 3 }).notNull().default("SEK"),
    status: supplierInvoiceStatusEnum("status").notNull().default("draft"),
    // B4: set by the payment registration when this open item is fully
    // settled; cleared back to null if that payment is cancelled. NULL on a
    // "paid" invoice = paid before B4 shipped, date unknown — deliberately
    // NOT backfilled (bankfiler-specen 8.4: no true date exists, and nothing
    // sorts or filters on it). A future report must handle NULL explicitly.
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // Header totals entered from the physical invoice — the source of truth so
    // freight/rounding on the paper invoice always reconciles (row sums are
    // only a hint).
    netAmount: numeric("net_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    grossAmount: numeric("gross_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    note: text("note"),
    // Bankfiler: OCR (sent as SCOR) or a message (Ustrd). Editable in draft
    // and approved, never while the invoice is reserved in a live batch.
    paymentReferenceKind: paymentReferenceKindEnum("payment_reference_kind"),
    paymentReference: varchar("payment_reference", { length: 140 }),
    // B2 automatkontering: the booked verification created atomically with
    // the draft → approved transition (and its reversal on cancellation).
    // Null while draft, and for invoices approved before B2 shipped —
    // restrict, same reasoning as invoices.verificationId.
    verificationId: uuid("verification_id").references(() => verifications.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The supplier's invoice number is unique per supplier, not globally.
    unique("supplier_invoices_supplier_invoice_number_unique").on(table.supplierId, table.invoiceNumber),
    index("idx_supplier_invoices_supplier").on(table.supplierId),
    index("idx_supplier_invoices_status").on(table.status),
    index("idx_supplier_invoices_po").on(table.purchaseOrderId),
    index("idx_supplier_invoices_verification").on(table.verificationId),
    // The förfallolista (aging list) sorts/filters on due date.
    index("idx_supplier_invoices_due_date").on(table.dueDate),
    check(
      "supplier_invoices_payment_reference_pair",
      sql`(${table.paymentReferenceKind} is null) = (${table.paymentReference} is null)`
    ),
  ]
);

export const supplierInvoiceRows = pgTable(
  "supplier_invoice_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierInvoiceId: uuid("supplier_invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "cascade" }),
    // Nullable: freight/fee/rounding lines carry no article.
    articleId: uuid("article_id").references(() => articles.id, { onDelete: "restrict" }),
    // Optional PO row this line is matched against — price/quantity deviation
    // is computed on read, never stored, and has no stock effect (goods were
    // already booked at receipt time).
    purchaseOrderRowId: uuid("purchase_order_row_id").references(() => purchaseOrderRows.id, {
      onDelete: "set null",
    }),
    description: varchar("description", { length: 255 }).notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).notNull(),
    lineAmount: numeric("line_amount", { precision: 14, scale: 2 }).notNull(),
    vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_supplier_invoice_rows_invoice").on(table.supplierInvoiceId),
    index("idx_supplier_invoice_rows_article").on(table.articleId),
  ]
);

// Underlag — the supplier's own invoice (PDF/scan) attached to its LF. This
// IS räkenskapsinformation (bokföringslagen 5 kap 6 §, kept 7 år per 7 kap):
// removable only while the invoice is a draft (a wrongly picked file), never
// once attested or cancelled — enforced in the service; ON DELETE restrict
// so not even a future invoice delete can take the underlag with it.
// sha256 is computed at upload so the stored file can be shown unaltered.
// Listing queries never select `data`.
export const supplierInvoiceFiles = pgTable(
  "supplier_invoice_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierInvoiceId: uuid("supplier_invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    data: bytea("data").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_supplier_invoice_files_invoice").on(table.supplierInvoiceId)]
);

// Leverantörsbetalning (supplier payment) — B4. One registration per paid
// payment: UTB-1, UTB-2 ... allocated inside the registration transaction,
// one supplier per payment, and one row per open item it settles. There is
// deliberately NO status enum: "Makulerad" is derived from cancelledAt (the
// nullfälts-model), because a payment only ever has two states and the
// cancellation carries three facts (when, by whom, with which omföring) that
// a status column could not.
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentNumber: varchar("payment_number", { length: 20 }).notNull().unique(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    paymentDate: date("payment_date").notNull(),
    // The betalkonto the money left from, picked per payment from the active
    // chart of accounts — snapshotted as a NUMBER (the verification rows carry
    // the account id) so a later renumbering cannot rewrite history.
    bankAccountNumber: varchar("bank_account_number", { length: 4 }).notNull(),
    // The BANK part only: 0 for a pure kvittning between open items.
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    note: text("note"),
    // The U verification booked in the same transaction as the registration.
    // NULL for a pure kvittning, which moves nothing in the ledger and is
    // therefore not a bokföringshändelse (see verification-poster.ts).
    // Restrict — a booked verification with a payment pointing at it must stay
    // readable.
    verificationId: uuid("verification_id").references(() => verifications.id, { onDelete: "restrict" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    // The omföring booked when the payment was cancelled — null both for a
    // payment that never booked anything and for one whose verification had
    // already been reversed manually.
    cancellationVerificationId: uuid("cancellation_verification_id").references(() => verifications.id, {
      onDelete: "restrict",
    }),
    // Bankfiler: the batch row this payment confirmed and the debit entry
    // that confirmed it (null for a manual "Bekräfta utförd"). Written in the
    // payment's own INSERT, in the confirmation's transaction.
    paymentBatchItemId: uuid("payment_batch_item_id").references(() => paymentBatchItems.id, { onDelete: "restrict" }),
    bankFileEntryId: uuid("bank_file_entry_id").references(() => bankFileEntries.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_supplier_payments_supplier").on(table.supplierId),
    index("idx_supplier_payments_verification").on(table.verificationId),
    index("idx_supplier_payments_cancellation").on(table.cancellationVerificationId),
    uniqueIndex("supplier_payments_item_live")
      .on(table.paymentBatchItemId)
      .where(sql`${table.cancelledAt} is null and ${table.paymentBatchItemId} is not null`),
    uniqueIndex("supplier_payments_entry_live")
      .on(table.bankFileEntryId)
      .where(sql`${table.cancelledAt} is null and ${table.bankFileEntryId} is not null`),
  ]
);

// What one payment settles, one row per open item (invoice or credit note).
// Both amounts are SIGNED: appliedAmount is the cash part (positive settles an
// invoice, negative settles a credit note) and writeOffAmount is the
// server-computed tolerance difference. What actually leaves the open item is
// their sum — see open-amounts.ts, the single aggregation authority.
export const supplierPaymentRows = pgTable(
  "supplier_payment_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => supplierPayments.id, { onDelete: "cascade" }),
    // Restrict: the derived open amount must never lose its anchor.
    supplierInvoiceId: uuid("supplier_invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    appliedAmount: numeric("applied_amount", { precision: 14, scale: 2 }).notNull(),
    writeOffAmount: numeric("write_off_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_supplier_payment_rows_payment").on(table.paymentId),
    index("idx_supplier_payment_rows_invoice").on(table.supplierInvoiceId),
  ]
);
