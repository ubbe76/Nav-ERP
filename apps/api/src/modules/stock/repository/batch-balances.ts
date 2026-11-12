import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { stockBatches, stockLocations, stockTransactions, warehouses, type Db, type Tx } from "@navet/db";
import { compareBatches, type BatchCell } from "../service/outflow-allocation.js";

// Batch (#8) — saldo per CELL (article, place, batch), read straight from
// the log. A leaf (Db | Tx), ALWAYS with an article filter so the query rides
// idx_stock_transactions_article_location; the stock_balances view is not
// touched (its plan is sensitive — every reader of it sums over the batches
// unchanged). batch_id NULL is the cell "Okänd". Physical: a Spärrad
// lagerplats is included (the callers decide), like every per-place reader.

export interface ArticleBatchCell extends BatchCell {
  articleId: string;
}

const CHUNK = 200;

// Every cell of the articles with a balance other than 0 — negative ones
// too (Okänd may be negative next to named batches). `locationIds` narrows
// to the places an outflow has locked.
export async function batchCellsForArticles(
  db: Db | Tx,
  articleIds: readonly string[],
  opts: { locationIds?: readonly string[] } = {}
): Promise<ArticleBatchCell[]> {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0 || opts.locationIds?.length === 0) return [];
  const cells: ArticleBatchCell[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({
        articleId: stockTransactions.articleId,
        locationId: stockTransactions.locationId,
        batchId: stockTransactions.batchId,
        batchNumber: stockBatches.batchNumber,
        batchCreatedAt: stockBatches.createdAt,
        quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
      })
      .from(stockTransactions)
      .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
      .where(
        and(
          inArray(stockTransactions.articleId, ids.slice(i, i + CHUNK)),
          opts.locationIds ? inArray(stockTransactions.locationId, [...opts.locationIds]) : undefined
        )
      )
      .groupBy(stockTransactions.articleId, stockTransactions.locationId, stockTransactions.batchId, stockBatches.batchNumber, stockBatches.createdAt)
      .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`);
    for (const row of rows) cells.push({ ...row, quantity: Number(row.quantity) });
  }
  return cells;
}

// ONE cell's balance — what an Ångra checks before it takes goods back out
// of the batch they were booked in (`batchId` null = the Okänd cell). The
// caller holds the article's outflow lock.
export async function batchCellQuantity(db: Db | Tx, articleId: string, locationId: string, batchId: string | null): Promise<number> {
  const [row] = await db
    .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(
      and(
        eq(stockTransactions.articleId, articleId),
        eq(stockTransactions.locationId, locationId),
        batchId === null ? isNull(stockTransactions.batchId) : eq(stockTransactions.batchId, batchId)
      )
    );
  return Number(row?.quantity ?? 0);
}

export interface ArticleBatchBalance {
  batchId: string | null;
  batchNumber: string | null;
  origin: (typeof stockBatches.origin.enumValues)[number] | null;
  createdAt: string | null;
  total: string;
  locations: { locationId: string; warehouseName: string; locationName: string; blocked: boolean; quantity: string }[];
}

// The article card's Saldo per batch: Okänd first, then the oldest batch
// (compareBatches — the order Automatiskt draws in), each with its places.
export async function articleBatchBalances(db: Db | Tx, articleId: string): Promise<ArticleBatchBalance[]> {
  const rows = await db
    .select({
      locationId: stockTransactions.locationId,
      warehouseName: warehouses.name,
      locationName: stockLocations.name,
      blocked: stockLocations.blocked,
      batchId: stockTransactions.batchId,
      batchNumber: stockBatches.batchNumber,
      origin: stockBatches.origin,
      batchCreatedAt: stockBatches.createdAt,
      quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
    })
    .from(stockTransactions)
    .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
    .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(eq(stockTransactions.articleId, articleId))
    .groupBy(
      stockTransactions.locationId,
      warehouses.name,
      stockLocations.name,
      stockLocations.blocked,
      stockTransactions.batchId,
      stockBatches.batchNumber,
      stockBatches.origin,
      stockBatches.createdAt
    )
    .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`);

  const byBatch = new Map<string, { head: (typeof rows)[number]; rows: typeof rows }>();
  for (const row of rows) {
    const key = row.batchId ?? "";
    const entry = byBatch.get(key) ?? { head: row, rows: [] };
    entry.rows.push(row);
    byBatch.set(key, entry);
  }
  return [...byBatch.values()]
    .sort((a, b) => compareBatches(a.head, b.head))
    .map(({ head, rows: places }) => ({
      batchId: head.batchId,
      batchNumber: head.batchNumber,
      origin: head.origin,
      createdAt: head.batchCreatedAt ? head.batchCreatedAt.toISOString() : null,
      total: places.reduce((sum, p) => sum + Number(p.quantity), 0).toFixed(4),
      locations: places
        .sort(
          (a, b) =>
            a.warehouseName.localeCompare(b.warehouseName, "sv", { numeric: true }) ||
            a.locationName.localeCompare(b.locationName, "sv", { numeric: true })
        )
        .map((p) => ({
          locationId: p.locationId,
          warehouseName: p.warehouseName,
          locationName: p.locationName,
          blocked: p.blocked,
          quantity: Number(p.quantity).toFixed(4),
        })),
    }));
}
