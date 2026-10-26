import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { supplierInvoiceFiles, supplierInvoices, suppliers } from "./purchase";

// Same local bytea helper as the other schema files.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Fakturaskanning (migration 0152) — spec
// private/superpowers/specs/2026-10-26-fakturaskanning-design.md §1.
//
// The Fakturainkorg: a received supplier invoice file (upload or the e-mail
// box) and the latest interpretation of it, until a person turns it into a
// supplier invoice draft (converted) or rejects it. A received invoice is
// räkenskapsinformation from the moment it arrives (BFL 5 kap 6 §): the
// service deletes only a rejected scan, and a converted scan's file lives
// on in supplier_invoice_files (data = NULL here, no double storage).
export const invoiceScanSourceEnum = pgEnum("invoice_scan_source", ["upload", "email"]);
export const invoiceScanStatusEnum = pgEnum("invoice_scan_status", ["new", "interpreted", "converted", "rejected"]);
export const invoiceScanEngineEnum = pgEnum("invoice_scan_engine", ["rules", "ai"]);
export const invoiceScanHintFieldEnum = pgEnum("invoice_scan_hint_field", [
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "paymentReference",
  "grossAmount",
  "netAmount",
  "vatAmount",
  "purchaseOrderReference",
]);
export const invoiceScanMailOutcomeEnum = pgEnum("invoice_scan_mail_outcome", [
  "imported",
  "no_attachment",
  "duplicate",
  "too_large",
  "unsupported",
  "error",
]);

export const invoiceScans = pgTable(
  "invoice_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // FI-1, FI-2 … from number_series "invoice_scan" (seeded by 0152,
    // created on first use if missing).
    scanNumber: varchar("scan_number", { length: 20 }).notNull().unique(),
    source: invoiceScanSourceEnum("source").notNull(),
    status: invoiceScanStatusEnum("status").notNull().default("new"),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    // The file until the conversion moves it to supplier_invoice_files.
    // Listings never select it.
    data: bytea("data"),
    supplierInvoiceFileId: uuid("supplier_invoice_file_id")
      .unique()
      .references(() => supplierInvoiceFiles.id, { onDelete: "restrict" }),
    // null for images; set by the text extraction.
    hasTextLayer: boolean("has_text_layer"),
    pageCount: integer("page_count"),
    // The latest interpretation (InvoiceScanResult in @navet/shared) — a
    // proposal, never authoritative.
    result: jsonb("result"),
    interpretedBy: invoiceScanEngineEnum("interpreted_by"),
    interpretedAt: timestamp("interpreted_at", { withTimezone: true }),
    // The AI call's reservation and its latest failure as Swedish text
    // (step 2 of the spec; created here so it needs no migration of its own).
    aiStartedAt: timestamp("ai_started_at", { withTimezone: true }),
    aiError: varchar("ai_error", { length: 200 }),
    supplierInvoiceId: uuid("supplier_invoice_id")
      .unique()
      .references(() => supplierInvoices.id, { onDelete: "restrict" }),
    emailMessageId: varchar("email_message_id", { length: 998 }),
    emailAttachmentIndex: integer("email_attachment_index"),
    emailFrom: varchar("email_from", { length: 320 }),
    emailSubject: varchar("email_subject", { length: 998 }),
    emailReceivedAt: timestamp("email_received_at", { withTimezone: true }),
    rejectedReason: varchar("rejected_reason", { length: 200 }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by").references(() => users.id, { onDelete: "set null" }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The e-mail job is idempotent: one scan per (message, attachment).
    uniqueIndex("invoice_scans_email_attachment")
      .on(table.emailMessageId, table.emailAttachmentIndex)
      .where(sql`${table.emailMessageId} IS NOT NULL`),
    // Dubblettspärr: the same file twice is refused (409 invoice-scan-
    // duplicate) unless the earlier one was rejected.
    uniqueIndex("invoice_scans_sha256_live").on(table.sha256).where(sql`${table.status} <> 'rejected'`),
    index("idx_invoice_scans_status_created").on(table.status, table.createdAt),
    check(
      "invoice_scans_converted_invoice",
      sql`(${table.status} = 'converted') = (${table.supplierInvoiceId} IS NOT NULL)`
    ),
    check("invoice_scans_data_or_file", sql`(${table.data} IS NULL) = (${table.supplierInvoiceFileId} IS NOT NULL)`),
    check("invoice_scans_rejected_at", sql`${table.status} <> 'rejected' OR ${table.rejectedAt} IS NOT NULL`),
  ]
);

// Leverantörsinlärningen: the label that stood before a confirmed value on
// the supplier's invoice (normalized: lower case, trimmed, no colon, max 60
// characters). Written by the conversion, read by the rules before the
// standard labels; at most 5 per supplier and field (oldest last_used_at
// goes).
export const invoiceScanHints = pgTable(
  "invoice_scan_hints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    field: invoiceScanHintFieldEnum("field").notNull(),
    label: varchar("label", { length: 60 }).notNull(),
    hits: integer("hits").notNull().default(1),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("invoice_scan_hints_supplier_field_label").on(table.supplierId, table.field, table.label)]
);

// Senast lästa brev — the e-mail job's append-only log (written from step 3
// of the spec; created here so it needs no migration of its own).
export const invoiceScanMailLog = pgTable(
  "invoice_scan_mail_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    messageId: varchar("message_id", { length: 998 }),
    emailFrom: varchar("email_from", { length: 320 }),
    emailSubject: varchar("email_subject", { length: 998 }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    outcome: invoiceScanMailOutcomeEnum("outcome").notNull(),
    detail: text("detail"),
    scanIds: uuid("scan_ids").array().notNull().default(sql`'{}'::uuid[]`),
  },
  (table) => [index("idx_invoice_scan_mail_log_run_at").on(table.runAt.desc())]
);
