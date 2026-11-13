import { and, eq, isNull, sql } from "drizzle-orm";
import { stockBatches, type Db, type Tx } from "@navet/db";
import { UNKNOWN_BATCH_LABEL } from "@navet/shared";
import { BatchExpiryMismatchError, BatchNumberReservedError, StockBatchNotFoundError } from "./batch.errors.js";

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
//
// Etapp 2 — the dates. `expiresOn` (Utgångsdatum) and `batchDate`
// (Batchdatum) are set when the batch is created, and FILLED IN when the
// batch exists without one. An existing batch with ANOTHER utgångsdatum:
// "refuse" (the default) ⇒ 409 batch-expiry-mismatch — never a silent
// overwrite, the date is corrected with PATCH /stock/batches/:id; "keep" ⇒
// the batch's date stands (the TO's batch: a later delinleverans computes a
// later date; the saldoimport, which warns instead). A differing Batchdatum
// always stands. The returned ref carries the dates the batch HAS, so the
// caller can compare.
export interface StockBatchWithDates extends StockBatchRef {
  expiresOn: string | null;
  batchDate: string | null;
}

export interface GetOrCreateBatchInput {
  articleId: string;
  batchNumber: string;
  origin: StockBatchOrigin;
  purchaseOrderId?: string | null;
  manufacturingOrderId?: string | null;
  createdBy?: string | null;
  expiresOn?: string | null | undefined;
  batchDate?: string | null | undefined;
  onExpiryMismatch?: "refuse" | "keep";
}

// The ref alone — what most writers want.
export async function getOrCreateBatch(db: Db | Tx, input: GetOrCreateBatchInput): Promise<StockBatchRef> {
  const { id, batchNumber } = await getOrCreateDatedBatch(db, input);
  return { id, batchNumber };
}

export async function getOrCreateDatedBatch(db: Db | Tx, input: GetOrCreateBatchInput): Promise<StockBatchWithDates> {
  const batchNumber = normalizeBatchNumber(input.batchNumber);
  const expiresOn = input.expiresOn ?? null;
  const batchDate = input.batchDate ?? null;
  await db
    .insert(stockBatches)
    .values({
      articleId: input.articleId,
      batchNumber,
      origin: input.origin,
      purchaseOrderId: input.purchaseOrderId ?? null,
      manufacturingOrderId: input.manufacturingOrderId ?? null,
      createdBy: input.createdBy ?? null,
      expiresOn,
      batchDate,
    })
    .onConflictDoNothing();
  const read = async () => {
    const [found] = await db
      .select({ id: stockBatches.id, batchNumber: stockBatches.batchNumber, expiresOn: stockBatches.expiresOn, batchDate: stockBatches.batchDate })
      .from(stockBatches)
      .where(and(eq(stockBatches.articleId, input.articleId), sql`lower(${stockBatches.batchNumber}) = lower(${batchNumber})`));
    return found!;
  };
  let row = await read();
  // Fill in what the batch lacks. The UPDATE's own WHERE (… IS NULL) decides
  // between two simultaneous inflows: the second waits for the first one's
  // row lock, changes nothing and is compared against the date that won.
  if ((expiresOn !== null && row.expiresOn === null) || (batchDate !== null && row.batchDate === null)) {
    if (expiresOn !== null && row.expiresOn === null) {
      await db.update(stockBatches).set({ expiresOn }).where(and(eq(stockBatches.id, row.id), isNull(stockBatches.expiresOn)));
    }
    if (batchDate !== null && row.batchDate === null) {
      await db.update(stockBatches).set({ batchDate }).where(and(eq(stockBatches.id, row.id), isNull(stockBatches.batchDate)));
    }
    row = await read();
  }
  if (expiresOn !== null && row.expiresOn !== null && row.expiresOn !== expiresOn && (input.onExpiryMismatch ?? "refuse") === "refuse") {
    throw new BatchExpiryMismatchError(row.batchNumber, row.expiresOn, expiresOn);
  }
  return row;
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
