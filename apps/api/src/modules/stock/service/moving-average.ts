// Moving-average (glidande medelpris) replay for the valuation report (D1).
// Pure — the service feeds it one article's stock_transactions rows in
// chronological order and gets the quantity and average unit cost at the
// report date back. Nothing is ever stored: the rows are the record and the
// average is always derived (arkitekturprincip 1).
import { round2 } from "@navet/shared";

export interface MovingAverageRow {
  // Positive = inflow, negative = outflow.
  quantityDelta: number;
  // Cost per unit in SEK — stamped by D0 on inflows; null on outflows,
  // stock-transfer legs, pre-D0 rows and inflows of articles without a
  // standard cost. Note that 0 is a real price ("worthless"), not unknown.
  unitCost: number | null;
}

export interface MovingAverageResult {
  quantity: number;
  // null until the first priced inflow — an average cannot be invented.
  average: number | null;
}

export function computeMovingAverage(rows: MovingAverageRow[]): MovingAverageResult {
  let quantity = 0;
  let average: number | null = null;

  for (const row of rows) {
    const delta = row.quantityDelta;
    const isPricedInflow = delta > 0 && row.unitCost !== null;

    if (isPricedInflow) {
      const cost = row.unitCost!;
      if (quantity <= 0 || average === null) {
        // The weighted formula is undefined across a zero crossing (and
        // against an unknown average): stock that no longer exists cannot
        // weight the price of stock that just arrived. The inflow SETS the
        // average.
        average = round2(cost);
      } else {
        average = round2((quantity * average + delta * cost) / (quantity + delta));
      }
    }
    // Outflows and unpriced inflows change the quantity only: an outflow
    // consumes at the current average by definition, and an unpriced inflow
    // must not drag the average toward zero — its cost is unknown, not free.

    quantity = round4(quantity + delta);
  }

  return { quantity, average };
}

// Quantities live in numeric(14,4); rounding at 2 decimals would corrupt
// fractional stock (0.125 kg), so quantity keeps 4 decimals while the
// average (money) keeps the house's öre-level round2.
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
