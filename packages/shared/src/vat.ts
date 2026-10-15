import { z } from "zod";

// Swedish VAT rates (moms) — the single source of truth since B5. A flat
// value list rather than a database register: the set is fixed by law and
// changes on a legislative timescale. If reverse charge/EU VAT ever arrives,
// a proper momskod register replaces this file — until then every consumer
// (article card, invoice rows, posting rules, the verification poster's
// account maps) derives from these exports. The web app keeps a hand-synced
// mirror in apps/web/lib/types.ts (Turbopack cannot import @navet/shared).
export const vatRates = [25, 12, 6, 0] as const;
export type VatRate = (typeof vatRates)[number];

export function isVatRate(value: number): value is VatRate {
  return (vatRates as readonly number[]).includes(value);
}

// Free (article-less) invoice rows fall back to the standard rate.
export const DEFAULT_VAT_RATE: VatRate = 25;

export const vatRateSchema = z.coerce
  .number()
  .refine(isVatRate, { message: "vatRate must be one of 25, 12, 6, 0" });

// Posting-rule / report variant. Coercion is kept (query params and form
// inputs arrive as strings), but a blank string is rejected rather than
// coerced: Number("") is 0, so a client sending vatRate: "" would otherwise
// silently create a valid 0 % rule instead of being told the field is
// missing. NaN fails z.coerce.number()'s own type check ("expected number,
// received nan"). The catch-all "all rates" rule is expressed as null, never
// as a blank string.
export const postingVatRateSchema = z
  .preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? Number.NaN : value),
    z.coerce.number()
  )
  .refine((rate) => isVatRate(rate), {
    message: "VAT rate must be one of 0, 6, 12 or 25",
  });
export type PostingVatRate = z.infer<typeof postingVatRateSchema>;
