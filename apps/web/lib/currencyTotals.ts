import { currencyLabel, SEK } from "./currency";
import { formatMoney, round2 } from "./format";
import type { CurrencyAmount } from "./types";

// Sums per currency — amounts in different currencies are never added
// together. SEK first, the other currencies alphabetically.
export function sumByCurrency<T>(rows: T[], pick: (row: T) => CurrencyAmount): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const { currency, amount } = pick(row);
    totals.set(currency, round2((totals.get(currency) ?? 0) + amount));
  }
  return sortCurrencyAmounts([...totals.entries()].map(([currency, amount]) => ({ currency, amount })));
}

export function sortCurrencyAmounts(amounts: CurrencyAmount[]): CurrencyAmount[] {
  return [...amounts].sort((a, b) =>
    a.currency === b.currency ? 0 : a.currency === SEK ? -1 : b.currency === SEK ? 1 : a.currency.localeCompare(b.currency)
  );
}

// "12 000,00 kr · 3 400,00 EUR"
export function formatCurrencyAmounts(amounts: CurrencyAmount[]): string {
  if (amounts.length === 0) return `${formatMoney(0)} kr`;
  return amounts.map((a) => `${formatMoney(a.amount)} ${currencyLabel(a.currency)}`).join(" · ");
}

// A batch's sums: totalsByCurrency when the API sent it, else the SEK total.
export function batchTotals(batch: { totalsByCurrency?: CurrencyAmount[]; totalAmount: number }): CurrencyAmount[] {
  return batch.totalsByCurrency && batch.totalsByCurrency.length > 0
    ? sortCurrencyAmounts(batch.totalsByCurrency)
    : [{ currency: SEK, amount: batch.totalAmount }];
}
