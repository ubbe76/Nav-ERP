import { and, asc, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  articles,
  articleStandardCostHistory,
  stockBatches,
  stockCountRows,
  stockCountSessions,
  stockLocations,
  stockTransactions,
  units,
  warehouses,
  type Db,
  type Tx,
} from "@navet/db";
import {
  formatLocationLabelCode,
  ilikePattern,
  type AddStockCountRowInput,
  type CreateStockCountInput,
  type ListStockCountsQuery,
  type StockCountBookOn,
  type UpdateStockCountRowInput,
} from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { deactivateEmptyLocation } from "../service/location-lifecycle.js";
import { isStockedArticleType } from "../service/stocked-article.js";
import { BatchNotTrackedError } from "../service/batch.errors.js";
import { getOrCreateBatch } from "../service/batches.js";
import { isTrackedArticle, batchTrackedSql, trackedSql } from "../service/batch-tracking.js";
import { lockArticlesForOutflow } from "../service/outflow-locations.js";
import { batchCellQuantity } from "./batch-balances.js";
import { stockValuedDate } from "./valued-at.js";
import {
  ArticleNotFoundError,
  ServiceArticleNotStockedError,
  DuplicateStockCountRowError,
  StockCountBackdateRefusedError,
  InactiveStockLocationError,
  StockCountAlreadyOpenError,
  StockCountNotFoundError,
  StockCountNotOpenError,
  StockCountRowNotFoundError,
  StockLocationNotFoundError,
} from "../service/stock.errors.js";

// Current derived balance for one article on one location — the same
// SUM(quantity_delta) the stock_balances view aggregates, scoped to a pair.
async function balanceFor(db: Db | Tx, articleId: string, locationId: string): Promise<string> {
  const [row] = await db
    .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return row?.quantity ?? "0";
}

// Inventering per underlagets datum (#26). Bookkeeping lives in the economy
// module, so whether the count's day may still be written to arrives through
// this reader (app.ts binds economy's postingPeriodLockOn). No covering
// accounting period is no lock — the stock log is not bookkeeping.
export interface PostingPeriodReader {
  lockOn(executor: Db | Tx, date: string): Promise<{ kind: "year_closed"; yearLabel: string } | { kind: "period_locked" } | null>;
}

// Tests that never backdate into a locked period build the repository without
// economy; app.ts always passes the real reader.
export const noPostingPeriodLocks: PostingPeriodReader = { lockOn: async () => null };

export type StockCountBackdateReason = "year_closed" | "period_locked" | "disturbed";

// sv-SE formats ISO-style (YYYY-MM-DD); explicit zone — the container may run UTC.
const stockholmDay = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });
export const stockholmDateOf = (instant: Date): string => stockholmDay.format(instant);

// May the count be booked per the moment its underlag was created? Only when
// the counted figures provably describe that moment and the day is still
// open for bookkeeping:
//  - no row that will be booked (counted, non-zero difference) has had a
//    movement registered on the location after the freeze, other than the
//    session's own — a blocking session passes by construction (the guard's
//    accepted TOCTOU aside), an unblocked one only when nothing happened;
//  - the day is in neither a closed fiscal year nor a locked period.
// The first refusal wins, the year/period before the movements (they are the
// harder rule: nothing at all may be written there). Read by GET (the card's
// choice) and again inside postSession's transaction (the authority).
async function backdatingVerdict(
  executor: Db | Tx,
  periods: PostingPeriodReader,
  session: { id: string; locationId: string; createdAt: Date },
  bookedArticleIds: string[]
): Promise<{ countDate: string; reason: StockCountBackdateReason | null; reasonText: string | null }> {
  const countDate = stockholmDateOf(session.createdAt);
  const lock = await periods.lockOn(executor, countDate);
  if (lock?.kind === "year_closed") {
    return { countDate, reason: "year_closed", reasonText: `Räkenskapsåret ${lock.yearLabel} är stängt.` };
  }
  if (lock?.kind === "period_locked") {
    return { countDate, reason: "period_locked", reasonText: `Bokföringsperioden för ${countDate} är låst.` };
  }
  if (bookedArticleIds.length > 0) {
    const [moved] = await executor
      .select({ id: stockTransactions.id })
      .from(stockTransactions)
      .where(
        and(
          eq(stockTransactions.locationId, session.locationId),
          inArray(stockTransactions.articleId, bookedArticleIds),
          gt(stockTransactions.createdAt, session.createdAt),
          or(isNull(stockTransactions.referenceId), ne(stockTransactions.referenceId, session.id))!
        )
      )
      .limit(1);
    if (moved) {
      return {
        countDate,
        reason: "disturbed",
        reasonText: "Inventeringens artiklar har fått lagerrörelser på lagerplatsen efter att underlaget skapades.",
      };
    }
  }
  return { countDate, reason: null, reasonText: null };
}

