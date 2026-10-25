import type { VatBoxSetting } from "./vatBoxes";

// Mirror of @navet/shared's momskod catalog (packages/shared/src/vat-codes.ts) —
// the web cannot import @navet/shared (Turbopack vs .js-suffix imports). Kept
// in sync by apps/api/test/vat-codes.shared.test.ts, which compares the
// catalog, the helpers and the lists below with the shared originals.
//
// A momskod says how a document row is taxed: its rate, which accounts it
// posts to (and therefore which declaration boxes the amounts land in) and
// the text an invoice must carry. The codes are a fixed catalog; what is the
// company's own (account numbers, invoice text, active) comes from
// GET /vat-codes (VatCodeView below).

export type VatRate = 25 | 12 | 6 | 0;

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
  "UTM",
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

export const VAT_CODE_DIRECTIONS = ["both", "sales", "purchase", "import"] as const;
export type VatCodeDirection = (typeof VAT_CODE_DIRECTIONS)[number];

export const VAT_CODE_KINDS = [
  "domestic",
  "eu_sale",
  "export",
  "reverse_sale",
  "reverse_purchase",
  "non_eu_goods",
  "import",
  "out_of_scope",
] as const;
export type VatCodeKind = (typeof VAT_CODE_KINDS)[number];

export const VAT_CODE_SLOTS = ["revenue", "outputVat", "inputVat", "cost", "base", "baseCounter"] as const;
export type VatCodeSlot = (typeof VAT_CODE_SLOTS)[number];

export type VatCodeSlotDefault = { account: string; box: VatBoxSetting };

export type VatCodeCatalogEntry = {
  code: VatCode;
  label: string;
  direction: VatCodeDirection;
  kind: VatCodeKind;
  rate: VatRate;
  slots: Partial<Record<VatCodeSlot, VatCodeSlotDefault>>;
  invoiceText: string | null;
  requiresBuyerVatNumber: boolean;
};

const slot = (account: string, box: VatBoxSetting): VatCodeSlotDefault => ({ account, box });

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
    // Dröjsmålsränta och förseningsersättning: the rows of a räntefaktura.
    code: "UTM",
    label: "Utanför momsens tillämpningsområde",
    direction: "sales",
    kind: "out_of_scope",
    rate: 0,
    slots: { revenue: slot("3990", "none") },
    invoiceText: null,
    requiresBuyerVatNumber: false,
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
  return CATALOG_BY_CODE.get(code)!;
}

export function vatCodeUsesSlot(code: VatCode, slotName: VatCodeSlot): boolean {
  return vatCodeEntry(code).slots[slotName] !== undefined;
}

export const DOMESTIC_VAT_CODES = ["MP25", "MP12", "MP6", "MF"] as const satisfies readonly VatCode[];
export type DomesticVatCode = (typeof DOMESTIC_VAT_CODES)[number];

export function isDomesticVatCode(code: VatCode): code is DomesticVatCode {
  return (DOMESTIC_VAT_CODES as readonly string[]).includes(code);
}

// Which codes a konteringsregel for "Alla momskoder" applies to: the domestic
// ones plus goods from outside the EU (IUTV posts no VAT and its cost account
// carries no box). Utrikes- and omvänd codes take their own account unless a
// rule exists for exactly that code.
export function vatCodeTakesCatchAllRule(code: VatCode): boolean {
  const { kind } = vatCodeEntry(code);
  return kind === "domestic" || kind === "non_eu_goods";
}

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

// Computed (omvänd) VAT, rounded half away from zero to öre — the same
// arithmetic the poster books, so the importmoms preview matches the verifikat.
export function computedVatAmount(base: number, rate: number): number {
  const magnitude = Math.round(Math.abs(base) * rate + 1e-9) / 100;
  return base < 0 ? -magnitude : magnitude;
}

export type ReverseVatPreviewInput = {
  headerCode: VatCode;
  netAmount: number;
  rows: { code: VatCode | null; lineAmount: number }[];
};
export type ReverseVatPreviewLine = { code: VatCode; base: number; vat: number };

// Förhandsvisning av beräknad (omvänd) moms on a supplier invoice — the same
// function the poster books.
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

// Greece is GR as a country code but EL as a VAT number prefix.
export function vatNumberPrefix(country: string): string {
  const upper = country.toUpperCase();
  return upper === "GR" ? "EL" : upper;
}

// --- Försäljningens momskod (spec 4.1) ---
//
// salesVatCode is the ONE implementation of which momskod a sales row gets by
// default — the invoice rows, the quote/order confirmation PDFs and the
// customer card all call the shared original; the web uses this mirror for
// the previews (the customer card's Momsbehandling, the default shown for a
// row that has no code of its own yet). The server always has the last word.

