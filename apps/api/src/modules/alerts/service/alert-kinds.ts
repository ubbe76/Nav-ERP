import { satisfiesRule, type AccessRule, type AlertKind, type AlertSeverity, type Permission, type UserRole } from "@navet/shared";

// Aviseringar — the catalog. Pure (no DB imports): every kind's label,
// severity, permission and list page, in DISPLAY ORDER (red before yellow,
// the spec's table order within each colour). This is the only place a
// kind's permission is written down; the readers and the digest both go
// through visibleKinds.

export interface AlertKindDef {
  kind: AlertKind;
  label: string;
  // The kind's colour for ordering and for its rows. supplier_invoice_due
  // is the one kind whose rows differ: red once overdue, yellow while only
  // due soon (supplierInvoiceSeverity) — it sits among the reds.
  severity: AlertSeverity;
  rule: AccessRule;
  // The web page that lists every row of the kind ("Visa alla").
  listHref: string;
}

export const ALERT_KIND_CATALOG: readonly AlertKindDef[] = [
  { kind: "stock_negative", label: "Negativt saldo", severity: "red", rule: ["lager"], listHref: "/lager/saldon" },
  {
    kind: "customer_invoice_overdue",
    label: "Förfallna kundfakturor",
    severity: "red",
    rule: ["forsaljning"],
    listHref: "/forsaljning/reskontra",
  },
  {
    kind: "supplier_invoice_due",
    label: "Leverantörsfakturor att betala",
    severity: "red",
    rule: ["inkop"],
    listHref: "/inkop/reskontra",
  },
  {
    kind: "einvoice_failed",
    label: "E-fakturor som inte gick fram",
    severity: "red",
    rule: ["forsaljning"],
    listHref: "/forsaljning/fakturor",
  },
  // The e-mail log is an admin page, so only administrators see this kind.
  { kind: "email_failed", label: "Utskick som misslyckades", severity: "red", rule: ["admin"], listHref: "/system/e-postlogg" },
  {
    kind: "sales_order_late",
    label: "Försenade kundordrar",
    severity: "yellow",
    rule: ["forsaljning"],
    listHref: "/forsaljning/ordrar",
  },
  { kind: "purchase_order_late", label: "Försenade inköpsordrar", severity: "yellow", rule: ["inkop"], listHref: "/inkop/ordrar" },
  {
    kind: "manufacturing_order_late",
    label: "Sena tillverkningsordrar",
    severity: "yellow",
    rule: ["tillverkning"],
    listHref: "/tillverkning/ordrar",
  },
  {
    kind: "purchase_needed",
    label: "Behöver beställas",
    severity: "yellow",
    rule: ["inkop"],
    listHref: "/tillverkning/behovsberakning",
  },
  {
    kind: "manufacture_needed",
    label: "Behöver tillverkas",
    severity: "yellow",
    rule: ["tillverkning"],
    listHref: "/tillverkning/behovsberakning",
  },
];

const BY_KIND = new Map(ALERT_KIND_CATALOG.map((def) => [def.kind, def] as const));
const ORDER = new Map(ALERT_KIND_CATALOG.map((def, index) => [def.kind, index] as const));

export function alertKindDef(kind: AlertKind): AlertKindDef {
  return BY_KIND.get(kind)!;
}

export type AlertUser = { role: UserRole; permissions?: readonly Permission[] };

// The kinds this user may see, in display order. Admin sees everything
// (satisfiesRule lets admin through every rule, including ["admin"]).
export function visibleKinds(user: AlertUser): AlertKind[] {
  return ALERT_KIND_CATALOG.filter((def) => satisfiesRule(user, def.rule)).map((def) => def.kind);
}

// Catalog order, duplicates dropped.
export function sortKinds(kinds: readonly AlertKind[]): AlertKind[] {
  return [...new Set(kinds)].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
}

// Leverantörsfakturor att betala: red once the due date has passed, yellow
// while it is today or ahead.
export function supplierInvoiceSeverity(dueDate: string, today: string): AlertSeverity {
  return dueDate < today ? "red" : "yellow";
}
