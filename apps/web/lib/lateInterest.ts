// Pure helpers for Försäljning → Räntefakturering and Ekonomi → Referensränta.
// NO imports: the API test suite loads this file directly
// (apps/api/test/web-late-interest.test.ts). The interest itself is always
// computed by the API (late-interest.ts's lateInterest) — this file only
// presents the candidates, keeps the selection and sums what is about to be
// invoiced per customer, with the same minimum-amount rule the server applies
// (the räntan per räntefaktura, not per source invoice).

export interface LateInterestRow {
  invoiceId: string;
  customerId: string;
  customerName: string;
  fromDate: string;
  toDate: string;
  days: number;
  rate: number | null;
  rates: number[];
  interest: number | null;
  fee: number;
  belowMinimum: boolean;
  rateMissing: boolean;
}

export interface LateInterestSelection {
  // Rows whose interest goes on the räntefaktura (the row's own checkbox).
  interest: ReadonlySet<string>;
  // Rows whose förseningsersättning goes on it (the Förseningsersättning
  // column's checkbox).
  fee: ReadonlySet<string>;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Interest that can be charged at all: a rate exists and the amount is above 0.
export function hasChargeableInterest(row: Pick<LateInterestRow, "interest" | "rateMissing">): boolean {
  return !row.rateMissing && row.interest !== null && row.interest > 0;
}

// The preselection: every row with chargeable interest except those under
// Minsta räntebelopp on their own; the ersättning of every row that has one.
export function defaultSelection(rows: readonly LateInterestRow[]): { interest: Set<string>; fee: Set<string> } {
  return {
    interest: new Set(rows.filter((r) => hasChargeableInterest(r) && !r.belowMinimum).map((r) => r.invoiceId)),
    fee: new Set(rows.filter((r) => r.fee > 0).map((r) => r.invoiceId)),
  };
}

export interface CustomerSummary {
  customerId: string;
  customerName: string;
  // Σ ränta of the selected rows / Σ förseningsersättning of the selected rows.
  interest: number;
  fee: number;
  // True when there is selected interest but it is under Minsta räntebelopp —
  // the server then leaves the interest off (the fee still gets its invoice).
  interestBelowMinimum: boolean;
  // What the räntefaktura will total (excl. nothing — interest and ersättning
  // carry no moms): interest counted only at or above the minimum.
  total: number;
  selectedRows: number;
}

// One summary per customer with something selected, in the order the
// customers first appear in `rows` (the API sorts by kundnamn).
export function customerSummaries(
  rows: readonly LateInterestRow[],
  selection: LateInterestSelection,
  minAmount: number
): CustomerSummary[] {
  const byCustomer = new Map<string, CustomerSummary>();
  for (const row of rows) {
    const takeInterest = selection.interest.has(row.invoiceId) && hasChargeableInterest(row);
    const takeFee = selection.fee.has(row.invoiceId) && row.fee > 0;
    if (!takeInterest && !takeFee) continue;
    let summary = byCustomer.get(row.customerId);
    if (!summary) {
      summary = {
        customerId: row.customerId,
        customerName: row.customerName,
        interest: 0,
        fee: 0,
        interestBelowMinimum: false,
        total: 0,
        selectedRows: 0,
      };
      byCustomer.set(row.customerId, summary);
    }
    if (takeInterest) summary.interest += row.interest ?? 0;
    if (takeFee) summary.fee += row.fee;
    summary.selectedRows += 1;
  }
  return [...byCustomer.values()].map((s) => {
    const interest = round2(s.interest);
    const fee = round2(s.fee);
    const interestBelowMinimum = interest > 0 && interest < minAmount;
    return { ...s, interest, fee, interestBelowMinimum, total: round2((interestBelowMinimum ? 0 : interest) + fee) };
  });
}

// The POST /late-interest/invoices items: one per row with something selected.
export function runItems(
  rows: readonly LateInterestRow[],
  selection: LateInterestSelection
): { invoiceId: string; fromDate: string; includeInterest: boolean; includeFee: boolean; fee: number }[] {
  const items = [];
  for (const row of rows) {
    const includeInterest = selection.interest.has(row.invoiceId) && hasChargeableInterest(row);
    const includeFee = selection.fee.has(row.invoiceId) && row.fee > 0;
    if (!includeInterest && !includeFee) continue;
    items.push({ invoiceId: row.invoiceId, fromDate: row.fromDate, includeInterest, includeFee, fee: row.fee });
  }
  return items;
}

// "12,00 %" — Swedish decimal comma, always two decimals (the rates are
// numeric(5,2)).
export function formatRatePercent(rate: number): string {
  return `${rate.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

// The Räntesats column: one rate for the whole period, "10,00 / 12,00 %" when
// the period spans a half-year shift, "–" without a rate.
export function rateText(row: Pick<LateInterestRow, "rate" | "rates" | "rateMissing">): string {
  if (row.rateMissing) return "Saknas";
  if (row.rate !== null) return formatRatePercent(row.rate);
  if (row.rates.length === 0) return "–";
  const parts = row.rates.map((r) => r.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return `${parts.join(" / ")} %`;
}

// "2026-09-02–2026-09-20", or "–" for a period without days (a row that only
// carries förseningsersättning).
export function periodText(row: Pick<LateInterestRow, "fromDate" | "toDate" | "days">): string {
  if (row.days <= 0 || !row.fromDate || !row.toDate) return "–";
  return `${row.fromDate}–${row.toDate}`;
}

// A referensränta applies for a calendar half year, valid from 1 January or
// 1 July. "första halvåret 2026" for 2026-01-01, "andra halvåret 2026" for
// 2026-07-01.
export function halfYearLabel(validFrom: string): string {
  const year = validFrom.slice(0, 4);
  return validFrom.slice(5, 7) === "01" ? `första halvåret ${year}` : `andra halvåret ${year}`;
}

// "2026-01-01" / "2026-07-01" for a year and a half (1 or 2).
export function halfYearStart(year: number, half: 1 | 2): string {
  return `${String(year).padStart(4, "0")}-${half === 1 ? "01" : "07"}-01`;
}

// The first day of the half year a date falls in.
export function halfYearStartOf(date: string): string {
  const year = Number(date.slice(0, 4));
  return halfYearStart(year, Number(date.slice(5, 7)) <= 6 ? 1 : 2);
}

// The half-year start `count` half years before the one containing `date`.
export function halfYearStartBefore(date: string, count: number): string {
  const start = halfYearStartOf(date);
  const index = Number(start.slice(0, 4)) * 2 + (start.slice(5, 7) === "01" ? 0 : 1) - count;
  return halfYearStart(Math.floor(index / 2), index % 2 === 0 ? 1 : 2);
}

// A typed percentage ("12,5" or "12.5") as a number, null when it is not one.
export function parsePercent(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
