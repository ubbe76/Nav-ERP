import { LATE_FEE_AMOUNT, round2 } from "@navet/shared";
import { halfYearStart, halfYearStartsBetween, nextHalfYearStart } from "../../system/service/half-years.js";

// Dröjsmålsränta och förseningsersättning — the pure rules (no DB imports),
// the ONE implementation every reader shares: Räntefakturering's candidate
// list, Skapa räntefakturor's re-check under the lock, and the reminder
// PDF's "Upplupen dröjsmålsränta".
//
// Räntelagen 4 § and 6 §: interest from the due date = Riksbankens
// referensränta for the calendar half-year (set 1 January and 1 July) + 8
// procentenheter (the margin is a setting, 8 by default), decided per
// half-year — a period crossing 1 January/1 July is computed in parts.
//
// Day count (kontrakt, beslut 1): interest runs for the days AFTER the due
// date through the payment day — paid on the due date = 0 days; due
// 2026-09-01, paid 2026-09-20 = 19 days, written 2026-09-02–2026-09-20.
// Actual days / 365, also in a leap year. A day d carries the capital after
// every payment dated BEFORE d (money arriving on d earns interest for d).
//
// Inkassokostnadslagen 4 a §: förseningsersättning 450 kr once per claim
// between businesses; 5 § andra stycket: påminnelse-/inkassoavgifter are
// payable only to the extent they EXCEED the förseningsersättning — so the
// fee offered is 450 minus the påminnelseavgift already charged.

export const DAYS_PER_YEAR = 365;

export type LateInterestPayment = { date: string; amount: number };
export type ReferenceRate = { validFrom: string; rate: number };

export type LateInterestSegment = { from: string; to: string; days: number; rate: number; amount: number };

export type LateInterestInput = {
  // The invoice's gross (incl. VAT) — never the påminnelseavgift.
  principal: number;
  dueDate: string;
  // The last day interest is computed for (the payment day, or asOf).
  through: string;
  // Live payment rows (applied + write-off), any order.
  payments: readonly LateInterestPayment[];
  // Referensräntor by half-year start (YYYY-01-01 / YYYY-07-01), in %.
  rates: readonly ReferenceRate[];
  // Procentenheter over the referensränta (räntelagen 6 §: 8).
  margin: number;
  // The customer's Avtalad räntesats (total %) — replaces rates + margin.
  agreedRate?: number | null;
};

export type LateInterestResult = {
  // round2 of the total; null when a referensränta is missing.
  amount: number | null;
  days: number;
  segments: LateInterestSegment[];
  // Half-year starts in the period without a rate (empty with agreedRate).
  rateMissing: string[];
};

// UTC day arithmetic on date-only strings — no DST edge to care about.
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

// Inclusive day count of [from, to]; 0 when from is after to.
export function daysBetween(from: string, to: string): number {
  return Math.max(0, dayNumber(to) - dayNumber(from) + 1);
}

export { halfYearStart, halfYearStartsBetween, nextHalfYearStart } from "../../system/service/half-years.js";

// The amount of a payment segment: capital × rate % × days / 365, unrounded.
function interestFor(capital: number, rate: number, days: number): number {
  return (capital * (rate / 100) * days) / DAYS_PER_YEAR;
}