// The rows postSession books: counted, with a difference against the snapshot.
function bookedRows<T extends { snapshotQuantity: string; countedQuantity: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => r.countedQuantity !== null && Number(r.countedQuantity) - Number(r.snapshotQuantity) !== 0);
}

// The standard cost each article had at `at` (D1's history: the latest row
// with valid_from <= at). An article with no history at all keeps its
// current standard cost (articles from before the history); one whose
// history only starts later had none then — null, never 0 (D0).
async function standardCostsAt(executor: Db | Tx, articleIds: string[], at: Date): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (articleIds.length === 0) return result;
  const history = await executor
    .select({
      articleId: articleStandardCostHistory.articleId,
      cost: articleStandardCostHistory.cost,
      validFrom: articleStandardCostHistory.validFrom,
    })
    .from(articleStandardCostHistory)
    .where(inArray(articleStandardCostHistory.articleId, articleIds))
    .orderBy(asc(articleStandardCostHistory.articleId), asc(articleStandardCostHistory.validFrom), asc(articleStandardCostHistory.id));
  const current = await executor
    .select({ id: articles.id, standardCost: articles.standardCost })
    .from(articles)
    .where(inArray(articles.id, articleIds));
  const withHistory = new Set<string>();
  for (const row of history) {
    withHistory.add(row.articleId);
    if (!result.has(row.articleId)) result.set(row.articleId, null);
    if (row.validFrom.getTime() <= at.getTime()) result.set(row.articleId, row.cost);
  }
  for (const article of current) {
    if (!withHistory.has(article.id)) result.set(article.id, article.standardCost ?? null);
  }
  return result;
}

// Loads the session FOR UPDATE and asserts it is still open — every mutation
// (row edits, post, cancel) goes through this so two concurrent registrations
// cannot both book the differences.
async function lockOpenSession(tx: Tx, id: string) {
  const [session] = await tx
    .select()
    .from(stockCountSessions)
    .where(eq(stockCountSessions.id, id))
    .for("update");
  if (!session) throw new StockCountNotFoundError(id);
  if (session.status !== "open") throw new StockCountNotOpenError(session.countNumber, session.status);
  return session;
}

