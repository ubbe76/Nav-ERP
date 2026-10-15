import { and, eq } from "drizzle-orm";
import { articles, stockLocations, warehouses, type Db, type Tx } from "@navet/db";

// Stock locations are mandatory on every stock movement, but the caller may
// leave the location out — it then resolves in this order:
//
//   1. the explicitly given location
//   2. the article's own default location (articles.default_location_id),
//      but only while that location is still active — an emptied location is
//      deactivated (see location-lifecycle.ts) and must never be resolved into
//   3. the fallback location "***", created on first use
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

  const [article] = await db
    .select({ defaultLocationId: stockLocations.id })
    .from(articles)
    .innerJoin(
      stockLocations,
      and(eq(stockLocations.id, articles.defaultLocationId), eq(stockLocations.active, true))
    )
    .where(eq(articles.id, articleId));
  if (article?.defaultLocationId) return article.defaultLocationId;

  return getOrCreateFallbackLocation(db);
}

export const FALLBACK_LOCATION_NAME = "***";

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