export function lateInterest(input: LateInterestInput): LateInterestResult {
  const from = addDays(input.dueDate, 1);
  const days = daysBetween(from, input.through);
  if (days === 0) return { amount: 0, days: 0, segments: [], rateMissing: [] };

  const agreed = input.agreedRate ?? null;
  const rateByHalfYear = new Map(input.rates.map((rate) => [rate.validFrom, rate.rate] as const));
  const rateMissing =
    agreed === null
      ? halfYearStartsBetween(from, input.through).filter((start) => !rateByHalfYear.has(start))
      : [];
  if (rateMissing.length > 0) return { amount: null, days, segments: [], rateMissing };

  // Payments sorted by day; the capital for day d counts those dated < d.
  const payments = [...input.payments].sort((a, b) => a.date.localeCompare(b.date));
  const rateFor = (day: string) => (agreed !== null ? agreed : rateByHalfYear.get(halfYearStart(day))! + input.margin);

  // Walk the period in runs of equal (capital, rate): a run ends the day
  // before a payment day changes the capital, or at a half-year boundary.
  const segments: LateInterestSegment[] = [];
  let total = 0;
  let paid = 0;
  let paymentIndex = 0;
  let day = from;
  while (day <= input.through) {
    while (paymentIndex < payments.length && payments[paymentIndex]!.date < day) {
      paid += payments[paymentIndex]!.amount;
      paymentIndex += 1;
    }
    const capital = Math.max(0, round2(input.principal - paid));
    const rate = rateFor(day);
    // The run ends before the next payment day (a payment dated d changes
    // the capital from d + 1) and before the next half-year.
    let end = input.through;
    if (paymentIndex < payments.length) end = min(end, payments[paymentIndex]!.date);
    if (agreed === null) end = min(end, addDays(nextHalfYearStart(day), -1));
    const runDays = daysBetween(day, end);
    const amount = interestFor(capital, rate, runDays);
    total += amount;
    const last = segments.at(-1);
    // Adjacent runs with the same rate and capital (several payments of 0,
    // or a half-year boundary with the same rate) merge for the text.
    if (last && last.rate === rate && last.amount === 0 && amount === 0) {
      last.to = end;
      last.days += runDays;
    } else {
      segments.push({ from: day, to: end, days: runDays, rate, amount: round2(amount) });
    }
    day = addDays(end, 1);
  }
  return { amount: round2(total), days, segments, rateMissing: [] };
}

function min(a: string, b: string): string {
  return a <= b ? a : b;
}

// Förseningsersättning (4 a §) net of the påminnelseavgift already charged
// on the invoice (5 § andra stycket) — never below 0; 0 = no fee row.
export function lateFeeAmount(chargedReminderFees: number): number {
  return Math.max(0, round2(LATE_FEE_AMOUNT - chargedReminderFees));
}

// The payment day on which the capital reaches 0 (payments dated ≤ through),
// or null while something is left.
export function fullyPaidDate(principal: number, payments: readonly LateInterestPayment[], through: string): string | null {
  const sorted = [...payments].filter((p) => p.date <= through).sort((a, b) => a.date.localeCompare(b.date));
  let paid = 0;
  for (const payment of sorted) {
    paid += payment.amount;
    if (round2(principal - paid) <= 0) return payment.date;
  }
  return null;
}

// "12,00 %" / "10,00/12,00 %" — the distinct rates in order of appearance.
export function formatRates(rates: readonly number[]): string {
  const distinct = [...new Set(rates)];
  return `${distinct.map((rate) => rate.toFixed(2).replace(".", ",")).join("/")} %`;
}

// Row texts on the räntefaktura — the ONE place they are written.
export function lateInterestRowText(input: { invoiceNumber: string; from: string; to: string; days: number; rates: readonly number[] }) {
  return `Dröjsmålsränta ${input.invoiceNumber}, ${input.from}–${input.to} (${input.days} ${input.days === 1 ? "dag" : "dagar"}, ${formatRates(input.rates)})`;
}

export function lateFeeRowText(invoiceNumber: string): string {
  return `Förseningsersättning ${invoiceNumber}`;
}

// The payment-reminder PDF's information line (never a charge).
export function accruedInterestText(through: string, amount: number): string {
  const formatted = amount.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ /g, " ");
  return `Upplupen dröjsmålsränta t.o.m. ${through}: ${formatted} kr`;
}

export const LATE_INTEREST_TERMS_TEXT = "Vid betalning efter förfallodagen debiteras dröjsmålsränta enligt räntelagen.";
