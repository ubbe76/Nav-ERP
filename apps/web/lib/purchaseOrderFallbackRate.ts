// The linked purchase order's rate when the invoice date has none: the same
// rule as the API's resolveRate (supplier-invoice.service.ts) — same
// currency, a rate above 0 that is not the SEK placeholder 1. null = no
// fallback, the field then says that no rate was found.
export function purchaseOrderFallbackRate(
  order: { currency: string | null | undefined; exchangeRate: string | number | null | undefined } | null,
  invoiceCurrency: string | null
): number | null {
  if (!order || !invoiceCurrency || order.currency?.trim().toUpperCase() !== invoiceCurrency.trim().toUpperCase()) return null;
  const rate = Number(order.exchangeRate);
  return Number.isFinite(rate) && rate > 0 && rate !== 1 ? rate : null;
}
