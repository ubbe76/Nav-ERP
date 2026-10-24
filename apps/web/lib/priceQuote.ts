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
