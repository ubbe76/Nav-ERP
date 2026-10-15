import { round2 } from "@navet/shared";

// Anläggningsregister (ekonomi etapp 2, delprojekt 2) — the pure plan
// arithmetic. Leaf file: no DB access, nothing imported from the economy
// services (same reasoning as month-periods.ts), so the service, the poster
// and the tests all share ONE definition of what a month's depreciation is.
//
// Month keys are "YYYY-MM" strings: they sort lexicographically, which is
// all the comparisons below need.

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function monthStart(key: string): string {
  return `${key}-01`;
}

export function monthEnd(key: string): string {
  const [year, month] = key.split("-").map(Number);
  // Day 0 of the NEXT month is the last day of this one — handles 28/29/30/31.
  const lastDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return `${key}-${String(lastDay).padStart(2, "0")}`;
}

export function addMonths(key: string, count: number): string {
  const [year, month] = key.split("-").map(Number);
  const index = year! * 12 + (month! - 1) + count;
  const newYear = Math.floor(index / 12);
  const newMonth = index - newYear * 12 + 1;
  return `${String(newYear).padStart(4, "0")}-${String(newMonth).padStart(2, "0")}`;
}

// Signed: positive when `to` is after `from`.
export function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  return (toYear! - fromYear!) * 12 + (toMonth! - fromMonth!);
}

export function lastDepreciationMonth(startMonth: string, usefulLifeMonths: number): string {
  return addMonths(startMonth, usefulLifeMonths - 1);
}

export interface DepreciationPlanInput {
  acquisitionCost: number;
  residualValue: number;
  usefulLifeMonths: number;
  depreciationStartMonth: string; // "YYYY-MM"
  // The asset's rows that still count (superseded_by_run_id IS NULL),
  // whichever run wrote them. Contiguous from the start month by
  // construction — runs always fill every missing month up to throughMonth.
  bookedMonths: { month: string; amount: number }[];
}

export interface PlannedDepreciation {
  month: string;
  amount: number;
}

// The plan rule (spec 2.2): the REMAINING base (cost − residual − booked) is
// spread evenly over the REMAINING months; the calendar-last month of the
// useful life takes whatever is left so the lifetime sum is exact. Without
// any edits this is linear depreciation; after a prospective change of
// useful life or residual value it automatically re-spreads the remainder
// (K2: ändrad bedömning av nyttjandeperiod) without touching booked rows.
//
// Months whose rounded amount is 0 produce no row (a row's amount must be
// > 0) — the remainder still lands in the last month, and because the
// schedule is keyed on the calendar (not on a row count) a skipped month
// never shifts later months.
export function missingMonths(input: DepreciationPlanInput, throughMonth: string): PlannedDepreciation[] {
  const base = round2(input.acquisitionCost - input.residualValue);
  const bookedSum = round2(input.bookedMonths.reduce((sum, row) => sum + row.amount, 0));
  let remainingBase = round2(base - bookedSum);
  if (remainingBase <= 0) return [];

  const lastBooked = input.bookedMonths.reduce<string | null>(
    (latest, row) => (latest === null || row.month > latest ? row.month : latest),
    null
  );
  let month = lastBooked === null ? input.depreciationStartMonth : addMonths(lastBooked, 1);
  const lastMonth = lastDepreciationMonth(input.depreciationStartMonth, input.usefulLifeMonths);
  const end = throughMonth < lastMonth ? throughMonth : lastMonth;

  const rows: PlannedDepreciation[] = [];
  while (month <= end) {
    // Recomputed per month from the booked history only, so the amounts do
    // not depend on how months are split into runs (cadence independence).
    const amount = month === lastMonth ? remainingBase : round2(remainingBase / (monthsBetween(month, lastMonth) + 1));
    if (amount > 0) rows.push({ month, amount });
    remainingBase = round2(remainingBase - amount);
    month = addMonths(month, 1);
  }
  return rows;
}

// --- Ingående avskrivning ---
//
// An asset acquired before the company kept its books in Nav already carries
// accumulated depreciation in the opening balance. The register stores that
// amount and the month it is valid through on the asset itself and treats it
// EXACTLY like months already booked: a synthetic booked entry on the
// through-month, so missingMonths() starts the month after and spreads only
// the remaining base. Nothing is ever written to fixed_asset_depreciations
// for it. These two helpers are the ONLY place that knowledge lives — every
// bookedMonths list handed to the plan rule (run, preview, asset card,
// disposal, plan report) goes through withOpeningDepreciation.

export interface OpeningDepreciationFields {
  openingDepreciation: string | number; // numeric(14,2) as the repo's string, or a number
  openingDepreciationThroughMonth: string | null; // "YYYY-MM-01" (row) or "YYYY-MM"
}

export interface BookedEntry {
  month: string; // "YYYY-MM"
  amount: number;
}

// The opening amount as a booked entry, or null when the asset has none.
// Accepts both the stored row shape and the service's merged "YYYY-MM" shape.
export function openingDepreciationOf(asset: OpeningDepreciationFields): BookedEntry | null {
  const amount = round2(Number(asset.openingDepreciation));
  if (amount <= 0 || asset.openingDepreciationThroughMonth === null) return null;
  return { month: monthKey(asset.openingDepreciationThroughMonth), amount };
}

// Live rows + the opening entry (first, it is the oldest). Σ of the result is
// the asset's accumulated depreciation; its max month is where the plan resumes.
export function withOpeningDepreciation(asset: OpeningDepreciationFields, booked: BookedEntry[]): BookedEntry[] {
  const opening = openingDepreciationOf(asset);
  return opening ? [opening, ...booked] : booked;
}

export interface DisposalInput {
  acquisitionCost: number;
  accumulatedDepreciation: number; // Σ gällande rader AFTER the catch-up run
  disposalPrice: number; // 0 for utrangering
}

export function disposalAmounts(input: DisposalInput): { bookValue: number; gain: number; loss: number } {
  const bookValue = round2(input.acquisitionCost - input.accumulatedDepreciation);
  const difference = round2(input.disposalPrice - bookValue);
  return { bookValue, gain: difference > 0 ? difference : 0, loss: difference < 0 ? -difference : 0 };
}

export type DisposalPostingRole = "asset" | "accumulated" | "intermediate" | "gain" | "loss";

export interface DisposalPostingRow {
  role: DisposalPostingRole;
  amount: number; // signed: positive = debet, negative = kredit
}

// Spec 3.4/6: kredit tillgångskonto, debet ack-konto, debet mellankonto
// (priset), kredit vinst / debet förlust. Zero rows are omitted — the poster
// and the disposal preview both render exactly this list.
export function disposalPostingRows(input: DisposalInput): DisposalPostingRow[] {
  const { gain, loss } = disposalAmounts(input);
  const rows: DisposalPostingRow[] = [{ role: "asset", amount: -round2(input.acquisitionCost) }];
  if (input.accumulatedDepreciation > 0) rows.push({ role: "accumulated", amount: round2(input.accumulatedDepreciation) });
  if (input.disposalPrice > 0) rows.push({ role: "intermediate", amount: round2(input.disposalPrice) });
  if (gain > 0) rows.push({ role: "gain", amount: -gain });
  if (loss > 0) rows.push({ role: "loss", amount: loss });
  return rows;
}
