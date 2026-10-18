import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
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
import { articleGroups, articles } from "./article";
import { users } from "./auth";
import { bankFileEntries } from "./banking";
import { verifications } from "./economy";
import { carriers, deliveryDayModeEnum, deliveryTerms, paymentTerms, units } from "./register";
import type { StoredRates } from "./shipping";
import { freightProducts, shipments } from "./shipping";

// Same pattern as article.ts/system.ts — no built-in bytea helper.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const salesOrderStatusEnum = pgEnum("sales_order_status", [
  "quote",
  "confirmed",
  "in_production",
  "delivered",
  "invoiced",
  "cancelled",
]);

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Kundnummer — 1001, 1002, ... issued by number-series.ts's
  // getNextOrderNumber (key "customer") at insert time unless the caller
  // supplies one. Manually chosen numbers are free text (max 50) but must
  // stay unique; the series is not consulted for them.
  customerNumber: varchar("customer_number", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  contactName: varchar("contact_name", { length: 255 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  // Street address; postal code and city are separate fields.
  address: text("address"),
  postalCode: varchar("postal_code", { length: 20 }),
  city: varchar("city", { length: 100 }),
  // ISO 3166-1 alpha-2 (SE, DK, NO ...). Printed on documents only when it
  // differs from SE; Monitor's customer export carries it per address.
  country: varchar("country", { length: 2 }).notNull().default("SE"),
  orgNumber: varchar("org_number", { length: 20 }),
  vatNumber: varchar("vat_number", { length: 30 }),
  deliveryTermId: uuid("delivery_term_id").references(() => deliveryTerms.id, { onDelete: "restrict" }),
  paymentTermId: uuid("payment_term_id").references(() => paymentTerms.id, { onDelete: "restrict" }),
  carrierId: uuid("carrier_id").references(() => carriers.id, { onDelete: "restrict" }),
  // C3: the customer's assigned price list (chain level 3). Restrict like
  // the terms FKs — a list in use cannot be deleted.
  priceListId: uuid("price_list_id").references(() => priceLists.id, { onDelete: "restrict" }),
  // The customer's account number with the carrier (kundnummer hos speditör).
  carrierCustomerNumber: varchar("carrier_customer_number", { length: 50 }),
  // Frakt etapp 2: the customer's förvalda fraktprodukt — a new shipment
  // inherits it when its order has no chosen product of its own.
  defaultFreightProductId: uuid("default_freight_product_id").references(() => freightProducts.id, { onDelete: "restrict" }),
  // Kundrabatt: a blanket percentage applied by the price resolver as the
  // last fallback — on the price-list or base price, never on top of a
  // customer-specific price or group rule (Monitor's "Rabatt" on the customer).
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  // Invoice address (fakturaadress) — the plain address/postalCode/city
  // fields above are the visiting address (besöksadress). Delivery
  // addresses live in customer_delivery_addresses.
  // invoice_name replaces the customer name in the invoice address block
  // when set (c/o, holding company, ...); null = the customer name.
  invoiceName: varchar("invoice_name", { length: 255 }),
  invoiceAddress: text("invoice_address"),
  invoicePostalCode: varchar("invoice_postal_code", { length: 20 }),
  invoiceCity: varchar("invoice_city", { length: 100 }),
  invoiceCountry: varchar("invoice_country", { length: 2 }),
  invoiceEmail: varchar("invoice_email", { length: 255 }),
  // Vårt leverantörsnummer — the number the customer files US under in their
  // own system (mirror of suppliers.our_customer_number). Free text, NOT
  // unique, no snapshot on the invoice: documents always print the current
  // value, same line as the supplier side.
  ourSupplierNumber: varchar("our_supplier_number", { length: 50 }),
  // Samlingsfaktura: the customer is billed through the collective invoicing
  // routine (one invoice per customer across all delivered orders) and the
  // ordinary POST /invoices is refused for them (409).
  collectiveInvoicing: boolean("collective_invoicing").notNull().default(false),
  // Privatperson: sales documents print prices including VAT and the card
  // labels org_number as "Personnummer". Bookkeeping is unaffected.
  privatePerson: boolean("private_person").notNull().default(false),
  // Visa tilläggspriser — default for the quote/confirmation print & mail
  // dialog, and what the invoice PDF follows at issue (configurator 4b).
  showConfigurationPrices: boolean("show_configuration_prices").notNull().default(false),
  // Webbsida — free text, may lack a scheme ("www.example.se").
  // Fasta leveransdagar (delivery-days.ts): ISO weekdays 1–7, sorted, no
  // duplicates (normalized by zod); empty = no fixed days. Mode and transit
  // days null = the system default for the side (system_settings).
  deliveryWeekdays: smallint("delivery_weekdays").array().notNull().default(sql`'{}'::smallint[]`),
  deliveryDayMode: deliveryDayModeEnum("delivery_day_mode"),
  transitDays: smallint("transit_days"),
  website: varchar("website", { length: 255 }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("customers_delivery_weekdays", sql`${table.deliveryWeekdays} <@ '{1,2,3,4,5,6,7}'::smallint[]`),
  check("customers_transit_days", sql`${table.transitDays} between 0 and 60`),
]);

// Multiple delivery addresses per customer; at most one is the default,
// enforced by the partial unique index (same pattern as the primary
// contact). Selected per sales order via sales_orders.delivery_address_id.
export const customerDeliveryAddresses = pgTable(
  "customer_delivery_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 100 }).notNull(),
    address: text("address").notNull(),
    postalCode: varchar("postal_code", { length: 20 }),
    city: varchar("city", { length: 100 }),
    country: varchar("country", { length: 2 }).notNull().default("SE"),
    isDefault: boolean("is_default").notNull().default(false),
    // Engångsadress: typed in on a single order (Ny leveransadress) without
    // Spara på kunden. It lives here so every reader of an order's delivery
    // address (documents, pick list, freight) works through the same FK, but
    // it is hidden from the customer's list, the order's address picker and
    // the import's matching — and deleted again when the order switches to
    // another address. Never the default.
    oneOff: boolean("one_off").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_delivery_addresses_one_default").on(table.customerId).where(sql`${table.isDefault}`),
    check("customer_delivery_addresses_one_off_not_default", sql`not (${table.oneOff} and ${table.isDefault})`),
  ]
);

// Multiple contacts per customer; at most one is the primary contact
// (huvudkontakt), enforced by the partial unique index.
export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 50 }),
    mobile: varchar("mobile", { length: 50 }),
    email: varchar("email", { length: 255 }),
    comment: text("comment"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("customer_contacts_one_primary").on(table.customerId).where(sql`${table.isPrimary}`),
  ]
);

