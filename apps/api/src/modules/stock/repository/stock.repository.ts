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
import { articlePlacePreference, compareOutflowLocations, FALLBACK_LOCATION_NAME } from "../service/outflow-allocation.js";
import { isCheckViolation } from "../../system/service/db-errors.js";
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
} from "@navet/shared";
import {
  ArticleNotFoundError,
  FallbackLocationNotBlockableError,
  InactiveStockLocationError,
  InsufficientStockError,
  StockLocationAlreadyBlockedError,
  StockLocationNotBlockedError,
  StockLocationNotEmptyError,
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
        // Location is mandatory — resolve article default / "***" when absent.
        const locationId = await resolveStockLocation(tx, input.articleId, input.locationId);
        await assertLocationNotUnderCount(tx, locationId);

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
            .select({ articleNumber: articles.articleNumber })
            .from(articles)
            .where(eq(articles.id, row.articleId));
          if (!article) throw new ArticleNotFoundError(row.articleId);

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

          await tx.insert(stockTransactions).values([
            {
              articleId: row.articleId,
              locationId: from.id,
              quantityDelta: String(-row.quantity),
              transactionType: "stock_transfer" as const,
              referenceId: transferId,
              note: input.note,
              createdBy,
            },
            {
              articleId: row.articleId,
              locationId: to.id,
              quantityDelta: String(row.quantity),
              transactionType: "stock_transfer" as const,
              referenceId: transferId,
              note: input.note,
              createdBy,
            },
          ]);
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
