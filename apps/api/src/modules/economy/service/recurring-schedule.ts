import { round2, type RecurringDayOfMonth } from "@navet/shared";

// Återkommande verifikat — the pure rules (no DB, no clock): which months a
// post owes a run, the date a month's run is booked on, and how a fördelning
// splits its amount over its months. Months are "YYYY-MM" strings throughout
// (they compare lexicographically); the caller hands in today's Stockholm
// date.

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

// The month `offset` months after `month` (negative allowed).
export function addMonths(month: string, offset: number): string {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Not a month: ${month}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + offset;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

// 0 for the same month, positive when `to` is later.
export function monthsBetween(from: string, to: string): number {
  const a = MONTH_RE.exec(from);
  const b = MONTH_RE.exec(to);
  if (!a || !b) throw new Error(`Not a month: ${from} / ${to}`);
  return Number(b[1]) * 12 + Number(b[2]) - (Number(a[1]) * 12 + Number(a[2]));
}

export function lastDayOfMonth(month: string): number {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Not a month: ${month}`);
  // Day 0 of the next month = the last day of this one (UTC, no DST issues).
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}

// The verification date for a month: its day_of_month, or the last day.
export function runDate(month: string, dayOfMonth: RecurringDayOfMonth): string {
  const day = dayOfMonth === "last" ? lastDayOfMonth(month) : dayOfMonth;
  return `${month}-${String(day).padStart(2, "0")}`;
}

export interface MonthPlanInput {
  startMonth: string;
  endMonth: string | null;
  dayOfMonth: RecurringDayOfMonth;
  // Today's Stockholm date.
  today: string;
  // Months that already have a run row (created, failed or skipped).
  doneMonths: ReadonlySet<string>;
}

// The months whose run date has passed (<= today), from startMonth to
// min(endMonth, this month), that have no run yet — in order, so a post
// created with a start month far back catches up oldest first.
export function monthsDue(input: MonthPlanInput): string[] {
  const thisMonth = monthOf(input.today);
  const last = input.endMonth !== null && input.endMonth < thisMonth ? input.endMonth : thisMonth;
  const due: string[] = [];
  for (let month = input.startMonth; month <= last; month = addMonths(month, 1)) {
    if (input.doneMonths.has(month)) continue;
    if (runDate(month, input.dayOfMonth) <= input.today) due.push(month);
  }
  return due;
}

// The next month that will get a run: the first month from startMonth
// (bounded by endMonth) without a run row — null when the post is past its
// end. Independent of today: a month whose day has not come yet is "next".
export function nextRunMonth(input: Omit<MonthPlanInput, "today">): string | null {
  // A failed month blocks itself until Kör nu, so the scan simply skips
  // every month that has a row — the bound keeps this finite.
  const limit = input.endMonth ?? addMonths(input.startMonth, 1200);
  for (let month = input.startMonth; month <= limit; month = addMonths(month, 1)) {
    if (!input.doneMonths.has(month)) return month;
  }
  return null;
}

// Fördela över perioder: amount / months in whole öre, rounded DOWN per
// month so the last month's remainder is never negative, and the last month
// takes the rest so the schedule sums to the amount exactly. An amount too
// small to give every month at least one öre is refused (a zero row cannot
// be booked).
export class AllocationTooSmallError extends Error {
  constructor(amount: number, months: number) {
    super(`Beloppet ${amount} är för litet för att fördelas på ${months} månader (mindre än ett öre per månad)`);
    this.name = "AllocationTooSmallError";
  }
}

export function allocationAmounts(amount: number, months: number): number[] {
  if (!Number.isInteger(months) || months < 1) throw new Error(`Invalid month count: ${months}`);
  const totalOre = Math.round(round2(amount) * 100);
  const eachOre = Math.floor(totalOre / months);
  if (eachOre < 1) throw new AllocationTooSmallError(round2(amount), months);
  const amounts: number[] = [];
  for (let i = 0; i < months - 1; i++) amounts.push(eachOre / 100);
  amounts.push((totalOre - eachOre * (months - 1)) / 100);
  return amounts.map(round2);
}

// "Text (månad 3 av 12)" for a fördelning's month.
export function allocationDescription(text: string, month: string, startMonth: string, months: number): string {
  return `${text} (månad ${monthsBetween(startMonth, month) + 1} av ${months})`;
}
