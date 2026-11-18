// Rest som förslag i antalsfältet: one on/off per routine. A leaf like
// quote-settings.ts so the keys and the defaults live in one place. The
// defaults are the behaviour before the setting existed — Inleverans,
// Utleverans and Rapportera prefill the remaining amount, the stamp terminal
// leaves Antal OK empty — so an absent key changes nothing at deploy.
// apps/web/lib/restSuggestion.ts mirrors the defaults for a payload that
// lacks the fields (test/web-rest-suggestion.test.ts keeps them equal).
export const REST_SUGGEST_RECEIPT_KEY = "rest_suggest_receipt";
export const REST_SUGGEST_DELIVERY_KEY = "rest_suggest_delivery";
export const REST_SUGGEST_REPORT_KEY = "rest_suggest_report";
export const REST_SUGGEST_STAMP_KEY = "rest_suggest_stamp";

export const DEFAULT_REST_SUGGEST_RECEIPT = true;
export const DEFAULT_REST_SUGGEST_DELIVERY = true;
export const DEFAULT_REST_SUGGEST_REPORT = true;
export const DEFAULT_REST_SUGGEST_STAMP = false;

// Stored as "true"/"false"; anything else (absent, junk) is the default.
export function decodeRestSuggest(raw: string | null | undefined, fallback: boolean): boolean {
  return raw === "true" ? true : raw === "false" ? false : fallback;
}