export function createStockCountRepository(db: Db, periods: PostingPeriodReader = noPostingPeriodLocks) {
  return {
    // Freeze: allocates the INV number (document series — inside the tx, a
    // failed create must roll the number back too), seeds one row per
    // non-zero balance on the location, snapshot = the balance right now.
    async createSession(input: CreateStockCountInput, createdBy: string | null) {
      return db.transaction(async (tx) => {
        const [location] = await tx
          .select({ id: stockLocations.id, name: stockLocations.name, active: stockLocations.active })
          .from(stockLocations)
          .where(eq(stockLocations.id, input.locationId));
        if (!location) throw new StockLocationNotFoundError(input.locationId);
        // A location holding stock is always active (invariant), so an
        // inactive one can only be empty — counting it is a user mistake.
        if (!location.active) throw new InactiveStockLocationError(location.name);

        // Pre-check for a friendly message; the partial unique index
        // (uq_stock_count_open_location) is the real guarantee under races.
        const [open] = await tx
          .select({ id: stockCountSessions.id })
          .from(stockCountSessions)
          .where(and(eq(stockCountSessions.locationId, input.locationId), eq(stockCountSessions.status, "open")))
          .limit(1);
        if (open) throw new StockCountAlreadyOpenError(location.name);

        const countNumber = await getNextOrderNumber(tx, "stock_count");
        let session;
        try {
          [session] = await tx
            .insert(stockCountSessions)
            .values({
              countNumber,
              locationId: input.locationId,
              blocksTransactions: input.blocksTransactions,
              note: input.note,
              createdBy,
            })
            .returning();
        } catch (err) {
          // Race lost on uq_stock_count_open_location — same 409 as the
          // pre-check, not a raw 23505 (addRow's idiom).
          if (isUniqueViolation(err)) throw new StockCountAlreadyOpenError(location.name);
          throw err;
        }

        // Services are never counted (tjänster lagerförs inte,
        // stocked-article.ts) — a balance one got before the rule stays as
        // history.
        // Batch (#8): a batchstyrd article is counted per batch — one row
        // per cell with a balance (batch null = Okänd); every other article
        // has its one row, summed over whatever batches its log holds.
        const countedBatch = sql<string | null>`case when ${trackedSql()} then ${stockTransactions.batchId} end`;
        const balances = await tx
          .select({
            articleId: stockTransactions.articleId,
            batchId: countedBatch,
            quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
          })
          .from(stockTransactions)
          .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
          .where(and(eq(stockTransactions.locationId, input.locationId), ne(articles.type, "service")))
          .groupBy(stockTransactions.articleId, countedBatch)
          .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`);

        if (balances.length > 0) {
          await tx.insert(stockCountRows).values(
            balances.map((b) => ({
              sessionId: session!.id,
              articleId: b.articleId,
              batchId: b.batchId,
              snapshotQuantity: b.quantity,
            }))
          );
        }

        return { ...session!, rowCount: balances.length };
      });
    },

    async listSessions(query: ListStockCountsQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(stockCountSessions.countNumber, pattern),
            ilike(stockLocations.name, pattern),
            ilike(warehouses.name, pattern)
          )!
        );
      }
      if (query.status && query.status.length > 0) {
        conditions.push(inArray(stockCountSessions.status, query.status));
      }
      if (query.locationId) conditions.push(eq(stockCountSessions.locationId, query.locationId));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const base = () =>
        db
          .select({
            id: stockCountSessions.id,
            countNumber: stockCountSessions.countNumber,
            locationId: stockCountSessions.locationId,
            locationName: stockLocations.name,
            warehouseName: warehouses.name,
            status: stockCountSessions.status,
            blocksTransactions: stockCountSessions.blocksTransactions,
            createdAt: stockCountSessions.createdAt,
            postedAt: stockCountSessions.postedAt,
          })
          .from(stockCountSessions)
          .innerJoin(stockLocations, eq(stockLocations.id, stockCountSessions.locationId))
          .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId));

      const [rows, totalRows] = await Promise.all([
        base().where(where).orderBy(desc(stockCountSessions.createdAt)).limit(query.limit).offset(query.offset),
        db
          .select({ total: count() })
          .from(stockCountSessions)
          .innerJoin(stockLocations, eq(stockLocations.id, stockCountSessions.locationId))
          .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .where(where),
      ]);

      // Row/counted counts per session — count(col) skips NULLs, so
      // count(counted_quantity) is exactly "rows with a counted value".
      const ids = rows.map((r) => r.id);
      const countRows =
        ids.length === 0
          ? []
          : await db
              .select({
                sessionId: stockCountRows.sessionId,
                rowCount: sql<number>`count(*)::int`,
                countedCount: sql<number>`count(${stockCountRows.countedQuantity})::int`,
              })
              .from(stockCountRows)
              .where(inArray(stockCountRows.sessionId, ids))
              .groupBy(stockCountRows.sessionId);
      const countsBySession = new Map(countRows.map((c) => [c.sessionId, c]));

      return {
        rows: rows.map((r) => ({
          ...r,
          rowCount: countsBySession.get(r.id)?.rowCount ?? 0,
          countedCount: countsBySession.get(r.id)?.countedCount ?? 0,
        })),
        total: totalRows[0]!.total,
      };
    },

    // Header + rows with the derived per-row "disturbed" flag: a transaction
    // on (article, location) after the freeze, excluding the session's own
    // posted adjustments, and — once posted — only up to posted_at (the flag
    // means "was disturbed while the count ran", not "moved since").
    async getSession(id: string) {
      const [session] = await db
        .select({
          id: stockCountSessions.id,
          countNumber: stockCountSessions.countNumber,
          locationId: stockCountSessions.locationId,
          locationName: stockLocations.name,
          locationLabelNumber: stockLocations.labelNumber,
          warehouseName: warehouses.name,
          status: stockCountSessions.status,
          blocksTransactions: stockCountSessions.blocksTransactions,
          note: stockCountSessions.note,
          createdAt: stockCountSessions.createdAt,
          postedAt: stockCountSessions.postedAt,
        })
        .from(stockCountSessions)
        .innerJoin(stockLocations, eq(stockLocations.id, stockCountSessions.locationId))
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(eq(stockCountSessions.id, id));
      if (!session) return null;

      const rows = await db
        .select({
          id: stockCountRows.id,
          articleId: stockCountRows.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          // Base unit code — same innerJoin(units, articles.unitId) the
          // article repository/pick-list use (unitId is a FK, not a code column).
          unit: units.code,
          snapshotQuantity: stockCountRows.snapshotQuantity,
          countedQuantity: stockCountRows.countedQuantity,
          note: stockCountRows.note,
          // Batch (#8): the row's cell — null = Okänd (and the one row of an
          // article that is not batchstyrd). batchTracked tells the card
          // which articles may get another batch row.
          batchId: stockCountRows.batchId,
          batchNumber: stockBatches.batchNumber,
          batchTracked: batchTrackedSql(),
          tracking: articles.tracking,
          // Lagerspårad: the row is one of the article's cells (stock.md).
          stockTracked: trackedSql(),
          // Etapp 2: the batch's utgångsdatum (null = none / Okänd).
          expiresOn: stockBatches.expiresOn,
        })
        .from(stockCountRows)
        .innerJoin(articles, eq(articles.id, stockCountRows.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(stockBatches, eq(stockBatches.id, stockCountRows.batchId))
        .where(eq(stockCountRows.sessionId, id))
        // Per article in the batches' own order: Okänd first, then the oldest.
        .orderBy(
          asc(articles.articleNumber),
          sql`${stockBatches.createdAt} asc nulls first`,
          asc(stockBatches.batchNumber),
          asc(stockCountRows.id)
        );

      const disturbedConditions = [
        eq(stockTransactions.locationId, session.locationId),
        gt(stockTransactions.createdAt, session.createdAt),
        or(isNull(stockTransactions.referenceId), ne(stockTransactions.referenceId, session.id))!,
      ];
      if (session.postedAt) disturbedConditions.push(lte(stockTransactions.createdAt, session.postedAt));
      const disturbedRows = await db
        .selectDistinct({ articleId: stockTransactions.articleId })
        .from(stockTransactions)
        .where(and(...disturbedConditions));
      const disturbed = new Set(disturbedRows.map((d) => d.articleId));

      // #26: an open count says whether Registrera may book it per the
      // underlag's day (the card's choice); a posted one says which day it
      // was booked per when that was not its registration day's own moment.
      let backdating = null;
      if (session.status === "open") {
        const verdict = await backdatingVerdict(
          db,
          periods,
          session,
          bookedRows(rows).map((r) => r.articleId)
        );
        backdating = {
          ...verdict,
          allowed: verdict.reason === null,
          sameDay: verdict.countDate === stockholmDateOf(new Date()),
        };
      }
      let valuedOn: string | null = null;
      if (session.status === "posted") {
        const [valued] = await db
          .select({ day: sql<string>`${stockValuedDate}::text` })
          .from(stockTransactions)
          .where(
            and(
              eq(stockTransactions.referenceId, session.id),
              eq(stockTransactions.transactionType, "inventory_adjustment"),
              isNotNull(stockTransactions.valuedAt)
            )
          )
          .limit(1);
        valuedOn = valued?.day ?? null;
      }

      const { locationLabelNumber, ...header } = session;
      return {
        ...header,
        // Skanning (#4): the place's label code, printed as the räknelista's
        // barcode and shown on the count card.
        locationLabelCode: formatLocationLabelCode(locationLabelNumber),
        rowCount: rows.length,
        countedCount: rows.filter((r) => r.countedQuantity !== null).length,
        rows: rows.map((r) => ({ ...r, disturbed: disturbed.has(r.articleId) })),
        backdating,
        valuedOn,
      };
    },

    // Add a physically-found article the seeding didn't list (zero balance).
    async addRow(sessionId: string, input: AddStockCountRowInput) {
      return db.transaction(async (tx) => {
        const session = await lockOpenSession(tx, sessionId);
        const [article] = await tx
          .select({ id: articles.id, articleNumber: articles.articleNumber, type: articles.type })
          .from(articles)
          .where(eq(articles.id, input.articleId));
        if (!article) throw new ArticleNotFoundError(input.articleId);
        if (!isStockedArticleType(article.type)) throw new ServiceArticleNotStockedError(article.articleNumber);

        // Batch (#8): a batchstyrd article gets one row per batch — the
        // named one (created when it is new: goods found on the shelf with a
        // batch nobody booked), or without a number the Okänd row — and the
        // snapshot is that CELL's balance. Any other article has its one
        // row for the whole place, and a batch for it is refused.
        const batchTracked = await isTrackedArticle(tx, input.articleId);
        if (input.batchNumber !== undefined && !batchTracked) throw new BatchNotTrackedError(article.articleNumber);
        const batch =
          input.batchNumber !== undefined
            ? await getOrCreateBatch(tx, { articleId: input.articleId, batchNumber: input.batchNumber, origin: "manual" })
            : null;
        const snapshot = batchTracked
          ? String(await batchCellQuantity(tx, input.articleId, session.locationId, batch?.id ?? null))
          : await balanceFor(tx, input.articleId, session.locationId);
        try {
          const [row] = await tx
            .insert(stockCountRows)
            .values({ sessionId, articleId: input.articleId, batchId: batch?.id ?? null, snapshotQuantity: snapshot })
            .returning();
          return row!;
        } catch (err) {
          if (isUniqueViolation(err)) throw new DuplicateStockCountRowError(article.articleNumber);
          throw err;
        }
      });
    },

    async updateRow(sessionId: string, rowId: string, input: UpdateStockCountRowInput) {
      return db.transaction(async (tx) => {
        await lockOpenSession(tx, sessionId);
        const patch: Record<string, string | null> = {};
        if (input.countedQuantity !== undefined) {
          patch.countedQuantity = input.countedQuantity === null ? null : String(input.countedQuantity);
        }
        if (input.note !== undefined) patch.note = input.note;
        const [row] = await tx
          .update(stockCountRows)
          .set(patch)
          .where(and(eq(stockCountRows.id, rowId), eq(stockCountRows.sessionId, sessionId)))
          .returning();
        if (!row) throw new StockCountRowNotFoundError(rowId);
        return row;
      });
    },

    async deleteRow(sessionId: string, rowId: string) {
      return db.transaction(async (tx) => {
        await lockOpenSession(tx, sessionId);
        const [row] = await tx
          .delete(stockCountRows)
          .where(and(eq(stockCountRows.id, rowId), eq(stockCountRows.sessionId, sessionId)))
          .returning({ id: stockCountRows.id });
        if (!row) throw new StockCountRowNotFoundError(rowId);
      });
    },

    // Registrering: one transaction for the whole session (C2's batch
    // pattern). Books counted - snapshot per counted row with a non-zero
    // diff as inventory_adjustment; uncounted rows are skipped, never
    // zeroed. Writes directly (not via createTransaction) so a blocking
    // session doesn't refuse its own resolution — the status flips to
    // posted in the same tx, releasing the guard atomically.
    //
    // #26 — bookOn: "count_date" values the rows at the freeze moment
    // (valued_at = the session's created_at; a positive difference at the
    // standard cost of that moment), "today" as before (valued_at null, the
    // current standard cost). Omitted = the card's default: the underlag's
    // day when backdatingVerdict allows it, else today. An explicit
    // "count_date" that is not allowed is refused (409), never silently
    // booked today.
    async postSession(id: string, postedBy: string | null, bookOn?: StockCountBookOn) {
      return db.transaction(async (tx) => {
        const session = await lockOpenSession(tx, id);
        // standardCost joined along (D0 rule 3) — one query, not one lookup
        // per positive-diff row; sessions are unbounded in size.
        const rows = await tx
          .select({
            articleId: stockCountRows.articleId,
            batchId: stockCountRows.batchId,
            snapshotQuantity: stockCountRows.snapshotQuantity,
            countedQuantity: stockCountRows.countedQuantity,
            note: stockCountRows.note,
            standardCost: articles.standardCost,
            batchTracked: batchTrackedSql(),
          tracking: articles.tracking,
          })
          .from(stockCountRows)
          .leftJoin(articles, eq(articles.id, stockCountRows.articleId))
          .where(eq(stockCountRows.sessionId, id));

        const toBook = bookedRows(rows);
        const verdict = await backdatingVerdict(
          tx,
          periods,
          session,
          toBook.map((r) => r.articleId)
        );
        if (bookOn === "count_date" && verdict.reason !== null) {
          throw new StockCountBackdateRefusedError(session.countNumber, verdict.countDate, verdict.reasonText!);
        }
        const backdated = (bookOn ?? (verdict.reason === null ? "count_date" : "today")) === "count_date";
        const valuedAt = backdated ? session.createdAt : null;
        const costAtFreeze = backdated
          ? await standardCostsAt(
              tx,
              toBook.filter((r) => Number(r.countedQuantity) > Number(r.snapshotQuantity)).map((r) => r.articleId),
              session.createdAt
            )
          : null;

        // Batch (#8): a negative difference on a batchstyrd article is an
        // outflow from its cell — the article lock every draw takes, sorted,
        // before any row is booked.
        await lockArticlesForOutflow(
          tx,
          toBook.filter((r) => r.batchTracked && Number(r.countedQuantity) < Number(r.snapshotQuantity)).map((r) => r.articleId)
        );

        let adjustments = 0;
        let counted = 0;
        let hasNegative = false;
        for (const row of rows) {
          if (row.countedQuantity === null) continue;
          counted += 1;
          const diff = Number(row.countedQuantity) - Number(row.snapshotQuantity);
          if (diff === 0) continue;

          // D0 rule 3: a positive adjustment is an inflow valued at the
          // article's standard cost — the one of the freeze moment when
          // backdated (#26), else the current one; null (never 0) when unset.
          // Negative diffs are outflows and carry no cost.
          const unitCost = diff > 0 ? (costAtFreeze ? (costAtFreeze.get(row.articleId) ?? null) : (row.standardCost ?? null)) : null;

          await tx.insert(stockTransactions).values({
            articleId: row.articleId,
            locationId: session.locationId,
            quantityDelta: String(diff),
            transactionType: "inventory_adjustment",
            referenceId: session.id,
            note: row.note ? `Inventering ${session.countNumber} — ${row.note}` : `Inventering ${session.countNumber}`,
            createdBy: postedBy,
            unitCost,
            valuedAt,
            // Batch (#8): the difference is booked in the row's cell.
            batchId: row.batchId,
          });
          adjustments += 1;
          if (diff < 0) hasNegative = true;
        }

        // Booking directly (not via resolveStockLocation) skipped the invariant
        // machinery: a location that was emptied and auto-deactivated mid-session
        // must come back when the count books saldo onto it — saldo on an
        // inactive location would be invisible in every list.
        if (adjustments > 0) {
          await tx
            .update(stockLocations)
            .set({ active: true })
            .where(and(eq(stockLocations.id, session.locationId), eq(stockLocations.active, false)));
        }

        // One call for the whole session — every row shares the location.
        if (hasNegative) await deactivateEmptyLocation(tx, session.locationId);

        const [updated] = await tx
          .update(stockCountSessions)
          .set({ status: "posted", postedAt: new Date() })
          .where(eq(stockCountSessions.id, id))
          .returning();

        return {
          session: updated!,
          adjustments,
          counted,
          skipped: rows.length - counted,
          // The day the differences count on when booked per the underlag.
          valuedOn: backdated && adjustments > 0 ? verdict.countDate : null,
        };
      });
    },

    async cancelSession(id: string) {
      return db.transaction(async (tx) => {
        await lockOpenSession(tx, id);
        const [updated] = await tx
          .update(stockCountSessions)
          .set({ status: "cancelled" })
          .where(eq(stockCountSessions.id, id))
          .returning();
        return updated!;
      });
    },
  };
}

export type StockCountRepository = ReturnType<typeof createStockCountRepository>;
