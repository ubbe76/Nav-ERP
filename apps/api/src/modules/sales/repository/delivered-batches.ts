import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { trackedSql } from "../../stock/service/batch-tracking.js";
import { articles, deliveryRowLocations, deliveryRows, salesOrderRows, stockBatches, stockTransactions, type Db, type Tx } from "@navet/db";
import { compareBatches } from "../../stock/service/outflow-allocation.js";
import { batchAgeDateSql } from "../../stock/repository/batch-balances.js";

// Batch (#8): which batches an order row's goods went out in — the invoice's
// "Batch: …" line (decision 13). EN läsare: the row's LIVE delivery parts
// (delivery_rows not undone ⋈ delivery_row_locations), each part's batch read
// through its own stock row (delivery_row_locations has no batch column —
// the log is append-only, so the link can never drift), summed per batch in
// the article's base unit.
//
// Only NAMED batches are returned (Okänd is never printed on a customer
// document, decision 14); `complete` says whether they cover everything the
// row has delivered, i.e. no part went out of Okänd. A row whose article is
// not batchstyrd NOW is absent (decision 10: its batches are not shown).
// Batches come in compareBatches order (FEFO), the order they were drawn in.
export interface DeliveredBatches {
  batches: { batchId: string; batchNumber: string; quantity: number }[];
  complete: boolean;
}

const CHUNK = 1000;

export async function deliveredBatchesForOrderRows(db: Db | Tx, salesOrderRowIds: readonly string[]): Promise<Map<string, DeliveredBatches>> {
  const ids = [...new Set(salesOrderRowIds)];
  const result = new Map<string, DeliveredBatches>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({
        salesOrderRowId: deliveryRows.salesOrderRowId,
        batchId: stockTransactions.batchId,
        batchNumber: stockBatches.batchNumber,
        batchCreatedAt: stockBatches.createdAt,
        // For the order only (FEFO) — the invoice prints no dates.
        expiresOn: stockBatches.expiresOn,
        batchAgeDate: batchAgeDateSql,
        quantity: sql<string>`sum(${deliveryRowLocations.quantity})`,
      })
      .from(deliveryRows)
      .innerJoin(deliveryRowLocations, eq(deliveryRowLocations.deliveryRowId, deliveryRows.id))
      .innerJoin(stockTransactions, eq(stockTransactions.id, deliveryRowLocations.stockTransactionId))
      .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
      .innerJoin(salesOrderRows, eq(salesOrderRows.id, deliveryRows.salesOrderRowId))
      .innerJoin(articles, eq(articles.id, salesOrderRows.articleId))
      .where(
        and(inArray(deliveryRows.salesOrderRowId, ids.slice(i, i + CHUNK)), isNull(deliveryRows.undoneAt), trackedSql())
      )
      .groupBy(
        deliveryRows.salesOrderRowId,
        stockTransactions.batchId,
        stockBatches.batchNumber,
        stockBatches.createdAt,
        stockBatches.expiresOn,
        stockBatches.batchDate
      );
    for (const row of [...rows].sort(compareBatches)) {
      const entry = result.get(row.salesOrderRowId) ?? { batches: [], complete: true };
      if (row.batchId === null || row.batchNumber === null) entry.complete = false;
      else entry.batches.push({ batchId: row.batchId, batchNumber: row.batchNumber, quantity: Number(row.quantity) });
      result.set(row.salesOrderRowId, entry);
    }
  }
  return result;
}
