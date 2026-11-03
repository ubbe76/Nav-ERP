import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { articles, stockCountSessions, stockLocations, stockTransactions, warehouses, type Db, type Tx } from "@navet/db";
import { resolveStockLocation } from "./location-resolver.js";
import { allocateOutflow, withRemainder, type OutflowCandidate, type OutflowPart } from "./outflow-allocation.js";

// Uttag där saldot finns — the Db | Tx leaf every outflow writer calls in
// place of resolveStockLocation when the location is NOT chosen: reads where
// the article's stock is and splits the quantity with the pure rule in
// outflow-allocation.ts. A chosen location is unchanged: everything from
// that one location (resolveStockLocation revives it), negative allowed.
//
// The balances are read under a lock on the article row (FOR NO KEY UPDATE
// — the same lock material-shortage.ts takes; FOR UPDATE would clash with
// the FK inserts' FOR KEY SHARE), so two simultaneous draws of one article
// never allocate the same balance twice: the second waits and then sees the
// first one's rows. A writer drawing SEVERAL articles in one transaction
// should take lockArticlesForOutflow first, sorted, so two such writers
// never wait on each other crosswise.
//
// Each part is one stock_transactions row; the caller still runs
// assertLocationNotUnderCount and deactivateEmptyLocation per part.
export async function allocateOutflowLocations(
  db: Db | Tx,
  articleId: string,
  quantity: number,
  locationId?: string | null
): Promise<OutflowPart[]> {
  if (locationId) {
    return [{ locationId: await resolveStockLocation(db, articleId, locationId), quantity }];
  }

  await lockArticlesForOutflow(db, [articleId]);

  const blockingCount = db
    .select({ locationId: stockCountSessions.locationId })
    .from(stockCountSessions)
    .where(and(eq(stockCountSessions.status, "open"), eq(stockCountSessions.blocksTransactions, true)))
    .as("blocking_count");
  const rows = await db
    .select({
      locationId: stockLocations.id,
      warehouseName: warehouses.name,
      locationName: stockLocations.name,
      quantityOnHand: sql<string>`sum(${stockTransactions.quantityDelta})`,
      isDefault: sql<boolean>`bool_or(${articles.defaultLocationId} = ${stockLocations.id})`,
      active: stockLocations.active,
      blocked: sql<boolean>`bool_or(${blockingCount.locationId} is not null)`,
    })
    .from(stockTransactions)
    .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
    .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
    .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
    .leftJoin(blockingCount, eq(blockingCount.locationId, stockLocations.id))
    .where(eq(stockTransactions.articleId, articleId))
    .groupBy(stockLocations.id, warehouses.name, stockLocations.name, stockLocations.active)
    .orderBy(asc(warehouses.name), asc(stockLocations.name));

  const candidates: OutflowCandidate[] = rows.map((r) => ({
    locationId: r.locationId,
    warehouseName: r.warehouseName,
    locationName: r.locationName,
    quantityOnHand: Number(r.quantityOnHand),
    isDefault: r.isDefault === true,
    active: r.active,
    blocked: r.blocked === true,
  }));
  const { parts, remainder } = allocateOutflow(quantity, candidates);
  if (remainder <= 0) return parts;
  // The shortfall goes negative where every outflow went before the split.
  return withRemainder(parts, remainder, await resolveStockLocation(db, articleId));
}

// Sorted FOR NO KEY UPDATE on the article rows — see above.
export async function lockArticlesForOutflow(db: Db | Tx, articleIds: string[]): Promise<void> {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0) return;
  await db
    .select({ id: articles.id })
    .from(articles)
    .where(inArray(articles.id, ids))
    .orderBy(asc(articles.id))
    .for("no key update");
}
