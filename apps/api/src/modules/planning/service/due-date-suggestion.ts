// Färdigdatumsförslag for a new TO: one working day before the article's
// first firm (skarpt) demand — a KO row or TO material need that stock and
// the open purchase/manufacturing orders do NOT already cover — or, for a TO
// made from a KO row, before that row's own delivery date if the row itself
// is uncovered. Never before the earliest possible finish (today plus the
// lead time): a date below that floor is moved up to it and flagged late.
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
import { addDays, addWorkingDays, isWorkingDay, previousWorkingDay } from "../../system/service/delivery-days.js";
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
  // The working day before the demand comes before the earliest possible
  // finish (today + the lead time in working days) — that floor is
  // suggested instead and the TO will be late for the demand. The same
  // pattern as suggestPurchaseDeliveryDate's floor.
  late: boolean;
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

// The working-day calendar lives in the delivery-days leaf (one
// implementation); re-exported here for the existing callers.
export { addDays, isWorkingDay, previousWorkingDay };

// How far back previousWorkingDay can reach in practice — the service loads
// holidays for [demandDate − HOLIDAY_LOOKBACK_DAYS, demandDate].
export const HOLIDAY_LOOKBACK_DAYS = 31;
export const holidayLookbackStart = (demandDate: string) => addDays(demandDate, -HOLIDAY_LOOKBACK_DAYS);

// The färdigdatum: the working day before the demand, but never before the
// earliest possible finish — today plus `leadDays` working days
// (manufacturing-lead-time.ts; 0 = today, so a TO without lead time is
// still suggested today at the earliest). Below the floor the floor is
// suggested and `late` says the demand will not be met in time.
export function suggestDueDate(
  demand: FirmDemand,
  opts: { today: string; offDays: ReadonlySet<string>; leadDays: number }
): DueDateSuggestion {
  const { date, ...rest } = demand;
  const workingDayBefore = previousWorkingDay(date, opts.offDays);
  const floor = addWorkingDays(opts.today, Math.max(0, opts.leadDays), opts.offDays);
  const late = workingDayBefore < floor;
  return { ...rest, demandDate: date, dueDate: late ? floor : workingDayBefore, late };
}
