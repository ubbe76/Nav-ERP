// Mirror of packages/shared/src/alerts.ts (the web cannot import
// @navet/shared) — keep the keys and the GET /alerts shape in step.
export const ALERT_KINDS = [
  "stock_negative",
  "sales_order_late",
  "purchase_order_late",
  "manufacturing_order_late",
  "purchase_needed",
  "manufacture_needed",
  "customer_invoice_overdue",
  "supplier_invoice_due",
  "einvoice_failed",
  "email_failed",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertSeverity = "red" | "yellow";

export interface AlertItem {
  key: string;
  severity: AlertSeverity;
  href: string | null;
  primary: string;
  secondary: string | null;
  date: string | null;
}

export interface AlertGroup {
  kind: AlertKind;
  label: string;
  severity: AlertSeverity;
  count: number;
  listHref: string;
  items: AlertItem[];
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
