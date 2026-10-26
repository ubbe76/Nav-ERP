import type { InvoiceScanRow } from "@navet/shared";
import { escapeRegExp } from "./rules-interpreter.js";

// Fakturaskanning — IO-matchningen (spec §3.6), only with Matcha mot
// inköpsorder. Pure: the service loads the matched supplier's received
// purchase orders and their rows.

export interface PurchaseOrderCandidate {
  id: string;
  orderNumber: string;
  // ISO timestamp — "the latest" among several candidates.
  createdAt: string;
  // Every row's received quantity is already invoiced (by live supplier
  // invoices).
  fullyInvoiced: boolean;
}

// Upper case letters and digits only — "IO-1005", "io 1005" and "IO1005"
// compare equal.
function canon(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// The order numbers the reference can mean: the number itself, and with or
// without the series prefix ("1005" ⇔ "IO-1005").
function referenceMatches(reference: string, orderNumber: string, prefix: string): boolean {
  const ref = canon(reference);
  if (ref === "") return false;
  const full = canon(orderNumber);
  if (ref === full) return true;
  if (prefix !== "" && orderNumber.toUpperCase().startsWith(prefix.toUpperCase())) {
    const numberPart = canon(orderNumber.slice(prefix.length));
    if (ref === numberPart) return true;
  }
  return false;
}

// Tokens in the text layer that look like a number in the series (the
// prefix, an optional hyphen or space, digits). A series without prefix is
// not searched — bare numbers are everywhere on an invoice.
export function purchaseOrderTokens(lines: string[], prefix: string): string[] {
  const letters = prefix.replace(/[-\s]+$/, "");
  if (letters === "") return [];
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(letters)}[-\\s]?(\\d+)(?![A-Za-z0-9])`, "gi");
  const tokens = new Set<string>();
  for (const line of lines) for (const m of line.matchAll(re)) tokens.add(`${letters}${m[1]}`);
  return [...tokens];
}

export interface PurchaseOrderMatch {
  purchaseOrderId: string;
  confidence: "high" | "low";
}

// A unique candidate on the reference (or the text's tokens) ⇒ high; several
// ⇒ low with the latest. No reference and no token, but exactly one
// received order that is not fully invoiced ⇒ low.
export function matchPurchaseOrder(input: {
  reference: string | null;
  tokens: string[];
  orders: PurchaseOrderCandidate[];
  prefix: string;
}): PurchaseOrderMatch | null {
  const latest = (orders: PurchaseOrderCandidate[]) => [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
  const wanted = [...(input.reference ? [input.reference] : []), ...input.tokens];
  if (wanted.length > 0) {
    const hits = input.orders.filter((o) => wanted.some((w) => referenceMatches(w, o.orderNumber, input.prefix)));
    if (hits.length === 1) return { purchaseOrderId: hits[0]!.id, confidence: "high" };
    if (hits.length > 1) return { purchaseOrderId: latest(hits).id, confidence: "low" };
  }
  if (input.reference === null && input.tokens.length === 0) {
    const open = input.orders.filter((o) => !o.fullyInvoiced);
    if (open.length === 1) return { purchaseOrderId: open[0]!.id, confidence: "low" };
  }
  return null;
}

export interface PurchaseOrderRowCandidate {
  id: string;
  articleId: string;
  articleNumber: string;
  // The supplier's own article number (article_suppliers) for this supplier.
  supplierArticleNumber: string | null;
  unitPrice: number;
  // Inlevererat ej fakturerat.
  openQuantity: number;
}

// Each invoice row against the order's rows, in the order (1) the supplier's
// article number, (2) our article number in the row text, (3) the one row
// with the same quantity and unit price (±1 %). A hit gives articleId +
// purchaseOrderRowId, high when the quantity fits within what is received
// and not yet invoiced. Each order row is matched at most once.
export function matchInvoiceRows(rows: InvoiceScanRow[], orderRows: PurchaseOrderRowCandidate[]): InvoiceScanRow[] {
  const used = new Set<string>();
  const free = () => orderRows.filter((r) => !used.has(r.id));
  return rows.map((row) => {
    let hit: PurchaseOrderRowCandidate | undefined;
    if (row.supplierArticleNumber) {
      const wanted = canon(row.supplierArticleNumber);
      hit = free().find((r) => r.supplierArticleNumber !== null && canon(r.supplierArticleNumber) === wanted);
    }
    if (!hit) {
      hit = free().find((r) =>
        new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(r.articleNumber)}(?![A-Za-z0-9])`, "i").test(row.description)
      );
    }
    if (!hit && row.quantity !== null && row.unitPrice !== null) {
      const same = free().filter(
        (r) =>
          Math.abs(r.openQuantity - row.quantity!) < 1e-9 &&
          r.unitPrice > 0 &&
          Math.abs(r.unitPrice - row.unitPrice!) <= r.unitPrice * 0.01
      );
      if (same.length === 1) hit = same[0];
    }
    if (!hit) return { ...row, articleId: null, purchaseOrderRowId: null, confidence: "low" as const };
    used.add(hit.id);
    const fits = row.quantity !== null && row.quantity <= hit.openQuantity + 1e-9;
    return { ...row, articleId: hit.articleId, purchaseOrderRowId: hit.id, confidence: fits ? ("high" as const) : ("low" as const) };
  });
}