// C3 Kundpriser: named price lists (chain level 3). Own register in sales —
// the generic register module serves bare arrays and cannot host per-article
// row subresources.
export const priceLists = pgTable("price_lists", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Price per (list, article, quantity break). Prices are in the article's
// BASE unit, like sales_order_rows.unit_price. from_quantity 1 = the plain
// single-tier price; resolution picks the highest break <= ordered quantity.
export const priceListRows = pgTable(
  "price_list_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    priceListId: uuid("price_list_id")
      .notNull()
      .references(() => priceLists.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    fromQuantity: numeric("from_quantity", { precision: 14, scale: 4 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.priceListId, table.articleId, table.fromQuantity)]
);

// Customer-specific rules (chain levels 1-2): per article OR article group
// (exactly one), carrying a special price OR a discount% on the customer's
// list/base price (exactly one). Both pairs are CHECK-enforced — the zod
// layer validates first, the constraint is the race-proof guarantee.
export const customerPrices = pgTable(
  "customer_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    articleId: uuid("article_id").references(() => articles.id, { onDelete: "restrict" }),
    articleGroupId: uuid("article_group_id").references(() => articleGroups.id, { onDelete: "restrict" }),
    fromQuantity: numeric("from_quantity", { precision: 14, scale: 4 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("customer_prices_target_check", sql`(article_id IS NULL) <> (article_group_id IS NULL)`),
    check("customer_prices_value_check", sql`(unit_price IS NULL) <> (discount_percent IS NULL)`),
    uniqueIndex("uq_customer_prices_article")
      .on(table.customerId, table.articleId, table.fromQuantity)
      .where(sql`article_id IS NOT NULL`),
    uniqueIndex("uq_customer_prices_group")
      .on(table.customerId, table.articleGroupId, table.fromQuantity)
      .where(sql`article_group_id IS NOT NULL`),
  ]
);

export const salesOrders = pgTable("sales_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  // KO-5001, KO-5002, ... (Kundorder) — issued by number-series.ts's
  // getNextOrderNumber (key "sales_order") at insert time.
  orderNumber: varchar("order_number", { length: 20 }).notNull().unique(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "restrict" }),
  // The customer's own PO number and contact reference for the order —
  // printed on the quote/order confirmation and the pick list.
  customerOrderNumber: varchar("customer_order_number", { length: 50 }),
  customerReference: varchar("customer_reference", { length: 100 }),
  // Which of the customer's delivery addresses this order ships to.
  deliveryAddressId: uuid("delivery_address_id").references(() => customerDeliveryAddresses.id, {
    onDelete: "set null",
  }),
  // Snapshotted from the customer at creation (like the PO's currency) —
  // editable on the order, printed on quote/order confirmation when set.
  deliveryTermId: uuid("delivery_term_id").references(() => deliveryTerms.id, { onDelete: "restrict" }),
  paymentTermId: uuid("payment_term_id").references(() => paymentTerms.id, { onDelete: "restrict" }),
  carrierId: uuid("carrier_id").references(() => carriers.id, { onDelete: "restrict" }),
  // Frakt på offert (2026-10-08): the transport product chosen with "Lägg till
  // frakt", Sendify's price when it was added, and the last rates answer for the
  // order (rows are picked by id, never by a client price). A shipment booked
  // from this order inherits product + price as its choice.
  freightProductId: uuid("freight_product_id").references(() => freightProducts.id, { onDelete: "restrict" }),
  freightCarrierPrice: numeric("freight_carrier_price", { precision: 14, scale: 2 }),
  freightQuote: jsonb("freight_quote").$type<StoredRates>(),
  status: salesOrderStatusEnum("status").notNull().default("quote"),
  expectedDeliveryDate: date("expected_delivery_date"),
  note: text("note"),
  // Bumped by 1 on every content change (header/terms/rows) — never by
  // status transitions or deliveries. Printed on quote/order confirmation.
  revision: integer("revision").notNull().default(1),
  // Legacy pre-C1 stamp: orders invoiced before the invoice module got an
  // FA- number written straight onto the order. Never written since C1 —
  // invoicing (partial and collective) lives in invoices/invoice_rows.
  invoiceNumber: varchar("invoice_number", { length: 20 }).unique(),
  invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per article per order for ordinary rows (same simplification as
// purchase_order_rows); configured rows (4b) are exempt — see the index below.
export const salesOrderRows = pgTable(
  "sales_order_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    salesOrderId: uuid("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    quantityOrdered: numeric("quantity_ordered", { precision: 14, scale: 4 }).notNull(),
    quantityDelivered: numeric("quantity_delivered", { precision: 14, scale: 4 }).notNull().default("0"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).notNull(),
    // C3: row discount in percent, printed on documents. Baked into the
    // invoice row's lineAmount — never a separate ledger figure.
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    // Display unit the row was entered in (null = the article's base unit).
    // Quantities/price are always stored in the base unit; unit_factor is the
    // article's quantity_per_base snapshotted at entry time.
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "restrict" }),
    unitFactor: numeric("unit_factor", { precision: 16, scale: 6 }),
    // Konfigurator 4b: a beställningsvara row keeps the template as article
    // and its choices, labels and price split here (OrderRowConfiguration in
    // @navet/shared). null = ordinary row.
    configuration: jsonb("configuration"),
    // Konfigurator 4c: the configuration's förkalkyl at the row's quantity
    // (OrderRowConfigurationCost) — what the row's margin is measured
    // against. Its own column on purpose: `configuration` is copied to the
    // invoice row and returned to OAuth clients; our self cost is neither's
    // business. Written by sales on create, Ändra konfiguration and every
    // quantity change.
    configurationCost: jsonb("configuration_cost"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per article per order for ORDINARY rows (the freight row is
    // looked up by article); configured rows of the same template may repeat
    // with different choices.
    uniqueIndex("sales_order_rows_order_article_unique")
      .on(table.salesOrderId, table.articleId)
      .where(sql`${table.configuration} IS NULL`),
  ]
);

// Leveranstillfälle (delivery occasion) — C2. One row per utleverans event,
// so a följesedel can document exactly what shipped THAT time. Deliveries
// before this table exist only as sales_order_rows.quantity_delivered
// accumulators and get no delivery note — the history was never grouped and
// is not reconstructable. stock_transactions is deliberately untouched: its
// referenceId stays the sales order id (existing readers depend on that);
// the occasion grouping lives here. deliveryNumber comes from the
// number_series key "delivery" (FS- prefix, seeded in the C2 migration).
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    salesOrderId: uuid("sales_order_id")
      .notNull()
      .references(() => salesOrders.id, { onDelete: "restrict" }),
    deliveryNumber: varchar("delivery_number", { length: 20 }).notNull().unique(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [index("idx_deliveries_order").on(table.salesOrderId)]
);

export const deliveryRows = pgTable(
  "delivery_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    salesOrderRowId: uuid("sales_order_row_id")
      .notNull()
      .references(() => salesOrderRows.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
  },
  (table) => [index("idx_delivery_rows_delivery").on(table.deliveryId)]
);

// Kundfaktura (customer invoice) — C1. The invoice is its own document,
// decoupled from the order: draft → issued → paid, cancellable only as a
// draft (corrections after issue go through a credit note). The FA number
// is allocated at ISSUE time (unbroken series — cancelled drafts never burn
// numbers); legacy orders invoiced before C1 keep their stamp on
// sales_orders.invoice_number and are never touched by this module.
export const invoiceStatusEnum = pgEnum("invoice_status", ["draft", "issued", "paid", "cancelled"]);
export const invoiceTypeEnum = pgEnum("invoice_type", ["invoice", "credit"]);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Null while draft; assigned from the number_series key "invoice" (FA-)
    // atomically with the draft → issued transition.
    invoiceNumber: varchar("invoice_number", { length: 20 }).unique(),
    type: invoiceTypeEnum("type").notNull().default("invoice"),
    // Credit notes reference the invoice they correct. Restrict: an invoice
    // with credits must stay readable.
    creditedInvoiceId: uuid("credited_invoice_id").references((): AnyPgColumn => invoices.id, {
      onDelete: "restrict",
    }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    paymentTermId: uuid("payment_term_id").references(() => paymentTerms.id, { onDelete: "restrict" }),
    status: invoiceStatusEnum("status").notNull().default("draft"),
    currency: varchar("currency", { length: 3 }).notNull().default("SEK"),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    ocrNumber: varchar("ocr_number", { length: 30 }),
    // Value snapshots frozen at issue so reprints stay stable regardless of
    // later customer/register edits. Null while draft.
    customerName: varchar("customer_name", { length: 255 }),
    // The customer's number at issue time — nullable: invoices issued before
    // the customer-number feature simply don't print it (no backfill).
    customerNumber: varchar("customer_number", { length: 50 }),
    invoiceAddress: text("invoice_address"),
    invoicePostalCode: varchar("invoice_postal_code", { length: 20 }),
    invoiceCity: varchar("invoice_city", { length: 100 }),
    // Snapshot of the recipient's country at issue; printed only when ≠ SE.
    invoiceCountry: varchar("invoice_country", { length: 2 }),
    orgNumber: varchar("org_number", { length: 20 }),
    vatNumber: varchar("vat_number", { length: 30 }),
    // Privatperson snapshot: the PDF prints prices including VAT. Frozen at
    // issue like the fields above (false while draft — drafts never print).
    privatePerson: boolean("private_person").notNull().default(false),
    paymentTermCode: varchar("payment_term_code", { length: 50 }),
    paymentTermName: varchar("payment_term_name", { length: 100 }),
    note: text("note"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // B2 automatkontering: the booked verification created atomically with
    // the draft → issued transition. Null while draft; restrict — a booked
    // verification with an invoice pointing at it must stay readable.
    verificationId: uuid("verification_id").references(() => verifications.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_invoices_customer").on(table.customerId),
    index("idx_invoices_status").on(table.status),
    index("idx_invoices_credited").on(table.creditedInvoiceId),
    index("idx_invoices_verification").on(table.verificationId),
    // Kundreskontra (B3): the open-items list orders by due date and filters
    // "endast förfallna" on it; the OCR lookup matches an incoming payment
    // reference. NOT unique — the OCR is a pure function of the unique FA
    // number, so uniqueness is already guaranteed upstream and an index that
    // enforced it would only add a way for a repair script to fail.
    index("idx_invoices_due_date").on(table.dueDate),
    index("idx_invoices_ocr").on(table.ocrNumber),
  ]
);

// Invoice lines. articleId is nullable (free/freight/rounding rows) and
// there is deliberately NO unique(invoiceId, articleId): partial and
// consolidated invoicing legitimately repeat an article. Credit-note rows
// are stored POSITIVE — the sign is applied by invoices.type in exactly two
// places (the invoiced-quantity aggregation and the PDF rendering).
export const invoiceRows = pgTable(
  "invoice_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    articleId: uuid("article_id").references(() => articles.id, { onDelete: "restrict" }),
    // The delfakturering link: which order row this line settles. Restrict —
    // the derived invoiced-quantity audit trail must not lose its anchor.
    salesOrderRowId: uuid("sales_order_row_id").references(() => salesOrderRows.id, { onDelete: "restrict" }),
    // Frakt etapp 2: the shipment this freight line bills. Restrict — the
    // link is the double-billing guard. The partial unique index below cannot
    // see the invoice's status, so cancelling a draft clears the link and
    // credit rows never carry it.
    shipmentId: uuid("shipment_id").references(() => shipments.id, { onDelete: "restrict" }),
    description: varchar("description", { length: 255 }).notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).notNull(),
    // C3: row discount in percent, printed on documents. Baked into the
    // invoice row's lineAmount — never a separate ledger figure.
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    // Display unit snapshot — same pattern as sales_order_rows.
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "restrict" }),
    unitFactor: numeric("unit_factor", { precision: 16, scale: 6 }),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    lineAmount: numeric("line_amount", { precision: 14, scale: 2 }).notNull(),
    vatAmount: numeric("vat_amount", { precision: 14, scale: 2 }).notNull(),
    // Konfigurator 4b: copy of the order row's configuration when the row was
    // linked (or of the credited invoice row); written once with the row,
    // never updated on an issued invoice.
    configuration: jsonb("configuration"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_invoice_rows_invoice").on(table.invoiceId),
    index("idx_invoice_rows_order_row").on(table.salesOrderRowId),
    uniqueIndex("invoice_rows_shipment_unique").on(table.shipmentId).where(sql`${table.shipmentId} IS NOT NULL`),
  ]
);

// Betalningspåminnelse (payment reminder) — B3. One row per reminder sent for
// an invoice: the level (1, 2, 3 ...), the statutory one-time fee it charged
// (0 for a fee-free reminder) and the K verification that booked that fee.
// There is no status and no "cancelled" — a reminder is an event that either
// happened or did not, and the row is only ever written after the email has
// actually left the building (see invoice.service.ts's sendReminder).
//
// The fee is what makes this table part of the open-item arithmetic: it is
// the third term of open-amounts.ts's formula, so charging it raises what the
// customer owes and the invoice cannot close until invoice + fee are settled.
export const invoiceReminders = pgTable(
  "invoice_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Restrict: the derived open amount must never lose its anchor (same rule
    // as customer_payment_rows.invoiceId).
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    // 1 for the first reminder, then +1 per reminder — printed as
    // "Betalningspåminnelse {level}" on the PDF. Deliberately NOT unique per
    // invoice: two reminders sent in the same second are a duplicate mailing,
    // not a data-integrity failure, and refusing the second one after its
    // email already went out would be the worse outcome.
    level: integer("level").notNull(),
    // The fee charged BY this reminder (kr), 0 for a fee-free one.
    fee: numeric("fee", { precision: 14, scale: 2 }).notNull().default("0"),
    // The K verification that booked the fee — null for a fee-free reminder.
    // Restrict, like every other verification link in this schema.
    feeVerificationId: uuid("fee_verification_id").references(() => verifications.id, { onDelete: "restrict" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_invoice_reminders_invoice").on(table.invoiceId),
    // THE statutory guarantee (lag om ersättning för inkassokostnader): a
    // påminnelseavgift may be charged ONCE per invoice. The service's own
    // pre-check gives the friendly 409; this partial index is what makes a
    // second fee impossible for any writer, including a racing transaction
    // that never took the invoice's row lock.
    uniqueIndex("invoice_reminders_one_fee").on(table.invoiceId).where(sql`${table.fee} > 0`),
  ]
);

// Arkiverade fakturadokument — the PDF exactly as issued/sent. An issued
// invoice (or credit note) and every sent betalningspåminnelse is a
// verifikation (bokföringslagen 5 kap 6 §) whose copy must stay unchanged
// for 7 år (7 kap). Rendering again later would follow LIVE company data
// (bankgiro, address, logo, vårt leverantörsnr hos er) — so the PDF is
// stored once and every reprint/email serves these bytes. Never updated or
// deleted: no code path writes anything but an insert, and both FKs are
// restrict. kind "invoice" is one per invoice; "reminder" one per reminder.
export const invoiceDocuments = pgTable(
  "invoice_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    kind: varchar("kind", { length: 20 }).notNull(), // "invoice" | "reminder"
    reminderId: uuid("reminder_id").references(() => invoiceReminders.id, { onDelete: "restrict" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_invoice_documents_invoice").on(table.invoiceId),
    uniqueIndex("invoice_documents_one_invoice_pdf").on(table.invoiceId).where(sql`${table.kind} = 'invoice'`),
    uniqueIndex("invoice_documents_one_per_reminder").on(table.reminderId),
    check(
      "invoice_documents_kind",
      sql`(${table.kind} = 'invoice' and ${table.reminderId} is null) or (${table.kind} = 'reminder' and ${table.reminderId} is not null)`
    ),
  ]
);

// Kundbetalning (customer payment) — B3. One registration per received
// payment: BET-1, BET-2 ... allocated inside the registration transaction,
// one customer per payment, and one row per open item it settles. There is
// deliberately NO status enum: "Makulerad" is derived from cancelledAt (the
// nullfälts-model), because a payment only ever has two states and the
// cancellation carries three facts (when, by whom, with which omföring) that
// a status column could not.
export const customerPayments = pgTable(
  "customer_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentNumber: varchar("payment_number", { length: 20 }).notNull().unique(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    paymentDate: date("payment_date").notNull(),
    // The betalkonto the money landed on, picked per payment from the active
    // chart of accounts — snapshotted as a NUMBER (the verification rows carry
    // the account id) so a later renumbering cannot rewrite history.
    bankAccountNumber: varchar("bank_account_number", { length: 4 }).notNull(),
    // The BANK part only: 0 for a pure kvittning between open items.
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    note: text("note"),
    // The K verification booked in the same transaction as the registration.
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
    // Bankfiler: the credit entry this payment booked. A cancelled payment
    // frees the entry again (the partial index only counts live payments).
    bankFileEntryId: uuid("bank_file_entry_id").references(() => bankFileEntries.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_customer_payments_customer").on(table.customerId),
    index("idx_customer_payments_verification").on(table.verificationId),
    index("idx_customer_payments_cancellation").on(table.cancellationVerificationId),
    uniqueIndex("customer_payments_entry_live")
      .on(table.bankFileEntryId)
      .where(sql`${table.cancelledAt} is null and ${table.bankFileEntryId} is not null`),
  ]
);

// What one payment settles, one row per open item (invoice or credit note).
// Both amounts are SIGNED: appliedAmount is the cash part (positive settles an
// invoice, negative settles a credit note) and writeOffAmount is the
// server-computed tolerance difference. What actually leaves the open item is
// their sum — see open-amounts.ts, the single aggregation authority.
export const customerPaymentRows = pgTable(
  "customer_payment_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => customerPayments.id, { onDelete: "cascade" }),
    // Restrict: the derived open amount must never lose its anchor.
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    appliedAmount: numeric("applied_amount", { precision: 14, scale: 2 }).notNull(),
    writeOffAmount: numeric("write_off_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_customer_payment_rows_payment").on(table.paymentId),
    index("idx_customer_payment_rows_invoice").on(table.invoiceId),
  ]
);
