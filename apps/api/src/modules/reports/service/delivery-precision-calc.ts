// F1: delivery precision — pure bucketing calc, no database. The repository
// feeds completed orders (promised date + actual completion timestamp); this
// module owns all the semantics: Stockholm-date conversion, the early /
// on-time / late rule (classifyDelivery, with the side's margins — #29),
// month bucketing over the requested range and the not-measurable counters.
import type { PrecisionMargins } from "../../system/service/precision-settings.js";

export type { PrecisionMargins };

export interface PrecisionOrderInput {
  expectedDeliveryDate: string | null; // promised date (YYYY-MM-DD), null = never promised
  completedAt: string | null; // last delivery/receipt timestamp (ISO), null = no records (pre-C2 history)
  // Gruppera: Motpart (Kvalitet) — the order and its customer/supplier.
  orderId?: string;
  counterpartyId?: string;
  counterpartyName?: string;
}

// How one order counts: measured in a month of the range (with its days
// late relative to the promise — classifyDelivery decides what that means),
// completed in the range without a promised date,
// without any completion record (all-time), or outside the range. The one
// rule bucketDeliveryPrecision and the counterparty grouping share.
export type OrderMeasure =
  | { kind: "measured"; month: string; daysLate: number }
  | { kind: "missingExpectedDate" }
  | { kind: "noDeliveryRecords" }
  | { kind: "outside" };

export function measureOrder(order: PrecisionOrderInput, months: ReadonlySet<string>): OrderMeasure {
  // No completion timestamp at all (pre-C2 history) trumps a missing
  // promise — there is nothing to measure either way.
  if (order.completedAt == null) return { kind: "noDeliveryRecords" };
  const completedDate = stockholmDate.format(new Date(order.completedAt));
  const month = completedDate.slice(0, 7);
  if (!months.has(month)) return { kind: "outside" };
  if (order.expectedDeliveryDate == null) return { kind: "missingExpectedDate" };
  return { kind: "measured", month, daysLate: dayDiff(completedDate, order.expectedDeliveryDate) };
}

export type DeliveryOutcome = "early" | "onTime" | "late";

// THE rule (#29), shared by the month view and Gruppera Motpart: late = more
// than lateDays after the promised date, early = more than earlyDays before
// it (only when the early margin is on), everything else on time. With
// NO_PRECISION_MARGINS this is the rule before the setting: same day or
// earlier is on time, the day after is late.
export function classifyDelivery(daysLate: number, margins: PrecisionMargins): DeliveryOutcome {
  if (daysLate > margins.lateDays) return "late";
  if (margins.earlyDays !== null && -daysLate > margins.earlyDays) return "early";
  return "onTime";
}

export interface PrecisionCounts {
  total: number;
  early: number;
  onTime: number;
  late: number;
  lateDays: number;
}

export const emptyCounts = (): PrecisionCounts => ({ total: 0, early: 0, onTime: 0, late: 0, lateDays: 0 });

export function sumCounts(into: PrecisionCounts, b: PrecisionCounts) {
  into.total += b.total;
  into.early += b.early;
  into.onTime += b.onTime;
  into.late += b.late;
  into.lateDays += b.lateDays;
}

// Precision = on time of all measured, so an early delivery (when the early
// margin is on) lowers it like a late one. Snitt försening is over the late
// orders only, in days after the promised date (not after the margin).
export function finishCounts(b: PrecisionCounts) {
  return {
    total: b.total,
    early: b.early,
    onTime: b.onTime,
    late: b.late,
    precisionPct: b.total > 0 ? Math.round((b.onTime / b.total) * 100) : null,
    avgDaysLate: b.late > 0 ? Math.round((b.lateDays / b.late) * 10) / 10 : null,
  };
}

export function addMeasure(b: PrecisionCounts, daysLate: number, margins: PrecisionMargins) {
  b.total += 1;
  const outcome = classifyDelivery(daysLate, margins);
  if (outcome === "early") b.early += 1;
  else if (outcome === "onTime") b.onTime += 1;
  else {
    b.late += 1;
    b.lateDays += daysLate;
  }
}

export interface PrecisionMonth {
  month: string; // YYYY-MM
  total: number;
  early: number; // always 0 while the side's early margin is off
  onTime: number;
  late: number;
  precisionPct: number | null; // whole %, null when total is 0
  avgDaysLate: number | null; // 1 decimal, over late orders only, null when none late
}

export interface PrecisionTotals {
  total: number;
  early: number;
  onTime: number;
  late: number;
  precisionPct: number | null;
  avgDaysLate: number | null;
}

export interface PrecisionSection {
  margins: PrecisionMargins; // the side's margins the section was measured with
  months: PrecisionMonth[]; // every month in [from, to], empty months included
  totals: PrecisionTotals;
  notMeasurable: {
    missingExpectedDate: number; // completed but never promised a date
    noDeliveryRecords: number; // no completion timestamp exists (pre-C2 history)
  };
}

const stockholmDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });

const dayDiff = (later: string, earlier: string) =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

export function monthAxis(from: string, to: string): string[] {
  const months: string[] = [];
  let [year, month] = from.split("-").map(Number) as [number, number];
  while (true) {
    const current = `${year}-${String(month).padStart(2, "0")}`;
    months.push(current);
    if (current === to || months.length > 400) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export function bucketDeliveryPrecision(
  orders: PrecisionOrderInput[],
  range: { from: string; to: string }, // YYYY-MM, inclusive
  margins: PrecisionMargins
): PrecisionSection {
  const buckets = new Map<string, PrecisionCounts>(monthAxis(range.from, range.to).map((m) => [m, emptyCounts()]));
  const months = new Set(buckets.keys());
  const notMeasurable = { missingExpectedDate: 0, noDeliveryRecords: 0 };

  for (const order of orders) {
    const measure = measureOrder(order, months);
    // noDeliveryRecords cannot be period-scoped (there is no date to scope
    // by), so it is an all-time figure; the UI labels it accordingly.
    // missingExpectedDate is period-scoped: only completions inside the
    // range count, so the note reconciles with the filtered table.
    if (measure.kind === "noDeliveryRecords") notMeasurable.noDeliveryRecords += 1;
    else if (measure.kind === "missingExpectedDate") notMeasurable.missingExpectedDate += 1;
    else if (measure.kind === "measured") addMeasure(buckets.get(measure.month)!, measure.daysLate, margins);
  }

  const overall = emptyCounts();
  for (const bucket of buckets.values()) sumCounts(overall, bucket);

  return {
    margins,
    months: [...buckets.entries()].map(([month, bucket]) => ({ month, ...finishCounts(bucket) })),
    totals: finishCounts(overall),
    notMeasurable,
  };
}
