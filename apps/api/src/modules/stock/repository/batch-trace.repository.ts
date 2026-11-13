import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  articles,
  customers,
  deliveries,
  deliveryRowLocations,
  deliveryRows,
  manufacturingOrders,
  purchaseOrders,
  purchaseReceipts,
  salesOrders,
  stockBatches,
  stockCountSessions,
  stockLocations,
  stockTransactions,
  suppliers,
  units,
  warehouses,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, type ListStockBatchesQuery, type StockBatchListRow, type TraceBatchRef } from "@navet/shared";
import type { BatchTraceReader, TraceMoEdge } from "../service/batch-trace.js";
import { isBatchExpired } from "../service/outflow-allocation.js";
import { trackedSql } from "../service/batch-tracking.js";
import { addDays } from "../../system/service/delivery-days.js";
import { batchExpiryHorizon, expiringBatchCondition } from "./batch-expiry.js";

// Spårbarhet (#8) — the reads behind GET /stock/batches and …/:id/trace.
// A leaf (`Db | Tx`) that reads the purchase, sales and manufacturing tables
// directly (precedent: manufacturing/repository/lego-purchases.ts): nothing
// is stored for the trace beyond `batch_id` on the stock rows, so every fact
// is the log joined to the document it belongs to.
//
// Every read is keyed on a list of batch ids (the partial index
// idx_stock_transactions_batch) or of TO ids (idx_stock_transactions_
// reference_id); the service (batch-trace.ts) caps a trace at 500 nodes per
// direction, so the lists stay short. Sums are PHYSICAL (blocked places
// included) — listed in stock-on-hand-readers.test.ts.

const iso = (date: Date) => date.toISOString();

const batchRefColumns = {
  batchId: stockBatches.id,
  batchNumber: stockBatches.batchNumber,
  articleId: articles.id,
  articleNumber: articles.articleNumber,
  articleName: articles.name,
  unitCode: units.code,
  tracking: articles.tracking,
  stockTracked: trackedSql(),
  expiresOn: stockBatches.expiresOn,
  origin: stockBatches.origin,
  createdAt: stockBatches.createdAt,
};

function toRef(row: {
  batchId: string | null;
  batchNumber: string | null;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unitCode: string;
  tracking: TraceBatchRef["tracking"];
  stockTracked?: boolean;
  expiresOn: string | null;
  origin: TraceBatchRef["origin"];
  createdAt: Date | null;
}): TraceBatchRef {
  const { stockTracked: _stockTracked, ...ref } = row;
  return { ...ref, batchTracked: ref.tracking === "batch", createdAt: ref.createdAt ? iso(ref.createdAt) : null };
}

// What a set of TOs drew ("mo_consumption", net < 0) or received
// ("mo_receipt", net > 0) per (TO, article, batch). An undone or returned
// row carries the batch of the row it reverses, so it nets itself away.
async function moEdges(
  db: Db | Tx,
  manufacturingOrderIds: string[],
  type: "mo_consumption" | "mo_receipt"
): Promise<(TraceMoEdge & { stockTracked: boolean })[]> {
  if (manufacturingOrderIds.length === 0) return [];
  const net = sql<string>`sum(${stockTransactions.quantityDelta})`;
  const rows = await db
    .select({
      manufacturingOrderId: sql<string>`${stockTransactions.referenceId}`,
      ...batchRefColumns,
      // Left join: the batch columns are null for Okänd.
      batchId: stockTransactions.batchId,
      quantity: net,
    })
    .from(stockTransactions)
    .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
    .innerJoin(units, eq(units.id, articles.unitId))
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(and(eq(stockTransactions.transactionType, type), inArray(stockTransactions.referenceId, manufacturingOrderIds)))
    .groupBy(
      stockTransactions.referenceId,
      stockTransactions.batchId,
      articles.id,
      articles.articleNumber,
      articles.name,
      units.code,
      articles.tracking,
      articles.serialAssignedAt,
      stockBatches.expiresOn,
      stockBatches.id,
      stockBatches.batchNumber,
      stockBatches.origin,
      stockBatches.createdAt
    )
    .having(type === "mo_consumption" ? sql`${net} < 0` : sql`${net} > 0`)
    // Per article: Okänd first, then the oldest batch (compareBatches' order).
    .orderBy(asc(articles.articleNumber), sql`${stockBatches.createdAt} asc nulls first`, asc(stockBatches.batchNumber), asc(stockBatches.id));
  return rows.map(({ manufacturingOrderId, quantity, ...ref }) => ({
    manufacturingOrderId,
    batch: toRef(ref),
    // Lagerspårad now (batch-tracking.ts) — not part of the trace's shape.
    stockTracked: ref.stockTracked === true,
    quantity: Math.abs(Number(quantity)),
  }));
}