const VAT_RATE_VALUES: readonly number[] = [25, 12, 6, 0];

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

function articleDomesticCode(articleRate: number): DomesticVatCode {
  return domesticVatCodeForRate((VAT_RATE_VALUES.includes(articleRate) ? articleRate : 25) as VatRate);
}

export function salesVatCode(input: { customer: SalesVatCustomer; isGoods: boolean; articleRate: number }): VatCode {
  const { customer, isGoods } = input;
  const domestic = articleDomesticCode(input.articleRate);
  const country = customer.country.trim().toUpperCase();
  // A private person: goods leaving the EU are exempt whoever buys them
  // (export) ⇒ EXV; anything else is svensk moms.
  if (customer.privatePerson) return isGoods && !isEuCountry(country) ? "EXV" : domestic;
  if (country === "SE") return customer.reverseChargeConstruction && !isGoods ? "OB" : domestic;
  if (isEuCountry(country)) {
    if (!hasVatNumber(customer.vatNumber)) return domestic;
    return isGoods ? "EUV" : "EUT";
  }
  return isGoods ? "EXV" : "EXT";
}

// Momsbehandling on the customer card (spec 4.6).
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

// A momsregistreringsnummer as compared and reported: upper case, letters and
// digits only ("de 123.456.789" ⇒ "DE123456789").
export function normalizeVatNumber(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// The VAT number prefixes of the OTHER member states (Greece EL).
const FOREIGN_EU_VAT_PREFIXES: readonly string[] = EU_COUNTRY_CODES.filter((country) => country !== "SE").map(
  vatNumberPrefix
);
const FOREIGN_EU_VAT_NUMBER = new RegExp(`^(${FOREIGN_EU_VAT_PREFIXES.join("|")})[A-Z0-9]{2,12}$`);

// The member-state prefix of a (normalized) number that is a well-formed VAT
// number of ANOTHER member state than Sweden, else null.
function foreignEuVatPrefix(normalized: string): string | null {
  return FOREIGN_EU_VAT_NUMBER.test(normalized) ? normalized.slice(0, 2) : null;
}

// Utfärda (spec 4.2): codes that require the buyer's momsregistreringsnummer
// need one on the invoice, in the right form — EU: a VAT number of ANOTHER
// member state than Sweden (any of them; a prefix that differs from the
// customer's country is only a warning, buyerVatNumberWarning), OB: SE + ten
// digits + 01. null = in order. `prefix` on eu_format is the prefix the
// customer's own country would have (null when the customer is not in another
// member state).
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

// The sentence the invoice card warns with (drafts) — the same wording the
// API's 409 vat-number-required carries when Utfärda refuses.
export function buyerVatNumberProblemText(problem: BuyerVatNumberProblem): string {
  switch (problem.reason) {
    case "missing":
      return "Kunden saknar momsregistreringsnummer — fakturan kan inte utfärdas med EU-försäljning eller omvänd betalningsskyldighet.";
    case "eu_format":
      return problem.prefix
        ? `Kundens momsregistreringsnummer ska vara ett momsnummer från ett annat EU-land än Sverige, med landskoden först (till exempel ${problem.prefix}) — det krävs för EU-försäljning.`
        : "EU-försäljning kräver ett momsregistreringsnummer från ett annat EU-land än Sverige, med landskoden först.";
    case "ob_format":
      return "Kundens momsregistreringsnummer ska ha formen SE + tio siffror + 01 för omvänd betalningsskyldighet.";
  }
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

// The sentences the cards show for the two warnings.
export function buyerVatNumberWarningText(warning: BuyerVatNumberWarning | CustomerVatNumberWarning): string {
  if (warning.reason === "eu_format") {
    return `Momsnumret ser inte ut som ett momsnummer från ett annat EU-land än Sverige — det ska börja med landskoden (för kundens land ${warning.expectedPrefix}). Fakturor med EU-försäljning kan inte utfärdas förrän det är rättat.`;
  }
  return `Momsnumret har ett annat landsprefix (${warning.prefix}) än kundens land (${warning.expectedPrefix}) — kontrollera att det är rätt.`;
}

// A document row's/header's code as the detail GETs return it: the company's
// own name, the catalog's rate.
export type VatCodeRef = { id: string; code: string; name: string; rate: number };

// The PATCH /vat-codes/:id field per slot.
export const VAT_CODE_ACCOUNT_FIELDS = {
  revenue: "revenueAccount",
  outputVat: "outputVatAccount",
  inputVat: "inputVatAccount",
  cost: "costAccount",
  base: "baseAccount",
  baseCounter: "baseCounterAccount",
} as const satisfies Record<VatCodeSlot, string>;
export type VatCodeAccountField = (typeof VAT_CODE_ACCOUNT_FIELDS)[VatCodeSlot];

// --- GET /vat-codes ---

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
  ruleCount: number;
};

// --- Swedish wording the Momskoder page, the konteringsregler and the
// importmoms dialog share ---

export const VAT_CODE_SLOT_LABELS: Record<VatCodeSlot, string> = {
  revenue: "Intäktskonto",
  outputVat: "Utgående moms",
  inputVat: "Ingående moms",
  cost: "Kostnadskonto",
  base: "Underlag",
  baseCounter: "Motkonto underlag",
};

export const VAT_CODE_KIND_LABELS: Record<VatCodeKind, string> = {
  domestic: "Svensk moms",
  eu_sale: "EU-försäljning",
  export: "Export",
  reverse_sale: "Omvänd moms, försäljning",
  reverse_purchase: "Omvänd moms, inköp",
  non_eu_goods: "Inköp utanför EU",
  import: "Importmoms",
  out_of_scope: "Utanför momsens tillämpningsområde",
};

// The role labels in the Momskoder table, where a code's accounts share a
// narrow column; the dialog uses the full VAT_CODE_SLOT_LABELS.
export const VAT_CODE_SLOT_SHORT_LABELS: Record<VatCodeSlot, string> = {
  revenue: "Intäkt",
  outputVat: "Utg. moms",
  inputVat: "Ing. moms",
  cost: "Kostnad",
  base: "Underlag",
  baseCounter: "Motkonto",
};

export const VAT_CODE_DIRECTION_LABELS: Record<VatCodeDirection, string> = {
  both: "Försäljning och inköp",
  sales: "Försäljning",
  purchase: "Inköp",
  import: "Importmoms",
};

export const VAT_CODE_WARNING_LABELS: Record<NonNullable<VatCodeAccountView["warning"]>, string> = {
  missing: "Kontot finns inte i kontoplanen",
  inactive: "Kontot är inaktivt",
  box_mismatch: "Kontot har fel momsruta",
};

// --- Konteringsregler: the account's momsruta against the code ---

// Purchase bases (inköp med omvänd moms, trepartsinköp, importunderlag): the
// cost account of a rule for svensk moms must carry none of them, or a
// domestic purchase would be declared as an EU/omvänd/import purchase.
export const PURCHASE_BASE_BOXES: readonly VatBoxSetting[] = ["20", "21", "22", "23", "24", "37", "50"];

export type RuleBoxProblem = {
  slot: "revenue" | "cost";
  // purchase_box: the cost account carries one of PURCHASE_BASE_BOXES.
  problem: "box_mismatch" | "purchase_box";
  accountNumber: string;
  actualBox: VatBoxSetting | null;
  // Every box that would be in order; empty for purchase_box.
  expectedBoxes: VatBoxSetting[];
};

// A konteringsregel replaces a code's own account, so the account it names
// must land in the right box — the same rules as the Momsrapport warns about
// (vat-report.service.ts's findRuleBoxMismatches, pinned by
// vat-codes.shared.test.ts):
//   * exact foreign/omvänd code — the code's box: the revenue account for a
//     sales code (EUV/EUT/EXV/EXT/OB), the cost account for an omvänd-moms
//     purchase;
//   * exact MP25/MP12/MP6 — a revenue account with ruta 05, MF ruta 42;
//   * "Alla momskoder" (code null) — ruta 05 or 42;
//   * the cost account of a domestic code, of IUTV and of "Alla momskoder" —
//     none of the purchase-base boxes.
// Importmoms codes are never posted through a rule.
export function ruleBoxProblems(rule: {
  vatCode: string | null;
  revenueAccountNumber: string | null;
  revenueAccountVatBox: VatBoxSetting | null;
  costAccountNumber: string | null;
  costAccountVatBox: VatBoxSetting | null;
}): RuleBoxProblem[] {
  let code: VatCode | null = null;
  if (rule.vatCode !== null) {
    if (!isVatCode(rule.vatCode)) return [];
    code = rule.vatCode;
  }
  const revenue = { number: rule.revenueAccountNumber, box: rule.revenueAccountVatBox };
  const cost = { number: rule.costAccountNumber, box: rule.costAccountVatBox };
  const found: RuleBoxProblem[] = [];

  const expectBox = (slotName: "revenue" | "cost", account: typeof revenue, allowed: VatBoxSetting[]) => {
    if (account.number === null || (account.box !== null && allowed.includes(account.box))) return;
    found.push({
      slot: slotName,
      problem: "box_mismatch",
      accountNumber: account.number,
      actualBox: account.box,
      expectedBoxes: allowed,
    });
  };
  const forbidPurchaseBox = (account: typeof cost) => {
    if (account.number === null || account.box === null || !PURCHASE_BASE_BOXES.includes(account.box)) return;
    found.push({
      slot: "cost",
      problem: "purchase_box",
      accountNumber: account.number,
      actualBox: account.box,
      expectedBoxes: [],
    });
  };

  if (code === null) {
    expectBox("revenue", revenue, ["05", "42"]);
    forbidPurchaseBox(cost);
    return found;
  }
  const entry = vatCodeEntry(code);
  if (entry.kind === "import") return [];
  if (entry.kind === "domestic") {
    expectBox("revenue", revenue, [entry.slots.revenue!.box]);
    forbidPurchaseBox(cost);
    return found;
  }
  if (entry.kind === "non_eu_goods") {
    forbidPurchaseBox(cost);
    return found;
  }
  const slotName = entry.direction === "sales" ? "revenue" : "cost";
  const expected = entry.slots[slotName];
  if (expected) expectBox(slotName, slotName === "revenue" ? revenue : cost, [expected.box]);
  return found;
}

// "ruta 05" / "ingen ruta" / "ingen ruta angiven" — a momsruta setting in a
// sentence.
export function vatBoxPhrase(box: VatBoxSetting | null): string {
  if (box === null) return "ingen ruta angiven";
  if (box === "none") return "ingen ruta";
  return `ruta ${box}`;
}

// "har ruta 36 men ska ha ruta 05 eller ruta 42" — what is wrong with the
// account of a konteringsregel; the inköpsruta case says what must not be
// there instead.
export function ruleBoxProblemText(problem: Pick<RuleBoxProblem, "problem" | "actualBox" | "expectedBoxes">): string {
  if (problem.problem === "purchase_box") {
    return `har ${vatBoxPhrase(problem.actualBox)} men ska inte ha någon av inköpsrutorna 20–24, 37 eller 50 (de gäller omvänd moms och import)`;
  }
  return `har ${vatBoxPhrase(problem.actualBox)} men ska ha ${problem.expectedBoxes.map(vatBoxPhrase).join(" eller ")}`;
}

// --- Pickers on the documents ---

// The codes a document row/header may be given, in catalog order: those of
// its direction that are active — plus the one the document already carries
// (`keepId`) even when it has been deactivated since, so editing never
// silently changes it.
export function vatCodesFor(
  codes: readonly VatCodeView[],
  document: "sales" | "purchase",
  keepId?: string | null
): VatCodeView[] {
  return codes.filter((code) => vatCodeAllowedOn(code.code, document) && (code.active || code.id === keepId));
}

// "EUV · Varor till annat EU-land (inaktiv)" — the option text of every
// Momskod select.
export function vatCodeOptionLabel(code: Pick<VatCodeView, "code" | "name" | "active">): string {
  return `${code.code} · ${code.name}${code.active ? "" : " (inaktiv)"}`;
}

// Momssats (the VAT rate field next to the supplier invoice's Momskod): a
// domestic code states its own rate; omvänd moms, momsfritt and import carry
// no VAT on the supplier's invoice, so the rate to prefill is 0.
export function chargedVatRate(code: VatCode): number {
  const entry = vatCodeEntry(code);
  return entry.kind === "domestic" ? entry.rate : 0;
}

// True when the supplier charges no VAT with this code — omvänd moms,
// momsfritt, goods from outside the EU: Momssats 0 % and Momsbelopp 0 (the
// attest refuses charged VAT on such a code, supplier-invoice-vat-code).
export function vatCodeChargesNoVat(code: VatCode): boolean {
  const entry = vatCodeEntry(code);
  return entry.kind !== "domestic" || entry.rate === 0;
}

// What to tell the user under Momskod/Momssats on a supplier invoice when the
// code takes no charged VAT — null for a code with a rate. Omvänd moms is
// computed by Nav at the attest; goods from outside the EU have their
// importmoms booked separately when the customs decision arrives.
export function supplierVatCodeNote(code: VatCode): string | null {
  const entry = vatCodeEntry(code);
  switch (entry.kind) {
    case "reverse_purchase":
      return "Leverantören debiterar ingen moms med den här momskoden — Nav beräknar momsen när fakturan godkänns och bokför den som både utgående och ingående moms.";
    case "non_eu_goods":
      return "Varor från ett land utanför EU: leverantören debiterar ingen svensk moms. Importmomsen redovisas separat när tullbeslutet kommer — se Bokför importmoms i Momsrapporten.";
    case "domestic":
      return entry.rate === 0 ? "Momsfritt — leverantören debiterar ingen moms på fakturan." : null;
    default:
      return null;
  }
}
