// Kundpris = Sendify's price + påslag, rounded to whole kronor (same rule as
// ERPNext Sverige Frakt's fraktpris.kundpris).
export function customerPriceFor(carrierPrice: number, markupPercent: number, markupAmount: number): number {
  return Math.round(carrierPrice * (1 + markupPercent / 100) + markupAmount);
}

// "Bekräfta prisändring över (%)": true when the fresh price differs from the
// saved one by MORE than the threshold (either direction).
export function priceChangeExceeds(saved: number, fresh: number, thresholdPercent: number): boolean {
  if (saved <= 0) return fresh !== saved;
  return (Math.abs(fresh - saved) / saved) * 100 > thresholdPercent;
}