export function createBatchTraceReader(db: Db | Tx): BatchTraceReader {
  return {
    async batchRefs(batchIds) {
      if (batchIds.length === 0) return [];
      const rows = await db
        .select(batchRefColumns)
        .from(stockBatches)
        .innerJoin(articles, eq(articles.id, stockBatches.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .where(inArray(stockBatches.id, batchIds));
      return rows.map(toRef);
    },

    // Inleveranser: the +row carries the batch, the receipt says whether it
    // was undone and which order it belongs to.
    async receipts(batchIds) {
      const rows = await db
        .select({
          batchId: sql<string>`${stockTransactions.batchId}`,
          purchaseOrderId: purchaseOrders.id,
          orderNumber: purchaseOrders.orderNumber,
          supplierId: suppliers.id,
          supplierName: suppliers.name,
          receivedAt: purchaseReceipts.createdAt,
          quantity: purchaseReceipts.quantity,
        })
        .from(stockTransactions)
        .innerJoin(purchaseReceipts, eq(purchaseReceipts.stockTransactionId, stockTransactions.id))
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseReceipts.purchaseOrderId))
        .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
        .where(and(inArray(stockTransactions.batchId, batchIds), isNull(purchaseReceipts.undoneAt)))
        .orderBy(asc(purchaseReceipts.createdAt), asc(purchaseReceipts.id));
      return rows.map((r) => ({ ...r, receivedAt: iso(r.receivedAt), quantity: Number(r.quantity) }));
    },

    async producedBy(batchIds) {
      const net = sql<string>`sum(${stockTransactions.quantityDelta})`;
      const rows = await db
        .select({
          batchId: sql<string>`${stockTransactions.batchId}`,
          manufacturingOrderId: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          quantity: net,
        })
        .from(stockTransactions)
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, stockTransactions.referenceId))
        .where(and(eq(stockTransactions.transactionType, "mo_receipt"), inArray(stockTransactions.batchId, batchIds)))
        .groupBy(stockTransactions.batchId, manufacturingOrders.id, manufacturingOrders.orderNumber)
        .having(sql`${net} > 0`)
        .orderBy(asc(manufacturingOrders.orderNumber), asc(manufacturingOrders.id));
      return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
    },

    // Okänd material is a leaf only for an article that is batchstyrd (the
    // trace says "Okänd" where it was used); the draws of articles without
    // batches are not part of a batch trace.
    async materials(manufacturingOrderIds) {
      const edges = await moEdges(db, manufacturingOrderIds, "mo_consumption");
      return edges
        .filter((edge) => edge.batch.batchId !== null || edge.stockTracked)
        .map(({ stockTracked: _stockTracked, ...edge }) => edge);
    },

    async events(batchIds) {
      const rows = await db
        .select({
          batchId: sql<string>`${stockTransactions.batchId}`,
          stockCountId: stockCountSessions.id,
          stockCountNumber: stockCountSessions.countNumber,
          at: stockTransactions.createdAt,
          quantity: stockTransactions.quantityDelta,
          note: stockTransactions.note,
        })
        .from(stockTransactions)
        .leftJoin(stockCountSessions, eq(stockCountSessions.id, stockTransactions.referenceId))
        .where(and(eq(stockTransactions.transactionType, "inventory_adjustment"), inArray(stockTransactions.batchId, batchIds)))
        .orderBy(asc(stockTransactions.createdAt), asc(stockTransactions.id));
      return rows.map((r) => ({
        ...r,
        kind: r.stockCountId ? ("stock_count" as const) : ("adjustment" as const),
        at: iso(r.at),
        quantity: Number(r.quantity),
      }));
    },

    async consumedBy(batchIds) {
      const net = sql<string>`sum(${stockTransactions.quantityDelta})`;
      const rows = await db
        .select({
          batchId: sql<string>`${stockTransactions.batchId}`,
          manufacturingOrderId: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          articleId: articles.id,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          quantity: net,
        })
        .from(stockTransactions)
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, stockTransactions.referenceId))
        // The TO's own article — what the batch went into.
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .where(and(eq(stockTransactions.transactionType, "mo_consumption"), inArray(stockTransactions.batchId, batchIds)))
        .groupBy(stockTransactions.batchId, manufacturingOrders.id, manufacturingOrders.orderNumber, articles.id, articles.articleNumber, articles.name)
        .having(sql`${net} < 0`)
        .orderBy(asc(manufacturingOrders.orderNumber), asc(manufacturingOrders.id));
      return rows.map((r) => ({ ...r, quantity: Math.abs(Number(r.quantity)) }));
    },

    async outputs(manufacturingOrderIds) {
      return (await moEdges(db, manufacturingOrderIds, "mo_receipt")).map(({ stockTracked: _stockTracked, ...edge }) => edge);
    },

    // Utleveranser: the row's parts (delivery_row_locations) point at their
    // own stock rows — a part of an undone row is no delivery.
    async deliveries(batchIds) {
      const rows = await db
        .select({
          batchId: sql<string>`${stockTransactions.batchId}`,
          deliveryId: deliveries.id,
          deliveryNumber: deliveries.deliveryNumber,
          salesOrderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          customerId: customers.id,
          customerName: customers.name,
          deliveredAt: deliveries.deliveredAt,
          quantity: sql<string>`sum(${deliveryRowLocations.quantity})`,
        })
        .from(stockTransactions)
        .innerJoin(deliveryRowLocations, eq(deliveryRowLocations.stockTransactionId, stockTransactions.id))
        .innerJoin(deliveryRows, eq(deliveryRows.id, deliveryRowLocations.deliveryRowId))
        .innerJoin(deliveries, eq(deliveries.id, deliveryRows.deliveryId))
        .innerJoin(salesOrders, eq(salesOrders.id, deliveries.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(and(inArray(stockTransactions.batchId, batchIds), isNull(deliveryRows.undoneAt)))
        .groupBy(
          stockTransactions.batchId,
          deliveries.id,
          deliveries.deliveryNumber,
          deliveries.deliveredAt,
          salesOrders.id,
          salesOrders.orderNumber,
          customers.id,
          customers.name
        )
        .orderBy(asc(deliveries.deliveredAt), asc(deliveries.id));
      return rows.map((r) => ({ ...r, deliveredAt: iso(r.deliveredAt), quantity: Number(r.quantity) }));
    },

    async onHand(batchIds) {
      const net = sql<string>`sum(${stockTransactions.quantityDelta})`;
      const rows = await db
        .select({
          batchId: sql<string>`${stockTransactions.batchId}`,
          locationId: stockLocations.id,
          warehouseName: warehouses.name,
          locationName: stockLocations.name,
          blocked: stockLocations.blocked,
          quantity: net,
        })
        .from(stockTransactions)
        .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
        .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
        .where(inArray(stockTransactions.batchId, batchIds))
        .groupBy(stockTransactions.batchId, stockLocations.id, warehouses.name, stockLocations.name, stockLocations.blocked)
        .having(sql`${net} <> 0`)
        .orderBy(asc(warehouses.name), asc(stockLocations.name), asc(stockLocations.id));
      return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
    },
  };
}

