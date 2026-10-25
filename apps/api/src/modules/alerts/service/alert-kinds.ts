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
  // and quote_followup are the kinds whose rows differ: red once the date
  // has passed, yellow while it is only near (dueDateSeverity) — they sit
  // among the reds.
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
  // Offerter att följa upp: expired (red) and expiring within N days (yellow).
  {
    kind: "quote_followup",
    label: "Offerter att följa upp",
    severity: "red",
    rule: ["forsaljning"],
    // Offerter (0138): quotes have their own list and card.
    listHref: "/forsaljning/offerter?status=quote",
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
  // Tillägg: System → Tillägg is an admin page.
  {
    kind: "plugin_delivery_failed",
    label: "Tillägg som inte tar emot händelser",
    severity: "red",
    rule: ["admin"],
    listHref: "/system/tillagg",
  },
  // Återkommande verifikat: a month the job could not create (locked
  // period, inactive account …) — fixed and retried with Kör nu.
  {
    kind: "recurring_verification_failed",
    label: "Återkommande verifikat som misslyckats",
    severity: "red",
    rule: ["ekonomi"],
    listHref: "/ekonomi/aterkommande-verifikat",
  },
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
  // Bankavstämning: statement entries older than BANK_UNRECONCILED_DAYS
  // without a matching — a bookkeeping to-do, not an error.
  {
    kind: "bank_unreconciled",
    label: "Omatchade bankposter",
    severity: "yellow",
    rule: ["ekonomi"],
    listHref: "/ekonomi/bankavstamning",
  },
  // Kostnadsställen och projekt: a booked row on an account with Kräver
  // kostnadsställe but without one — the automatkontering books anyway and
  // leaves it here (a manual booking is refused at Bokför).
  {
    kind: "cost_center_missing",
    label: "Bokningar utan kostnadsställe",
    severity: "yellow",
    rule: ["ekonomi"],
    listHref: "/ekonomi/verifikat",
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

// A dated row: red once the date has passed, yellow while it is today or
// ahead. Leverantörsfakturor att betala (due date) and Offerter att följa
// upp (Giltig t.o.m.) share it.
export function dueDateSeverity(date: string, today: string): AlertSeverity {
  return date < today ? "red" : "yellow";
}
export const supplierInvoiceSeverity = dueDateSeverity;
export const quoteFollowupSeverity = dueDateSeverity;
