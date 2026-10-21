// VAT rate ⇒ Peppol VAT category (BT-151/BT-118, code list UNCL5305).
//
// Etapp 1 is Swedish domestic trade only (spec, decision 1 and 3): 25/12/6 %
// are category S (standard rated) — and ONLY those three may be S for a
// Swedish supplier (Peppol SE-R-006, fatal) — while 0 % is category E
// (exempt) with the reason text BT-120 required by BR-E-10. Reverse charge
// (AE), export (G) and intra-EU (K) are etapp 2 and would need a momskod
// register on the row; until then the rate alone decides.
export type VatCategoryId = "S" | "E";

export interface VatCategory {
  id: VatCategoryId;
  percent: number;
  // BT-120, only for E.
  exemptionReason?: string;
}

export const VAT_EXEMPTION_REASON = "Undantagen från mervärdesskatt";

export const STANDARD_RATED_PERCENTS: readonly number[] = [25, 12, 6];

export function vatCategoryFor(rate: number): VatCategory {
  if (STANDARD_RATED_PERCENTS.includes(rate)) return { id: "S", percent: rate };
  if (rate === 0) return { id: "E", percent: 0, exemptionReason: VAT_EXEMPTION_REASON };
  throw new Error(`Unsupported VAT rate ${rate} — ubl-check refuses it before the builder runs`);
}

export function isSupportedVatRate(rate: number): boolean {
  return rate === 0 || STANDARD_RATED_PERCENTS.includes(rate);
}
