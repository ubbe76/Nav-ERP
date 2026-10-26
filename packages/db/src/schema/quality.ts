import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { articles } from "./article";
import { users } from "./auth";
import { manufacturingOrders, moOperations } from "./manufacturing";
import { purchaseOrderRows, purchaseOrders, suppliers } from "./purchase";
import { deviationReasons } from "./register";
import { customers, invoices, salesOrderRows, salesOrders } from "./sales";

// Same local bytea helper as the other schema files.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Reklamationer och avvikelser (Kvalitet, migration 0153). One register for
// the three kinds of case — Kundreklamation, Leverantörsavvikelse and Intern
// avvikelse — with the same flow and the same orsaksregister
// (deviation_reasons, register.ts). A case documents: it books nothing and
// moves no stock; the shortcuts (kreditfaktura, ersättningsorder, IO, TO)
// create ordinary documents through their own routines and link them here
// (deviation_links).
export const deviationTypeEnum = pgEnum("deviation_type", ["customer", "supplier", "internal"]);
// Registrerad → Utreds → Avslutad, Makulerad from the first two, Öppna igen
// from Avslutad — the whitelist is quality/service/deviation-status.ts.
export const deviationStatusEnum = pgEnum("deviation_status", ["registered", "investigating", "closed", "cancelled"]);
// Godkänd / Avslagen: required at Avsluta for customer and supplier cases.
export const deviationDecisionEnum = pgEnum("deviation_decision", ["accepted", "rejected"]);
// Material, Arbete, Frakt, Kreditering, Övrigt are costs; Ersättning
// (recovery) reduces the net cost.
export const deviationCostKindEnum = pgEnum("deviation_cost_kind", ["material", "labour", "freight", "credit", "other", "recovery"]);
export const deviationLinkDocumentTypeEnum = pgEnum("deviation_link_document_type", [
  "credit_invoice",
  "sales_order",
  "purchase_order",
  "manufacturing_order",
  "supplier_invoice",
]);
export const deviationEventEnum = pgEnum("deviation_event", [
  "created",
  "status_changed",
  "updated",
  "cost_added",
  "cost_removed",
  "link_added",
  "link_removed",
  "file_added",
  "file_removed",
  "email_sent",
]);

// Avvikelser — AV-1, AV-2 … from the number series "deviation". The type
// decides which counterparty and which document columns may be set (CHECKs
// below; the service checks that they belong together — the KO to the
// customer, the row to the order, the article to the row/TO). Document rows
// and TO operations can be deleted by their own routines, so those links are
// `set null`; orders, invoices, partners and articles are never deleted.
export const deviations = pgTable(
  "deviations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviationNumber: varchar("deviation_number", { length: 20 }).notNull().unique(),
    type: deviationTypeEnum("type").notNull(),
    status: deviationStatusEnum("status").notNull().default("registered"),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    // Stockholm day, defaulted to today by the service.
    reportedDate: date("reported_date").notNull(),
    reasonId: uuid("reason_id").references(() => deviationReasons.id, { onDelete: "restrict" }),
    responsibleUserId: uuid("responsible_user_id").references(() => users.id, { onDelete: "set null" }),
    // Åtgärd senast.
    dueDate: date("due_date"),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    // Kundens/leverantörens referens (their case number).
    counterpartyReference: varchar("counterparty_reference", { length: 100 }),
    salesOrderId: uuid("sales_order_id").references(() => salesOrders.id, { onDelete: "restrict" }),
    salesOrderRowId: uuid("sales_order_row_id").references(() => salesOrderRows.id, { onDelete: "set null" }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "restrict" }),
    purchaseOrderRowId: uuid("purchase_order_row_id").references(() => purchaseOrderRows.id, { onDelete: "set null" }),
    manufacturingOrderId: uuid("manufacturing_order_id").references(() => manufacturingOrders.id, { onDelete: "restrict" }),
    moOperationId: uuid("mo_operation_id").references(() => moOperations.id, { onDelete: "set null" }),
    articleId: uuid("article_id").references(() => articles.id, { onDelete: "restrict" }),
    // Avvikande antal in the article's base (stock) unit.
    quantity: numeric("quantity", { precision: 14, scale: 4 }),
    causeAnalysis: text("cause_analysis"),
    correctiveAction: text("corrective_action"),
    preventiveAction: text("preventive_action"),
    decision: deviationDecisionEnum("decision"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelReason: varchar("cancel_reason", { length: 500 }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_deviations_status").on(table.status),
    index("idx_deviations_reported_date").on(table.reportedDate),
    index("idx_deviations_customer").on(table.customerId),
    index("idx_deviations_supplier").on(table.supplierId),
    index("idx_deviations_sales_order").on(table.salesOrderId),
    index("idx_deviations_invoice").on(table.invoiceId),
    index("idx_deviations_purchase_order").on(table.purchaseOrderId),
    index("idx_deviations_manufacturing_order").on(table.manufacturingOrderId),
    index("idx_deviations_article").on(table.articleId),
    index("idx_deviations_reason").on(table.reasonId),
    check("deviations_customer_type", sql`(${table.type} = 'customer') = (${table.customerId} IS NOT NULL)`),
    check("deviations_supplier_type", sql`(${table.type} = 'supplier') = (${table.supplierId} IS NOT NULL)`),
    check(
      "deviations_customer_links",
      sql`${table.type} = 'customer' OR (${table.salesOrderId} IS NULL AND ${table.salesOrderRowId} IS NULL AND ${table.invoiceId} IS NULL)`
    ),
    check(
      "deviations_supplier_links",
      sql`${table.type} = 'supplier' OR (${table.purchaseOrderId} IS NULL AND ${table.purchaseOrderRowId} IS NULL)`
    ),
    check("deviations_internal_decision", sql`${table.type} <> 'internal' OR ${table.decision} IS NULL`),
    check("deviations_quantity_positive", sql`${table.quantity} IS NULL OR ${table.quantity} > 0`),
    check("deviations_closed_at", sql`(${table.status} = 'closed') = (${table.closedAt} IS NOT NULL)`),
    check("deviations_cancelled_at", sql`(${table.status} = 'cancelled') = (${table.cancelledAt} IS NOT NULL)`),
  ]
);

