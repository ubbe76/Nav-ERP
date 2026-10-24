// Årsbokslut — valutaomvärdering (valuta steg 4, spec §6). Pure leaf (no DB
// imports), like year-end-calc.ts: every amount the step shows and books.
//
// K2: monetary items in a foreign currency are valued at the balance day's
// rate. Per open invoice in another currency than SEK:
//
//   revalued SEK = toSek(open amount, closing date's rate)
//   difference   = revalued SEK − the open SEK value booked for it
//
// revaluationDifference (@navet/shared, on toSek — the same conversion the
// invoice postings and the payments' frigjort SEK use) rounds per invoice,
// so a currency's total is the sum of its invoices' own öre.
//
// Signs follow the reskontra: receivables + = the customer owes us,
// payables + = we owe. A positive receivable difference is a kursvinst, a
// positive payable difference (the debt grew) a kursförlust.
import { revaluationDifference } from "@navet/shared";

export type FxSide = "receivable" | "payable";
export type FxRateSource = "riksbank" | "manual" | "step";

export interface FxRate {
  currency: string;
  rate: number;
  // The rate's own day (Valutakurser), null for a rate typed in the step.
  date: string | null;
  source: FxRateSource;
}

export interface FxOpenItem {
  side: FxSide;
  id: string;
  number: string;
  partnerName: string;
  currency: string;
  exchangeRate: number | null;
  openAmount: number;
  openAmountSek: number;
}

export interface FxRevaluedItem extends FxOpenItem {
  rate: number | null;
  revaluedSek: number | null;
  difference: number | null;
}

export interface FxCurrencySummary {
  currency: string;
  rate: number | null;
  invoiceCount: number;
  openAmount: number;
  bookedSek: number;
  revaluedSek: number | null;
  difference: number | null;
}

export interface FxSideSummary {
  invoiceCount: number;
  bookedSek: number;
  // null while a currency on the side has no rate.
  revaluedSek: number | null;
  difference: number | null;
  currencies: FxCurrencySummary[];
}

export interface FxRevaluation {
  items: FxRevaluedItem[];
  receivable: FxSideSummary;
  payable: FxSideSummary;
  // Currencies with open items but no rate — nothing can be booked.
  missingCurrencies: string[];
  // The effect on the year's result: receivable difference − payable
  // difference (+ = net kursvinst). null while a rate is missing.
  resultEffect: number | null;
}

function cents(value: number): number {
  return Math.round(value * 100);
}

function fromCents(value: number): number {
  const result = value / 100;
  return result === 0 ? 0 : result;
}

// One invoice: the öre-exact difference between the balance day's value and
// the booked one (@navet/shared, mirrored for the web's live preview).
export const revalueItem = revaluationDifference;

function summarizeSide(items: FxRevaluedItem[]): FxSideSummary {
  const byCurrency = new Map<string, FxRevaluedItem[]>();
  for (const item of items) byCurrency.set(item.currency, [...(byCurrency.get(item.currency) ?? []), item]);
  const currencies = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, rows]): FxCurrencySummary => {
      const rate = rows[0]!.rate;
      const complete = rows.every((row) => row.revaluedSek !== null);
      return {
        currency,
        rate,
        invoiceCount: rows.length,
        openAmount: fromCents(rows.reduce((sum, row) => sum + cents(row.openAmount), 0)),
        bookedSek: fromCents(rows.reduce((sum, row) => sum + cents(row.openAmountSek), 0)),
        revaluedSek: complete ? fromCents(rows.reduce((sum, row) => sum + cents(row.revaluedSek!), 0)) : null,
        difference: complete ? fromCents(rows.reduce((sum, row) => sum + cents(row.difference!), 0)) : null,
      };
    });
  const complete = currencies.every((row) => row.difference !== null);
  return {
    invoiceCount: items.length,
    bookedSek: fromCents(currencies.reduce((sum, row) => sum + cents(row.bookedSek), 0)),
    revaluedSek: complete ? fromCents(currencies.reduce((sum, row) => sum + cents(row.revaluedSek!), 0)) : null,
    difference: complete ? fromCents(currencies.reduce((sum, row) => sum + cents(row.difference!), 0)) : null,
    currencies,
  };
}

