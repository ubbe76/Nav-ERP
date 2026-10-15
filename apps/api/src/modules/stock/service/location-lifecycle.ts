import { eq, sql } from "drizzle-orm";
import { articles, stockLocations, stockTransactions, type Db, type Tx } from "@navet/db";
import { FALLBACK_LOCATION_NAME } from "./location-resolver.js";

// A stock location where every article nets to zero is no longer in use, so it
// is deactivated and disappears from every location picker. The row itself has
// to stay: stock_transactions.location_id is NOT NULL / ON DELETE restrict and
// the transaction log must keep showing where the stock used to be. The "***"
// fallback location is never pruned — the resolver depends on it existing.
//
// Same shape as location-resolver.ts: a plain async function taking Db | Tx, so
// every stock writer can call it inside its own repository transaction.
export async function deactivateEmptyLocation(db: Db | Tx, locationId: string): Promise<boolean> {
  const [location] = await db
    .select({ name: stockLocations.name, active: stockLocations.active })
    .from(stockLocations)
    .where(eq(stockLocations.id, locationId));
  if (!location || !location.active || location.name === FALLBACK_LOCATION_NAME) return false;

  if (await locationHoldsStock(db, locationId)) return false;

  await db.update(stockLocations).set({ active: false }).where(eq(stockLocations.id, locationId));

  // Nothing may auto-resolve into a hidden location — articles pointing here
  // fall back to "***" (the transfer routine repoints the moved ones after).
  await db
    .update(articles)
    .set({ defaultLocationId: null })
    .where(eq(articles.defaultLocationId, locationId));

  return true;
}

// Per article, not the location total: +5 of one article and -5 of another
// sums to zero without the location being empty.
export async function locationHoldsStock(db: Db | Tx, locationId: string): Promise<boolean> {
  const remaining = await db
    .select({ articleId: stockTransactions.articleId })
    .from(stockTransactions)
    .where(eq(stockTransactions.locationId, locationId))
    .groupBy(stockTransactions.articleId)
    .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`)
    .limit(1);
  return remaining.length > 0;
}
