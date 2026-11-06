import { stockholmDateOf } from "../../system/service/delivery-days.js";

// Prishistorik as of a moment — what a price WAS when the material was taken
// out, for the efterkalkyl and Produkter i arbete. Pure: the repository hands
// in the history rows (ascending by validFrom) and gets the value back, so the
// rule is testable without a database.
//
// One convention for every history, the one the stock valuation already uses
// for the standard cost (D1): the latest row valid at the moment; before the
// first row, the first row — "the price before any known price is the first
// one we ever recorded", never an invented one. Histories start at their
// migration, so an order consumed earlier is priced at that first value.

export interface StandardCostHistoryRow {
  cost: string;
  validFrom: Date;
}

export interface SupplierSnapshotRow {
  supplierId: string | null;
  price: string | null;
  currency: string;
  priceBreaks: { fromQuantity: number; price: number }[];
  isPrimary: boolean;
  removed: boolean;
  validFrom: Date;
}

// The last row (ascending by validFrom) still valid at the moment — `valid`
// is monotone over the rows, so the scan stops at the first that is not.
function latestWhere<T>(rows: T[], valid: (row: T) => boolean): T | undefined {
  let found: T | undefined;
  for (const row of rows) {
    if (valid(row)) found = row;
    else break;
  }
  return found;
}

function latestAt<T extends { validFrom: Date }>(rows: T[], at: Date): T | undefined {
  return latestWhere(rows, (row) => row.validFrom.getTime() <= at.getTime());
}

export function standardCostAt(rows: StandardCostHistoryRow[], at: Date): string | null {
  if (rows.length === 0) return null;
  return (latestAt(rows, at) ?? rows[0]!).cost;
}

// The primary supplier's catalog row as it stood at `at`: each supplier's
// latest snapshot by then, and of those the one that was primary and still in
// the catalog. Before the article's first snapshot, each supplier's first one.
export function primarySupplierAt(rows: SupplierSnapshotRow[], at: Date): SupplierSnapshotRow | null {
  if (rows.length === 0) return null;
  const beforeHistory = rows[0]!.validFrom.getTime() > at.getTime();
  const bySupplier = new Map<string | null, SupplierSnapshotRow[]>();
  for (const row of rows) {
    const list = bySupplier.get(row.supplierId);
    if (list) list.push(row);
    else bySupplier.set(row.supplierId, [row]);
  }
  for (const list of bySupplier.values()) {
    const state = beforeHistory ? list[0] : latestAt(list, at);
    if (state && state.isPrimary && !state.removed) return state;
  }
  return null;
}

export interface PriceHistories {
  standard: Map<string, StandardCostHistoryRow[]>;
  supplier: Map<string, SupplierSnapshotRow[]>;
}

export interface WithdrawalPriceBasis {
  componentArticleId: string;
  standardCost: string | null;
  supplierPrice: string | null;
  supplierCurrency: string | null;
  supplierPriceBreaks: { fromQuantity: number; price: number }[];
}

// Prissatt vid uttaget — THE rule the efterkalkyl and Produkter i arbete (#25)
// share: each component is priced as of `drawnAt` (its latest withdrawal on
// the order; for PIA the latest one on or before the report's day) — the
// standard cost from its history, the primary supplier's catalog row from its
// snapshots, and the Stockholm day of that moment as priceDate, which the
// rate attacher looks the supplier currency up for. A component without a
// withdrawal is priced as of `otherwise` (the efterkalkyl: now). No standard
// history at all: the article's current value, as before.
export function pricedAtWithdrawal<T extends WithdrawalPriceBasis>(
  consumptions: T[],
  drawnAt: Map<string, Date>,
  histories: PriceHistories,
  otherwise: Date
): (T & { priceDate: string })[] {
  return consumptions.map((c) => {
    const at = drawnAt.get(c.componentArticleId) ?? otherwise;
    const supplier = primarySupplierAt(histories.supplier.get(c.componentArticleId) ?? [], at);
    return {
      ...c,
      standardCost: standardCostAt(histories.standard.get(c.componentArticleId) ?? [], at) ?? c.standardCost,
      supplierPrice: supplier?.price ?? null,
      supplierCurrency: supplier?.currency ?? null,
      supplierPriceBreaks: supplier?.priceBreaks ?? [],
      priceDate: stockholmDateOf(at),
    };
  });
}

// ---------------------------------------------------------------------------
// Timkostnad per datum (#14 etapp 4, migration 0189)
// ---------------------------------------------------------------------------