// The whole step: every item revalued at its currency's rate (a currency
// absent from `rates` stays unrevalued and is listed as missing).
export function revalue(items: FxOpenItem[], rates: ReadonlyMap<string, number>): FxRevaluation {
  const revalued = items.map((item): FxRevaluedItem => {
    const rate = rates.get(item.currency) ?? null;
    if (rate === null) return { ...item, rate: null, revaluedSek: null, difference: null };
    return { ...item, rate, ...revalueItem(item.openAmount, item.openAmountSek, rate) };
  });
  const receivable = summarizeSide(revalued.filter((item) => item.side === "receivable"));
  const payable = summarizeSide(revalued.filter((item) => item.side === "payable"));
  const missingCurrencies = [...new Set(revalued.filter((item) => item.rate === null).map((item) => item.currency))].sort();
  return {
    items: revalued,
    receivable,
    payable,
    missingCurrencies,
    resultEffect:
      receivable.difference === null || payable.difference === null
        ? null
        : fromCents(cents(receivable.difference) - cents(payable.difference)),
  };
}

export type FxRole = "receivable" | "payable" | "gain" | "loss";
export type FxEntry = { role: FxRole; amount: number }; // + debet, − kredit

// The verification, per role (debit-positive), netted:
//   * the receivable and the payable account take their side's NET
//     difference — one row each, what the reconciliation adds to the
//     reskontra (steg 6);
//   * the result side is gross PER CURRENCY: a currency whose revaluation
//     is a gain goes to kursvinst (3960), a loss to kursförlust (7960) — K2
//     puts kursvinster bland övriga rörelseintäkter and kursförluster bland
//     övriga rörelsekostnader respectively, so a EUR gain is never netted
//     against a USD loss in the result.
// The automatic reversal is the mirror (year-end-calc mirrorAmounts). Empty
// when nothing differs; throws on missing rates (the caller checks first).
export function fxRevaluationEntries(revaluation: FxRevaluation): FxEntry[] {
  if (revaluation.missingCurrencies.length > 0) throw new Error("Cannot book a revaluation with missing rates");
  const totals: Record<FxRole, number> = { receivable: 0, payable: 0, gain: 0, loss: 0 };
  for (const row of revaluation.receivable.currencies) {
    const d = cents(row.difference!);
    totals.receivable += d;
    if (d > 0) totals.gain -= d;
    else if (d < 0) totals.loss -= d;
  }
  for (const row of revaluation.payable.currencies) {
    const d = cents(row.difference!);
    totals.payable -= d;
    if (d > 0) totals.loss += d;
    else if (d < 0) totals.gain += d;
  }
  return (["receivable", "payable", "gain", "loss"] as const)
    .filter((role) => totals[role] !== 0)
    .map((role) => ({ role, amount: fromCents(totals[role]) }));
}

// "Would a re-run book the same verification?" — per account, netted.
export function sameNetAmounts(a: { accountId: string; amount: number }[], b: { accountId: string; amount: number }[]): boolean {
  const net = (rows: { accountId: string; amount: number }[]) => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.accountId, (map.get(row.accountId) ?? 0) + cents(row.amount));
    return new Map([...map.entries()].filter(([, value]) => value !== 0));
  };
  const left = net(a);
  const right = net(b);
  if (left.size !== right.size) return false;
  return [...left.entries()].every(([accountId, value]) => right.get(accountId) === value);
}

// The same currencies at the same rates (source and day aside).
export function sameRates(a: FxRate[], b: FxRate[]): boolean {
  if (a.length !== b.length) return false;
  const byCurrency = new Map(a.map((rate) => [rate.currency, rate.rate]));
  return b.every((rate) => byCurrency.has(rate.currency) && byCurrency.get(rate.currency) === rate.rate);
}
