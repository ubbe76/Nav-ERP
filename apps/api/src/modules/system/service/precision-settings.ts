// Marginal i leveransprecisionen (#29): how Rapporter → Leveransprecision
// tells early, on time and late apart, one pair per side (kundordrar,
// inköpsordrar):
//
// - Sen efter (dagar): a delivery is late only when it comes MORE than this
//   many days after the promised date. 0 (the default when unset) = the day
//   after is late — the rule before the setting existed.
// - För tidig före (dagar): a delivery is early when it comes MORE than this
//   many days before the promised date. null (unset / empty) = off: every
//   delivery up to the late margin counts as on time, as before. 0 = any day
//   before the promised date is early.
//
// A leaf like quote-settings.ts, so the settings page and the report decode
// the keys the same way; junk decodes to the default.

export const PRECISION_MARGIN_KEYS = {
  salesLate: "precision_sales_late_margin_days",
  salesEarly: "precision_sales_early_margin_days",
  purchaseLate: "precision_purchase_late_margin_days",
  purchaseEarly: "precision_purchase_early_margin_days",
} as const;

export const MAX_PRECISION_MARGIN_DAYS = 365;

export interface PrecisionMargins {
  lateDays: number;
  earlyDays: number | null;
}

// The rule before #29 — and what a side decodes to with nothing stored.
export const NO_PRECISION_MARGINS: PrecisionMargins = { lateDays: 0, earlyDays: null };

function decodeMarginDays(raw: string | null | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PRECISION_MARGIN_DAYS ? parsed : null;
}

export function decodePrecisionMargins(get: (key: string) => string | null | undefined): {
  sales: PrecisionMargins;
  purchase: PrecisionMargins;
} {
  return {
    sales: {
      lateDays: decodeMarginDays(get(PRECISION_MARGIN_KEYS.salesLate)) ?? 0,
      earlyDays: decodeMarginDays(get(PRECISION_MARGIN_KEYS.salesEarly)),
    },
    purchase: {
      lateDays: decodeMarginDays(get(PRECISION_MARGIN_KEYS.purchaseLate)) ?? 0,
      earlyDays: decodeMarginDays(get(PRECISION_MARGIN_KEYS.purchaseEarly)),
    },
  };
}
