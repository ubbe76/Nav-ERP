import { and, eq, inArray, or, sql } from "drizzle-orm";
import { articleAlternativeLocations, articles, stockLocations, warehouses, type Db, type Tx } from "@navet/db";
import { articlePlacePreference, FALLBACK_LOCATION_NAME } from "./outflow-allocation.js";

// Stock locations are mandatory on every stock movement, but the caller may
// leave the location out — it then resolves in this order:
//
//   1. the explicitly given location
//   2. the article's huvudplats (articles.default_location_id), but only
//      while that location is still active — an emptied location is
//      deactivated (see location-lifecycle.ts) and must never be resolved into
//      — and not blocked: a Spärrad lagerplats (0185) only takes goods someone
//      put there on purpose, never an inflow nobody placed — and not "***":
//      the fallback as huvudplats counts as no huvudplats
//      (articlePlacePreference)
//   3. else the first of its alternative places (0186) in order that is
//      active and not blocked — usableArticleLocations, the ONE place this
//      rule lives (the saldoimport's preview calls it too)
//   4. the fallback location "***", created on first use (never blocked)
//
// An inflow always lands on that one place; it never tops up an alternative
// place that already holds stock — predictable, and whoever wants another
// place chooses it.
//
// Same pattern as system/number-series.ts's getNextOrderNumber: a plain
// async function taking Db | Tx, so it works inside repository transactions.
//
// The "***" lookup-or-create has no unique constraint backing it, so two
// perfectly simultaneous first-ever resolutions could create it twice. That
// race is accepted (single-user self-hosted system); a duplicate would only
// mean two identical fallback locations, not data corruption.
export async function resolveStockLocation(
  db: Db | Tx,
  articleId: string,
  locationId?: string | null
): Promise<string> {
  // An explicit location is honoured even when it has been retired, but it is
  // revived first: this is the mirror of deactivateEmptyLocation, and together
  // they keep the invariant that a location holding a balance is always active
  // (and therefore visible in every list). Reviving rather than refusing keeps
  // the order routines working when an earlier row empties the location the
  // whole order is being booked against.
  if (locationId) {
    await db
      .update(stockLocations)
      .set({ active: true })
      .where(and(eq(stockLocations.id, locationId), eq(stockLocations.active, false)));
    return locationId;
  }

  const usable = (await usableArticleLocations(db, [articleId])).get(articleId);
  if (usable) return usable;

  return getOrCreateFallbackLocation(db);
}

const CHUNK = 500;

// articleId -> the place an inflow without a chosen place lands on: the
// huvudplats when it is active and not blocked, else the first alternative
// place (sort_order) that is. A huvudplats that is "***" counts as none
// (articlePlacePreference). An article with none is absent — the caller
// falls back to "***" (resolveStockLocation creates it on first use). ONE
// query per 500 articles: each article's huvudplats and alternatives joined
// to the usable places, ranked by articlePlacePreference (the rule the
// Automatiskt split and the pick list read too). A place that is both the
// huvudplats and listed as an alternative ranks as the huvudplats.
export async function usableArticleLocations(db: Db | Tx, articleIds: string[]): Promise<Map<string, string>> {
  const best = new Map<string, { locationId: string; preference: number }>();
  const ids = [...new Set(articleIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({
        articleId: articles.id,
        locationId: stockLocations.id,
        locationName: stockLocations.name,
        isPrimary: sql<boolean>`coalesce(${stockLocations.id} = ${articles.defaultLocationId}, false)`,
        sortOrder: articleAlternativeLocations.sortOrder,
      })
      .from(articles)
      .leftJoin(articleAlternativeLocations, eq(articleAlternativeLocations.articleId, articles.id))
      .innerJoin(
        stockLocations,
        and(
          or(eq(stockLocations.id, articles.defaultLocationId), eq(stockLocations.id, articleAlternativeLocations.locationId)),
          eq(stockLocations.active, true),
          eq(stockLocations.blocked, false)
        )
      )
      .where(inArray(articles.id, ids.slice(i, i + CHUNK)));
    for (const row of rows) {
      const preference = articlePlacePreference({ locationName: row.locationName, isPrimary: row.isPrimary === true, sortOrder: row.sortOrder });
      if (preference === null) continue;
      const current = best.get(row.articleId);
      if (!current || preference < current.preference) best.set(row.articleId, { locationId: row.locationId, preference });
    }
  }
  return new Map([...best].map(([articleId, place]) => [articleId, place.locationId]));
}

// ONE definition, in the pure allocation file (it cannot import this one).
export { FALLBACK_LOCATION_NAME } from "./outflow-allocation.js";

export async function getOrCreateFallbackLocation(db: Db | Tx): Promise<string> {
  const [existing] = await db
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(eq(stockLocations.name, FALLBACK_LOCATION_NAME))
    .limit(1);
  if (existing) return existing.id;

  const [existingWarehouse] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.name, FALLBACK_LOCATION_NAME))
    .limit(1);
  const warehouseId =
    existingWarehouse?.id ??
    (await db.insert(warehouses).values({ name: FALLBACK_LOCATION_NAME, active: true }).returning({ id: warehouses.id }))[0]!
      .id;

  const [location] = await db
    .insert(stockLocations)
    .values({ warehouseId, name: FALLBACK_LOCATION_NAME, active: true })
    .returning({ id: stockLocations.id });
  return location!.id;
}
