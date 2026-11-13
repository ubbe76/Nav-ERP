import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { articleAlternativeLocations, articles, stockBatches, stockLocations, stockTransactions, warehouses, type Db, type Tx } from "@navet/db";
import { articlePlacePreference, compareBatchCells, compareBatches, isBatchExpired, type BatchCell } from "../service/outflow-allocation.js";

// The batch's AGE as a Stockholm day (etapp 2): its Batchdatum, else the day
// the row was created — what compareBatches sorts the undated batches on.
// Null for Okänd (the left join). created_at is a timestamptz: never ::date
// without the zone.
export const batchAgeDateSql = sql<string | null>`coalesce(${stockBatches.batchDate}, (${stockBatches.createdAt} AT TIME ZONE 'Europe/Stockholm')::date)::text`;

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
        expiresOn: stockBatches.expiresOn,
        batchAgeDate: batchAgeDateSql,
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
      .groupBy(
        stockTransactions.articleId,
        stockTransactions.locationId,
        stockTransactions.batchId,
        stockBatches.batchNumber,
        stockBatches.createdAt,
        stockBatches.expiresOn,
        stockBatches.batchDate
      )
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
  // Etapp 2: Utgångsdatum (last usable day), Batchdatum (null = the day of
  // createdAt) and whether the batch is utgången today (Stockholm day).
  expiresOn: string | null;
  batchDate: string | null;
  expired: boolean;
  total: string;
  locations: { locationId: string; warehouseName: string; locationName: string; blocked: boolean; quantity: string }[];
}

// The article card's Saldo per batch, in compareBatches order (FEFO: Okänd
// first, the dated by utgångsdatum, the undated oldest first) — the order
// Automatiskt draws in, except that it skips the expired — each with its
// places. `today` = the Stockholm day `expired` is judged against.
export async function articleBatchBalances(db: Db | Tx, articleId: string, today: string): Promise<ArticleBatchBalance[]> {
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
      expiresOn: stockBatches.expiresOn,
      batchDate: stockBatches.batchDate,
      batchAgeDate: batchAgeDateSql,
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
      stockBatches.createdAt,
      stockBatches.expiresOn,
      stockBatches.batchDate
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
      expiresOn: head.expiresOn,
      batchDate: head.batchDate,
      expired: isBatchExpired(head.expiresOn, today),
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

export interface PickBatchCell {
  articleId: string;
  locationId: string;
  warehouseName: string;
  locationName: string;
  // A Spärrad lagerplats — physical stock the pick list leaves out.
  blocked: boolean;
  preference: number | null;
  batchId: string | null;
  batchNumber: string | null;
  // Etapp 2: the batch's utgångsdatum and whether it is utgången today —
  // Automatiskt leaves such a cell alone (it can be chosen by hand).
  expiresOn: string | null;
  expired: boolean;
  quantity: string;
}

// The pick list's cells (#8): for the BATCHSTYRDA among these articles, every
// cell with a balance, per article in the order Automatiskt draws them —
// compareBatchCells: Okänd first, then the oldest batch, within a batch the
// places in pick-list order — so the paper and the booking say the same
// thing. An article that is not batchstyrd is absent (its places come from
// balancesForArticles, as before). Physical, with `blocked` as a flag.
// Etapp 2: FEFO, and the cells of an utgången batch LAST per article
// (Automatiskt skips them) — `today` is the Stockholm day.
export async function pickBatchCellsForArticles(
  db: Db | Tx,
  articleIds: readonly string[],
  opts: { locationId?: string; today: string }
): Promise<PickBatchCell[]> {
  const ids = [...new Set(articleIds)];
  const cells: (PickBatchCell & { batchCreatedAt: Date | null; batchAgeDate: string | null })[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({
        articleId: stockTransactions.articleId,
        locationId: stockTransactions.locationId,
        warehouseName: warehouses.name,
        locationName: stockLocations.name,
        blocked: stockLocations.blocked,
        isPrimary: sql<boolean>`coalesce(${articles.defaultLocationId} = ${stockTransactions.locationId}, false)`,
        sortOrder: articleAlternativeLocations.sortOrder,
        batchId: stockTransactions.batchId,
        batchNumber: stockBatches.batchNumber,
        batchCreatedAt: stockBatches.createdAt,
        expiresOn: stockBatches.expiresOn,
        batchAgeDate: batchAgeDateSql,
        quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
      })
      .from(stockTransactions)
      .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
      .innerJoin(stockLocations, eq(stockLocations.id, stockTransactions.locationId))
      .innerJoin(warehouses, eq(warehouses.id, stockLocations.warehouseId))
      .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
      .leftJoin(
        articleAlternativeLocations,
        and(eq(articleAlternativeLocations.articleId, stockTransactions.articleId), eq(articleAlternativeLocations.locationId, stockTransactions.locationId))
      )
      .where(
        and(
          inArray(stockTransactions.articleId, ids.slice(i, i + CHUNK)),
          ne(articles.tracking, "none"),
          opts.locationId ? eq(stockTransactions.locationId, opts.locationId) : undefined
        )
      )
      .groupBy(
        stockTransactions.articleId,
        stockTransactions.locationId,
        warehouses.name,
        stockLocations.name,
        stockLocations.blocked,
        articles.defaultLocationId,
        articleAlternativeLocations.sortOrder,
        stockTransactions.batchId,
        stockBatches.batchNumber,
        stockBatches.createdAt,
        stockBatches.expiresOn,
        stockBatches.batchDate
      )
      .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`);
    for (const { isPrimary, sortOrder, ...row } of rows) {
      cells.push({
        ...row,
        expired: isBatchExpired(row.expiresOn, opts.today),
        quantity: Number(row.quantity).toFixed(4),
        preference: articlePlacePreference({ locationName: row.locationName, isPrimary: isPrimary === true, sortOrder }),
      });
    }
  }
  return cells
    .sort(
      (a, b) =>
        (a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0) ||
        Number(a.expired) - Number(b.expired) ||
        compareBatchCells({ batch: a, place: a }, { batch: b, place: b })
    )
    .map(({ batchCreatedAt: _created, batchAgeDate: _age, ...cell }) => cell);
}
