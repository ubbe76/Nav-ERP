import { eq, inArray, sql } from "drizzle-orm";
import { articles, stockTransactions, type Db, type Tx } from "@navet/db";

// Tjänster lagerförs inte (användarbeslut 2026-11-10): a service is work,
// not goods. It is still bought (inleverans updates the IO row), sold
// (utleverans updates the order row) and consumed on a TO (the material
// row's förbrukat and the report log), but never written to stock_transactions
// — no balance, no value, no Negativt saldo. The ONE rule every stock writer
// asks; the manual routes refuse a service with ServiceArticleNotStockedError.
// A balance a service got before this rule stays in the log as history.
export function isStockedArticleType(type: string): boolean {
  return type !== "service";
}

// The stocked ones among these articles (unknown ids are simply absent).
// Read FOR KEY SHARE — the lock the writer's stock_transactions INSERT takes
// on the article anyway (its FK), only taken at the check instead: a type
// change to Tjänst holds the article FOR UPDATE (updateArticle), so a writer
// that asks while one is in progress waits and then sees the new type,
// instead of reading the old one and writing stock for a service after the
// change committed. KEY SHARE conflicts with nothing else on articles (the
// outflow locks are FOR NO KEY UPDATE), so no other writer waits for it.
export async function stockedArticleIds(db: Db | Tx, articleIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: articles.id, type: articles.type })
    .from(articles)
    .where(inArray(articles.id, ids))
    .for("key share");
  return new Set(rows.filter((row) => isStockedArticleType(row.type)).map((row) => row.id));
}

export async function isStockedArticle(db: Db | Tx, articleId: string): Promise<boolean> {
  return (await stockedArticleIds(db, [articleId])).has(articleId);
}

// Tjänst only without stock (användarbeslut 2026-11-10, artikelgranskningen):
// updateArticle refuses a type change to Tjänst while the article holds stock
// on any place — physical per place, a blocked place too, so +5 here and −5
// there still counts (it is stock to straighten out with a justering first).
// The caller holds the article FOR UPDATE: a writer that has already written
// a row holds the article FOR KEY SHARE (the FK) until it commits, so the
// lock waits for it and this read sees the row.
export async function articleHoldsStock(db: Db | Tx, articleId: string): Promise<boolean> {
  const remaining = await db
    .select({ locationId: stockTransactions.locationId })
    .from(stockTransactions)
    .where(eq(stockTransactions.articleId, articleId))
    .groupBy(stockTransactions.locationId)
    .having(sql`sum(${stockTransactions.quantityDelta}) <> 0`)
    .limit(1);
  return remaining.length > 0;
}
