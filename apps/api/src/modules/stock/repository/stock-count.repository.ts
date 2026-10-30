import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  articles,
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
  type UpdateStockCountRowInput,
} from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { deactivateEmptyLocation } from "../service/location-lifecycle.js";
import {
  ArticleNotFoundError,
  DuplicateStockCountRowError,
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

export function createStockCountRepository(db: Db) {
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

        const balances = await tx
          .select({
            articleId: stockTransactions.articleId,
            quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
          })
          .from(stockTransactions)
          .where(eq(stockTransactions.locationId, input.locationId))
          .groupBy(stockTransactions.articleId)
          .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`);

        if (balances.length > 0) {
          await tx.insert(stockCountRows).values(
            balances.map((b) => ({
              sessionId: session!.id,
              articleId: b.articleId,
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
        })
        .from(stockCountRows)
        .innerJoin(articles, eq(articles.id, stockCountRows.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .where(eq(stockCountRows.sessionId, id))
        .orderBy(asc(articles.articleNumber));

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

      const { locationLabelNumber, ...header } = session;
      return {
        ...header,
        // Skanning (#4): the place's label code, printed as the räknelista's
        // barcode and shown on the count card.
        locationLabelCode: formatLocationLabelCode(locationLabelNumber),
        rowCount: rows.length,
        countedCount: rows.filter((r) => r.countedQuantity !== null).length,
        rows: rows.map((r) => ({ ...r, disturbed: disturbed.has(r.articleId) })),
      };
    },

    // Add a physically-found article the seeding didn't list (zero balance).
    async addRow(sessionId: string, input: AddStockCountRowInput) {
      return db.transaction(async (tx) => {
        const session = await lockOpenSession(tx, sessionId);
        const [article] = await tx
          .select({ id: articles.id, articleNumber: articles.articleNumber })
          .from(articles)
          .where(eq(articles.id, input.articleId));
        if (!article) throw new ArticleNotFoundError(input.articleId);

        const snapshot = await balanceFor(tx, input.articleId, session.locationId);
        try {
          const [row] = await tx
            .insert(stockCountRows)
            .values({ sessionId, articleId: input.articleId, snapshotQuantity: snapshot })
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
    async postSession(id: string, postedBy: string | null) {
      return db.transaction(async (tx) => {
        const session = await lockOpenSession(tx, id);
        // standardCost joined along (D0 rule 3) — one query, not one lookup
        // per positive-diff row; sessions are unbounded in size.
        const rows = await tx
          .select({
            articleId: stockCountRows.articleId,
            snapshotQuantity: stockCountRows.snapshotQuantity,
            countedQuantity: stockCountRows.countedQuantity,
            note: stockCountRows.note,
            standardCost: articles.standardCost,
          })
          .from(stockCountRows)
          .leftJoin(articles, eq(articles.id, stockCountRows.articleId))
          .where(eq(stockCountRows.sessionId, id));

        let adjustments = 0;
        let counted = 0;
        let hasNegative = false;
        for (const row of rows) {
          if (row.countedQuantity === null) continue;
          counted += 1;
          const diff = Number(row.countedQuantity) - Number(row.snapshotQuantity);
          if (diff === 0) continue;

          // D0 rule 3: a positive adjustment is an inflow valued at the
          // article's current standard cost — null (never 0) when unset.
          // Negative diffs are outflows and carry no cost.
          const unitCost = diff > 0 ? (row.standardCost ?? null) : null;

          await tx.insert(stockTransactions).values({
            articleId: row.articleId,
            locationId: session.locationId,
            quantityDelta: String(diff),
            transactionType: "inventory_adjustment",
            referenceId: session.id,
            note: row.note ? `Inventering ${session.countNumber} — ${row.note}` : `Inventering ${session.countNumber}`,
            createdBy: postedBy,
            unitCost,
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

        return { session: updated!, adjustments, counted, skipped: rows.length - counted };
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
