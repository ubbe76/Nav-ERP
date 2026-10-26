// F1: delivery precision — pure bucketing calc, no database. The repository
// feeds completed orders (promised date + actual completion timestamp); this
// module owns all the semantics: Stockholm-date conversion, on-time rule
// (same day counts as on time), month bucketing over the requested range and
// the not-measurable counters.

export interface PrecisionOrderInput {
  expectedDeliveryDate: string | null; // promised date (YYYY-MM-DD), null = never promised
  completedAt: string | null; // last delivery/receipt timestamp (ISO), null = no records (pre-C2 history)
  // Gruppera: Motpart (Kvalitet) — the order and its customer/supplier.
  orderId?: string;
  counterpartyId?: string;
  counterpartyName?: string;
}

// How one order counts: measured in a month of the range (with its days
// late, ≤ 0 = on time), completed in the range without a promised date,
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

export interface PrecisionCounts {
  total: number;
  onTime: number;
  late: number;
  lateDays: number;
}

export function finishCounts(b: PrecisionCounts) {
  return {
    total: b.total,
    onTime: b.onTime,
    late: b.late,
    precisionPct: b.total > 0 ? Math.round((b.onTime / b.total) * 100) : null,
    avgDaysLate: b.late > 0 ? Math.round((b.lateDays / b.late) * 10) / 10 : null,
  };
}

export function addMeasure(b: PrecisionCounts, daysLate: number) {
  b.total += 1;
  if (daysLate <= 0) b.onTime += 1;
  else {
    b.late += 1;
    b.lateDays += daysLate;
  }
}

export interface PrecisionMonth {
  month: string; // YYYY-MM
  total: number;
  onTime: number;
  late: number;
  precisionPct: number | null; // whole %, null when total is 0
  avgDaysLate: number | null; // 1 decimal, over late orders only, null when none late
}

export interface PrecisionTotals {
  total: number;
  onTime: number;
  late: number;
  precisionPct: number | null;
  avgDaysLate: number | null;
}

export interface PrecisionSection {
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
  range: { from: string; to: string } // YYYY-MM, inclusive
): PrecisionSection {
  const emptyBucket = (): PrecisionCounts => ({ total: 0, onTime: 0, late: 0, lateDays: 0 });
  const buckets = new Map<string, PrecisionCounts>(monthAxis(range.from, range.to).map((m) => [m, emptyBucket()]));
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
    else if (measure.kind === "measured") addMeasure(buckets.get(measure.month)!, measure.daysLate);
  }

  const overall = emptyBucket();
  for (const bucket of buckets.values()) {
    overall.total += bucket.total;
    overall.onTime += bucket.onTime;
    overall.late += bucket.late;
    overall.lateDays += bucket.lateDays;
  }

  return {
    months: [...buckets.entries()].map(([month, bucket]) => ({ month, ...finishCounts(bucket) })),
    totals: finishCounts(overall),
    notMeasurable,
  };
}
