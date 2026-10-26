import {
  addMeasure,
  finishCounts,
  measureOrder,
  monthAxis,
  type PrecisionCounts,
  type PrecisionOrderInput,
} from "./delivery-precision-calc.js";

// Leveransprecision — Gruppera: Motpart (Kvalitet). Pure: per supplier
// (inköp) or customer (försäljning) the same precision columns as the month
// view (measured with measureOrder, the one rule) plus the quality:
//
// - Avvikelser: the counterparty's cases of the matching type (leverantörs-
//   avvikelse / kundreklamation) with Datum in the period, not cancelled.
// - Order med avvikelse / Andel felfria: of the orders measured in the
//   precision, those with a case (any date, not cancelled) linked through the
//   case's KO/IO column — and the share without one.
// - Reklamerat antal: the period's cases' quantity per article; a total only
//   when every quantity is in the same unit (mixed units never add up).
// - Avvikelsekostnad: the period's cases' net cost (deviation-costs.ts),
//   null for a user who may not see prices.

export interface QualityDeviationInput {
  counterpartyId: string;
  counterpartyName: string | null;
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
  unitCode: string | null;
  quantity: number | null;
  netCost: number;
}

export interface ClaimedArticle {
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
  unitCode: string | null;
  quantity: number;
}

export interface CounterpartyPrecisionRow {
  counterpartyId: string;
  counterpartyName: string;
  total: number;
  onTime: number;
  late: number;
  precisionPct: number | null;
  avgDaysLate: number | null;
  deviations: number;
  ordersWithDeviation: number;
  defectFreePct: number | null;
  claimedQuantity: number | null;
  claimedUnit: string | null;
  claimedByArticle: ClaimedArticle[];
  deviationCost: number | null;
}

export type CounterpartyPrecisionTotals = Omit<CounterpartyPrecisionRow, "counterpartyId" | "counterpartyName">;

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

// The ids of the orders the precision measures in the range — the
// population of Order med avvikelse.
export function measuredOrderIds(orders: PrecisionOrderInput[], range: { from: string; to: string }): string[] {
  const months = new Set(monthAxis(range.from, range.to));
  return orders.filter((o) => o.orderId && measureOrder(o, months).kind === "measured").map((o) => o.orderId!);
}

// The day range of a month range (from the 1st through the last day).
export function monthRangeDates(range: { from: string; to: string }): { fromDate: string; toDate: string } {
  const [year, month] = range.to.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { fromDate: `${range.from}-01`, toDate: `${range.to}-${String(lastDay).padStart(2, "0")}` };
}

interface Acc {
  name: string;
  counts: PrecisionCounts;
  deviations: number;
  ordersWithDeviation: number;
  claimed: Map<string, ClaimedArticle>;
  cost: number;
}

function claimedTotal(claimed: ClaimedArticle[]): { quantity: number | null; unit: string | null } {
  if (claimed.length === 0) return { quantity: null, unit: null };
  const units = new Set(claimed.map((c) => c.unitCode));
  if (units.size !== 1 || claimed[0]!.unitCode === null) return { quantity: null, unit: null };
  return { quantity: round4(claimed.reduce((sum, c) => sum + c.quantity, 0)), unit: claimed[0]!.unitCode };
}

function defectFree(total: number, withDeviation: number): number | null {
  return total > 0 ? Math.round(((total - withDeviation) / total) * 100) : null;
}

export function groupPrecisionByCounterparty(
  orders: PrecisionOrderInput[],
  range: { from: string; to: string },
  quality: { deviations: QualityDeviationInput[]; ordersWithDeviation: ReadonlySet<string> },
  opts: { seePrices: boolean }
): { rows: CounterpartyPrecisionRow[]; totals: CounterpartyPrecisionTotals } {
  const months = new Set(monthAxis(range.from, range.to));
  const byParty = new Map<string, Acc>();
  const acc = (id: string, name: string | null | undefined): Acc => {
    let entry = byParty.get(id);
    if (!entry) {
      entry = { name: name ?? "", counts: { total: 0, onTime: 0, late: 0, lateDays: 0 }, deviations: 0, ordersWithDeviation: 0, claimed: new Map(), cost: 0 };
      byParty.set(id, entry);
    }
    if (!entry.name && name) entry.name = name;
    return entry;
  };

  for (const order of orders) {
    if (!order.counterpartyId) continue;
    const measure = measureOrder(order, months);
    if (measure.kind !== "measured") continue;
    const entry = acc(order.counterpartyId, order.counterpartyName);
    addMeasure(entry.counts, measure.daysLate);
    if (order.orderId && quality.ordersWithDeviation.has(order.orderId)) entry.ordersWithDeviation += 1;
  }

  for (const d of quality.deviations) {
    const entry = acc(d.counterpartyId, d.counterpartyName);
    entry.deviations += 1;
    entry.cost += d.netCost;
    if (d.quantity !== null) {
      const key = d.articleId ?? `unit:${d.unitCode ?? ""}`;
      const claimed = entry.claimed.get(key) ?? {
        articleId: d.articleId,
        articleNumber: d.articleNumber,
        articleName: d.articleName,
        unitCode: d.unitCode,
        quantity: 0,
      };
      claimed.quantity = round4(claimed.quantity + d.quantity);
      entry.claimed.set(key, claimed);
    }
  }

  const rows: CounterpartyPrecisionRow[] = [...byParty.entries()]
    .map(([counterpartyId, entry]) => {
      const claimedByArticle = [...entry.claimed.values()].sort((a, b) => (a.articleNumber ?? "").localeCompare(b.articleNumber ?? "", "sv"));
      const total = claimedTotal(claimedByArticle);
      return {
        counterpartyId,
        counterpartyName: entry.name,
        ...finishCounts(entry.counts),
        deviations: entry.deviations,
        ordersWithDeviation: entry.ordersWithDeviation,
        defectFreePct: defectFree(entry.counts.total, entry.ordersWithDeviation),
        claimedQuantity: total.quantity,
        claimedUnit: total.unit,
        claimedByArticle,
        deviationCost: opts.seePrices ? round2(entry.cost) : null,
      };
    })
    .sort((a, b) => a.counterpartyName.localeCompare(b.counterpartyName, "sv"));

  const overall: PrecisionCounts = { total: 0, onTime: 0, late: 0, lateDays: 0 };
  let deviations = 0;
  let withDeviation = 0;
  let cost = 0;
  const allClaimed: ClaimedArticle[] = [];
  for (const entry of byParty.values()) {
    overall.total += entry.counts.total;
    overall.onTime += entry.counts.onTime;
    overall.late += entry.counts.late;
    overall.lateDays += entry.counts.lateDays;
    deviations += entry.deviations;
    withDeviation += entry.ordersWithDeviation;
    cost += entry.cost;
    allClaimed.push(...entry.claimed.values());
  }
  const claimed = claimedTotal(allClaimed);
  return {
    rows,
    totals: {
      ...finishCounts(overall),
      deviations,
      ordersWithDeviation: withDeviation,
      defectFreePct: defectFree(overall.total, withDeviation),
      claimedQuantity: claimed.quantity,
      claimedUnit: claimed.unit,
      claimedByArticle: [],
      deviationCost: opts.seePrices ? round2(cost) : null,
    },
  };
}
