import { sql } from "drizzle-orm";
import { customType, index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
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
    // ONE live transmission per invoice: a resend is only possible after
    // rejected/failed. The service inserts the `sending` row BEFORE calling
    // the access point and maps this index's violation to
    // EinvoiceAlreadySentError, so a double click can never send twice.
    uniqueIndex("einvoice_transmissions_live")
      .on(table.invoiceId)
      .where(sql`${table.status} IN ('sending', 'sent', 'delivered')`),
  ]
);
