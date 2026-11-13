import { and, asc, count, eq, isNotNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { articles, stockBatches, systemSettings, units, type Db, type Tx } from "@navet/db";
import { ALERT_BATCH_EXPIRY_DAYS_KEY, decodeAlertBatchExpiryDays } from "../../system/service/alert-settings.js";
import { addDays } from "../../system/service/delivery-days.js";

// Utgångna batcher (#8 etapp 2) — the ONE definition of "a batch to act on
// before it expires", shared by the avisering (alerts.repository.ts) and the
// batch register's filter `expiry` (its "Visa alla"), so the list is the
// group. A leaf (`Db | Tx`).
//
// A batch counts when
//   * it has an utgångsdatum on or before the horizon (today + the setting
//     "Batcher som går ut inom (dagar)"; expired ones included),
//   * its article is spårad NOW (a batch of an article whose Spårning was
//     switched off is no longer shown anywhere), and
//   * it has stock on places that are NOT blocked: a Spärrad lagerplats is
//     how stock that must not be used is put aside, so moving the batch
//     there (or scrapping/consuming it) is what makes the alert go away.
//
// The sum is deliberately per batch over the unblocked places — physical
// stock minus the blocked places, not onHandByArticle (which is per article;
// a named batch's cell never goes negative, so no debt is hidden). Listed in
// stock-on-hand-readers.test.ts.

// For a SELECT with stock_batches and articles in scope.
export const batchUsableQuantitySql = sql<string>`(
  select coalesce(sum(st.quantity_delta), 0)
  from stock_transactions st
  inner join stock_locations sl on sl.id = st.location_id
  where st.batch_id = ${stockBatches.id} and sl.blocked = false
)`;

export function expiringBatchCondition(horizon: string): SQL {
  return and(
    isNotNull(stockBatches.expiresOn),
    lte(stockBatches.expiresOn, horizon),
    ne(articles.tracking, "none"),
    sql`${batchUsableQuantitySql} > 0`
  )!;
}

// The horizon of the window: the Stockholm day `today` + the setting.
export async function batchExpiryHorizon(db: Db | Tx, today: string): Promise<string> {
  const [row] = await db.select({ value: systemSettings.value }).from(systemSettings).where(eq(systemSettings.key, ALERT_BATCH_EXPIRY_DAYS_KEY));
  return addDays(today, decodeAlertBatchExpiryDays(row?.value));
}

export interface ExpiringBatchRow {
  batchId: string;
  batchNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unitCode: string;
  expiresOn: string;
  // On places that are not blocked, base unit.
  quantity: number;
}

// Shortest date first; `count` is the real number, the rows at most `limit`.
export async function listExpiringBatches(db: Db | Tx, horizon: string, limit: number): Promise<{ rows: ExpiringBatchRow[]; count: number }> {
  const where = expiringBatchCondition(horizon);
  const [rows, totals] = await Promise.all([
    db
      .select({
        batchId: stockBatches.id,
        batchNumber: stockBatches.batchNumber,
        articleId: articles.id,
        articleNumber: articles.articleNumber,
        articleName: articles.name,
        unitCode: units.code,
        expiresOn: stockBatches.expiresOn,
        quantity: batchUsableQuantitySql,
      })
      .from(stockBatches)
      .innerJoin(articles, eq(articles.id, stockBatches.articleId))
      .innerJoin(units, eq(units.id, articles.unitId))
      .where(where)
      .orderBy(asc(stockBatches.expiresOn), asc(articles.articleNumber), asc(stockBatches.batchNumber), asc(stockBatches.id))
      .limit(limit),
    db.select({ total: count() }).from(stockBatches).innerJoin(articles, eq(articles.id, stockBatches.articleId)).where(where),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, expiresOn: r.expiresOn!, quantity: Number(r.quantity) })),
    count: totals[0]!.total,
  };
}