// GET /stock/batches — the list pattern: `where` built once for the rows
// and the count, then ONE aggregation of the log for the page's ids (as the
// lagerplatsregister). Newest batch first.
export async function listStockBatches(
  db: Db | Tx,
  query: ListStockBatchesQuery,
  today: string
): Promise<{ rows: StockBatchListRow[]; total: number }> {
  const conditions: (SQL | undefined)[] = [];
  if (query.search) {
    const pattern = ilikePattern(query.search);
    conditions.push(or(ilike(stockBatches.batchNumber, pattern), ilike(articles.articleNumber, pattern), ilike(articles.name, pattern)));
  }
  if (query.articleId) conditions.push(eq(stockBatches.articleId, query.articleId));
  // Etapp 2: the avisering's rows (batch-expiry.ts — the same condition).
  if (query.expiry === "due") conditions.push(expiringBatchCondition(await batchExpiryHorizon(db, today)));
  if (query.expiry === "expired") conditions.push(expiringBatchCondition(addDays(today, -1)));
  const where = and(...conditions);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: stockBatches.id,
        batchNumber: stockBatches.batchNumber,
        articleId: articles.id,
        articleNumber: articles.articleNumber,
        articleName: articles.name,
        unitCode: units.code,
        origin: stockBatches.origin,
        createdAt: stockBatches.createdAt,
        expiresOn: stockBatches.expiresOn,
        batchDate: stockBatches.batchDate,
      })
      .from(stockBatches)
      .innerJoin(articles, eq(articles.id, stockBatches.articleId))
      .innerJoin(units, eq(units.id, articles.unitId))
      .where(where)
      .orderBy(
        // With the filter: the date first (the avisering's order).
        ...(query.expiry ? [asc(stockBatches.expiresOn), asc(articles.articleNumber)] : [desc(stockBatches.createdAt)]),
        asc(stockBatches.batchNumber),
        asc(stockBatches.id)
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(stockBatches).innerJoin(articles, eq(articles.id, stockBatches.articleId)).where(where),
  ]);

  const ids = rows.map((r) => r.id);
  const sums =
    ids.length === 0
      ? []
      : await db
          .select({ batchId: stockTransactions.batchId, quantity: sql<string>`sum(${stockTransactions.quantityDelta})` })
          .from(stockTransactions)
          .where(inArray(stockTransactions.batchId, ids))
          .groupBy(stockTransactions.batchId);
  const quantityByBatch = new Map(sums.map((s) => [s.batchId, Number(s.quantity)]));
  return {
    rows: rows.map((r) => ({
      ...r,
      createdAt: iso(r.createdAt),
      expired: isBatchExpired(r.expiresOn, today),
      quantity: quantityByBatch.get(r.id) ?? 0,
    })),
    total: totals[0]!.total,
  };
}
