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
  if (customer.privatePerson) return domestic;
  const country = customer.country.trim().toUpperCase();
  if (country === "SE") return customer.reverseChargeConstruction && !isGoods ? "OB" : domestic;
  if (isEuCountry(country)) {
    if (!hasVatNumber(customer.vatNumber)) return domestic;
    return isGoods ? "EUV" : "EUT";
  }
  return isGoods ? "EXV" : "EXT";
}

// Momsbehandling on the customer card (spec 4.6).
export const CUSTOMER_VAT_TREATMENTS = ["domestic", "domestic_no_vat_number", "eu", "export", "private_eu"] as const;
export type CustomerVatTreatment = (typeof CUSTOMER_VAT_TREATMENTS)[number];

export const CUSTOMER_VAT_TREATMENT_LABELS: Record<CustomerVatTreatment, string> = {
  domestic: "Svensk moms",
  domestic_no_vat_number: "Svensk moms (saknar momsnummer)",
  eu: "EU — utan moms",
  export: "Export — utan moms",
  private_eu: "Privatperson i annat EU-land — svensk moms",
};

export function customerVatTreatment(customer: SalesVatCustomer): CustomerVatTreatment {
  const country = customer.country.trim().toUpperCase();
  if (customer.privatePerson) return country !== "SE" && isEuCountry(country) ? "private_eu" : "domestic";
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

// Utfärda (spec 4.2): codes that require the buyer's momsregistreringsnummer
// need one on the invoice, in the right form. null = in order.
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
      const prefix = country !== "SE" && isEuCountry(country) ? vatNumberPrefix(country) : null;
      if (prefix === null || !new RegExp(`^${prefix}[A-Z0-9]{2,12}$`).test(number)) {
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
        ? `Kundens momsregistreringsnummer ska börja med landskoden ${problem.prefix} — det krävs för EU-försäljning.`
        : "EU-försäljning kräver en kund i ett annat EU-land med momsregistreringsnummer.";
    case "ob_format":
      return "Kundens momsregistreringsnummer ska ha formen SE + tio siffror + 01 för omvänd betalningsskyldighet.";
  }
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
