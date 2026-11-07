// Pegging (#9): which supply covers which demand for ONE article — the
// koppling between a TO and the TOs of its halvfabrikat, derived at read
// time from the artikelöversikt. Pure like article-overview.ts: the service
// loads the overview, the TO supplies' ready dates and the holiday register,
// this module owns the rules.
//
// ONE coverage rule: the quantity each demand is left without is exactly
// what findFirmDemand (due-date-suggestion.ts, built on top of this) and the
// behovsberäkning net — stock plus every open supply, dated, late or
// undated, allocated to the demands in the overview's date order. The
// allocation is FIFO with two pointers: each demand draws from the first
// supply with something left, then the next.
//
// Supplies in order: stock (onHand > 0, ready today) first, then the
// overview's supply rows in overview order (date ascending, undated last).
// Demands in order: negative stock (onHand < 0) is a demand today before
// every other — the shortage the first supply fills, as findFirmDemand sees
// it — then the overview's demand rows in overview order.
//
// Late: an allocation is late when the supply's ready date (floored at
// today — a passed date is not done, it is today at the earliest) lies
// AFTER the demand's date; the same day is on time (the overview puts
// supply before demand on a day). Stock is never late: it is there now,
// and a passed demand date is the parent's own delay, not the stock's. An
// undated supply against a dated demand is `undated` (shown, never late);
// an undated demand is never late. daysLate is counted in working days —
// the holiday set is the caller's.
import { workingDaysBetween } from "../../system/service/delivery-days.js";
import { isFirmOverviewRow, type ArticleOverview, type ArticleOverviewRow, type OverviewRowKind } from "./article-overview.js";

// The stock pseudo-row's id on both sides: the supply "stock" (onHand > 0)
// and the demand "stock" (onHand < 0) can never both exist.
export const STOCK_PEG_ID = "stock";

export type PegSupplyKind = "stock" | Extract<OverviewRowKind, "purchase_order" | "manufacturing_order">;

export interface PegAllocation {
  supplyId: string;
  demandId: string;
  quantity: number;
  // The supply's ready date after the floor at today; null = undated.
  readyDate: string | null;
  late: boolean;
  undated: boolean;
  daysLate: number; // working days after the demand's date; 0 unless late
}

export interface PegDemand {
  id: string;
  // The overview row; null for the negative-stock demand.
  row: ArticleOverviewRow | null;
  date: string | null;
  quantity: number; // positive
  allocations: PegAllocation[];
  uncovered: number;
}

export interface PegSupply {
  id: string;
  kind: PegSupplyKind;
  // The overview row; null for stock.
  row: ArticleOverviewRow | null;
  readyDate: string | null; // floored at today; null = undated
  quantity: number; // positive
  allocations: PegAllocation[];
  surplus: number; // what no demand takes — "till lager"
}

export interface Pegging {
  demands: PegDemand[];
  supplies: PegSupply[];
}

export interface PegOptions {
  today: string;
  // Ready date per overview supply row id (the TO supplies' plannedFinish ??
  // dueDate — the same rule that decides Sen; null = undated). A row not in
  // the map is ready on its own date.
  readyDates: ReadonlyMap<string, string | null>;
  // Full-day holidays for daysLate; omitted = weekends only.
  offDays?: ReadonlySet<string>;
}

// Same scale as the overview (numeric(14,4)) — keeps float noise from
// turning an exactly covered demand into a 1e-15 shortage.
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

export function pegOverview(overview: ArticleOverview, opts: PegOptions): Pegging {
  const offDays = opts.offDays ?? new Set<string>();
  const floor = (date: string | null) => (date === null ? null : date < opts.today ? opts.today : date);

  const supplies: PegSupply[] = [];
  const demands: PegDemand[] = [];
  if (overview.onHand > 0) {
    supplies.push({ id: STOCK_PEG_ID, kind: "stock", row: null, readyDate: opts.today, quantity: round4(overview.onHand), allocations: [], surplus: 0 });
  } else if (overview.onHand < 0) {
    demands.push({ id: STOCK_PEG_ID, row: null, date: opts.today, quantity: round4(-overview.onHand), allocations: [], uncovered: 0 });
  }
  for (const row of overview.rows) {
    // Prognos (#10): a forecast row is not a firm demand — it never takes a
    // supply, so it never moves a färdigdatum or a koppling (and
    // findFirmDemand, built on this, never dates a TO from it).
    if (!isFirmOverviewRow(row)) continue;
    if (row.direction === "supply") {
      const ready = opts.readyDates.has(row.id) ? (opts.readyDates.get(row.id) ?? null) : row.date;
      supplies.push({
        id: row.id,
        kind: row.kind as PegSupplyKind,
        row,
        readyDate: floor(ready),
        quantity: round4(row.quantity),
        allocations: [],
        surplus: 0,
      });
    } else {
      demands.push({ id: row.id, row, date: row.date, quantity: round4(-row.quantity), allocations: [], uncovered: 0 });
    }
  }

  // FIFO with two pointers.
  let s = 0;
  let left = supplies[0]?.quantity ?? 0;
  for (const demand of demands) {
    let need = demand.quantity;
    while (need > 0 && s < supplies.length) {
      if (left <= 0) {
        s++;
        left = supplies[s]?.quantity ?? 0;
        continue;
      }
      const supply = supplies[s]!;
      const quantity = round4(Math.min(need, left));
      const dated = demand.date !== null && supply.readyDate !== null && supply.kind !== "stock";
      const late = dated && supply.readyDate! > demand.date!;
      const allocation: PegAllocation = {
        supplyId: supply.id,
        demandId: demand.id,
        quantity,
        readyDate: supply.readyDate,
        late,
        undated: demand.date !== null && supply.readyDate === null,
        daysLate: late ? workingDaysBetween(demand.date!, supply.readyDate!, offDays) : 0,
      };
      demand.allocations.push(allocation);
      supply.allocations.push(allocation);
      need = round4(need - quantity);
      left = round4(left - quantity);
    }
    demand.uncovered = need;
  }
  for (let i = s; i < supplies.length; i++) {
    supplies[i]!.surplus = i === s ? round4(Math.max(left, 0)) : supplies[i]!.quantity;
  }
  return { demands, supplies };
}
