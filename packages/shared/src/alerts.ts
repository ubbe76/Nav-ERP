import { z } from "zod";

// Aviseringar — derived at every read, never stored (the same "a question
// against the current state" rule as the open items in the ledgers). The
// catalog with each kind's label, severity, permission and list page lives
// in apps/api/src/modules/alerts/service/alert-kinds.ts; this file is the
// shared contract: the keys and the shape of GET /alerts. Display order is
// the catalog's, not this list's.
export const ALERT_KINDS = [
  "stock_negative",
  "sales_order_late",
  "purchase_order_late",
  "manufacturing_order_late",
  "purchase_needed",
  "manufacture_needed",
  "customer_invoice_overdue",
  "supplier_invoice_due",
  "quote_followup",
  "einvoice_failed",
  "email_failed",
  "plugin_delivery_failed",
  "recurring_verification_failed",
  "bank_unreconciled",
  "cost_center_missing",
  "invoice_scans_pending",
  "invoice_scan_mail_failed",
  "deviations_overdue",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const alertKindSchema = z.enum(ALERT_KINDS);

// Red before yellow in the fixed order; a supplier invoice is red once it is
// overdue and yellow while it is only due soon.
export type AlertSeverity = "red" | "yellow";

// At most this many rows per group in the response; `count` is always the
// real number.
export const ALERT_ITEMS_LIMIT = 200;

export interface AlertItem {
  // Stable per underlying row (the order/invoice/article id), so the web can
  // key rows and the digest can refer to them.
  key: string;
  severity: AlertSeverity;
  // The card where the matter is fixed; article kinds link to the article
  // overview. null when there is no card (a failed test email).
  href: string | null;
  primary: string;
  secondary: string | null;
  // The date the row is sorted/measured on (ISO date), when there is one.
  date: string | null;
}

export interface AlertGroup {
  kind: AlertKind;
  label: string;
  severity: AlertSeverity;
  count: number;
  listHref: string;
  items: AlertItem[];
  // A reader that failed does not take the others down: the group is shown
  // with error = true and a text, and no rows.
  error: boolean;
  message: string | null;
}

export interface AlertsResponse {
  computedAt: string;
  groups: AlertGroup[];
}
