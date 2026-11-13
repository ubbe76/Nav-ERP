import { trackedSql } from "./batch-tracking.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  articleAlternativeLocations,
  articles,
  stockCountSessions,
  stockLocations,
  stockTransactions,
  warehouses,
  type Db,
  type Tx,
} from "@navet/db";
import { resolveStockLocation } from "./location-resolver.js";
import {
  allocateBatchOutflow,
  allocateOutflow,
  articlePlacePreference,
  withBatchRemainder,
  withRemainder,
  type OutflowCandidate,
  type OutflowPart,
} from "./outflow-allocation.js";
import { BatchNotTrackedError } from "./batch.errors.js";
import { findArticleBatch } from "./batches.js";
import { batchCellsForArticles } from "../repository/batch-balances.js";
import { StockLocationBlockedError } from "./stock.errors.js";
import { stockholmToday } from "../../system/service/delivery-days.js";

// What a CHOSEN place that is blocked (Spärrad lagerplats, 0185) means for
// the draw:
//   "refuse"    — a pure outflow (utleverans, the order card's Leverera,
//                 Förbruka): 409 stock-location-blocked. The default, so a
//                 new writer is strict unless it says otherwise.
//   "automatic" — the TO card, where the same field also receives the
//                 finished goods: the choice only applies to the receipt and
//                 the material is taken as with Automatiskt.
export type BlockedChoice = "refuse" | "automatic";

// Uttag där saldot finns — the Db | Tx leaf every outflow writer calls in
// place of resolveStockLocation when the location is NOT chosen: reads where
// the article's stock is and splits the quantity with the pure rule in
// outflow-allocation.ts. A chosen location is unchanged: everything from
// that one location (resolveStockLocation revives it), negative allowed —
// unless it is blocked (see BlockedChoice).
//
// The balances are read under a lock on the article row (FOR NO KEY UPDATE
// — the same lock material-shortage.ts takes; FOR UPDATE would clash with
// the FK inserts' FOR KEY SHARE), so two simultaneous draws of one article
// never allocate the same balance twice: the second waits and then sees the
// first one's rows. The same lock keeps the article's order of places
// steady: PUT /articles/:id/locations takes it before it replaces the
// huvudplats and the alternatives, so a draw reads either the whole old
// order or the whole new one. A writer drawing SEVERAL articles in one
// transaction should take lockArticlesForOutflow first, sorted, so two such
// writers never wait on each other crosswise.
//
// Spärra vs. a draw: the candidate places are locked FOR SHARE (sorted on
// id) before their blocked flags are read, and Spärra/Släpp spärr is a
// single UPDATE of the place row. A block therefore waits for a draw that
// has read the place as open, and a draw that comes after a block waits for
// it and then reads blocked = true — a draw never takes from a place that is
// blocked when it commits. FOR SHARE does not clash with the FK inserts' FOR
// KEY SHARE, so inflows never wait.
//
// Lock order, on BOTH paths: the article first, then the place(s). A chosen
// place without the article lock let two draws of one article from it each
// hold the place FOR SHARE and then wait on each other in
// deactivateEmptyLocation (the article, or the upgrade of the place) — and
// an Automatiskt draw holding the article could wait on such a draw's share
// lock crosswise. A writer that holds a place lock before it draws (Slutför's
// receipt revives its place) locks its articles before that.
//
// Each part is one stock_transactions row; the caller still runs
// assertLocationNotUnderCount and deactivateEmptyLocation per part.
// `expired` (etapp 2): what Automatiskt does with the cells of an utgången
// batch — "skip" (the default: förbrukning and utleverans never take
// expired stock by themselves; a batch chosen by hand is never tried) or
// "include". The day is the Stockholm day of the draw.
export interface OutflowOptions {
  blockedChoice?: BlockedChoice;
  batchId?: string | null;
  expired?: "skip" | "include";
}

