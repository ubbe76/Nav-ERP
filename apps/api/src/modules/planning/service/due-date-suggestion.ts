// Färdigdatumsförslag for a new TO: one working day before the article's
// first firm (skarpt) demand — a KO row or TO material need that stock and
// the open purchase/manufacturing orders do NOT already cover — or, for a TO
// made from a KO row, before that row's own delivery date if the row itself
// is uncovered. Never in the past: a passed date is moved up to today.
//
// Coverage is by QUANTITY, not time-phased: stock plus every open IO/TO
// (dated, late or undated) is allocated to the demands in date order, the
// same netting the behovsberäkning does. A demand an existing order already
// covers is that order's business — even if the order is late or has no
// date yet — and must not pull a new TO's date forward.
//
// Pure, like article-overview.ts: the service loads the overview and the
// holiday register, this module owns the rules. Split in two because the
// demand date decides which holidays the service has to load.
import type { ArticleOverview, ArticleOverviewRow } from "./article-overview.js";

export interface FirmDemand {
  date: string; // YYYY-MM-DD
  // "sales_order_row" = the linked KO row itself; "shortage" = the first
  // uncovered demand (or negative stock the supply doesn't make up, which
  // is a shortage today).
  source: "sales_order_row" | "shortage";
  documentType: ArticleOverviewRow["documentType"] | null;
  documentId: string | null;
  documentNumber: string | null; // null = negative stock, no document
}

export interface DueDateSuggestion extends Omit<FirmDemand, "date"> {
  dueDate: string;
  demandDate: string;
  // The working day before the demand had already passed — today instead.
  clampedToToday: boolean;
}

function fromRow(row: ArticleOverviewRow & { date: string }, source: FirmDemand["source"]): FirmDemand {
  return {
    date: row.date,
    source,
    documentType: row.documentType,
    documentId: row.documentId,
    documentNumber: row.documentNumber,
  };
}

const hasDate = (row: ArticleOverviewRow): row is ArticleOverviewRow & { date: string } => row.date !== null;

// Same scale as the overview (numeric(14,4)) — keeps float noise from
// turning an exactly covered demand into a 1e-15 shortage.
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

export function findFirmDemand(
  overview: ArticleOverview,
  opts: { today: string; salesOrderRowId?: string }
): FirmDemand | null {
  let available = round4(
    overview.rows.filter((r) => r.direction === "supply").reduce((sum, r) => sum + r.quantity, overview.onHand)
  );
  if (available < 0) {
    return { date: opts.today, source: "shortage", documentType: null, documentId: null, documentNumber: null };
  }
  // Demands in the overview's date order (undated last); quantity is signed,
  // so adding it draws the pool down.
  const uncovered: ArticleOverviewRow[] = [];
  for (const row of overview.rows) {
    if (row.direction !== "demand") continue;
    available = round4(available + row.quantity);
    if (available < 0) uncovered.push(row);
  }

  if (opts.salesOrderRowId) {
    const linked = uncovered.find((r) => r.id === `so:${opts.salesOrderRowId}`);
    if (linked && hasDate(linked)) return fromRow(linked, "sales_order_row");
  }
  // An undated first shortage (every dated demand is covered) gives nothing
  // to plan by.
  const first = uncovered[0];
  return first && hasDate(first) ? fromRow(first, "shortage") : null;
}

// Calendar arithmetic on YYYY-MM-DD strings in UTC, so no local time zone or
// DST shift can move a date.
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A working day is Monday–Friday and not a full-day holiday (offDays = the
// holiday register's dates without a day schedule). The company has no
// week schedule of its own — resources and employees do — so the weekend
// is the fixed default.
export function isWorkingDay(date: string, offDays: ReadonlySet<string>): boolean {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return weekday !== 0 && weekday !== 6 && !offDays.has(date);
}

export function previousWorkingDay(date: string, offDays: ReadonlySet<string>): string {
  let day = addDays(date, -1);
  // Bounded: a register that marks a whole year off can't loop forever.
  for (let i = 0; i < 366 && !isWorkingDay(day, offDays); i++) day = addDays(day, -1);
  return day;
}

// How far back previousWorkingDay can reach in practice — the service loads
// holidays for [demandDate − HOLIDAY_LOOKBACK_DAYS, demandDate].
export const HOLIDAY_LOOKBACK_DAYS = 31;
export const holidayLookbackStart = (demandDate: string) => addDays(demandDate, -HOLIDAY_LOOKBACK_DAYS);

export function suggestDueDate(
  demand: FirmDemand,
  opts: { today: string; offDays: ReadonlySet<string> }
): DueDateSuggestion {
  const { date, ...rest } = demand;
  const workingDayBefore = previousWorkingDay(date, opts.offDays);
  const clampedToToday = workingDayBefore < opts.today;
  return { ...rest, demandDate: date, dueDate: clampedToToday ? opts.today : workingDayBefore, clampedToToday };
}
