import { z } from "zod";
import { listQuerySchema, statusListParam } from "./list.js";

// Outbound email — documents are always sent as PDF attachments; the body is
// a short plain-text message the user can edit in the send dialog.
// payment_reminder (B3) logs against the INVOICE's id — the reminder is an
// event on the invoice, not a document of its own. alert_digest is the daily
// aviseringar sammanställning — no documentId, and never resent.
export const emailDocumentTypes = [
  "inquiry",
  "purchase_order",
  "quote",
  "order_confirmation",
  "invoice",
  "payment_reminder",
  "test",
  "alert_digest",
] as const;
export type EmailDocumentType = (typeof emailDocumentTypes)[number];

// The list query derives this from documentId rather than storing it: old
// "invoice" rows (pre-C1, stamped before real invoices existed) point at a
// sales order id, so the Dokument column can't just trust documentType —
// it needs to know which card the id actually belongs to. Every other
// documentType passes straight through since its id never had this
// ambiguity.
export const emailLinkKinds = [...emailDocumentTypes, "sales_order"] as const;
export type EmailLinkKind = (typeof emailLinkKinds)[number];

export const emailStatuses = ["sent", "failed"] as const;
export type EmailStatus = (typeof emailStatuses)[number];

export const sendDocumentEmailSchema = z.object({
  to: z.string().trim().email().max(255),
  subject: z.string().trim().min(1).max(255),
  message: z.string().trim().max(5000).default(""),
  // Attach the drawings (article files) of every article on the order.
  attachDrawings: z.boolean().default(false),
});
export type SendDocumentEmailInput = z.infer<typeof sendDocumentEmailSchema>;

// Sales orders carry two printable documents: the quote and the order
// confirmation. Sending the confirmation is what confirms the quote.
export const salesEmailVariants = ["quote", "confirmation"] as const;
export const sendSalesOrderEmailSchema = sendDocumentEmailSchema.extend({
  variant: z.enum(salesEmailVariants),
  // Visa tilläggspriser on the attached PDF; omitted ⇒ the customer's setting.
  showConfigurationPrices: z.boolean().optional(),
});
export type SendSalesOrderEmailInput = z.infer<typeof sendSalesOrderEmailSchema>;

export const sendTestEmailSchema = z.object({
  to: z.string().trim().email().max(255),
});
export type SendTestEmailInput = z.infer<typeof sendTestEmailSchema>;

// documentType/documentId let the document cards show their own send history.
export const listEmailLogQuerySchema = listQuerySchema.extend({
  status: statusListParam(emailStatuses),
  documentType: z.enum(emailDocumentTypes).optional(),
  documentId: z.string().uuid().optional(),
});
export type ListEmailLogQuery = z.infer<typeof listEmailLogQuerySchema>;
