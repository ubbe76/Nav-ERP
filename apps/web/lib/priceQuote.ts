import { SEK } from "./currency";

// GET /price-quote path. The price is in the order's currency: with a
// salesOrderId the order's own currency and rate win (an existing order);
// otherwise `currency` (always sent — omitted, the API takes the CUSTOMER's
// currency, which is not what a SEK order for a EUR customer wants) and, for a
// foreign currency, the order's `exchangeRate` (omitted, the API would look up
// today's — the form shows and binds the rate it displays).
export function priceQuotePath(options: {
  customerId: string;
  articleId: string;
  // In the article's base unit.
  quantity: number;
  salesOrderId?: string;
  currency?: string;
  exchangeRate?: number | null;
}): string {
  const params = new URLSearchParams({
    customerId: options.customerId,
    articleId: options.articleId,
    quantity: String(options.quantity),
  });
  if (options.salesOrderId) {
    params.set("salesOrderId", options.salesOrderId);
  } else if (options.currency) {
    params.set("currency", options.currency);
    if (options.currency !== SEK && options.exchangeRate) params.set("exchangeRate", String(options.exchangeRate));
  }
  return `/api/v1/price-quote?${params.toString()}`;
}

// The numeric rate a Kurs field holds, or null when it is empty, half typed or
// not positive.
export function parseRate(text: string): number | null {
  const n = Number(text.replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

// Kalkylpris (#16): GET /price-quote answers `source: "calculated"` when the
// customer's own markup priced the article from its latest saved förkalkyl.
// The order-row forms then OMIT unitPrice (and send discountPercent only when
// touched) so the server sets the row's calculated_price flag; a price the
// operator typed is always sent ("manuellt vinner").
export type MarkupLevel = "order" | "customer" | "group" | "company";

export interface CalculatedPriceInfo {
  calculationId: string;
  calculatedAt: string;
  quantity: number;
  generalMarkup: { percent: number; level: MarkupLevel };
  materialMarkup: { percent: number; level: MarkupLevel };
}

export type CalculatedPriceUnavailable = "no-calculation" | "material-base-missing" | "calculation-outdated";

// The slice of a price-quote answer the Kalkylpris helpers read.
export interface CalculatedQuoteLike {
  price: { source: string } | null;
  calculated?: CalculatedPriceInfo;
  calculatedPriceUnavailable?: CalculatedPriceUnavailable;
}

export function isCalculatedQuote(quote: CalculatedQuoteLike | null | undefined): boolean {
  return quote?.price?.source === "calculated";
}

const LEVEL_WORDS: Record<MarkupLevel, string> = {
  order: "ordern",
  customer: "kunden",
  group: "varugruppen",
  company: "företaget",
};

function percentText(percent: number): string {
  return `${percent.toLocaleString("sv-SE", { maximumFractionDigits: 2 })} %`;
}

// "Kalkylpris: förkalkyl 2026-11-07, generellt påslag 25 % (kunden), materialpåslag 0 % (företaget)".
// `date` is the Stockholm day of calculatedAt, formatted by the caller. A
// client without the `calculated` detail (OAuth) just gets "Kalkylpris".
export function calculatedPriceText(quote: CalculatedQuoteLike, date: (iso: string) => string): string | null {
  if (!isCalculatedQuote(quote)) return null;
  const c = quote.calculated;
  if (!c) return "Kalkylpris";
  return (
    `Kalkylpris: förkalkyl ${date(c.calculatedAt)}, ` +
    `generellt påslag ${percentText(c.generalMarkup.percent)} (${LEVEL_WORDS[c.generalMarkup.level]}), ` +
    `materialpåslag ${percentText(c.materialMarkup.percent)} (${LEVEL_WORDS[c.materialMarkup.level]})`
  );
}

export function calculatedUnavailableText(quote: CalculatedQuoteLike | null | undefined): string | null {
  switch (quote?.calculatedPriceUnavailable) {
    case "no-calculation":
      return "Kundens påslag kunde inte användas — artikeln saknar sparad förkalkyl. Artikelns försäljningspris används.";
    case "material-base-missing":
      return "Kundens påslag kunde inte användas — spara en ny förkalkyl för artikeln. Artikelns försäljningspris används.";
    case "calculation-outdated":
      return "Kundens påslag kunde inte användas — förkalkylen är sparad före ändringen av påslagskedjan, förkalkylera igen. Artikelns försäljningspris används.";
    default:
      return null;
  }
}

// New quote/order and Lägg till rad: leave unitPrice out while the field is
// untouched and the suggestion shown is the Kalkylpris.
export function omitUnitPriceOnCreate(priceTouched: boolean, quote: CalculatedQuoteLike | null | undefined): boolean {
  return !priceTouched && isCalculatedQuote(quote);
}

// Ändra: only when the quantity changed (the Kalkylpris depends on it) and the
// price field is untouched. With the same quantity the price is sent as before,
// which keeps the row's flag.
export function omitUnitPriceOnEdit(options: {
  priceTouched: boolean;
  quantityChanged: boolean;
  quote: CalculatedQuoteLike | null | undefined;
}): boolean {
  return options.quantityChanged && !options.priceTouched && isCalculatedQuote(options.quote);
}
