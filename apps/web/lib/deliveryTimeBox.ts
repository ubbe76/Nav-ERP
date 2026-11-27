import { formatDtcAlternativeSummary, type DeliveryTimeCheckRequest } from "./deliveryTimeCheck";
import { shortDate } from "./planning";
import type { DeliveryTimeCheckResult } from "./types";

// Pure parts of the Leveranstid box (offert, Ny offert, Ny kundorder): the
// key that decides when the estimate is recomputed, and the texts.

// A stable key of what the check depends on: the customer and the rows
// (article, quantity in base units, the configuration's choices). Row order,
// whitespace and object key order do not change it; null request = "".
export function estimateKey(request: DeliveryTimeCheckRequest | null): string {
  if (!request) return "";
  const rows = (request.rows ?? []).map((r) => {
    const selection = r.configuration?.selection ?? null;
    const choices = selection
      ? Object.keys(selection)
          .map((k) => [k.trim(), typeof selection[k] === "string" ? (selection[k] as string).trim() : selection[k]] as const)
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      : null;
    return JSON.stringify([r.articleId.trim(), Number(r.quantity), choices]);
  });
  rows.sort();
  return JSON.stringify([request.customerId?.trim() ?? null, request.salesOrderId?.trim() ?? null, rows]);
}

export interface EstimateLine {
  // The headline, e.g. "Tidigast leverans 12 dec (avsändning 10 dec)".
  text: string;
  // The extra line when alternative resources gave the date.
  alternative: string | null;
  // The date "Använd datumet" hands on (YYYY-MM-DD); null = nothing to use.
  date: string | null;
}

export const ESTIMATE_NO_DATE = "Ingen leveransdag inom två år";
export const ESTIMATE_CONFIGURE = "Konfigurera raden för att se leveranstiden";
export const ESTIMATE_COUNTING = "Räknar…";

export function estimateLine(result: DeliveryTimeCheckResult, withCustomer: boolean): EstimateLine {
  const date = result.deliveryDate;
  if (!date) return { text: ESTIMATE_NO_DATE, alternative: null, date: null };
  const text = withCustomer
    ? `Tidigast leverans ${shortDate(date)}${result.shipDate ? ` (avsändning ${shortDate(result.shipDate)})` : ""}`
    : `Tidigast avsändning ${shortDate(result.shipDate ?? date)}`;
  const alternative = result.usesAlternatives
    ? formatDtcAlternativeSummary(shortDate(date), result.ordinaryDeliveryDate ? shortDate(result.ordinaryDeliveryDate) : null)
    : null;
  return { text, alternative, date };
}

// The text for a failed check: a row that needs a configuration is a hint,
// not an error.
export function estimateErrorLine(code: string | undefined, message: string | null): string {
  return code === "configuration-required" ? ESTIMATE_CONFIGURE : (message ?? "Kunde inte räkna ut leveranstiden");
}