export async function allocateOutflowLocations(
  db: Db | Tx,
  articleId: string,
  quantity: number,
  locationId?: string | null,
  opts: OutflowOptions = {}
): Promise<OutflowPart[]> {
  await lockArticlesForOutflow(db, [articleId]);
  // Batch (#8). The flag on the row just locked: a flag change takes the
  // article FOR UPDATE (updateArticle), so it has either committed or waits
  // for this draw. An article that is not batchstyrd takes the path below
  // exactly as before — its parts carry no batchId.
  const [subject] = await db
    .select({ batchTracked: trackedSql(), articleNumber: articles.articleNumber })
    .from(articles)
    .where(eq(articles.id, articleId));
  if (subject?.batchTracked) return allocateBatchTracked(db, articleId, quantity, locationId, opts);
  // A chosen named batch is never dropped silently (null = Okänd is what
  // every row of such an article is anyway).
  if (typeof opts.batchId === "string") throw new BatchNotTrackedError(subject?.articleNumber ?? articleId);
  if (locationId) {
    // Revive first (resolveStockLocation's UPDATE of an inactive place takes
    // the row lock itself), then FOR SHARE: taking the share lock first and
    // upgrading it would let two draws from one revived place deadlock.
    const chosen = await resolveStockLocation(db, articleId, locationId);
    const [place] = await db
      .select({ blocked: stockLocations.blocked, name: stockLocations.name })
      .from(stockLocations)
      .where(eq(stockLocations.id, chosen))
      .for("share");
    if (!place?.blocked) return [{ locationId: chosen, quantity }];
    if ((opts.blockedChoice ?? "refuse") === "refuse") {
      const [warehouse] = await db
        .select({ name: warehouses.name })
        .from(stockLocations)
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(eq(stockLocations.id, chosen));
      throw new StockLocationBlockedError(`${warehouse?.name ?? ""} — ${place.name}`);
    }
    // "automatic": fall through to the split below.
  }

  const candidateIds = await lockOutflowCandidates(db, articleId);
  const { parts, remainder } = allocateOutflow(quantity, candidateIds.length > 0 ? await readCandidates(db, articleId, candidateIds) : []);
  if (remainder <= 0) return parts;
  // The shortfall goes negative where every outflow went before the split —
  // the huvudplats unless it is inactive, blocked or "***", else the first
  // usable alternative place, else "***" (which can never be blocked). Every
  // one of the article's places is among the locked ones.
  return withRemainder(parts, remainder, await resolveStockLocation(db, articleId));
}

// The batchstyrd path (#8): the same locks in the same order — the article
// is held by the caller, then the place(s) FOR SHARE — and the split per
// cell (place, batch) with the pure rule allocateBatchOutflow:
//
//   place   batch          result
//   chosen  chosen named   the cell must cover the quantity (409
//                          batch-insufficient), one part
//   chosen  chosen Okänd   one part (place, Okänd), may go negative
//   chosen  automatic      the place's cells oldest first, no ceiling (a
//                          chosen place may go negative); the rest Okänd there
//   auto    chosen / auto  the candidates' cells, oldest batch first, each
//                          place capped at its net balance; the rest Okänd
//                          on resolveStockLocation's place (a chosen NAMED
//                          batch that does not cover it is refused)
//
// Etapp 2: with the batch on automatic, the cells of an utgången batch are
// skipped on every row of the table (opts.expired, default "skip") — only
// expired stock left ⇒ the whole quantity is the remainder, Okänd minus.
//
// `opts.batchId`: left out = automatic, null = Okänd, an id = that batch
// (it must be the article's — 404 stock-batch-not-found). A blocked chosen
// place is tried exactly as on the other path, and with "automatic" the
// chosen batch follows into the automatic split. Batch rows are never
// locked: a batch belongs to one article, and every draw of it holds the
// article lock.
async function allocateBatchTracked(
  db: Db | Tx,
  articleId: string,
  quantity: number,
  locationId: string | null | undefined,
  opts: OutflowOptions
): Promise<OutflowPart[]> {
  const expiredBefore = (opts.expired ?? "skip") === "skip" ? stockholmToday() : undefined;
  const batch =
    opts.batchId === undefined
      ? undefined
      : opts.batchId === null
        ? { batchId: null }
        : await findArticleBatch(db, articleId, opts.batchId).then((found) => ({ batchId: found.id, batchNumber: found.batchNumber }));
  if (locationId) {
    const chosen = await resolveStockLocation(db, articleId, locationId);
    const [place] = await db
      .select({ blocked: stockLocations.blocked, name: stockLocations.name })
      .from(stockLocations)
      .where(eq(stockLocations.id, chosen))
      .for("share");
    if (!place?.blocked) {
      const cells = await batchCellsForArticles(db, [articleId], { locationIds: [chosen] });
      const { parts, remainder } = allocateBatchOutflow(quantity, [], cells, { locationId: chosen, batch, expiredBefore });
      return withBatchRemainder(parts, remainder, chosen);
    }
    if ((opts.blockedChoice ?? "refuse") === "refuse") {
      const [warehouse] = await db
        .select({ name: warehouses.name })
        .from(stockLocations)
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(eq(stockLocations.id, chosen));
      throw new StockLocationBlockedError(`${warehouse?.name ?? ""} — ${place.name}`);
    }
    // "automatic": fall through to the split below.
  }

  const candidateIds = await lockOutflowCandidates(db, articleId);
  const [candidates, cells] =
    candidateIds.length > 0
      ? await Promise.all([readCandidates(db, articleId, candidateIds), batchCellsForArticles(db, [articleId], { locationIds: candidateIds })])
      : [[], []];
  const { parts, remainder } = allocateBatchOutflow(quantity, candidates, cells, { batch, expiredBefore });
  if (remainder <= 0) return parts;
  return withBatchRemainder(parts, remainder, await resolveStockLocation(db, articleId));
}

