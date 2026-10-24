import { z } from "zod";
import type { VatBoxSetting } from "./economy.js";
import { isVatRate, type VatRate } from "./vat.js";

// Momskoder (bokföringsgranskningen etapp 1). A VAT code says how a document
// row is taxed: its rate, which accounts it posts to — and therefore which
// declaration boxes the amounts land in — and the text an invoice must carry.
// The CODES are a fixed catalog here, like the alert kinds: the law decides
// which exist. What is the company's own (account numbers, invoice text,
// active) lives in the vat_codes table, one row per catalog code, seeded by
// migration 0142. The VAT report keeps reading the ACCOUNTS' momsruta, never
// the documents — the code is only the way to the right account.
//
// Mirrored in apps/web/lib/vatCodes.ts (the web cannot import @navet/shared),
// kept in sync by vat-codes.shared.test.ts.

export const VAT_CODES = [
  "MP25",
  "MP12",
  "MP6",
  "MF",
  "EUV",
  "EUT",
  "EXV",
  "EXT",
  "OB",
  "IEUV25",
  "IEUV12",
  "IEUV6",
  "IEUT",
  "IUTT",
  "IOBV",
  "IOBT",
  "IUTV",
  "IMP25",
  "IMP12",
  "IMP6",
] as const;
export type VatCode = (typeof VAT_CODES)[number];

export function isVatCode(value: string): value is VatCode {
  return (VAT_CODES as readonly string[]).includes(value);
}

// both = customer and supplier invoices, sales = customer invoices only,
// purchase = supplier invoices only, import = the importmoms posting only.
export const VAT_CODE_DIRECTIONS = ["both", "sales", "purchase", "import"] as const;
export type VatCodeDirection = (typeof VAT_CODE_DIRECTIONS)[number];

// What the poster does with a row carrying the code:
//   domestic         — svensk moms (or momsfri): revenue/cost by konteringsregel,
//                      the document's own VAT on the code's VAT account
//   eu_sale          — EU-försäljning, no VAT, revenue on the code's account
//   export           — export, no VAT
//   reverse_sale     — omvänd betalningsskyldighet in Sweden (the buyer pays)
//   reverse_purchase — omvänd moms on a purchase: VAT computed and booked
//                      both as utgående and ingående
//   non_eu_goods     — goods from outside the EU: no VAT on the invoice, the
//                      importmoms is its own event (tullbeslutet)
//   import           — importmoms on the tax base from the customs decision
export const VAT_CODE_KINDS = [
  "domestic",
  "eu_sale",
  "export",
  "reverse_sale",
  "reverse_purchase",
  "non_eu_goods",
  "import",
] as const;
export type VatCodeKind = (typeof VAT_CODE_KINDS)[number];

// Account slots a code can use. A code uses exactly the slots its catalog
// entry lists; the vat_codes service refuses an account for any other slot.
export const VAT_CODE_SLOTS = ["revenue", "outputVat", "inputVat", "cost", "base", "baseCounter"] as const;
export type VatCodeSlot = (typeof VAT_CODE_SLOTS)[number];

// Default account number per slot and the momsruta that account is expected
// to carry — what the VAT report's warnings and the Momskoder page compare
// against. "none" = deliberately no box (the import base's counter account).
export type VatCodeSlotDefault = { account: string; box: VatBoxSetting };

export type VatCodeCatalogEntry = {
  code: VatCode;
  label: string;
  direction: VatCodeDirection;
  kind: VatCodeKind;
  rate: VatRate;
  slots: Partial<Record<VatCodeSlot, VatCodeSlotDefault>>;
  invoiceText: string | null;
  // EU sales and omvänd betalningsskyldighet: the buyer's momsregistrerings-
  // nummer must be on the invoice (ML 17 kap. 24 §).
  requiresBuyerVatNumber: boolean;
};

const slot = (account: string, box: VatBoxSetting): VatCodeSlotDefault => ({ account, box });