export interface HourlyRateHistoryRow {
  hourlyRate: string;
  validFrom: Date;
}

// The resource's hourly rate as of `at`, by the same convention as every
// history here: the latest row valid then; before the first row, the first
// (the history starts at 0189's backfill, so time before it keeps the rate it
// was priced at until then); no history at all ⇒ null (the caller's current
// rate). `at` is either
// - an instant — the avvikelseanalys's base at T₀ (the order's created_at);
// - a Stockholm day, YYYY-MM-DD — a time report's work day: the latest change
//   made on or before that day, so a change applies to the whole day it was
//   made on (time_reports.date has no time of day).
export function hourlyRateAt(rows: HourlyRateHistoryRow[], at: Date | string): string | null {
  if (rows.length === 0) return null;
  const found =
    typeof at === "string" ? latestWhere(rows, (row) => stockholmDateOf(row.validFrom) <= at) : latestAt(rows, at);
  return (found ?? rows[0]!).hourlyRate;
}

export interface WorkDayHours {
  // The work day (time_reports.date), YYYY-MM-DD.
  date: string;
  hours: number;
}

// Hundredths of an hour: time_reports.hours is numeric(10,2), so every sum
// of it is exact in integers — H is then the same number the SQL sum gave
// (a float sum would make 0.1 + 0.2 + 0.3 + 1 = 1.6000000000000003).
function hundredths(hours: number | string): number {
  return Math.round(Number(hours) * 100);
}

// One group of an operation's time reports — the repositories group on
// (operation, work day[, kind]) and nothing else.
export interface ReportedTimeRow {
  date: string;
  // Ställ/produktion (time_reports.kind, #14 etapp 3); null = ej uppdelad.
  // Left out by a reader that does not group on it (PIA).
  kind?: "setup" | "run" | null;
  hours: number | string;
}

export interface ReportedTime {
  // H: all reported hours on the operation.
  hours: number;
  // Hs/Hr: of H, reported as ställ/produktion — null while no row has a kind
  // (all of H is then ej uppdelad).
  setupHours: number | null;
  runHours: number | null;
  // H per work day, ascending — what laborAtWorkDays prices.
  days: WorkDayHours[];
}

// An operation's reported time, every figure from the SAME rows: H, Hs, Hr
// and the work days Lön is priced on. Read in separate queries a time report
// committed in between made H ≠ Σ H_d, and its whole cost became Timpris in
// a saved analysis for good.
export function reportedTime(rows: ReportedTimeRow[]): ReportedTime {
  let total = 0;
  let setup = 0;
  let run = 0;
  let typed = false;
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const h = hundredths(row.hours);
    total += h;
    byDay.set(row.date, (byDay.get(row.date) ?? 0) + h);
    if (row.kind === "setup") setup += h;
    if (row.kind === "run") run += h;
    if (row.kind) typed = true;
  }
  return {
    hours: total / 100,
    setupHours: typed ? setup / 100 : null,
    runHours: typed ? run / 100 : null,
    days: [...byDay.keys()].sort().map((date) => ({ date, hours: byDay.get(date)! / 100 })),
  };
}

// Lön per arbetsdag — THE rule the efterkalkyl and Produkter i arbete share:
// each work day's hours at that day's hourly rate (hourlyRateAt), summed.
// `hourlyRate` is what the specification row shows: the one rate when every
// day had the same, otherwise the hours-weighted average at the column's two
// decimals (Lön stays the exact sum; the avvikelseanalys's Timpris is Lön −
// R₀ × H, never the average). No hours: the current rate. `hours` is summed
// in hundredths, so it equals reportedTime's H over the same days.
export function laborAtWorkDays(
  days: WorkDayHours[],
  history: HourlyRateHistoryRow[],
  currentRate: number
): { hours: number; laborAmount: number; hourlyRate: number } {
  let totalHundredths = 0;
  let laborAmount = 0;
  const rates = new Set<number>();
  for (const day of days) {
    const rate = Number(hourlyRateAt(history, day.date) ?? currentRate);
    rates.add(rate);
    totalHundredths += hundredths(day.hours);
    laborAmount += day.hours * rate;
  }
  const hours = totalHundredths / 100;
  if (rates.size === 0) return { hours: 0, laborAmount: 0, hourlyRate: currentRate };
  const hourlyRate = rates.size === 1 ? [...rates][0]! : hours !== 0 ? Math.round((laborAmount / hours) * 100) / 100 : currentRate;
  return { hours, laborAmount, hourlyRate };
}
