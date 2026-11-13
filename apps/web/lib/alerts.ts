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

export const ALERT_AREAS = ["inkop", "forsaljning", "tillverkning", "lager", "kvalitet", "ekonomi", "system"] as const;
export type AlertArea = (typeof ALERT_AREAS)[number];
export const ALERT_AREA_LABELS: Record<AlertArea, string> = {
  inkop: "Inköp",
  forsaljning: "Försäljning",
  tillverkning: "Tillverkning",
  lager: "Lager",
  kvalitet: "Kvalitet",
  ekonomi: "Ekonomi",
  system: "System",
};

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
  area: AlertArea;
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

// Aviseringar per område: the kinds with something to show (rows or a read
// error) under their area's heading, areas in the menu's order and the kinds
// in the response's order within each (red before yellow). An area is red
// when any of its kinds is — group.severity is already red when any row is,
// and a kind that could not be read counts as red.
export interface AlertAreaSection {
  area: AlertArea;
  label: string;
  count: number;
  tone: AlertSeverity;
  groups: AlertGroup[];
}

export const alertGroupTone = (group: AlertGroup): AlertSeverity => (group.error ? "red" : group.severity);

export function alertAreaSections(groups: readonly AlertGroup[]): AlertAreaSection[] {
  const shown = groups.filter((g) => g.count > 0 || g.error);
  return ALERT_AREAS.flatMap((area) => {
    const inArea = shown.filter((g) => g.area === area);
    if (inArea.length === 0) return [];
    return [
      {
        area,
        label: ALERT_AREA_LABELS[area],
        count: inArea.reduce((sum, g) => sum + g.count, 0),
        tone: inArea.some((g) => alertGroupTone(g) === "red") ? "red" : "yellow",
        groups: inArea,
      },
    ];
  });
}

// The page's anchors: Översiktens Att bevaka links a kind to
// /aviseringar#<alertKindAnchor>, which also unfolds it.
export const alertAreaAnchor = (area: AlertArea): string => `omrade-${area}`;
export const alertKindAnchor = (kind: AlertKind): string => `typ-${kind}`;
export function alertKindFromHash(hash: string): AlertKind | null {
  const raw = hash.replace(/^#/, "");
  if (!raw.startsWith("typ-")) return null;
  const kind = raw.slice("typ-".length);
  return (ALERT_KINDS as readonly string[]).includes(kind) ? (kind as AlertKind) : null;
}

// Rows per kind before Visa fler.
export const ALERT_PREVIEW_ROWS = 5;

// Behöver beställas folded: the first `limit` rows over the supplier
// sections, each row still under its own heading; a section with no row
// left is dropped.
export function previewSupplierSections(sections: readonly AlertSupplierSection[], limit: number): AlertSupplierSection[] {
  let left = limit;
  return sections.flatMap((section) => {
    if (left <= 0) return [];
    const items = section.items.slice(0, left);
    left -= items.length;
    return items.length > 0 ? [{ group: section.group, items }] : [];
  });
}

// Översiktens Att bevaka: one row per kind with its count, under the same
// area headings as the page; a row opens the kind on Aviseringar. count null
// = the kind could not be read.
export interface AttentionKindRow {
  kind: AlertKind;
  label: string;
  count: number | null;
  tone: AlertSeverity;
  href: string;
}
export interface AttentionSection {
  area: AlertArea;
  label: string;
  rows: AttentionKindRow[];
}

export function attentionSections(groups: readonly AlertGroup[]): AttentionSection[] {
  return alertAreaSections(groups).map((section) => ({
    area: section.area,
    label: section.label,
    rows: section.groups.map((g) => ({
      kind: g.kind,
      label: g.label,
      count: g.error ? null : g.count,
      tone: alertGroupTone(g),
      href: `/aviseringar#${alertKindAnchor(g.kind)}`,
    })),
  }));
}
