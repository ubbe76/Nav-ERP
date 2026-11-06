// Användbart saldo — THE reader of an article's stock as the planning sees
// it: Σ quantity_on_hand over its places, split into what is usable and what
// lies on a Spärrad lagerplats (migration 0185). Every reader that means
// usable stock (the behovsberäkning, the artikelöversikt and with it the
// Leveranstidskontroll and the färdigdatumsförslag, Materialbrist, the
// release-time shortage warning) calls this; nobody spreads their own filter
// on stock_locations.blocked. Physical balances (Saldon, the valuation, the
// stock log, a place's own balance) read stock_balances/stock_transactions
// directly — stock-on-hand-readers.test.ts makes every new reader pick a side.
//
// Leaf (schema imports only, Db | Tx) like valued-at.ts, so a caller can read
// inside its own transaction (Materialbrist after its draws, the
// Leveranstidskontroll's reservation). ONE query giving both parts, which a
// view could not.
import { eq, inArray, sql } from "drizzle-orm";
import { stockBalances, stockLocations, type Db, type Tx } from "@navet/db";

export interface ArticleOnHand {
  // On places that are not blocked, plus every MINUS on a blocked place —
  // may be negative.
  usable: number;
  // The plus on blocked places — shown, never counted. Never negative.
  blocked: number;
}

// The split, per place balance: a minus is never goods on hold. It is a
// debt — Automatiskt's remainder went negative on the Lagerplats before it
// was blocked, or a kassation took more than the blocked place held — and the
// goods really came from a usable place. Counted as blocked it would leave
// the usable part too high (−3 blocked, +10 open: 7 physically, not 10).
// usable + blocked is still the physical balance.

// Without articleIds: every article with a stock row (the behovsberäkning).
// An article without rows is absent — read it as 0.
export async function onHandByArticle(dbc: Db | Tx, articleIds?: readonly string[]): Promise<Map<string, ArticleOnHand>> {
  const result = new Map<string, ArticleOnHand>();
  if (articleIds && articleIds.length === 0) return result;
  const rows = await dbc
    .select({
      articleId: stockBalances.articleId,
      usable: sql<string>`coalesce(sum(${stockBalances.quantityOnHand}) filter (where not ${stockLocations.blocked} or ${stockBalances.quantityOnHand} < 0), 0)`,
      blocked: sql<string>`coalesce(sum(${stockBalances.quantityOnHand}) filter (where ${stockLocations.blocked} and ${stockBalances.quantityOnHand} > 0), 0)`,
    })
    .from(stockBalances)
    .innerJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
    .where(articleIds ? inArray(stockBalances.articleId, [...new Set(articleIds)]) : undefined)
    .groupBy(stockBalances.articleId);
  for (const row of rows) result.set(row.articleId, { usable: Number(row.usable), blocked: Number(row.blocked) });
  return result;
}