// Kostnader — registered for the follow-up, never booked. Amounts in SEK,
// always positive; the kind decides the sign of the net cost (recovery
// reduces it). The derived amounts (an issued kreditfaktura, an attested
// leverantörskreditnota linked in deviation_links) are read, never stored.
export const deviationCosts = pgTable(
  "deviation_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviationId: uuid("deviation_id")
      .notNull()
      .references(() => deviations.id, { onDelete: "cascade" }),
    kind: deviationCostKindEnum("kind").notNull(),
    description: varchar("description", { length: 200 }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_deviation_costs_deviation").on(table.deviationId),
    check("deviation_costs_amount_positive", sql`${table.amount} > 0`),
  ]
);

// Kopplade dokument — what the case led to: created through the shortcuts
// (in the document's own create transaction) or linked by hand. Polymorphic
// (no FK per type): the reader tolerates a document that no longer exists.
// The reklamerade KO/IO/TO themselves are the columns on deviations.
export const deviationLinks = pgTable(
  "deviation_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviationId: uuid("deviation_id")
      .notNull()
      .references(() => deviations.id, { onDelete: "cascade" }),
    documentType: deviationLinkDocumentTypeEnum("document_type").notNull(),
    documentId: uuid("document_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("deviation_links_unique").on(table.deviationId, table.documentType, table.documentId),
    index("idx_deviation_links_document").on(table.documentType, table.documentId),
    // A kreditfaktura / leverantörskreditnota belongs to at most ONE case —
    // its amount is a derived cost line, and two cases would count it twice
    // (0154). The index, not a check under the case lock, is the guard: two
    // Koppla dokument on DIFFERENT cases lock different rows.
    uniqueIndex("deviation_links_one_case_per_invoice")
      .on(table.documentType, table.documentId)
      .where(sql`${table.documentType} in ('credit_invoice', 'supplier_invoice')`),
  ]
);

// Bilder och filer (photos of damaged goods, the customer's letter). Same
// shape as supplier_invoice_files, but NOT räkenskapsinformation: removable
// while the case is open. Listings never select `data`.
export const deviationFiles = pgTable(
  "deviation_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviationId: uuid("deviation_id")
      .notNull()
      .references(() => deviations.id, { onDelete: "cascade" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    data: bytea("data").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_deviation_files_deviation").on(table.deviationId)]
);

// Historik — the case card's log, append-only. Its own table rather than the
// audit log because the card's history is for everyone with Kvalitet, while
// the audit log is an admin read.
export const deviationEvents = pgTable(
  "deviation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviationId: uuid("deviation_id")
      .notNull()
      .references(() => deviations.id, { onDelete: "cascade" }),
    event: deviationEventEnum("event").notNull(),
    detail: jsonb("detail"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_deviation_events_deviation").on(table.deviationId, table.createdAt)]
);
