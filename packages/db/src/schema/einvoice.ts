import { sql } from "drizzle-orm";
import { check, customType, date, index, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { invoiceScans } from "./invoice-scan";
import { invoices } from "./sales";

// Same local bytea helper as the other schema files.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// E-faktura via Peppol (B2Brouter) — spec
// private/superpowers/specs/2026-10-21-e-faktura-peppol-design.md §1.
//
// Nav's own transmission states (B2Brouter's raw `state` is kept beside it
// in provider_state): sending = handed over / waiting for the access point,
// sent = accepted for transport, delivered = the recipient's access point
// registered it (final for Nav — payment is the kundreskontra's business),
// rejected = the recipient refused it, failed = never got through.
export const einvoiceStatusEnum = pgEnum("einvoice_status", ["sending", "sent", "delivered", "rejected", "failed"]);

// Sändningsloggen — one row per send attempt, the e-mail log's counterpart.
// Append-only: `document` is the UBL exactly as it left Nav (bokföringslagen:
// that is what reached the customer) with its sha256 beside it; migration
// 0133's NV001 trigger refuses any UPDATE of those two columns and every
// DELETE. The status columns are what the status job updates.
export const einvoiceTransmissions = pgTable(
  "einvoice_transmissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    provider: varchar("provider", { length: 20 }).notNull(),
    // sandbox | production — a sandbox transmission must never look real.
    environment: varchar("environment", { length: 10 }).notNull(),
    // The Peppol-id used, "scheme:value", snapshot at send time.
    recipientId: varchar("recipient_id", { length: 60 }).notNull(),
    status: einvoiceStatusEnum("status").notNull(),
    providerInvoiceId: varchar("provider_invoice_id", { length: 40 }),
    providerState: varchar("provider_state", { length: 40 }),
    errorMessage: text("error_message"),
    document: bytea("document").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    statusUpdatedAt: timestamp("status_updated_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("idx_einvoice_transmissions_invoice").on(table.invoiceId, table.startedAt.desc()),
    // ONE live transmission per invoice AND environment: a resend is only
    // possible after rejected/failed, but a sandbox trial never blocks the
    // real send (and vice versa). The service inserts the `sending` row
    // BEFORE calling the access point and maps this index's violation to
    // EinvoiceAlreadySentError, so a double click can never send twice.
    uniqueIndex("einvoice_transmissions_live")
      .on(table.invoiceId, table.environment)
      .where(sql`${table.status} IN ('sending', 'sent', 'delivered')`),
  ]
);

// Mottagningsloggen (migration 0183, spec 2026-11-05-e-faktura-mottagning) —
// one row per received document at the access point, and the home of the
// ORIGINAL e-invoice (the XML exactly as B2Brouter served it): the invoice
// inbox only carries the PDF (embedded or Nav's visningskopia). The original
// is räkenskapsinformation and stays even when a rejected inbox post is
// deleted (the FK nulls invoice_scan_id). Append-only: migration 0183's NV001
// trigger refuses every DELETE and any UPDATE except outcome/detail/
// invoice_scan_id, and the identity/interpretation columns (document_type …
// payable_amount, interpretation_xml, attachments) may be filled ONCE: a
// row logged `unreadable` (all of them null) gets them when the document
// can be read later, and from then on they are frozen too. UNIQUE
// (environment, provider_invoice_id) makes the job idempotent — a document
// is never imported twice.
export const einvoiceReceptions = pgTable(
  "einvoice_receptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // sandbox | production
    environment: varchar("environment", { length: 10 }).notNull(),
    providerInvoiceId: varchar("provider_invoice_id", { length: 40 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // invoice | credit_note; null when the document could not be read.
    documentType: varchar("document_type", { length: 12 }),
    documentNumber: varchar("document_number", { length: 100 }),
    issueDate: date("issue_date"),
    // "scheme:value" (0007:5566778899).
    senderEndpoint: varchar("sender_endpoint", { length: 80 }),
    senderName: varchar("sender_name", { length: 200 }),
    currency: varchar("currency", { length: 3 }),
    payableAmount: numeric("payable_amount", { precision: 14, scale: 2 }),
    originalXml: bytea("original_xml").notNull(),
    originalSha256: varchar("original_sha256", { length: 64 }).notNull(),
    originalContentType: varchar("original_content_type", { length: 100 }).notNull(),
    // B2Brouter's UBL BIS3 rendering when the original is not UBL (CII …);
    // null when the original was read directly.
    interpretationXml: bytea("interpretation_xml"),
    // The embedded attachments' metadata ([{ index, filename, contentType,
    // sizeBytes }]) read at import, so the inbox never parses the XML to
    // list them; the download route decodes.
    attachments: jsonb("attachments"),
    // imported | duplicate | unreadable | dismissed (an unreadable document
    // closed by hand: acknowledged at the access point, registered by hand)
    outcome: varchar("outcome", { length: 12 }).notNull(),
    detail: text("detail"),
    invoiceScanId: uuid("invoice_scan_id").references(() => invoiceScans.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("einvoice_receptions_provider").on(table.environment, table.providerInvoiceId),
    index("idx_einvoice_receptions_received").on(table.receivedAt.desc()),
    index("idx_einvoice_receptions_scan").on(table.invoiceScanId),
    // Statusmängder är vitlistor (EINVOICE_RECEPTION_OUTCOMES in @navet/shared).
    check(
      "einvoice_receptions_outcome",
      sql`${table.outcome} IN ('imported', 'duplicate', 'unreadable', 'dismissed')`
    ),
    check("einvoice_receptions_environment", sql`${table.environment} IN ('sandbox', 'production')`),
    check(
      "einvoice_receptions_document_type",
      sql`${table.documentType} IS NULL OR ${table.documentType} IN ('invoice', 'credit_note')`
    ),
  ]
);