// Account numbers follow BAS 2026. Two deviations from the BAS 2025 era the
// design started from: BAS 2026 has no 2617, so domestic omvänd moms uses the
// general 2614 (both land in ruta 30), and no 4549 — the import base's counter
// account keeps the long-established 4549 "Motkonto beskattningsunderlag
// import" in the free 454x range (migration 0142 adds it when missing).
export const VAT_CODE_CATALOG: readonly VatCodeCatalogEntry[] = [
  {
    code: "MP25",
    label: "Moms 25 %",
    direction: "both",
    kind: "domestic",
    rate: 25,
    slots: { revenue: slot("3001", "05"), outputVat: slot("2610", "10"), inputVat: slot("2640", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "MP12",
    label: "Moms 12 %",
    direction: "both",
    kind: "domestic",
    rate: 12,
    slots: { revenue: slot("3002", "05"), outputVat: slot("2620", "11"), inputVat: slot("2640", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "MP6",
    label: "Moms 6 %",
    direction: "both",
    kind: "domestic",
    rate: 6,
    slots: { revenue: slot("3003", "05"), outputVat: slot("2630", "12"), inputVat: slot("2640", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "MF",
    label: "Momsfri",
    direction: "both",
    kind: "domestic",
    rate: 0,
    slots: { revenue: slot("3004", "42") },
    invoiceText: "Momsfri omsättning",
    requiresBuyerVatNumber: false,
  },
  {
    code: "EUV",
    label: "Varor till annat EU-land",
    direction: "sales",
    kind: "eu_sale",
    rate: 0,
    slots: { revenue: slot("3108", "35") },
    invoiceText: "Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)",
    requiresBuyerVatNumber: true,
  },
  {
    code: "EUT",
    label: "Tjänster till annat EU-land",
    direction: "sales",
    kind: "eu_sale",
    rate: 0,
    slots: { revenue: slot("3308", "39") },
    invoiceText: "Omvänd betalningsskyldighet (artikel 196 i mervärdesskattedirektivet)",
    requiresBuyerVatNumber: true,
  },
  {
    code: "EXV",
    label: "Export av varor",
    direction: "sales",
    kind: "export",
    rate: 0,
    slots: { revenue: slot("3105", "36") },
    invoiceText: "Export av varor, undantagen från moms (artikel 146 i mervärdesskattedirektivet)",
    requiresBuyerVatNumber: false,
  },
  {
    code: "EXT",
    label: "Tjänster till land utanför EU",
    direction: "sales",
    kind: "export",
    rate: 0,
    slots: { revenue: slot("3305", "40") },
    invoiceText: "Tjänsten är omsatt utanför Sverige",
    requiresBuyerVatNumber: false,
  },
  {
    code: "OB",
    label: "Omvänd betalningsskyldighet, Sverige",
    direction: "sales",
    kind: "reverse_sale",
    rate: 0,
    slots: { revenue: slot("3231", "41") },
    invoiceText: "Omvänd betalningsskyldighet",
    requiresBuyerVatNumber: true,
  },
  {
    code: "IEUV25",
    label: "Inköp varor från EU 25 %",
    direction: "purchase",
    kind: "reverse_purchase",
    rate: 25,
    slots: { cost: slot("4515", "20"), outputVat: slot("2614", "30"), inputVat: slot("2645", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IEUV12",
    label: "Inköp varor från EU 12 %",
    direction: "purchase",
    kind: "reverse_purchase",
    rate: 12,
    slots: { cost: slot("4516", "20"), outputVat: slot("2624", "31"), inputVat: slot("2645", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IEUV6",
    label: "Inköp varor från EU 6 %",
    direction: "purchase",
    kind: "reverse_purchase",
    rate: 6,
    slots: { cost: slot("4517", "20"), outputVat: slot("2634", "32"), inputVat: slot("2645", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IEUT",
    label: "Inköp tjänster från EU 25 %",
    direction: "purchase",
    kind: "reverse_purchase",
    rate: 25,
    slots: { cost: slot("4535", "21"), outputVat: slot("2614", "30"), inputVat: slot("2645", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IUTT",
    label: "Inköp tjänster utanför EU 25 %",
    direction: "purchase",
    kind: "reverse_purchase",
    rate: 25,
    slots: { cost: slot("4531", "22"), outputVat: slot("2614", "30"), inputVat: slot("2645", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IOBV",
    label: "Inköp varor i Sverige, omvänd betalningsskyldighet",
    direction: "purchase",
    kind: "reverse_purchase",
    rate: 25,
    slots: { cost: slot("4415", "23"), outputVat: slot("2614", "30"), inputVat: slot("2647", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IOBT",
    label: "Inköp tjänster i Sverige, omvänd betalningsskyldighet",
    direction: "purchase",
    kind: "reverse_purchase",
    rate: 25,
    slots: { cost: slot("4425", "24"), outputVat: slot("2614", "30"), inputVat: slot("2647", "48") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IUTV",
    label: "Inköp varor utanför EU (importmoms separat)",
    direction: "purchase",
    kind: "non_eu_goods",
    rate: 0,
    slots: {},
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IMP25",
    label: "Importmoms 25 %",
    direction: "import",
    kind: "import",
    rate: 25,
    slots: {
      base: slot("4545", "50"),
      baseCounter: slot("4549", "none"),
      outputVat: slot("2615", "60"),
      inputVat: slot("2645", "48"),
    },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IMP12",
    label: "Importmoms 12 %",
    direction: "import",
    kind: "import",
    rate: 12,
    slots: {
      base: slot("4546", "50"),
      baseCounter: slot("4549", "none"),
      outputVat: slot("2625", "61"),
      inputVat: slot("2645", "48"),
    },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
  {
    code: "IMP6",
    label: "Importmoms 6 %",
    direction: "import",
    kind: "import",
    rate: 6,
    slots: {
      base: slot("4547", "50"),
      baseCounter: slot("4549", "none"),
      outputVat: slot("2635", "62"),
      inputVat: slot("2645", "48"),
    },
    invoiceText: null,
    requiresBuyerVatNumber: false,
  },
];

const CATALOG_BY_CODE = new Map(VAT_CODE_CATALOG.map((entry) => [entry.code, entry] as const));

export function vatCodeEntry(code: VatCode): VatCodeCatalogEntry {
  // Total over the VatCode union: the catalog lists every code exactly once
  // (vat-codes.shared.test.ts).
  return CATALOG_BY_CODE.get(code)!;
}

export function vatCodeUsesSlot(code: VatCode, slotName: VatCodeSlot): boolean {
  return vatCodeEntry(code).slots[slotName] !== undefined;
}

// Svensk moms and momsfritt — the only codes a konteringsregel for "Alla
// momskoder" applies to (a catch-all rule sending a group to a 05 account
// must never silently take an EU sale that belongs in ruta 35).
export const DOMESTIC_VAT_CODES = ["MP25", "MP12", "MP6", "MF"] as const satisfies readonly VatCode[];
export type DomesticVatCode = (typeof DOMESTIC_VAT_CODES)[number];

export function isDomesticVatCode(code: VatCode): code is DomesticVatCode {
  return (DOMESTIC_VAT_CODES as readonly string[]).includes(code);
}

// Which codes a konteringsregel for "Alla momskoder" applies to: the domestic
// ones, plus goods from outside the EU — IUTV posts no VAT and its cost
// account carries no box, so a catch-all cost rule cannot misplace anything.
export function vatCodeTakesCatchAllRule(code: VatCode): boolean {
  const { kind } = vatCodeEntry(code);
  return kind === "domestic" || kind === "non_eu_goods";
}

// The domestic code for a Swedish rate — how a bare vatRate (an article's
// rate, an integration still sending vatRate, migration 0142's backfill)
// translates to a code.
export function domesticVatCodeForRate(rate: VatRate): DomesticVatCode {
  switch (rate) {
    case 25:
      return "MP25";
    case 12:
      return "MP12";
    case 6:
      return "MP6";
    case 0:
      return "MF";
  }
}

export function vatCodeAllowedOn(code: VatCode, document: "sales" | "purchase" | "import"): boolean {
  const { direction } = vatCodeEntry(code);
  if (document === "import") return direction === "import";
  return direction === "both" || direction === document;
}

// Omvänd moms: what the buyer computes and books as both utgående and
// ingående moms. Rounded half away from zero to öre, so a supplier credit
// note computes the exact mirror of the invoice it reverses.
export function computedVatAmount(base: number, rate: number): number {
  // |base| × rate is the VAT in öre (kr × % / 100 × 100).
  const magnitude = Math.round(Math.abs(base) * rate + 1e-9) / 100;
  return base < 0 ? -magnitude : magnitude;
}

// Förhandsvisning av beräknad (omvänd) moms on a supplier invoice — the ONE
// implementation the poster books and the invoice card shows. The header's
// code covers every row without a code of its own and the remainder (net −
// row total, freight/fees typed only into the header). One entry per reverse
// code in catalog order; codes without reverse VAT are left out.
export type ReverseVatPreviewInput = {
  headerCode: VatCode;
  netAmount: number;
  rows: { code: VatCode | null; lineAmount: number }[];
};
export type ReverseVatPreviewLine = { code: VatCode; base: number; vat: number };

export function reverseVatPreview(input: ReverseVatPreviewInput): ReverseVatPreviewLine[] {
  const baseByCode = new Map<VatCode, number>();
  const add = (code: VatCode, amount: number) =>
    baseByCode.set(code, Math.round(((baseByCode.get(code) ?? 0) + amount) * 100) / 100);
  let rowTotal = 0;
  for (const row of input.rows) {
    add(row.code ?? input.headerCode, row.lineAmount);
    rowTotal += row.lineAmount;
  }
  const remainder = Math.round((input.netAmount - rowTotal) * 100) / 100;
  if (remainder !== 0) add(input.headerCode, remainder);

  return VAT_CODE_CATALOG.flatMap((entry) => {
    if (entry.kind !== "reverse_purchase") return [];
    const base = baseByCode.get(entry.code);
    if (base === undefined || base === 0) return [];
    return [{ code: entry.code, base, vat: computedVatAmount(base, entry.rate) }];
  });
}

// The 27 EU member states (ISO 3166-1 alpha-2; Greece is GR as a country
// code but EL as a VAT number prefix — vatNumberPrefix).
export const EU_COUNTRY_CODES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
] as const;
export type EuCountryCode = (typeof EU_COUNTRY_CODES)[number];

export function isEuCountry(country: string): boolean {
  return (EU_COUNTRY_CODES as readonly string[]).includes(country.toUpperCase());
}

export function vatNumberPrefix(country: string): string {
  const upper = country.toUpperCase();
  return upper === "GR" ? "EL" : upper;
}

// --- Försäljningens momskod (spec 4.1) ---
//
// salesVatCode is the ONE implementation of which momskod a sales row gets
// by default: the invoice rows (create, addRow, credit, samlingsfaktura,
// fraktrader), the quote/order confirmation PDFs and the customer card all
// call it. The user can always pick another code on the invoice row.

// The customer facts the derivation reads. `country` is the customer's own
// country (customers.country), never the invoice address's.
export type SalesVatCustomer = {
  country: string;
  vatNumber: string | null;
  privatePerson: boolean;
  reverseChargeConstruction: boolean;
};

export function hasVatNumber(vatNumber: string | null | undefined): boolean {
  return (vatNumber ?? "").trim() !== "";
}

// Goods or service for the derivation: an article that is not a service is
// goods, so is the freight article (frakt följer varuleveransen) and a free
// row without an article.
export function salesRowIsGoods(row: {
  articleId: string | null;
  articleType: string | null;
  freightArticleId: string | null;
}): boolean {
  if (row.articleId === null) return true;
  if (row.freightArticleId !== null && row.articleId === row.freightArticleId) return true;
  return row.articleType !== "service";
}

// The article's own (domestic) code — a rate outside the Swedish set falls
// back to MP25 (articles.vat_rate is enum-locked, so only legacy data could).
function articleDomesticCode(articleRate: number): DomesticVatCode {
  return domesticVatCodeForRate(isVatRate(articleRate) ? articleRate : 25);
}

export function salesVatCode(input: { customer: SalesVatCustomer; isGoods: boolean; articleRate: number }): VatCode {
  const { customer, isGoods } = input;
  const domestic = articleDomesticCode(input.articleRate);
  const country = customer.country.trim().toUpperCase();
  // 1. Privatperson: goods leaving the EU are exempt whoever buys them
  //    (export, artikel 146 i mervärdesskattedirektivet) ⇒ EXV; a service to
  //    a private person outside the EU, and anything to a private person in
  //    the EU (Sweden included), is svensk moms — distansförsäljning/OSS is
  //    not part of etapp 1, the customer card warns instead.
  if (customer.privatePerson) return isGoods && !isEuCountry(country) ? "EXV" : domestic;
  // 2. Sweden: svensk moms, except a service to a customer with omvänd
  //    betalningsskyldighet för byggtjänster.
  if (country === "SE") return customer.reverseChargeConstruction && !isGoods ? "OB" : domestic;
  // 3. Another EU country: without a momsregistreringsnummer svensk moms is
  //    charged (the card warns).
  if (isEuCountry(country)) {
    if (!hasVatNumber(customer.vatNumber)) return domestic;
    return isGoods ? "EUV" : "EUT";
  }
  // 4. Outside the EU.
  return isGoods ? "EXV" : "EXT";
}

// Momsbehandling on the customer card (spec 4.6) — the same rules as
// salesVatCode, said about the customer instead of a row.
export const CUSTOMER_VAT_TREATMENTS = [
  "domestic",
  "domestic_no_vat_number",
  "eu",
  "export",
  "private_eu",
  "private_export",
] as const;
export type CustomerVatTreatment = (typeof CUSTOMER_VAT_TREATMENTS)[number];

export const CUSTOMER_VAT_TREATMENT_LABELS: Record<CustomerVatTreatment, string> = {
  domestic: "Svensk moms",
  domestic_no_vat_number: "Svensk moms (saknar momsnummer)",
  eu: "EU — utan moms",
  export: "Export — utan moms",
  private_eu: "Privatperson i annat EU-land — svensk moms",
  private_export: "Privatperson utanför EU — export utan moms för varor",
};

export function customerVatTreatment(customer: SalesVatCustomer): CustomerVatTreatment {
  const country = customer.country.trim().toUpperCase();
  if (customer.privatePerson) {
    if (country === "SE") return "domestic";
    return isEuCountry(country) ? "private_eu" : "private_export";
  }
  if (country === "SE") return "domestic";
  if (isEuCountry(country)) return hasVatNumber(customer.vatNumber) ? "eu" : "domestic_no_vat_number";
  return "export";
}

// Leverantörens förvalda momskod when the supplier has none of its own
// (spec 5): Sweden ⇒ svensk moms 25 %, another EU country ⇒ omvänd moms on
// EU goods, outside the EU ⇒ goods with the importmoms booked separately.
export function supplierDefaultVatCode(country: string): "MP25" | "IEUV25" | "IUTV" {
  const upper = country.trim().toUpperCase();
  if (upper === "SE") return "MP25";
  return isEuCountry(upper) ? "IEUV25" : "IUTV";
}

// A momsregistreringsnummer as compared and reported: upper case, letters
// and digits only ("de 123.456.789" ⇒ "DE123456789"). Deliberately no prefix
// is added here — the invoice must carry the buyer's number WITH its country
// prefix (Utfärda refuses it otherwise); the periodisk sammanställning adds
// a missing prefix itself when summing old invoices.
export function normalizeVatNumber(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// The VAT number prefixes of the OTHER member states (Greece EL).
const FOREIGN_EU_VAT_PREFIXES: readonly string[] = EU_COUNTRY_CODES.filter((country) => country !== "SE").map(vatNumberPrefix);
const FOREIGN_EU_VAT_NUMBER = new RegExp(`^(${FOREIGN_EU_VAT_PREFIXES.join("|")})[A-Z0-9]{2,12}$`);

// The member-state prefix of a (normalized) number that is a well-formed VAT
// number of ANOTHER member state than Sweden, else null.
function foreignEuVatPrefix(normalized: string): string | null {
  return FOREIGN_EU_VAT_NUMBER.test(normalized) ? normalized.slice(0, 2) : null;
}

// Utfärda (spec 4.2): codes that require the buyer's momsregistreringsnummer
// (EU sales, omvänd betalningsskyldighet) need one on the invoice, in the
// right form — EU: a VAT number of ANOTHER member state than Sweden (any of
// them: artikel 138 asks for the buyer's number from another member state,
// not necessarily the one of the buyer's address; a prefix that differs from
// the customer's country is only a warning, buyerVatNumberWarning), OB: SE +
// ten digits + 01. null = in order. `country` is the customer's own country;
// `prefix` on eu_format is the prefix the customer's own country would have
// (null when the customer is not in another member state) — the hint the
// refusal texts give.
export type BuyerVatNumberProblem =
  | { reason: "missing"; code: VatCode }
  | { reason: "eu_format"; code: VatCode; prefix: string | null }
  | { reason: "ob_format"; code: VatCode };

export function buyerVatNumberProblem(input: {
  codes: readonly VatCode[];
  vatNumber: string | null;
  country: string;
}): BuyerVatNumberProblem | null {
  const requiring = VAT_CODE_CATALOG.filter((entry) => entry.requiresBuyerVatNumber && input.codes.includes(entry.code));
  if (requiring.length === 0) return null;
  const number = normalizeVatNumber(input.vatNumber);
  if (number === "") return { reason: "missing", code: requiring[0]!.code };
  const country = input.country.trim().toUpperCase();
  for (const entry of requiring) {
    if (entry.kind === "eu_sale") {
      if (foreignEuVatPrefix(number) === null) {
        const prefix = country !== "SE" && isEuCountry(country) ? vatNumberPrefix(country) : null;
        return { reason: "eu_format", code: entry.code, prefix };
      }
    } else if (!/^SE\d{10}01$/.test(number)) {
      return { reason: "ob_format", code: entry.code };
    }
  }
  return null;
}

// The warning that goes with an accepted EU-sale number (never a refusal):
// the number is another member state's, but not the one of the customer's
// own country — allowed (artikel 138), worth a second look.
export type BuyerVatNumberWarning = {
  reason: "eu_country_mismatch";
  code: VatCode;
  // The number's prefix and the one the customer's country would have.
  prefix: string;
  expectedPrefix: string;
};

export function buyerVatNumberWarning(input: {
  codes: readonly VatCode[];
  vatNumber: string | null;
  country: string;
}): BuyerVatNumberWarning | null {
  const euSale = VAT_CODE_CATALOG.find((entry) => entry.kind === "eu_sale" && input.codes.includes(entry.code));
  if (!euSale) return null;
  const prefix = foreignEuVatPrefix(normalizeVatNumber(input.vatNumber));
  const expectedPrefix = vatNumberPrefix(input.country.trim());
  if (prefix === null || prefix === expectedPrefix) return null;
  return { reason: "eu_country_mismatch", code: euSale.code, prefix, expectedPrefix };
}

// The customer card's warning about the momsregistreringsnummer of a company
// customer in another member state (Momsbehandling "EU — utan moms"): a
// number that is no other member state's (EU sales with it cannot be issued)
// or one of another member state than the customer's country (allowed, a
// warning). null = nothing to say, also for every other treatment.
export type CustomerVatNumberWarning =
  | { reason: "eu_format"; expectedPrefix: string }
  | { reason: "eu_country_mismatch"; prefix: string; expectedPrefix: string };

export function customerVatNumberWarning(customer: SalesVatCustomer): CustomerVatNumberWarning | null {
  if (customerVatTreatment(customer) !== "eu") return null;
  const expectedPrefix = vatNumberPrefix(customer.country.trim());
  const prefix = foreignEuVatPrefix(normalizeVatNumber(customer.vatNumber));
  if (prefix === null) return { reason: "eu_format", expectedPrefix };
  return prefix === expectedPrefix ? null : { reason: "eu_country_mismatch", prefix, expectedPrefix };
}

// --- API contracts ---

// "" resets the slot to the catalog's default account (the same convention
// as the posting_* settings); a slot the code does not use is refused by the
// service.
const vatCodeAccountField = z.union([z.literal(""), z.string().regex(/^[0-9]{4}$/, "Account number must be exactly 4 digits")]);

export const updateVatCodeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    // "" and null both clear the text (no text printed on the invoice).
    invoiceText: z
      .string()
      .trim()
      .max(255)
      .nullable()
      .optional()
      .transform((value) => (value === "" ? null : value)),
    active: z.boolean().optional(),
    revenueAccount: vatCodeAccountField.optional(),
    outputVatAccount: vatCodeAccountField.optional(),
    inputVatAccount: vatCodeAccountField.optional(),
    costAccount: vatCodeAccountField.optional(),
    baseAccount: vatCodeAccountField.optional(),
    baseCounterAccount: vatCodeAccountField.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateVatCodeInput = z.infer<typeof updateVatCodeSchema>;

// The account field per slot, in the order of VAT_CODE_SLOTS — shared by the
// service and the web's dialog.
export const VAT_CODE_ACCOUNT_FIELDS: Record<VatCodeSlot, keyof UpdateVatCodeInput & `${string}Account`> = {
  revenue: "revenueAccount",
  outputVat: "outputVatAccount",
  inputVat: "inputVatAccount",
  cost: "costAccount",
  base: "baseAccount",
  baseCounter: "baseCounterAccount",
};

// One slot of GET /vat-codes: the stored account, the catalog default and
// how the account looks in the chart. warning null = in order.
export type VatCodeAccountView = {
  slot: VatCodeSlot;
  accountNumber: string;
  defaultAccountNumber: string;
  expectedBox: VatBoxSetting;
  accountName: string | null;
  accountActive: boolean | null;
  actualBox: VatBoxSetting | null;
  warning: "missing" | "inactive" | "box_mismatch" | null;
};

export type VatCodeView = {
  id: string;
  code: VatCode;
  name: string;
  invoiceText: string | null;
  active: boolean;
  label: string;
  direction: VatCodeDirection;
  kind: VatCodeKind;
  rate: number;
  requiresBuyerVatNumber: boolean;
  defaultInvoiceText: string | null;
  accounts: VatCodeAccountView[];
  // Konteringsregler pointing at the code exactly.
  ruleCount: number;
};

// Importmoms (tullbeslutet): one row per rate on the customs decision. The
// tax base is tullvärde + tull + frakt till gränsen — never the supplier's
// invoice — so the posting is its own event.
export const importVatSchema = z.object({
  date: z.string().date(),
  description: z.string().trim().min(1).max(255),
  rows: z
    .array(
      z.object({
        vatCodeId: z.string().uuid(),
        taxBase: z.coerce.number().positive().max(999_999_999_999),
      })
    )
    .min(1)
    .max(20),
});
export type ImportVatInput = z.infer<typeof importVatSchema>;
