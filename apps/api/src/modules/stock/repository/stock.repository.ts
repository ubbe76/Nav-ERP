import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articleAlternativeLocations,
  articles,
  manufacturingOrders,
  purchaseOrders,
  salesOrders,
  stockBalances,
  stockBatches,
  stockCountSessions,
  stockLocations,
  stockTransactions,
  units,
  users,
  warehouses,
  type Db,
  type Tx,
} from "@navet/db";
import { resolveStockLocation } from "../service/location-resolver.js";
import { deactivateEmptyLocation, locationHoldsStock } from "../service/location-lifecycle.js";
import { assertLocationNotUnderCount } from "../service/count-guard.js";
import { lockArticlesForOutflow, chosenSerials } from "../service/outflow-locations.js";
import { isStockedArticleType } from "../service/stocked-article.js";
import { allocateBatchOutflow, articlePlacePreference, compareOutflowLocations, FALLBACK_LOCATION_NAME, withBatchRemainder } from "../service/outflow-allocation.js";
import { isCheckViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import { stockValuedAt } from "./valued-at.js";
import { readArticleLocations, replaceArticleLocations } from "./article-locations.js";
import {
  ilikePattern,
  type ArticleLocationsInput,
  type CreateStockLocationInput,
  type CreateStockTransactionInput,
  type CreateStockTransferInput,
  type CreateWarehouseInput,
  type ListQuery,
  type ListStockTransactionsQuery,
  type ListStockBatchesQuery,
  type UpdateStockBatchInput,
  type StockTransactionReference,
  type ListStockBalancesQuery,
  type ListStockLocationRegisterQuery,
  type ListStockLocationsQuery,
  type StockLocationRegisterRow,
  type StockLocationUnitBalance,
  type UpdateStockLocationInput,
  type UpdateWarehouseInput,
  formatLocationLabelCode,
  parseLocationLabelCode,
  round4,
  UNKNOWN_BATCH_LABEL,
} from "@navet/shared";
import { ArticleNotSerialTrackedError, BatchNotTrackedError, DuplicateBatchNumberError, SerialCountMismatchError } from "../service/batch.errors.js";
import { stockTrackingOf } from "../service/article-tracking.js";
import { findArticleBatch, getOrCreateBatch, normalizeBatchNumber } from "../service/batches.js";
import { stockholmToday } from "../../system/service/delivery-days.js";
import { isTrackedArticle, trackedSql, trackingOf } from "../service/batch-tracking.js";
import { assertSerialsOutOfStock, getOrCreateSerials, lockSerials } from "../service/serial-numbers.js";
import { articleBatchBalances, batchCellsForArticles, pickBatchCellsForArticles } from "./batch-balances.js";
import { createBatchTraceReader, listStockBatches } from "./batch-trace.repository.js";
import { traceBatch, type BatchTraceLimits } from "../service/batch-trace.js";
import {
  ArticleNotFoundError,
  FallbackLocationNotBlockableError,
  InactiveStockLocationError,
  InsufficientStockError,
  StockLocationAlreadyBlockedError,
  StockLocationNotBlockedError,
  StockLocationNotEmptyError,
  ServiceArticleNotStockedError,
  StockLocationNameReservedError,
  StockLocationNotFoundError,
} from "../service/stock.errors.js";

// "***" may never be blocked (the remainder of Automatiskt lands there) — the
// CHECK behind it, caught on create and on a rename of a blocked place.
const FALLBACK_NOT_BLOCKED_CHECK = "stock_locations_fallback_not_blocked";

function rethrowFallbackBlocked(err: unknown): never {
  if (isCheckViolation(err, FALLBACK_NOT_BLOCKED_CHECK)) throw new FallbackLocationNotBlockableError();
  throw err;
}

// One stock location as GET /stock/locations answers with it (and the
// Spärra/Släpp spärr responses).
const locationColumns = {
  id: stockLocations.id,
  warehouseId: stockLocations.warehouseId,
  name: stockLocations.name,
  active: stockLocations.active,
  // Fast lagerplats: stays when emptied.
  fixed: stockLocations.fixed,
  // Spärrad lagerplats (0185): not usable, never drawn automatically.
  blocked: stockLocations.blocked,
  blockedAt: stockLocations.blockedAt,
  blockedNote: stockLocations.blockedNote,
  warehouseName: warehouses.name,
  labelNumber: stockLocations.labelNumber,
};
// Etikettkod (#4): what the location's label and a scan say (LP0042).
function toLocationView<R extends { labelNumber: number }>({ labelNumber, ...row }: R) {
  return { ...row, labelCode: formatLocationLabelCode(labelNumber) };
}

async function locationView(dbc: Db | Tx, id: string) {
  const [row] = await dbc
    .select(locationColumns)
    .from(stockLocations)
    .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
    .where(eq(stockLocations.id, id));
  return row ? toLocationView(row) : null;
}

// What Spärra/Släpp spärr tells the user afterwards: the articles whose
// balance on the place is not 0, and those that have it as their Lagerplats
// (their inflows go to the next place while it is blocked). Read after the
// UPDATE — which waited for any draw holding the place — so a draw that
// committed meanwhile is counted.
async function blockImpact(dbc: Db | Tx, id: string) {
  const [[withStock], [defaults]] = await Promise.all([
    dbc
      .select({ n: sql<number>`count(*)::int` })
      .from(
        dbc
          .select({ articleId: stockTransactions.articleId })
          .from(stockTransactions)
          .where(eq(stockTransactions.locationId, id))
          .groupBy(stockTransactions.articleId)
          .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`)
          .as("with_stock")
      ),
    dbc.select({ n: sql<number>`count(*)::int` }).from(articles).where(eq(articles.defaultLocationId, id)),
  ]);
  return { articlesWithStock: withStock?.n ?? 0, defaultForArticles: defaults?.n ?? 0 };
}

export function createStockRepository(db: Db) {
  return {
    async createWarehouse(input: CreateWarehouseInput) {
      const [row] = await db.insert(warehouses).values(input).returning();
      return row;
    },

    // A place may be created blocked (a Karantän); blocked_at is the moment.
    async createLocation(input: CreateStockLocationInput) {
      if (input.name.trim() === FALLBACK_LOCATION_NAME) throw new StockLocationNameReservedError();
      const { blocked, blockedNote, ...fields } = input;
      const isBlocked = blocked === true;
      try {
        const [row] = await db
          .insert(stockLocations)
          .values({
            ...fields,
            blocked: isBlocked,
            blockedAt: isBlocked ? new Date() : null,
            blockedNote: isBlocked ? (blockedNote ?? null) : null,
          })
          .returning();
        return row!;
      } catch (err) {
        rethrowFallbackBlocked(err);
      }
    },

    async updateWarehouse(id: string, input: UpdateWarehouseInput) {
      const [row] = await db.update(warehouses).set(input).where(eq(warehouses.id, id)).returning();
      return row ?? null;
    },

    async updateLocation(id: string, input: UpdateStockLocationInput) {
      try {
        return await db.transaction(async (tx) => {
          // The reserved name: the real "***" keeps it, no other place takes it.
          if (input.name !== undefined) {
            const [named] = await tx
              .select({ name: stockLocations.name })
              .from(stockLocations)
              .where(eq(stockLocations.id, id))
              .for("no key update");
            if (!named) return null;
            if ((named.name === FALLBACK_LOCATION_NAME) !== (input.name.trim() === FALLBACK_LOCATION_NAME)) {
              throw new StockLocationNameReservedError();
            }
          }
          if (input.active === false || input.blockedNote !== undefined) {
            // Locked like Spärra/Släpp spärr, so a note never lands on a
            // place that was just unblocked.
            const [current] = await tx
              .select({ name: stockLocations.name, active: stockLocations.active, blocked: stockLocations.blocked })
              .from(stockLocations)
              .where(eq(stockLocations.id, id))
              .for("no key update");
            if (!current) return null;
            // Retiring a location by hand must not strand its stock — emptying it
            // is what deactivates a location, and that happens automatically.
            if (input.active === false && current.active && (await locationHoldsStock(tx, id))) {
              throw new StockLocationNotEmptyError(current.name);
            }
            // The note belongs to the spärr; the flag itself only changes
            // through block/unblock.
            if (input.blockedNote !== undefined && !current.blocked) throw new StockLocationNotBlockedError(current.name);
          }
          const [row] = await tx.update(stockLocations).set(input).where(eq(stockLocations.id, id)).returning();
          return row ?? null;
        });
      } catch (err) {
        // A blocked place renamed to "***".
        rethrowFallbackBlocked(err);
      }
    },

    // Spärra lagerplats: a whitelisted transition — ONE conditional UPDATE
    // (open, not "***"), so two simultaneous blocks give one winner and one
    // 409. The UPDATE waits for draws holding the place FOR SHARE
    // (outflow-locations.ts) and draws after it see blocked = true. No
    // stock_transactions row: a spärr is a property of the place.
    async blockLocation(id: string, note: string | null) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(stockLocations)
          .set({ blocked: true, blockedAt: new Date(), blockedNote: note })
          .where(and(eq(stockLocations.id, id), eq(stockLocations.blocked, false), ne(stockLocations.name, FALLBACK_LOCATION_NAME)))
          .returning({ id: stockLocations.id });
        if (!row) {
          const [current] = await tx
            .select({ name: stockLocations.name, blocked: stockLocations.blocked })
            .from(stockLocations)
            .where(eq(stockLocations.id, id));
          if (!current) throw new StockLocationNotFoundError(id);
          if (current.blocked) throw new StockLocationAlreadyBlockedError(current.name);
          throw new FallbackLocationNotBlockableError();
        }
        return { location: (await locationView(tx, id))!, ...(await blockImpact(tx, id)) };
      });
    },

    // Släpp spärr: the mirror — only a blocked place, the time and note
    // cleared. previousNote is for the audit row only (read unlocked first).
    async unblockLocation(id: string) {
      return db.transaction(async (tx) => {
        const [before] = await tx.select({ note: stockLocations.blockedNote }).from(stockLocations).where(eq(stockLocations.id, id));
        const [row] = await tx
          .update(stockLocations)
          .set({ blocked: false, blockedAt: null, blockedNote: null })
          .where(and(eq(stockLocations.id, id), eq(stockLocations.blocked, true)))
          .returning({ id: stockLocations.id });
        if (!row) {
          const [current] = await tx.select({ name: stockLocations.name }).from(stockLocations).where(eq(stockLocations.id, id));
          if (!current) throw new StockLocationNotFoundError(id);
          throw new StockLocationNotBlockedError(current.name);
        }
        return { location: (await locationView(tx, id))!, previousNote: before?.note ?? null, ...(await blockImpact(tx, id)) };
      });
    },

    // One place in GET /stock/locations' shape; null when unknown.
    async findLocationView(id: string) {
      return locationView(db, id);
    },

    // Append-only: this is the only write path into stock. There is no update/delete
    // on balances — current quantity is always derived from stock_balances.
    async listWarehouses() {
      return db.select().from(warehouses).orderBy(asc(warehouses.name));
    },

    // Deactivated locations are the system's "deleted" — only the register page
    // asks for them, every form dropdown gets the active ones.
    // Etiketter (#4): what a lagerplats label prints, in the order asked for.
    async labelLocations(ids: string[]) {
      const rows = await db
        .select({ id: stockLocations.id, name: stockLocations.name, labelNumber: stockLocations.labelNumber, warehouseName: warehouses.name })
        .from(stockLocations)
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(inArray(stockLocations.id, ids));
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    },

    async listLocations(query: ListStockLocationsQuery = { includeInactive: false }) {
      const rows = await db
        .select(locationColumns)
        .from(stockLocations)
        .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(query.includeInactive ? undefined : eq(stockLocations.active, true))
        .orderBy(asc(warehouses.name), asc(stockLocations.name));
      return rows.map(toLocationView);
    },

    // Lagerplatsregistret: the list pattern (where built once on
    // stock_locations ⋈ warehouses, rows + count(*) in parallel), then ONE
    // aggregation for the page's ids — the articles whose balance on the
    // place is not 0, summed per base unit. The location filter sits on a
    // grouping column of stock_balances, so Postgres pushes it into the view
    // and idx_stock_transactions_location_article (0185) finds the rows;
    // "<> 0" stays a HAVING on the view's sum. Physical, like Saldon: a
    // blocked place shows what stands there.
    async listLocationRegister(query: ListStockLocationRegisterQuery): Promise<{ rows: StockLocationRegisterRow[]; total: number }> {
      const conditions: (SQL | undefined)[] = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        // "LP0042" — the etikettkod is LP + label_number, not stored text.
        const labelNumber = parseLocationLabelCode(query.search);
        conditions.push(
          or(
            ilike(stockLocations.name, pattern),
            ilike(warehouses.name, pattern),
            labelNumber === null ? undefined : eq(stockLocations.labelNumber, labelNumber)
          )
        );
      }
      if (query.warehouseId) conditions.push(eq(stockLocations.warehouseId, query.warehouseId));
      if (query.status !== "all") conditions.push(eq(stockLocations.active, query.status === "active"));
      if (query.blocked !== undefined) conditions.push(eq(stockLocations.blocked, query.blocked));
      const where = and(...conditions);

      const [places, totalRows] = await Promise.all([
        db
          .select(locationColumns)
          .from(stockLocations)
          .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .where(where)
          .orderBy(asc(warehouses.name), asc(stockLocations.name), asc(stockLocations.id))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(stockLocations)
          .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .where(where),
      ]);

      const ids = places.map((p) => p.id);
      const sums =
        ids.length === 0
          ? []
          : await db
              .select({
                locationId: stockBalances.locationId,
                unitCode: units.code,
                articleCount: sql<number>`count(*)::int`,
                quantity: sql<string>`sum(${stockBalances.quantityOnHand})`,
              })
              .from(stockBalances)
              .innerJoin(articles, eq(articles.id, stockBalances.articleId))
              .innerJoin(units, eq(units.id, articles.unitId))
              .where(and(inArray(stockBalances.locationId, ids), ne(stockBalances.quantityOnHand, "0")))
              .groupBy(stockBalances.locationId, units.code)
              .orderBy(asc(units.code));

      const byLocation = new Map<string, { articleCount: number; balances: StockLocationUnitBalance[] }>();
      for (const sum of sums) {
        const entry = byLocation.get(sum.locationId) ?? { articleCount: 0, balances: [] };
        entry.articleCount += sum.articleCount;
        entry.balances.push({ unitCode: sum.unitCode, quantity: sum.quantity });
        byLocation.set(sum.locationId, entry);
      }

      const rows = places.map((place) => {
        const { blockedAt, ...view } = toLocationView(place);
        return {
          ...view,
          blockedAt: blockedAt ? blockedAt.toISOString() : null,
          ...(byLocation.get(place.id) ?? { articleCount: 0, balances: [] }),
        };
      });
      return { rows, total: totalRows[0]!.total };
    },

    async createTransaction(input: CreateStockTransactionInput, createdBy?: string) {
      return db.transaction(async (tx) => {
        const [subject] = await tx
          .select({ articleNumber: articles.articleNumber, type: articles.type })
          .from(articles)
          .where(eq(articles.id, input.articleId));
        if (!subject) throw new ArticleNotFoundError(input.articleId);
        if (!isStockedArticleType(subject.type)) throw new ServiceArticleNotStockedError(subject.articleNumber);
        // Batch (#8). The flag is read FOR KEY SHARE (batch-tracking.ts), so
        // a flag change in progress is waited out.
        const sort = await trackingOf(tx, input.articleId);
        const batchTracked = sort !== null;
        if ((input.batchNumber !== undefined || typeof input.batchId === "string") && !batchTracked) {
          throw new BatchNotTrackedError(subject.articleNumber);
        }
        if (input.serialIds !== undefined && sort !== "serial") throw new ArticleNotSerialTrackedError(subject.articleNumber);
        // A decrease of a batchstyrd article is an outflow like any other:
        // the article lock every draw takes, BEFORE the place is resolved
        // (article → place) — the cells it is taken from must not be
        // allocated twice.
        if (batchTracked && input.quantityDelta < 0) await lockArticlesForOutflow(tx, [input.articleId]);
        // Location is mandatory — resolve article default / "***" when absent.
        const locationId = await resolveStockLocation(tx, input.articleId, input.locationId);
        await assertLocationNotUnderCount(tx, locationId);
        // A decrease of a batchstyrd article is split per batch WITHIN the
        // place with the pure rule (a chosen place: no ceiling, the place may
        // go negative as it always could): the chosen batch — a named one
        // must cover the quantity, 409 batch-insufficient — or the place's
        // batches oldest first, Okänd first, and what they do not cover as
        // Okänd. One row per batch; the answer is the FIRST row, as for every
        // other justering, with `parts` listing all of them.
        if (batchTracked && input.quantityDelta < 0) {
          const chosen =
            input.batchId === undefined
              ? undefined
              : input.batchId === null
                ? { batchId: null, batchNumber: null }
                : await findArticleBatch(tx, input.articleId, input.batchId).then((b) => ({ batchId: b.id, batchNumber: b.batchNumber }));
          // Serienummer (steg 4): whole styck — a chosen number (batchId, one
          // styck), several (serialIds) or the place's numbers oldest first;
          // only the Okänd cell (batchId null) may be corrected by a fraction.
          const serials =
            sort === "serial" && input.batchId !== null
              ? await chosenSerials(tx, input.articleId, subject.articleNumber, -input.quantityDelta, input)
              : undefined;
          if (sort === "serial" && input.batchId === null && input.serialIds !== undefined) {
            throw new SerialCountMismatchError(-input.quantityDelta, input.serialIds.length);
          }
          const cells = await batchCellsForArticles(tx, [input.articleId], { locationIds: [locationId] });
          const allocation = allocateBatchOutflow(-input.quantityDelta, [], cells, { locationId, batch: chosen, batches: serials });
          const parts = withBatchRemainder(allocation.parts, allocation.remainder, locationId);
          if (sort === "serial") await lockSerials(tx, parts.flatMap((part) => (part.batchId ? [part.batchId] : [])));
          const rows = await tx
            .insert(stockTransactions)
            .values(
              parts.map((part) => ({
                articleId: input.articleId,
                locationId,
                quantityDelta: String(-part.quantity),
                transactionType: input.transactionType,
                referenceId: input.referenceId,
                note: input.note,
                createdBy,
                batchId: part.batchId ?? null,
              }))
            )
            .returning();
          await deactivateEmptyLocation(tx, locationId);
          const numbers = new Map(cells.map((cell) => [cell.batchId, cell.batchNumber]));
          return {
            ...rows[0]!,
            parts: rows.map((row) => ({
              id: row.id,
              quantityDelta: row.quantityDelta,
              batchId: row.batchId,
              batchNumber: row.batchId === null ? null : (numbers.get(row.batchId) ?? chosen?.batchNumber ?? null),
            })),
          };
        }
        // An inflow names its batch (created on first use); without one the
        // goods are Okänd.
        //
        // Serienummer (0215): on a serienummerstyrd article the number IS a
        // serial number — one styck (the delta must be 1), which must not
        // stand in stock already; its row is locked after the place. Without
        // a number the goods are Okänd, in any quantity (old stock must be
        // correctable).
        let serial: { id: string } | null = null;
        if (sort === "serial" && input.batchNumber !== undefined && input.quantityDelta > 0) {
          if (input.quantityDelta !== 1) throw new SerialCountMismatchError(input.quantityDelta, 1);
          [serial = null] = await getOrCreateSerials(tx, {
            articleId: input.articleId,
            serialNumbers: [input.batchNumber],
            origin: "manual",
            createdBy,
            expiresOn: input.expiresOn,
          });
          await lockSerials(tx, [serial!.id]);
          await assertSerialsOutOfStock(tx, [serial!.id]);
        }
        const batch =
          serial !== null
            ? serial
            : input.batchNumber !== undefined && input.quantityDelta > 0
            ? await getOrCreateBatch(tx, {
                articleId: input.articleId,
                batchNumber: input.batchNumber,
                origin: "manual",
                createdBy,
                // Etapp 2: the new batch's utgångsdatum; another date than an
                // existing batch has is refused (409 batch-expiry-mismatch).
                expiresOn: input.expiresOn,
              })
            : null;

        // Only inflows are a valuation event — an outflow doesn't get a cost.
        // unit_cost is the article's current standard cost; null (not 0) when
        // none is set, since 0 would be a false claim of zero value.
        let unitCost: string | null = null;
        if (input.quantityDelta > 0) {
          const [article] = await tx
            .select({ standardCost: articles.standardCost })
            .from(articles)
            .where(eq(articles.id, input.articleId));
          unitCost = article?.standardCost ?? null;
        }

        const [row] = await tx
          .insert(stockTransactions)
          .values({
            articleId: input.articleId,
            locationId,
            quantityDelta: String(input.quantityDelta),
            transactionType: input.transactionType,
            referenceId: input.referenceId,
            note: input.note,
            unitCost,
            createdBy,
            batchId: batch?.id ?? null,
          })
          .returning();
        // A negative adjustment may have emptied the location.
        if (input.quantityDelta < 0) await deactivateEmptyLocation(tx, locationId);
        return row;
      });
    },

    // Lagerflytt: both legs of every row plus the emptied-source cleanup in one
    // transaction. The two legs of a row share the transfer's reference_id.
    async transferStock(input: CreateStockTransferInput, createdBy: string) {
      return db.transaction(async (tx) => {
        const [from] = await tx
          .select({ id: stockLocations.id, name: stockLocations.name })
          .from(stockLocations)
          .where(eq(stockLocations.id, input.fromLocationId));
        if (!from) throw new StockLocationNotFoundError(input.fromLocationId);

        const [to] = await tx
          .select({ id: stockLocations.id, name: stockLocations.name, active: stockLocations.active, blocked: stockLocations.blocked })
          .from(stockLocations)
          .where(eq(stockLocations.id, input.toLocationId));
        if (!to) throw new StockLocationNotFoundError(input.toLocationId);
        if (!to.active) throw new InactiveStockLocationError(to.name);

        // A count freezes its whole location — both legs of a transfer touch one.
        await assertLocationNotUnderCount(tx, from.id);
        await assertLocationNotUnderCount(tx, to.id);

        const articleIds = input.rows.map((row) => row.articleId);

        // Every moved article FOR NO KEY UPDATE, sorted, before anything else:
        // the overdraw check below reads the source's balance, and every
        // outflow (Automatiskt, a chosen place, another transfer) takes the
        // article first — without it a transfer and a draw could both take
        // the same balance and leave the source negative. Article → place,
        // as in every draw.
        await lockArticlesForOutflow(tx, articleIds);

        // The followers — moved articles whose huvudplats is the source —
        // captured before the cleanup below clears every pointer to it, and
        // LOCKED as they are read (FOR NO KEY UPDATE, sorted, before any
        // place lock: article → place, as in every draw). A PUT
        // /articles/:id/locations in progress is waited out, and the
        // locking read re-checks its WHERE on what the PUT committed: an
        // article the PUT moved off the source is no follower, so the
        // transfer never writes over the huvudplats the PUT has already
        // answered with. Held until commit, nothing changes them meanwhile.
        const followers = await tx
          .select({ id: articles.id })
          .from(articles)
          .where(and(inArray(articles.id, articleIds), eq(articles.defaultLocationId, from.id)))
          .orderBy(asc(articles.id))
          .for("no key update");

        const transferId = randomUUID();
        for (const row of input.rows) {
          const [article] = await tx
            .select({
              articleNumber: articles.articleNumber,
              type: articles.type,
              batchTracked: trackedSql(),
              tracking: articles.tracking,
              serialAssignedAt: articles.serialAssignedAt,
            })
            .from(articles)
            .where(eq(articles.id, row.articleId));
          if (!article) throw new ArticleNotFoundError(row.articleId);
          if (!isStockedArticleType(article.type)) throw new ServiceArticleNotStockedError(article.articleNumber);
          // The row is locked above, so the flag cannot change under the move.
          if (!article.batchTracked && typeof row.batchId === "string") throw new BatchNotTrackedError(article.articleNumber);
          const sort = stockTrackingOf(article);
          if (row.serialIds !== undefined && sort !== "serial") throw new ArticleNotSerialTrackedError(article.articleNumber);
          // Serienummer (steg 4): whole styck — except Okänd, old stock that
          // may be any quantity — and the chosen numbers validated.
          const serials = sort === "serial" && row.batchId !== null ? await chosenSerials(tx, row.articleId, article.articleNumber, row.quantity, row) : undefined;
          if (sort === "serial" && row.batchId === null && row.serialIds !== undefined) throw new SerialCountMismatchError(row.quantity, row.serialIds.length);

          const [balance] = await tx
            .select({ quantityOnHand: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
            .from(stockTransactions)
            .where(
              and(
                eq(stockTransactions.articleId, row.articleId),
                eq(stockTransactions.locationId, from.id)
              )
            );
          const available = balance?.quantityOnHand ?? "0";
          if (row.quantity > Number(available)) {
            throw new InsufficientStockError(article.articleNumber, available, row.quantity);
          }

          // Batch (#8): the batch follows the goods — one pair of legs per
          // batch, both legs in the same batch. A chosen batch must hold the
          // whole quantity on the source (a named one: 409
          // batch-insufficient; Okänd: 409 insufficient-stock — a move never
          // leaves a cell negative). Automatiskt takes the source's cells
          // oldest first (Okänd first); the quantity is within the place's
          // net balance (checked above), so the positive cells always cover
          // it. An article that is not batchstyrd moves as one pair without
          // a batch, exactly as before.
          let moved: { quantity: number; batchId: string | null }[] = [{ quantity: row.quantity, batchId: null }];
          if (article.batchTracked) {
            const batch =
              row.batchId === undefined
                ? undefined
                : row.batchId === null
                  ? { batchId: null }
                  : await findArticleBatch(tx, row.articleId, row.batchId).then((b) => ({ batchId: b.id, batchNumber: b.batchNumber }));
            const cells = await batchCellsForArticles(tx, [row.articleId], { locationIds: [from.id] });
            const { parts, remainder } = allocateBatchOutflow(row.quantity, [], cells, { locationId: from.id, batch, batches: serials });
            if (remainder > 0) {
              throw new InsufficientStockError(
                `${article.articleNumber} (${UNKNOWN_BATCH_LABEL})`,
                String(round4(row.quantity - remainder)),
                row.quantity
              );
            }
            moved = parts.map((part) => ({ quantity: part.quantity, batchId: part.batchId ?? null }));
            // The numbers that move: their rows locked, sorted, after the
            // places (both legs are written in one INSERT — the −1 first —
            // so the guard sees the move as a whole).
            if (sort === "serial") await lockSerials(tx, moved.flatMap((part) => (part.batchId ? [part.batchId] : [])));
          }

          await tx.insert(stockTransactions).values(
            moved.flatMap((part) => [
              {
                articleId: row.articleId,
                locationId: from.id,
                quantityDelta: String(-part.quantity),
                transactionType: "stock_transfer" as const,
                referenceId: transferId,
                note: input.note,
                createdBy,
                batchId: part.batchId,
              },
              {
                articleId: row.articleId,
                locationId: to.id,
                quantityDelta: String(part.quantity),
                transactionType: "stock_transfer" as const,
                referenceId: transferId,
                note: input.note,
                createdBy,
                batchId: part.batchId,
              },
            ])
          );
        }

        const deactivatedSourceLocation = await deactivateEmptyLocation(tx, from.id);
        // The stock physically moved, so articles that lived on the emptied
        // source follow it rather than falling back to "***" — but never onto
        // a Spärrad lagerplats: a blocked place is not a Lagerplats anyone
        // chose (the resolver would skip it anyway), so they stay on "***".
        // Only the huvudplats follows (0186): an emptied temporary source that
        // was an alternative place is simply gone from the articles' lists
        // (deactivateEmptyLocation deleted the assignments). Only the locked
        // followers, and only those the cleanup has just cleared — they had
        // the source as huvudplats up to that UPDATE (it clears the articles
        // it locked, ours among them) and the lock kept everyone else out.
        if (deactivatedSourceLocation && followers.length > 0 && !to.blocked) {
          await tx
            .update(articles)
            .set({ defaultLocationId: to.id })
            .where(and(inArray(articles.id, followers.map((a) => a.id)), isNull(articles.defaultLocationId)));
        }

        return {
          transferId,
          movedRows: input.rows.length,
          fromLocationName: from.name,
          toLocationName: to.name,
          deactivatedSourceLocation,
        };
      });
    },

    // Översikten's "artiklar i lager": articles whose PHYSICAL balance, summed
    // over every place including blocked ones, is above 0 — one query, so it is
    // right beyond any page of balance rows.
    async countArticlesInStock(): Promise<number> {
      const result = await db.execute<{ total: string }>(sql`
        select count(*)::text as total from (
          select article_id from ${stockBalances}
          group by article_id
          having sum(quantity_on_hand) > 0
        ) in_stock
      `);
      return Number([...result][0]?.total ?? 0);
    },

    async getBalances(query: ListStockBalancesQuery) {
      // A netted-out article/location pair carries no information — the history
      // lives in the transaction log, and its location is usually deactivated.
      const conditions = [ne(stockBalances.quantityOnHand, "0")];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(articles.articleNumber, pattern), ilike(articles.name, pattern))!);
      }
      if (query.articleId) conditions.push(eq(stockBalances.articleId, query.articleId));
      // Utleverans: every article on the order in one call.
      if (query.articleIds) conditions.push(inArray(stockBalances.articleId, query.articleIds));
      if (query.locationId) conditions.push(eq(stockBalances.locationId, query.locationId));
      // Spärrade lagerplatser: only them / without them.
      if (query.blocked !== undefined) conditions.push(eq(stockLocations.blocked, query.blocked));
      const where = and(...conditions);

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            articleId: stockBalances.articleId,
            locationId: stockBalances.locationId,
            quantityOnHand: stockBalances.quantityOnHand,
            locationName: stockLocations.name,
            warehouseName: warehouses.name,
            // A balance on a Spärrad lagerplats — physical, but not usable.
            locationBlocked: stockLocations.blocked,
            articleNumber: articles.articleNumber,
            articleName: articles.name,
            // The balance is in the article's base unit.
            unitCode: units.code,
          })
          .from(stockBalances)
          .leftJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
          .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .innerJoin(articles, eq(articles.id, stockBalances.articleId))
          .innerJoin(units, eq(units.id, articles.unitId))
          .where(where)
          .orderBy(asc(articles.articleNumber), asc(stockLocations.name))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(stockBalances)
          .leftJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
          .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .innerJoin(articles, eq(articles.id, stockBalances.articleId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // Balance rows for a set of articles — used by the sales pick list to
    // show where each article can be picked from, in the order the automatic
    // outflow draws from them (the huvudplats first, then the alternative
    // places in order, then warehouse/location, "***" last —
    // compareOutflowLocations is the one rule for both, and `preference` is
    // the same articlePlacePreference: 0 huvudplats, the alternative's
    // sort_order, null other, and "***" as huvudplats counts as none), so
    // the paper and the booking agree. Physical: a row on
    // a Spärrad lagerplats is included with blocked = true — the pick list
    // leaves it out (Automatiskt never draws there), the configurator's
    // variant list sums it like the article card.
    async balancesForArticles(articleIds: string[]) {
      if (articleIds.length === 0) return [];
      const rows = await db
        .select({
          articleId: stockBalances.articleId,
          locationId: stockBalances.locationId,
          quantityOnHand: stockBalances.quantityOnHand,
          locationName: stockLocations.name,
          warehouseName: warehouses.name,
          blocked: sql<boolean>`coalesce(${stockLocations.blocked}, false)`,
          isPrimary: sql<boolean>`coalesce(${articles.defaultLocationId} = ${stockBalances.locationId}, false)`,
          sortOrder: articleAlternativeLocations.sortOrder,
        })
        .from(stockBalances)
        .innerJoin(articles, eq(articles.id, stockBalances.articleId))
        .leftJoin(
          articleAlternativeLocations,
          and(
            eq(articleAlternativeLocations.articleId, stockBalances.articleId),
            eq(articleAlternativeLocations.locationId, stockBalances.locationId)
          )
        )
        .leftJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
        .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(and(inArray(stockBalances.articleId, articleIds), ne(stockBalances.quantityOnHand, "0")))
        .orderBy(asc(warehouses.name), asc(stockLocations.name));
      return rows
        .map(({ isPrimary, sortOrder, blocked, ...row }) => ({
          ...row,
          blocked: blocked === true,
          preference: articlePlacePreference({ locationName: row.locationName ?? "", isPrimary: isPrimary === true, sortOrder }),
        }))
        .sort((a, b) =>
          compareOutflowLocations(
            { warehouseName: a.warehouseName ?? "", locationName: a.locationName ?? "", preference: a.preference },
            { warehouseName: b.warehouseName ?? "", locationName: b.locationName ?? "", preference: b.preference }
          )
        );
    },

    // Flera lagerplatser per artikel (0186): the Lager tab's card. The
    // replace runs in its own transaction (article-locations.ts takes the
    // locks); the answer is read after the commit.
    // Batch (#8): the pick list's cells for the batchstyrda among these
    // articles, in the order Automatiskt draws (batch-balances.ts).
    async pickBatchCellsForArticles(articleIds: string[], opts: { locationId?: string } = {}) {
      return pickBatchCellsForArticles(db, articleIds, { ...opts, today: stockholmToday() });
    },

    // Batch (#8): GET /articles/:id/batch-balances — null = no such article.
    // An article that is not batchstyrd shows no batches: the ones it had
    // stay in the log and come back when the flag is switched on again.
    async articleBatchBalances(articleId: string) {
      const [article] = await db.select({ tracking: articles.tracking, stockTracked: trackedSql() }).from(articles).where(eq(articles.id, articleId));
      if (!article) return null;
      return {
        batchTracked: article.tracking === "batch",
        batches: article.stockTracked ? await articleBatchBalances(db, articleId, stockholmToday()) : [],
      };
    },

    // Spårbarhet (#8): the batch register and one batch's trace. The whole
    // trace reads ONE snapshot (repeatable read, read only — PIA's pattern),
    // so a level never sees a movement the level before it did not.
    async listBatches(query: ListStockBatchesQuery) {
      return listStockBatches(db, query, stockholmToday());
    },

    // PATCH /stock/batches/:id (etapp 2): the batch's dates and number. The
    // batch row is not part of the append-only log. The row is locked FOR
    // UPDATE and compared, so the caller can log what actually changed; a
    // number another batch of the article has (case-insensitively, the
    // unique index) is DuplicateBatchNumberError, the reserved name
    // BatchNumberReservedError. null = no such batch.
    async updateBatch(batchId: string, input: UpdateStockBatchInput) {
      return db.transaction(async (tx) => {
        const columns = {
          id: stockBatches.id,
          articleId: stockBatches.articleId,
          batchNumber: stockBatches.batchNumber,
          expiresOn: stockBatches.expiresOn,
          batchDate: stockBatches.batchDate,
        };
        const [before] = await tx.select(columns).from(stockBatches).where(eq(stockBatches.id, batchId)).for("update");
        if (!before) return null;
        const patch: { expiresOn?: string | null; batchDate?: string | null; batchNumber?: string } = {};
        if (input.expiresOn !== undefined && input.expiresOn !== before.expiresOn) patch.expiresOn = input.expiresOn;
        if (input.batchDate !== undefined && input.batchDate !== before.batchDate) patch.batchDate = input.batchDate;
        if (input.batchNumber !== undefined) {
          const batchNumber = normalizeBatchNumber(input.batchNumber);
          if (batchNumber !== before.batchNumber) patch.batchNumber = batchNumber;
        }
        if (Object.keys(patch).length === 0) return { before, after: before, changed: false };
        try {
          // A savepoint, so the unique violation does not abort the caller's
          // view of the transaction before it is mapped.
          const [after] = await tx.transaction((sp) => sp.update(stockBatches).set(patch).where(eq(stockBatches.id, batchId)).returning(columns));
          return { before, after: after!, changed: true };
        } catch (err) {
          if (isUniqueViolation(err) && patch.batchNumber !== undefined) throw new DuplicateBatchNumberError(patch.batchNumber);
          throw err;
        }
      });
    },

    async traceBatch(batchId: string, limits?: BatchTraceLimits) {
      return db.transaction((tx) => traceBatch(createBatchTraceReader(tx), batchId, limits), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
    },

    async articleLocations(articleId: string) {
      return readArticleLocations(db, articleId);
    },

    async replaceArticleLocations(articleId: string, input: ArticleLocationsInput) {
      await db.transaction((tx) => replaceArticleLocations(tx, articleId, input));
      return (await readArticleLocations(db, articleId))!;
    },

    // Lagerloggen. The where clause is built once (against the base table) and
    // shared by the rows and the count query. The running balance is a window
    // over the article's FULL history (restricted to the location only when a
    // location filter is set), computed in its own subquery and joined back by
    // id — so type/direction/date/search filters never change it. Dates, the
    // order and the running balance follow the värderingsdatum (#26,
    // stockValuedAt): a stock count registered per underlagets datum sits at
    // its freeze time; createdAt still says when the row was registered.
    async listTransactions(query: ListStockTransactionsQuery) {
      const conditions: (SQL | undefined)[] = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(articles.articleNumber, pattern), ilike(articles.name, pattern)));
      }
      if (query.articleId) conditions.push(eq(stockTransactions.articleId, query.articleId));
      if (query.locationId) conditions.push(eq(stockTransactions.locationId, query.locationId));
      if (query.type) conditions.push(eq(stockTransactions.transactionType, query.type));
      if (query.batchId) conditions.push(eq(stockTransactions.batchId, query.batchId));
      if (query.direction === "in") conditions.push(sql`${stockTransactions.quantityDelta} > 0`);
      if (query.direction === "out") conditions.push(sql`${stockTransactions.quantityDelta} < 0`);
      // from/to are Stockholm calendar days, inclusive.
      if (query.from) {
        conditions.push(sql`${stockValuedAt} >= (${query.from}::date)::timestamp AT TIME ZONE 'Europe/Stockholm'`);
      }
      if (query.to) {
        conditions.push(
          sql`${stockValuedAt} < ((${query.to}::date + 1)::timestamp AT TIME ZONE 'Europe/Stockholm')`
        );
      }
      const where = and(...conditions);

      const balanceSq = query.articleId
        ? db
            .select({
              id: stockTransactions.id,
              balance: sql<string>`sum(${stockTransactions.quantityDelta}) over (order by ${stockValuedAt}, (${stockTransactions.quantityDelta} > 0), ${stockTransactions.id})`.as(
                "balance"
              ),
            })
            .from(stockTransactions)
            .where(
              and(
                eq(stockTransactions.articleId, query.articleId),
                query.locationId ? eq(stockTransactions.locationId, query.locationId) : undefined
              )
            )
            .as("bal")
        : null;

      const po = alias(purchaseOrders, "ref_po");
      const so = alias(salesOrders, "ref_so");
      const mo = alias(manufacturingOrders, "ref_mo");
      const sc = alias(stockCountSessions, "ref_sc");
      const t = stockTransactions;

      const rowsBase = db
        .select({
          ...getTableColumns(stockTransactions),
          // Always set — the column's NULL means "same as createdAt".
          valuedAt: stockValuedAt,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          locationName: stockLocations.name,
          warehouseName: warehouses.name,
          // Batch (#8): a PK lookup per shown row; null = Okänd / no batch.
          batchNumber: stockBatches.batchNumber,
          createdByName: users.name,
          value: sql<string | null>`${t.quantityDelta} * ${t.unitCost}`,
          balance: balanceSq ? balanceSq.balance : sql<string | null>`null`,
          poId: po.id,
          poNumber: po.orderNumber,
          soId: so.id,
          soNumber: so.orderNumber,
          moId: mo.id,
          moNumber: mo.orderNumber,
          scId: sc.id,
          scNumber: sc.countNumber,
          counterpartLocation: sql<string | null>`(
            select w2.name || ' — ' || l2.name
            from stock_transactions t2
            join stock_locations l2 on l2.id = t2.location_id
            join warehouses w2 on w2.id = l2.warehouse_id
            where ${t.transactionType} = 'stock_transfer'
              and t2.reference_id = ${t.referenceId}
              and t2.article_id = ${t.articleId}
              and t2.id <> ${t.id}
              and sign(t2.quantity_delta) = -sign(${t.quantityDelta})
            order by t2.id
            limit 1
          )`,
        })
        .from(stockTransactions)
        .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
        .leftJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
        .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .leftJoin(users, eq(users.id, stockTransactions.createdBy))
        .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
        .leftJoin(po, and(eq(t.transactionType, "purchase_receipt"), eq(po.id, t.referenceId)))
        .leftJoin(so, and(eq(t.transactionType, "sales_delivery"), eq(so.id, t.referenceId)))
        .leftJoin(
          mo,
          and(inArray(t.transactionType, ["mo_consumption", "mo_receipt"]), eq(mo.id, t.referenceId))
        )
        .leftJoin(sc, and(eq(t.transactionType, "inventory_adjustment"), eq(sc.id, t.referenceId)));

      const [rawRows, totalRows] = await Promise.all([
        (balanceSq ? rowsBase.leftJoin(balanceSq, eq(balanceSq.id, t.id)) : rowsBase)
          .where(where)
          .orderBy(
            desc(stockValuedAt),
            sql`(${stockTransactions.quantityDelta} > 0) desc`,
            desc(stockTransactions.id)
          )
          .limit(query.limit)
          .offset(query.offset),
        // articles only matter to the count when searching on them.
        (query.search
          ? db
              .select({ total: count() })
              .from(stockTransactions)
              .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
              .where(where)
          : db.select({ total: count() }).from(stockTransactions).where(where)),
      ]);

      const rows = rawRows.map(
        ({ poId, poNumber, soId, soNumber, moId, moNumber, scId, scNumber, counterpartLocation, ...row }) => {
          let reference: StockTransactionReference | null = null;
          switch (row.transactionType) {
            case "purchase_receipt":
              if (poId) reference = { kind: "purchase_order", id: poId, number: poNumber! };
              break;
            case "sales_delivery":
              if (soId) reference = { kind: "sales_order", id: soId, number: soNumber! };
              break;
            case "mo_consumption":
            case "mo_receipt":
              if (moId) reference = { kind: "manufacturing_order", id: moId, number: moNumber! };
              break;
            case "inventory_adjustment":
              reference = scId ? { kind: "stock_count", id: scId, number: scNumber! } : { kind: "manual" };
              break;
            case "stock_transfer":
              if (counterpartLocation) reference = { kind: "transfer", counterpartLocation };
              break;
          }
          return { ...row, reference };
        }
      );
      return { rows, total: totalRows[0]!.total };
    },
  };
}

export type StockRepository = ReturnType<typeof createStockRepository>;
