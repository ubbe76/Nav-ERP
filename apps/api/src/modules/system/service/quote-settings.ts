import { decodeDaysSetting } from "./alert-settings.js";

// Offertens giltighetstid (dagar): a new quote's Giltig t.o.m. = today + N
// unless the caller sets the date itself; 0 = no validity date. A leaf like
// alert-settings.ts so the settings page and the sales service read the
// value the same way.
export const QUOTE_VALIDITY_DAYS_KEY = "quote_validity_days";
export const DEFAULT_QUOTE_VALIDITY_DAYS = 30;
export const MAX_QUOTE_VALIDITY_DAYS = 365;

export function decodeQuoteValidityDays(raw: string | null | undefined): number {
  return decodeDaysSetting(raw, DEFAULT_QUOTE_VALIDITY_DAYS, MAX_QUOTE_VALIDITY_DAYS);
}
