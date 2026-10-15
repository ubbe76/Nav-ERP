import { boolean, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

// Which business document an email carried. "test" rows come from the
// "Skicka testmejl" button on /system/installningar and have no documentId.
// A "payment_reminder" (B3) carries the invoice's OWN id as documentId — the
// reminder is not a document of its own, it is an event on the invoice, so
// the invoice card's send history shows invoice and reminder emails together.
export const emailDocumentTypeEnum = pgEnum("email_document_type", [
  "inquiry",
  "purchase_order",
  "quote",
  "order_confirmation",
  "invoice",
  "payment_reminder",
  "test",
]);

export const emailStatusEnum = pgEnum("email_status", ["sent", "failed"]);

// Append-only outbound email log. Every SMTP attempt gets a row — successful
// or not — so users can audit what actually reached customers/suppliers and
// retry failures from /system/e-postlogg.
export const emailLog = pgTable("email_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentType: emailDocumentTypeEnum("document_type").notNull(),
  documentId: uuid("document_id"),
  recipient: varchar("recipient", { length: 255 }).notNull(),
  subject: varchar("subject", { length: 255 }).notNull(),
  // Body text as sent — lets "Skicka om" resend a failed email faithfully.
  message: text("message").notNull().default(""),
  // Whether article drawings were attached — reused on resend.
  attachDrawings: boolean("attach_drawings").notNull().default(false),
  // Visa tilläggspriser as sent (quote/order confirmation only; null = not
  // applicable) — reused on resend (configurator 4b).
  showConfigurationPrices: boolean("show_configuration_prices"),
  status: emailStatusEnum("status").notNull(),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
