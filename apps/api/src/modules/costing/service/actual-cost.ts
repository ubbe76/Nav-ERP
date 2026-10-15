import { computeMovingAverage } from "../../stock/service/moving-average.js";

// Verklig kostnad — the actual unit cost of the material a manufacturing order
// consumed, derived from the stock log. Pure: the repository hands it the two
// row sets and gets a per-article price back, so the whole rule is testable
// without a database (the same shape computeMovingAverage itself has).
//
// Why derived and not read: D0 stamps stock_transactions.unit_cost on INFLOWS
// only — an outflow has no price of its own, because its price is whatever the
// stock was worth at that moment. So each draw is valued at the moving average
// as of just before it, and the order's draws of one article are combined
// weighted by quantity.

export interface DrawRow {
  articleId: string;
  /** Negative, as the consumption booked it. */
  quantityDelta: string;
  createdAt: Date;
  id: string;
}

export interface HistoryRow {
  articleId: string;
  quantityDelta: string;
  unitCost: string | null;
  createdAt: Date;
  id: string;
}

// null for an article whose draws could not all be priced — an honest fallback
// to the standard cost explains itself, while a half-derived average does not.
export function weightedActualCosts(draws: DrawRow[], history: HistoryRow[]): Map<string, number | null> {
  const drawIds = new Set(draws.map((d) => d.id));
  const byArticle = new Map<string, HistoryRow[]>();
  for (const row of history) {
    const list = byArticle.get(row.articleId);
    if (list) list.push(row);
    else byArticle.set(row.articleId, [row]);
  }

  const result = new Map<string, number | null>();
  for (const articleId of new Set(draws.map((d) => d.articleId))) {
    const rows = byArticle.get(articleId) ?? [];
    let weighted = 0;
    let quantity = 0;
    let unpriced = false;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (!drawIds.has(row.id)) continue;

      // The average BEFORE this draw. Outflows never move the average, so
      // slice(0, i) and slice(0, i + 1) agree — the exclusive form simply says
      // what is meant: stock is consumed at what it was worth on arrival.
      const { average } = computeMovingAverage(
        rows.slice(0, i).map((r) => ({ quantityDelta: Number(r.quantityDelta), unitCost: r.unitCost === null ? null : Number(r.unitCost) }))
      );
      if (average === null) {
        // Drawn before the first priced receipt — nothing to average yet.
        unpriced = true;
        break;
      }
      const drawn = Math.abs(Number(row.quantityDelta));
      weighted += drawn * average;
      quantity += drawn;
    }

    result.set(articleId, unpriced || quantity === 0 ? null : weighted / quantity);
  }
  return result;
}