// Balances and flags of the locked places, as the pure rule wants them.
async function readCandidates(db: Db | Tx, articleId: string, candidateIds: string[]): Promise<OutflowCandidate[]> {
  const blockingCount = db
    .select({ locationId: stockCountSessions.locationId })
    .from(stockCountSessions)
    .where(and(eq(stockCountSessions.status, "open"), eq(stockCountSessions.blocksTransactions, true)))
    .as("blocking_count");
  // Only the locked places: one that got its first stock after the lock (an
  // inflow racing the draw) is simply not a candidate this time.
  const rows = await db
    .select({
      locationId: stockLocations.id,
      warehouseName: warehouses.name,
      locationName: stockLocations.name,
      quantityOnHand: sql<string>`sum(${stockTransactions.quantityDelta})`,
      // The facts articlePlacePreference ranks (the huvudplats wins when a
      // place is both, "***" is none of the article's own).
      isPrimary: sql<boolean>`coalesce(bool_or(${articles.defaultLocationId} = ${stockLocations.id}), false)`,
      sortOrder: sql<number | null>`min(${articleAlternativeLocations.sortOrder})`,
      active: stockLocations.active,
      placeBlocked: stockLocations.blocked,
      countBlocked: sql<boolean>`bool_or(${blockingCount.locationId} is not null)`,
    })
    .from(stockTransactions)
    .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
    .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
    .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
    .leftJoin(blockingCount, eq(blockingCount.locationId, stockLocations.id))
    .leftJoin(
      articleAlternativeLocations,
      and(eq(articleAlternativeLocations.articleId, stockTransactions.articleId), eq(articleAlternativeLocations.locationId, stockLocations.id))
    )
    .where(and(eq(stockTransactions.articleId, articleId), inArray(stockTransactions.locationId, candidateIds)))
    .groupBy(stockLocations.id, warehouses.name, stockLocations.name, stockLocations.active, stockLocations.blocked)
    .orderBy(asc(warehouses.name), asc(stockLocations.name));

  return rows.map((r) => ({
    locationId: r.locationId,
    warehouseName: r.warehouseName,
    locationName: r.locationName,
    quantityOnHand: Number(r.quantityOnHand),
    preference: articlePlacePreference({
      locationName: r.locationName,
      isPrimary: r.isPrimary === true,
      sortOrder: r.sortOrder === null ? null : Number(r.sortOrder),
    }),
    active: r.active,
    // A blocking stock count OR a Spärrad lagerplats — skipped alike.
    blocked: r.countBlocked === true || r.placeBlocked,
  }));
}

// The places an automatic draw of the article may touch — those holding a
// positive balance plus the article's huvudplats and every alternative place
// (the remainder lands on the first usable one of them) — locked FOR SHARE,
// sorted on id. The article row is already locked, so its places cannot
// change meanwhile. "***" is locked too when it is one of them; harmless, it
// is never blocked or updated by a draw. Holding an empty alternative place
// FOR SHARE also makes deactivateEmptyLocation's place lock wait the draw
// out before it deletes the place's assignments (location-lifecycle.ts).
async function lockOutflowCandidates(db: Db | Tx, articleId: string): Promise<string[]> {
  const [withStock, [article], alternatives] = await Promise.all([
    db
      .select({ locationId: stockTransactions.locationId })
      .from(stockTransactions)
      .where(eq(stockTransactions.articleId, articleId))
      .groupBy(stockTransactions.locationId)
      .having(sql`sum(${stockTransactions.quantityDelta}) > 0`),
    db.select({ defaultLocationId: articles.defaultLocationId }).from(articles).where(eq(articles.id, articleId)),
    db
      .select({ locationId: articleAlternativeLocations.locationId })
      .from(articleAlternativeLocations)
      .where(eq(articleAlternativeLocations.articleId, articleId)),
  ]);
  const ids = new Set(withStock.map((r) => r.locationId));
  if (article?.defaultLocationId) ids.add(article.defaultLocationId);
  for (const r of alternatives) ids.add(r.locationId);
  if (ids.size === 0) return [];
  const locked = await db
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(inArray(stockLocations.id, [...ids]))
    .orderBy(asc(stockLocations.id))
    .for("share");
  return locked.map((r) => r.id);
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
