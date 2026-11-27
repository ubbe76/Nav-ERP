// Leveransläget in the kundorder list — the mark beside the status pill
// (web-delivery-risk.test.ts). The API decides (GET /sales-orders'
// deliveryOutlook, the same derivation as the card's); the words are the
// card's own (lib/deliveryOutlook.ts) and the CSV column's
// (salesOrderOutlookText in packages/shared/src/sales.ts).
import { COMPONENT_LATE_LABEL, outlookLabel, outlookTone, type OutlookTone } from "./deliveryOutlook";
import type { SalesOrderListOutlook } from "./types";

// The kundorder list's filter value (DELIVERY_RISK_FILTER in shared list.ts)
// and its chip.
export const DELIVERY_RISK_FILTER = "delivery_risk";
export const DELIVERY_RISK_LABEL = "Leverans i fara";

// null = nothing to show: no outlook (a quote, a closed order) or on time —
// the list marks only what needs a look. An order that is not late itself
// but at risk is so through Halvfabrikat sent.
export function listOutlookMark(outlook: SalesOrderListOutlook | null | undefined): { label: string; tone: OutlookTone } | null {
  if (!outlook) return null;
  if (outlook.status === "late" || outlook.status === "uncovered") return { label: outlookLabel(outlook), tone: outlookTone(outlook) };
  if (outlook.atRisk) return { label: COMPONENT_LATE_LABEL, tone: "delayed" };
  if (outlook.status === "undated") return { label: outlookLabel(outlook), tone: outlookTone(outlook) };
  return null;
}

// The words of every outlook, also I tid — the CSV column's text.
export function listOutlookText(outlook: SalesOrderListOutlook | null | undefined): string {
  if (!outlook) return "";
  return listOutlookMark(outlook)?.label ?? outlookLabel(outlook);
}
