// Momskod / VAT rate ⇒ Peppol VAT category (BT-151/BT-118, code list UNCL5305).
//
// Etapp 1 is Swedish trade only (spec, decision 1 and 3). Since the momskoder
// (bokföringsgranskningen etapp 1, spec 4.5) the row's CODE decides:
//   * MP25/MP12/MP6 ⇒ S (standard rated) — and ONLY 25/12/6 may be S for a
//     Swedish supplier (Peppol SE-R-006, fatal),
//   * MF ⇒ E (exempt) with the reason text BT-120 required by BR-E-10,
//   * OB (omvänd betalningsskyldighet, Sverige) ⇒ AE (reverse charge) with
//     BT-121 = VATEX-EU-AE (the CEF VATEX code "Reverse charge", only for
//     category AE — PEPPOL-EN16931-P0107) next to BT-120 = the code's invoice
//     text (BR-AE-10 asks for either; both together are allowed, its test is
//     presence only) and the buyer's VAT number (BR-AE-02).
// Every other code (EU sales, export) cannot occur in etapp 1 — foreign
// customers are refused before the document is built — and ubl-check refuses
// it for safety. A line without a code (documents built before the momskoder,
// the unit tests) falls back to the rate alone: 25/12/6 ⇒ S, 0 ⇒ E.
export type VatCategoryId = "S" | "E" | "AE";

export interface VatCategory {
  id: VatCategoryId;
  percent: number;
  // BT-120, only for E and AE.
  exemptionReason?: string;
  // BT-121 (CEF VATEX code list), only for AE.
  exemptionReasonCode?: string;
}

export const VAT_EXEMPTION_REASON = "Undantagen från mervärdesskatt";
// BT-120 for AE when the code has no invoice text of its own.
export const REVERSE_CHARGE_REASON = "Omvänd betalningsskyldighet";
// BT-121 for AE.
export const REVERSE_CHARGE_REASON_CODE = "VATEX-EU-AE";

export const STANDARD_RATED_PERCENTS: readonly number[] = [25, 12, 6];

// The momskoder an e-invoice may carry in etapp 1, with the rate each one
// must have.
const UBL_VAT_CODE_RATES: ReadonlyMap<string, number> = new Map([
  ["MP25", 25],
  ["MP12", 12],
  ["MP6", 6],
  ["MF", 0],
  ["OB", 0],
]);

export function vatCategoryFor(rate: number): VatCategory {
  if (STANDARD_RATED_PERCENTS.includes(rate)) return { id: "S", percent: rate };
  if (rate === 0) return { id: "E", percent: 0, exemptionReason: VAT_EXEMPTION_REASON };
  throw new Error(`Unsupported VAT rate ${rate} — ubl-check refuses it before the builder runs`);
}

export function isSupportedVatRate(rate: number): boolean {
  return rate === 0 || STANDARD_RATED_PERCENTS.includes(rate);
}

export function isSupportedVatCode(code: string): boolean {
  return UBL_VAT_CODE_RATES.has(code);
}

// A line's VAT facts as the builder and ubl-check read them.
export type LineVatFacts = { vatRate: number; vatCode?: string | null; vatExemptionText?: string | null };

// Whether the line's code (or, without one, its rate) can be expressed in
// Peppol BIS in etapp 1 — and the rate agrees with the code.
export function isSupportedLineVat(line: LineVatFacts): boolean {
  if (line.vatCode == null) return isSupportedVatRate(line.vatRate);
  return UBL_VAT_CODE_RATES.get(line.vatCode) === line.vatRate;
}

export function lineVatCategory(line: LineVatFacts): VatCategory {
  if (line.vatCode == null) return vatCategoryFor(line.vatRate);
  if (!isSupportedLineVat(line)) {
    throw new Error(`Unsupported VAT code ${line.vatCode} — ubl-check refuses it before the builder runs`);
  }
  if (line.vatCode === "OB") {
    return {
      id: "AE",
      percent: 0,
      exemptionReasonCode: REVERSE_CHARGE_REASON_CODE,
      exemptionReason: line.vatExemptionText?.trim() || REVERSE_CHARGE_REASON,
    };
  }
  return vatCategoryFor(line.vatRate);
}

// Subtotal order: highest rate first, then S → E → AE (one subtotal per
// category and rate, BR-CO-18 / BR-AE-01).
const CATEGORY_ORDER: Record<VatCategoryId, number> = { S: 0, E: 1, AE: 2 };

export function compareVatCategories(a: VatCategory, b: VatCategory): number {
  return b.percent - a.percent || CATEGORY_ORDER[a.id] - CATEGORY_ORDER[b.id];
}
