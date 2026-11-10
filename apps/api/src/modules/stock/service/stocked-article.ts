import { inArray } from "drizzle-orm";
import { articles, type Db, type Tx } from "@navet/db";

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
export async function stockedArticleIds(db: Db | Tx, articleIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.select({ id: articles.id, type: articles.type }).from(articles).where(inArray(articles.id, ids));
  return new Set(rows.filter((row) => isStockedArticleType(row.type)).map((row) => row.id));
}

export async function isStockedArticle(db: Db | Tx, articleId: string): Promise<boolean> {
  return (await stockedArticleIds(db, [articleId])).has(articleId);
}
