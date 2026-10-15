import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles,
  manufacturingOrders,
  purchaseOrders,
  salesOrders,
  stockBalances,
  stockCountSessions,
  stockLocations,
  stockTransactions,
  users,
  warehouses,
  type Db,
} from "@navet/db";
import { resolveStockLocation } from "../service/location-resolver.js";
import { deactivateEmptyLocation, locationHoldsStock } from "../service/location-lifecycle.js";
import { assertLocationNotUnderCount } from "../service/count-guard.js";
import {
  ilikePattern,
  type CreateStockLocationInput,
  type CreateStockTransactionInput,
  type CreateStockTransferInput,
  type CreateWarehouseInput,
  type ListQuery,
  type ListStockTransactionsQuery,
  type StockTransactionReference,
  type ListStockBalancesQuery,
  type ListStockLocationsQuery,
  type UpdateStockLocationInput,
  type UpdateWarehouseInput,
} from "@navet/shared";
import {
  ArticleNotFoundError,
  InactiveStockLocationError,
  InsufficientStockError,
  StockLocationNotEmptyError,
  StockLocationNotFoundError,
} from "../service/stock.errors.js";

export function createStockRepository(db: Db) {
  return {
    async createWarehouse(input: CreateWarehouseInput) {
      const [row] = await db.insert(warehouses).values(input).returning();
      return row;
    },

    async createLocation(input: CreateStockLocationInput) {
      const [row] = await db.insert(stockLocations).values(input).returning();
      return row;
    },

    async updateWarehouse(id: string, input: UpdateWarehouseInput) {
      const [row] = await db.update(warehouses).set(input).where(eq(warehouses.id, id)).returning();
      return row ?? null;
    },

    async updateLocation(id: string, input: UpdateStockLocationInput) {
      return db.transaction(async (tx) => {
        // Retiring a location by hand must not strand its stock — emptying it
        // is what deactivates a location, and that happens automatically.
        if (input.active === false) {
          const [current] = await tx
            .select({ name: stockLocations.name, active: stockLocations.active })
            .from(stockLocations)
            .where(eq(stockLocations.id, id));
          if (current?.active && (await locationHoldsStock(tx, id))) {
            throw new StockLocationNotEmptyError(current.name);
          }
        }
        const [row] = await tx.update(stockLocations).set(input).where(eq(stockLocations.id, id)).returning();
        return row ?? null;
      });
    },

    // Append-only: this is the only write path into stock. There is no update/delete
    // on balances — current quantity is always derived from stock_balances.
    async listWarehouses() {
      return db.select().from(warehouses).orderBy(asc(warehouses.name));
    },

    // Deactivated locations are the system's "deleted" — only the register page
    // asks for them, every form dropdown gets the active ones.
    async listLocations(query: ListStockLocationsQuery = { includeInactive: false }) {
      return db
        .select({
          id: stockLocations.id,
          warehouseId: stockLocations.warehouseId,
          name: stockLocations.name,
          active: stockLocations.active,
          warehouseName: warehouses.name,
        })
        .from(stockLocations)
        .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(query.includeInactive ? undefined : eq(stockLocations.active, true))
        .orderBy(asc(warehouses.name), asc(stockLocations.name));
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
          .select({ id: stockLocations.id, name: stockLocations.name, active: stockLocations.active })
          .from(stockLocations)
          .where(eq(stockLocations.id, input.toLocationId));
        if (!to) throw new StockLocationNotFoundError(input.toLocationId);
        if (!to.active) throw new InactiveStockLocationError(to.name);

        // A count freezes its whole location — both legs of a transfer touch one.
        await assertLocationNotUnderCount(tx, from.id);
        await assertLocationNotUnderCount(tx, to.id);

        const articleIds = input.rows.map((row) => row.articleId);

        // Captured before the cleanup below clears every pointer to the source.
        const followers = await tx
          .select({ id: articles.id })
          .from(articles)
          .where(and(inArray(articles.id, articleIds), eq(articles.defaultLocationId, from.id)));

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
        // source follow it rather than falling back to "***".
        if (deactivatedSourceLocation && followers.length > 0) {
          await tx
            .update(articles)
            .set({ defaultLocationId: to.id })
            .where(inArray(articles.id, followers.map((a) => a.id)));
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
      if (query.locationId) conditions.push(eq(stockBalances.locationId, query.locationId));
      const where = and(...conditions);

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            articleId: stockBalances.articleId,
            locationId: stockBalances.locationId,
            quantityOnHand: stockBalances.quantityOnHand,
            locationName: stockLocations.name,
            warehouseName: warehouses.name,
            articleNumber: articles.articleNumber,
            articleName: articles.name,
          })
          .from(stockBalances)
          .leftJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
          .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
          .innerJoin(articles, eq(articles.id, stockBalances.articleId))
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
    // show where each article can be picked from.
    async balancesForArticles(articleIds: string[]) {
      if (articleIds.length === 0) return [];
      return db
        .select({
          articleId: stockBalances.articleId,
          quantityOnHand: stockBalances.quantityOnHand,
          locationName: stockLocations.name,
          warehouseName: warehouses.name,
        })
        .from(stockBalances)
        .leftJoin(stockLocations, eq(stockLocations.id, stockBalances.locationId))
        .leftJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(and(inArray(stockBalances.articleId, articleIds), ne(stockBalances.quantityOnHand, "0")))
        .orderBy(asc(warehouses.name), asc(stockLocations.name));
    },

    // Lagerloggen. The where clause is built once (against the base table) and
    // shared by the rows and the count query. The running balance is a window
    // over the article's FULL history (restricted to the location only when a
    // location filter is set), computed in its own subquery and joined back by
    // id — so type/direction/date/search filters never change it.
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
        conditions.push(sql`${stockTransactions.createdAt} >= (${query.from}::date)::timestamp AT TIME ZONE 'Europe/Stockholm'`);
      }
      if (query.to) {
        conditions.push(
          sql`${stockTransactions.createdAt} < ((${query.to}::date + 1)::timestamp AT TIME ZONE 'Europe/Stockholm')`
        );
      }
      const where = and(...conditions);

      const balanceSq = query.articleId
        ? db
            .select({
              id: stockTransactions.id,
              balance: sql<string>`sum(${stockTransactions.quantityDelta}) over (order by ${stockTransactions.createdAt}, (${stockTransactions.quantityDelta} > 0), ${stockTransactions.id})`.as(
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
            desc(stockTransactions.createdAt),
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
