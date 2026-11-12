import { and, eq, sql } from "drizzle-orm";
import { stockBatches, type Db, type Tx } from "@navet/db";
import { UNKNOWN_BATCH_LABEL } from "@navet/shared";
import { BatchNumberReservedError, StockBatchNotFoundError } from "./batch.errors.js";

export type StockBatchOrigin = (typeof stockBatches.origin.enumValues)[number];

export interface StockBatchRef {
  id: string;
  batchNumber: string;
}

// The number as it is stored: trimmed; "Okänd" (any case) is reserved — it
// is what a row without a batch is called. The column is varchar(50).
export function normalizeBatchNumber(raw: string): string {
  const batchNumber = raw.trim();
  if (batchNumber.toLocaleLowerCase("sv") === UNKNOWN_BATCH_LABEL.toLocaleLowerCase("sv")) throw new BatchNumberReservedError(batchNumber);
  return batchNumber;
}

// Batch (#8): the article's batch with this number, created on its first
// inflow — the Db | Tx leaf every inflow with a batch calls (inleverans, the
// TO's finished goods, a positive justering, the saldoimport). One batch per
// (article, number), case-insensitively: "abc" from a scanner and "ABC" by
// hand are the same batch, and the FIRST spelling is kept. INSERT … ON
// CONFLICT DO NOTHING + a re-read against the unique index
// stock_batches_article_number_unique (the pattern of
// getOrCreateFallbackLocation): two simultaneous first inflows get the same
// batch — the second waits for the first one's commit in the index. `origin`
// and the order references describe how the batch was created and are never
// changed by a later inflow. The comparison is Postgres' lower() on both
// sides, never JS's (the two disagree on å/ä/ö under a C collation).
export async function getOrCreateBatch(
  db: Db | Tx,
  input: {
    articleId: string;
    batchNumber: string;
    origin: StockBatchOrigin;
    purchaseOrderId?: string | null;
    manufacturingOrderId?: string | null;
    createdBy?: string | null;
  }
): Promise<StockBatchRef> {
  const batchNumber = normalizeBatchNumber(input.batchNumber);
  await db
    .insert(stockBatches)
    .values({
      articleId: input.articleId,
      batchNumber,
      origin: input.origin,
      purchaseOrderId: input.purchaseOrderId ?? null,
      manufacturingOrderId: input.manufacturingOrderId ?? null,
      createdBy: input.createdBy ?? null,
    })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: stockBatches.id, batchNumber: stockBatches.batchNumber })
    .from(stockBatches)
    .where(and(eq(stockBatches.articleId, input.articleId), sql`lower(${stockBatches.batchNumber}) = lower(${batchNumber})`));
  return row!;
}

// A CHOSEN batch (an outflow's batchId): it must exist and be the article's
// — 404 stock-batch-not-found otherwise, never the insert's FK violation.
export async function findArticleBatch(db: Db | Tx, articleId: string, batchId: string): Promise<StockBatchRef> {
  const [row] = await db
    .select({ id: stockBatches.id, batchNumber: stockBatches.batchNumber })
    .from(stockBatches)
    .where(and(eq(stockBatches.id, batchId), eq(stockBatches.articleId, articleId)));
  if (!row) throw new StockBatchNotFoundError(batchId);
  return row;
}
