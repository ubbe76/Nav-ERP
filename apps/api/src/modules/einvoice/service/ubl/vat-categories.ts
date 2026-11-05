// Momskod / VAT rate ⇒ Peppol VAT category (BT-151/BT-118, code list UNCL5305).
//
// The row's CODE decides (momskoder, bokföringsgranskningen etapp 1, spec
// 4.5; utländska kunder, spec 2026-11-05-e-faktura-utland-automatik):
//   * MP25/MP12/MP6 ⇒ S (standard rated) — and ONLY 25/12/6 may be S for a
//     Swedish supplier (Peppol SE-R-006, fatal),
//   * MF ⇒ E (exempt) with the reason text BT-120 required by BR-E-10,
//   * OB (omvänd betalningsskyldighet, Sverige) and EUT (tjänster till annat
//     EU-land, artikel 196) ⇒ AE (reverse charge) with BT-121 = VATEX-EU-AE,
//   * EUV (varor till annat EU-land, artikel 138) ⇒ K (intra-community
//     supply) with VATEX-EU-IC — BR-IC-11/12 then want a delivery date and
//     the deliver-to country, which the builder writes and ubl-check demands,
//   * EXV (export av varor, artikel 146) ⇒ G with VATEX-EU-G,
//   * EXT (tjänster till land utanför EU) ⇒ O (not subject to VAT) with
//     VATEX-EU-O — BR-O-11..14 forbid any other category on the same
//     invoice and BR-O-02 the seller's and buyer's VAT identifiers, so the
//     builder leaves those out and the service refuses a mixed invoice.
// A VATEX code may only stand next to its own category (PEPPOL-EN16931-
// P0104..P0107). BT-120 is the code's invoice text in the document's
// language (BR-AE-10/IC-10/G-10/O-10 accept a code OR a text; both are
// written). UTM (räntefakturans rader) has no category and is refused. A line
// without a code (documents built before the momskoder, the unit tests)
// falls back to the rate alone: 25/12/6 ⇒ S, 0 ⇒ E.
export type VatCategoryId = "S" | "E" | "AE" | "K" | "G" | "O";

export interface VatCategory {
  id: VatCategoryId;
  percent: number;
  // BT-120, only for the 0 % categories.
  exemptionReason?: string;
  // BT-121 (CEF VATEX code list), for AE, K, G and O.
  exemptionReasonCode?: string;
}

export type UblLanguage = "sv" | "en";

export const VAT_EXEMPTION_REASON = "Undantagen från mervärdesskatt";
const VAT_EXEMPTION_REASON_EN = "Exempt from VAT";
// BT-120 for AE when the code has no invoice text of its own.
export const REVERSE_CHARGE_REASON = "Omvänd betalningsskyldighet";
// BT-121 for AE.
export const REVERSE_CHARGE_REASON_CODE = "VATEX-EU-AE";

export const STANDARD_RATED_PERCENTS: readonly number[] = [25, 12, 6];

interface ZeroRatedCategory {
  id: "AE" | "K" | "G" | "O";
  reasonCode: string;
  // BT-120 when the momskod has no invoice text (the company blanked it).
  fallback: Record<UblLanguage, string>;
}

const ZERO_RATED: Record<string, ZeroRatedCategory> = {
  OB: { id: "AE", reasonCode: REVERSE_CHARGE_REASON_CODE, fallback: { sv: REVERSE_CHARGE_REASON, en: "Reverse charge" } },
  EUT: { id: "AE", reasonCode: REVERSE_CHARGE_REASON_CODE, fallback: { sv: REVERSE_CHARGE_REASON, en: "Reverse charge" } },
  EUV: { id: "K", reasonCode: "VATEX-EU-IC", fallback: { sv: "Unionsintern leverans", en: "Intra-Community supply" } },
  EXV: { id: "G", reasonCode: "VATEX-EU-G", fallback: { sv: "Export av varor", en: "Export outside the EU" } },
  EXT: { id: "O", reasonCode: "VATEX-EU-O", fallback: { sv: "Tjänsten är omsatt utanför Sverige", en: "Not subject to VAT" } },
};

// The momskoder an e-invoice may carry, with the rate each one must have.
const UBL_VAT_CODE_RATES: ReadonlyMap<string, number> = new Map([
  ["MP25", 25],
  ["MP12", 12],
  ["MP6", 6],
  ["MF", 0],
  ...Object.keys(ZERO_RATED).map((code) => [code, 0] as const),
]);

export function vatCategoryFor(rate: number, language: UblLanguage = "sv"): VatCategory {
  if (STANDARD_RATED_PERCENTS.includes(rate)) return { id: "S", percent: rate };
  if (rate === 0) return { id: "E", percent: 0, exemptionReason: language === "en" ? VAT_EXEMPTION_REASON_EN : VAT_EXEMPTION_REASON };
  throw new Error(`Unsupported VAT rate ${rate} — ubl-check refuses it before the builder runs`);
}

export function isSupportedVatRate(rate: number): boolean {
  return rate === 0 || STANDARD_RATED_PERCENTS.includes(rate);
}

export function isSupportedVatCode(code: string): boolean {
  return UBL_VAT_CODE_RATES.has(code);
}

// EXT ⇒ O, which Peppol never lets share an invoice with another category.
export function isOutOfScopeVatCode(code: string | null | undefined): boolean {
  return code != null && ZERO_RATED[code]?.id === "O";
}

// A line's VAT facts as the builder and ubl-check read them.
export type LineVatFacts = { vatRate: number; vatCode?: string | null; vatExemptionText?: string | null };

// Whether the line's code (or, without one, its rate) can be expressed in
// Peppol BIS — and the rate agrees with the code.
export function isSupportedLineVat(line: LineVatFacts): boolean {
  if (line.vatCode == null) return isSupportedVatRate(line.vatRate);
  return UBL_VAT_CODE_RATES.get(line.vatCode) === line.vatRate;
}

export function lineVatCategory(line: LineVatFacts, language: UblLanguage = "sv"): VatCategory {
  if (line.vatCode == null) return vatCategoryFor(line.vatRate, language);
  if (!isSupportedLineVat(line)) {
    throw new Error(`Unsupported VAT code ${line.vatCode} — ubl-check refuses it before the builder runs`);
  }
  const zeroRated = ZERO_RATED[line.vatCode];
  if (zeroRated) {
    return {
      id: zeroRated.id,
      percent: 0,
      exemptionReasonCode: zeroRated.reasonCode,
      exemptionReason: line.vatExemptionText?.trim() || zeroRated.fallback[language],
    };
  }
  return vatCategoryFor(line.vatRate, language);
}

// Subtotal order: highest rate first, then S → E → AE → K → G → O (one
// subtotal per category and rate, BR-CO-18 / BR-AE-01 / BR-IC-01 / BR-G-01).
const CATEGORY_ORDER: Record<VatCategoryId, number> = { S: 0, E: 1, AE: 2, K: 3, G: 4, O: 5 };

export function compareVatCategories(a: VatCategory, b: VatCategory): number {
  return b.percent - a.percent || CATEGORY_ORDER[a.id] - CATEGORY_ORDER[b.id];
}
