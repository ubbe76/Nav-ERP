import { asc, eq, sql } from "drizzle-orm";
import { articleAlternativeLocations, articles, stockLocations, stockTransactions, type Db, type Tx } from "@navet/db";
import { FALLBACK_LOCATION_NAME } from "./location-resolver.js";

// A TEMPORARY stock location (fixed = false) where every article nets to zero
// is no longer in use, so it is deactivated and disappears from every location
// picker. The row itself has to stay: stock_transactions.location_id is NOT
// NULL / ON DELETE restrict and the transaction log must keep showing where the
// stock used to be. A FIXED location (the default since migration 0179) is
// never pruned — a shelf that runs empty is still the article's shelf, and
// the next receipt must land there, not on "***". The "***" fallback location
// is never pruned either — the resolver depends on it existing.
//
// Same shape as location-resolver.ts: a plain async function taking Db | Tx, so
// every stock writer can call it inside its own repository transaction.
export async function deactivateEmptyLocation(db: Db | Tx, locationId: string): Promise<boolean> {
  const [location] = await db
    .select({ name: stockLocations.name, active: stockLocations.active, fixed: stockLocations.fixed })
    .from(stockLocations)
    .where(eq(stockLocations.id, locationId));
  if (!location || !location.active || location.fixed || location.name === FALLBACK_LOCATION_NAME) return false;

  // The usual case — something is left on the place — is answered WITHOUT a
  // lock. Locking first made every decrement on a temporary place ask for all
  // of the place's articles, so two draws of different articles from it
  // (each already holding its own article) deadlocked.
  if (await locationHoldsStock(db, locationId)) return false;

  // It looks empty. Lock order article → place, as in every draw: the
  // articles whose Lagerplats this is (sorted), then the place row itself.
  // An Automatiskt draw of such an article holds the article and then asks
  // for the place FOR SHARE (outflow-locations.ts), so taking the place first
  // and the article after could wait crosswise with it. The place lock waits
  // out every draw that holds the place FOR SHARE. Then the emptiness is
  // tried again: a draw that held one of those locks has committed and is
  // seen. (Two transactions can only both see the place empty when they
  // drew the same article, and the draws serialise on the article first.)
  await db
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.defaultLocationId, locationId))
    .orderBy(asc(articles.id))
    .for("no key update");
  await db.select({ id: stockLocations.id }).from(stockLocations).where(eq(stockLocations.id, locationId)).for("no key update");
  if (await locationHoldsStock(db, locationId)) return false;

  // A Spärrad lagerplats keeps its spärr (0185) — a revived one is still blocked.
  await db.update(stockLocations).set({ active: false }).where(eq(stockLocations.id, locationId));

  // Nothing may auto-resolve into a hidden location — articles pointing here
  // fall back to their alternative places, then "***" (the transfer routine
  // repoints the moved ones after). No alternative place is promoted: the
  // huvudplats stays empty until someone chooses one.
  await db
    .update(articles)
    .set({ defaultLocationId: null })
    .where(eq(articles.defaultLocationId, locationId));

  // Its assignments as an alternative place (0186) go too. The articles that
  // have it only as an alternative are NOT locked first: the DELETE takes no
  // lock on an article row (a child row, no FK check on its parent), so
  // there is no article-after-place lock to put in order — and locking them
  // would only widen the accepted crosswise deadlock (two draws that each
  // empty a place the other's article uses) to more articles. A draw of such an
  // article holds the place FOR SHARE (lockOutflowCandidates takes every
  // alternative), so the place lock above has already waited it out, and a
  // draw that comes after waits for this one and then reads the place gone.
  // A PUT /articles/:id/locations locks its places FOR SHARE after the
  // article, so it is ordered against this place lock the same way.
  await db.delete(articleAlternativeLocations).where(eq(articleAlternativeLocations.locationId, locationId));

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
