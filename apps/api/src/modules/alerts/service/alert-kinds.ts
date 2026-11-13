import { satisfiesRule, type AccessRule, type AlertArea, type AlertKind, type AlertSeverity, type Permission, type UserRole } from "@navet/shared";

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
  // among the reds. batch_expiry is the third such kind.
  severity: AlertSeverity;
  rule: AccessRule;
  // The web page that lists every row of the kind ("Öppna listan").
  listHref: string;
  // The heading the kind is grouped under on Aviseringar and in Att bevaka
  // (the menu where the matter is fixed — the admin-only kinds are System).
  area: AlertArea;
}

export const ALERT_KIND_CATALOG: readonly AlertKindDef[] = [
  { kind: "stock_negative", label: "Negativt saldo", severity: "red", rule: ["lager"], listHref: "/lager/saldon", area: "lager" },
  // Utgångna batcher (#8 etapp 2): batches with stock on places that are
  // not blocked whose utgångsdatum has passed (red) or is within N days
  // (yellow). "Öppna listan" is the batch register filtered on the same rows.
  {
    kind: "batch_expiry",
    label: "Utgångna batcher",
    severity: "red",
    rule: ["lager"],
    listHref: "/lager/sparbarhet?expiry=due",
    area: "lager",
  },
  {
    kind: "customer_invoice_overdue",
    label: "Förfallna kundfakturor",
    severity: "red",
    rule: ["forsaljning"],
    listHref: "/forsaljning/reskontra",
    area: "forsaljning",
  },
  {
    kind: "supplier_invoice_due",
    label: "Leverantörsfakturor att betala",
    severity: "red",
    rule: ["inkop"],
    listHref: "/inkop/reskontra",
    area: "inkop",
  },
  // Offerter att följa upp: expired (red) and expiring within N days (yellow).
  {
    kind: "quote_followup",
    label: "Offerter att följa upp",
    severity: "red",
    rule: ["forsaljning"],
    // Offerter (0138): quotes have their own list and card.
    listHref: "/forsaljning/offerter?status=quote",
    area: "forsaljning",
  },
  {
    kind: "einvoice_failed",
    label: "E-fakturor som inte gick fram",
    severity: "red",
    rule: ["forsaljning"],
    listHref: "/forsaljning/fakturor",
    area: "forsaljning",
  },
  // Mottagning: the reception job could not fetch received e-invoices at
  // the last run — System → E-faktura is an admin page.
  {
    kind: "einvoice_receive_failed",
    label: "E-fakturor kunde inte hämtas",
    severity: "red",
    rule: ["admin"],
    listHref: "/system/e-faktura",
    area: "system",
  },
  // The e-mail log is an admin page, so only administrators see this kind.
  {
    kind: "email_failed",
    label: "Utskick som misslyckades",
    severity: "red",
    rule: ["admin"],
    listHref: "/system/e-postlogg",
    area: "system",
  },
  // Tillägg: System → Tillägg is an admin page.
  {
    kind: "plugin_delivery_failed",
    label: "Tillägg som inte tar emot händelser",
    severity: "red",
    rule: ["admin"],
    listHref: "/system/tillagg",
    area: "system",
  },
  // Fakturaskanning: the e-mail box could not be read at the last run —
  // System → Fakturaskanning is an admin page.
  {
    kind: "invoice_scan_mail_failed",
    label: "E-postlådan för fakturor kunde inte läsas",
    severity: "red",
    rule: ["admin"],
    listHref: "/system/fakturaskanning",
    area: "system",
  },
  // Återkommande verifikat: a month the job could not create (locked
  // period, inactive account …) — fixed and retried with Kör nu.
  {
    kind: "recurring_verification_failed",
    label: "Återkommande verifikat som misslyckats",
    severity: "red",
    rule: ["ekonomi"],
    listHref: "/ekonomi/aterkommande-verifikat",
    area: "ekonomi",
  },
  {
    kind: "sales_order_late",
    label: "Försenade kundordrar",
    severity: "yellow",
    rule: ["forsaljning"],
    // Straight to the list filtered on Sen — the same rule (late-orders.ts).
    listHref: "/forsaljning/ordrar?status=late",
    area: "forsaljning",
  },
  {
    kind: "purchase_order_late",
    label: "Försenade inköpsordrar",
    severity: "yellow",
    rule: ["inkop"],
    listHref: "/inkop/ordrar?status=late",
    area: "inkop",
  },
  {
    kind: "manufacturing_order_late",
    label: "Sena tillverkningsordrar",
    severity: "yellow",
    rule: ["tillverkning"],
    listHref: "/tillverkning/ordrar?status=late",
    area: "tillverkning",
  },
  {
    kind: "purchase_needed",
    label: "Behöver beställas",
    severity: "yellow",
    rule: ["inkop"],
    listHref: "/tillverkning/behovsberakning",
    area: "inkop",
  },
  // Fakturaskanning: files in the Fakturainkorg still to review (new +
  // interpreted) — Att granska.
  {
    kind: "invoice_scans_pending",
    label: "Fakturor i inkorgen att granska",
    severity: "yellow",
    rule: ["inkop"],
    listHref: "/inkop/fakturainkorg",
    area: "inkop",
  },
  {
    kind: "manufacture_needed",
    label: "Behöver tillverkas",
    severity: "yellow",
    rule: ["tillverkning"],
    listHref: "/tillverkning/behovsberakning",
    area: "tillverkning",
  },
  // Bankavstämning: statement entries older than BANK_UNRECONCILED_DAYS
  // without a matching — a bookkeeping to-do, not an error.
  {
    kind: "bank_unreconciled",
    label: "Omatchade bankposter",
    severity: "yellow",
    rule: ["ekonomi"],
    listHref: "/ekonomi/bankavstamning",
    area: "ekonomi",
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
    area: "ekonomi",
  },
  // Kvalitet: open avvikelser whose Åtgärd senast has passed.
  {
    kind: "deviations_overdue",
    label: "Avvikelser som passerat Åtgärd senast",
    severity: "yellow",
    rule: ["kvalitet"],
    listHref: "/kvalitet/avvikelser?overdue=1",
    area: "kvalitet",
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
// Utgångna batcher: the utgångsdatum is the LAST usable day, so the batch is
// utgången (red) from the day after — the same comparison (isBatchExpired).
export const batchExpirySeverity = dueDateSeverity;
