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
  "einvoice_receive_failed",
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

// GET /alerts?kinds=a,b — only these kinds (still narrowed to what the user
// may see); absent = every visible kind. Översikten's single-kind cards ask
// for theirs so the behovsberäkning only runs when a card needs it.
export const alertsQuerySchema = z.object({
  kinds: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return undefined;
      const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
      const invalid = parts.filter((p) => !(ALERT_KINDS as readonly string[]).includes(p));
      if (invalid.length > 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid alert kind: ${invalid.join(", ")}` });
        return z.NEVER;
      }
      return parts as AlertKind[];
    }),
});
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;

// Red before yellow in the fixed order; a supplier invoice is red once it is
// overdue and yellow while it is only due soon.
export type AlertSeverity = "red" | "yellow";

// At most this many rows per group in the response; `count` is always the
// real number.
export const ALERT_ITEMS_LIMIT = 200;

// Behöver beställas: one of the row's order proposals, in the form
// POST /planning/orders takes (createPlanningOrdersSchema) — the web sends
// the marked rows' proposals as they are, so Skapa inköpsorder is the
// behovsberäkning's Skapa ordrar. `key` makes the server recompute and
// refuse a proposal that is already ordered.
export interface AlertOrderProposal {
  articleId: string;
  quantity: number;
  kind: "purchase" | "subcontract";
  key: string;
  reason: "demand" | "reorder_point" | "safety_stock" | "forecast" | "undated";
  needDate?: string;
  // Subcontract only: the TO operation the proposal buys.
  moOperationId?: string;
}

// Behöver beställas: the rows grouped per supplier. `items` come sorted in
// the groups' order, so a group is the next `shown` rows; `count` is the
// group's real number (the response holds at most ALERT_ITEMS_LIMIT rows).
export interface AlertSupplierGroup {
  // The supplier id, "none" for Utan förvald leverantör (always first).
  key: string;
  supplierId: string | null;
  supplierName: string | null;
  count: number;
  shown: number;
}

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
  // purchase_needed only: the proposal's own supplier (the article's förvalda
  // leverantör, the lego operation's supplier; null = none) and the order
  // proposals to send to POST /planning/orders.
  supplierId?: string | null;
  supplierName?: string | null;
  proposals?: AlertOrderProposal[];
}

export interface AlertGroup {
  kind: AlertKind;
  label: string;
  severity: AlertSeverity;
  count: number;
  listHref: string;
  items: AlertItem[];
  // purchase_needed only: the supplier groups in display order (without a
  // förvald leverantör first, then by supplier name).
  supplierGroups?: AlertSupplierGroup[];
  // A reader that failed does not take the others down: the group is shown
  // with error = true and a text, and no rows.
  error: boolean;
  message: string | null;
}

export interface AlertsResponse {
  computedAt: string;
  groups: AlertGroup[];
}
