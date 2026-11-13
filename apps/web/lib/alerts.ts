// Mirror of packages/shared/src/alerts.ts (the web cannot import
// @navet/shared) — keep the keys and the GET /alerts shape in step.
export const ALERT_KINDS = [
  "stock_negative",
  "batch_expiry",
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

export type AlertSeverity = "red" | "yellow";

export interface AlertOrderProposal {
  articleId: string;
  quantity: number;
  kind: "purchase" | "subcontract";
  key: string;
  reason: "demand" | "reorder_point" | "safety_stock" | "forecast" | "undated";
  needDate?: string;
  moOperationId?: string;
}

export interface AlertSupplierGroup {
  key: string;
  supplierId: string | null;
  supplierName: string | null;
  count: number;
  shown: number;
}

export interface AlertItem {
  key: string;
  severity: AlertSeverity;
  href: string | null;
  primary: string;
  secondary: string | null;
  date: string | null;
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
  supplierGroups?: AlertSupplierGroup[];
  error: boolean;
  message: string | null;
}

export interface AlertsResponse {
  computedAt: string;
  groups: AlertGroup[];
}

// "hh:mm" in Stockholm time for the "Beräknad" label.
const STOCKHOLM_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  hour: "2-digit",
  minute: "2-digit",
});
export const formatAlertTime = (iso: string): string => STOCKHOLM_TIME.format(new Date(iso));

export const ALERTS_EMPTY_TEXT = "Inget att bevaka just nu.";

export interface AlertSupplierSection {
  group: AlertSupplierGroup;
  items: AlertItem[];
}

// Behöver beställas arrives flat in the groups' order; each supplier group
// owns the next `shown` rows. Never sorted here — the API fixed the order.
export function supplierSections(group: AlertGroup | undefined): AlertSupplierSection[] {
  if (!group?.supplierGroups) return [];
  let offset = 0;
  return group.supplierGroups.map((sg) => {
    const items = group.items.slice(offset, offset + sg.shown);
    offset += sg.shown;
    return { group: sg, items };
  });
}
