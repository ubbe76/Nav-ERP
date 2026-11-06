// Flera lagerplatser per artikel (migration 0186) — the article's huvudplats
// (articles.default_location_id) and its alternative places
// (article_alternative_locations), read and replaced for the Lager tab's
// Lagerplatser card (GET/PUT /articles/:id/locations, served by the stock
// module). Leaf (schema imports only, Db | Tx) like on-hand.ts, so a test can
// hold a replace open inside its own transaction.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { articleAlternativeLocations, articles, stockLocations, stockTransactions, warehouses, type Db, type Tx } from "@navet/db";
import { formatLocationLabelCode, type ArticleLocationPlace, type ArticleLocations, type ArticleLocationsInput } from "@navet/shared";
import { articleLocationPlaceProblem, type ArticleLocationFacts } from "../service/article-locations.js";
import { ArticleLocationInvalidError, ArticleNotFoundError } from "../service/stock.errors.js";

// The card: each place with the article's own balance there (physical —
// a blocked place shows what lies on it). null = no such article.
export async function readArticleLocations(dbc: Db | Tx, articleId: string): Promise<ArticleLocations | null> {
  const [article] = await dbc.select({ defaultLocationId: articles.defaultLocationId }).from(articles).where(eq(articles.id, articleId));
  if (!article) return null;
  const listed = await dbc
    .select({ locationId: articleAlternativeLocations.locationId })
    .from(articleAlternativeLocations)
    .where(eq(articleAlternativeLocations.articleId, articleId))
    .orderBy(asc(articleAlternativeLocations.sortOrder));
  // A place that is the huvudplats is only the huvudplats (PATCH /articles
  // or the transfer's followers can make an alternative the huvudplats; the
  // order already ranks it first, and the next PUT writes the set anew).
  const alternativeIds = listed.map((r) => r.locationId).filter((id) => id !== article.defaultLocationId);
  const ids = [...(article.defaultLocationId ? [article.defaultLocationId] : []), ...alternativeIds];
  if (ids.length === 0) return { primary: null, alternatives: [] };

  const [places, balances] = await Promise.all([
    dbc
      .select({
        locationId: stockLocations.id,
        warehouseId: stockLocations.warehouseId,
        warehouseName: warehouses.name,
        name: stockLocations.name,
        labelNumber: stockLocations.labelNumber,
        active: stockLocations.active,
        blocked: stockLocations.blocked,
        fixed: stockLocations.fixed,
      })
      .from(stockLocations)
      .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
      .where(inArray(stockLocations.id, ids)),
    dbc
      .select({ locationId: stockTransactions.locationId, quantity: sql<string>`sum(${stockTransactions.quantityDelta})` })
      .from(stockTransactions)
      .where(and(eq(stockTransactions.articleId, articleId), inArray(stockTransactions.locationId, ids)))
      .groupBy(stockTransactions.locationId),
  ]);
  const byId = new Map(places.map(({ labelNumber, ...place }) => [place.locationId, { ...place, labelCode: formatLocationLabelCode(labelNumber) }]));
  const balanceOf = new Map(balances.map((b) => [b.locationId, b.quantity]));
  const view = (id: string): ArticleLocationPlace | null => {
    const place = byId.get(id);
    return place ? { ...place, quantityOnHand: balanceOf.get(id) ?? "0.0000" } : null;
  };
  return {
    primary: article.defaultLocationId ? view(article.defaultLocationId) : null,
    alternatives: alternativeIds.map(view).filter((p): p is ArticleLocationPlace => p !== null),
  };
}

// PUT: the whole set in the caller's transaction. Lock order article →
// place, as in every draw: the article row FOR NO KEY UPDATE first (the lock
// allocateOutflowLocations takes, so a draw reads either the old order or
// the new one, never half of each), then the places of the new set FOR
// SHARE sorted on id (a concurrent Spärra or deactivateEmptyLocation waits
// for this, or this waits for it and then reads what it did). The current
// set and the places' flags are read after both locks, the rules asked
// (article-locations.ts), and then the huvudplats written and the
// alternatives deleted and inserted as 1..n. articleLocationInputProblem
// (count, duplicates, huvudplats in the list) has run before.
export async function replaceArticleLocations(tx: Tx, articleId: string, input: ArticleLocationsInput): Promise<void> {
  const [article] = await tx
    .select({ defaultLocationId: articles.defaultLocationId })
    .from(articles)
    .where(eq(articles.id, articleId))
    .for("no key update");
  if (!article) throw new ArticleNotFoundError(articleId);

  const ids = [...new Set([...(input.primaryLocationId ? [input.primaryLocationId] : []), ...input.alternativeLocationIds])];
  if (ids.length > 0) {
    await tx.select({ id: stockLocations.id }).from(stockLocations).where(inArray(stockLocations.id, ids)).orderBy(asc(stockLocations.id)).for("share");
  }
  const [current, places] = await Promise.all([
    tx
      .select({ locationId: articleAlternativeLocations.locationId })
      .from(articleAlternativeLocations)
      .where(eq(articleAlternativeLocations.articleId, articleId)),
    ids.length === 0
      ? Promise.resolve([] as ArticleLocationFacts[])
      : tx
          .select({
            id: stockLocations.id,
            name: stockLocations.name,
            warehouseName: warehouses.name,
            active: stockLocations.active,
            blocked: stockLocations.blocked,
          })
          .from(stockLocations)
          .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .where(inArray(stockLocations.id, ids)),
  ]);
  const problem = articleLocationPlaceProblem(
    input,
    { primaryLocationId: article.defaultLocationId, alternativeLocationIds: current.map((r) => r.locationId) },
    new Map(places.map((p) => [p.id, p]))
  );
  if (problem) throw new ArticleLocationInvalidError(problem);

  if (input.primaryLocationId !== article.defaultLocationId) {
    await tx.update(articles).set({ defaultLocationId: input.primaryLocationId, updatedAt: new Date() }).where(eq(articles.id, articleId));
  }
  await tx.delete(articleAlternativeLocations).where(eq(articleAlternativeLocations.articleId, articleId));
  if (input.alternativeLocationIds.length > 0) {
    await tx
      .insert(articleAlternativeLocations)
      .values(input.alternativeLocationIds.map((locationId, i) => ({ articleId, locationId, sortOrder: i + 1 })));
  }
}
