import { eq, inArray, sql } from "drizzle-orm";
import { articles, systemSettings, type Db, type Tx } from "@navet/db";

// Batchstyrd (#8) — the ONE place the article's flag and the system setting
// are read by the stock writers and the article card.

// A Tjänst is never stocked (stocked-article.ts) and a phantom never stands
// in stock, so neither can carry a batch.
export function batchTrackableArticle(article: { type: string; isPhantom: boolean }): boolean {
  return article.type !== "service" && !article.isPhantom;
}

// The batchstyrda among these articles (unknown ids are simply absent).
// Read FOR KEY SHARE — the pattern and the reasoning of stockedArticleIds:
// it is the lock the writer's stock_transactions INSERT takes on the article
// anyway (its FK), only taken at the check. A flag change holds the article
// FOR UPDATE (updateArticle under lockArticle), so an inflow that asks while
// one is in progress waits and then sees the new flag, and a flag change
// waits for an inflow that has already asked. KEY SHARE conflicts with
// nothing else on articles (the outflow locks are FOR NO KEY UPDATE).
export async function batchTrackedArticleIds(db: Db | Tx, articleIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0) return new Set();
  const tracked = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ id: articles.id, batchTracked: articles.batchTracked })
      .from(articles)
      .where(inArray(articles.id, ids.slice(i, i + 500)))
      .for("key share");
    for (const row of rows) if (row.batchTracked) tracked.add(row.id);
  }
  return tracked;
}

export async function isBatchTrackedArticle(db: Db | Tx, articleId: string): Promise<boolean> {
  return (await batchTrackedArticleIds(db, [articleId])).has(articleId);
}

// --- The system setting "Använd batch- och serienummer" (beslut 9) ---
//
// Off by default (no row = off). Two rules tie it to the articles' flag:
// an article can only be made Batchstyrd while it is on, and it can only be
// switched off while no article is. The setting's ROW orders the two:
// whoever switches a flag on reads the row FOR SHARE (no row = off, refused)
// and holds it until its commit; PATCH /settings writes the row first (its
// upsert waits for those share locks) and only then counts the batchstyrda
// articles — so it sees every flag that was switched on before it, and a
// flag change that comes after waits for the upsert and reads the new value.
export const BATCH_TRACKING_ENABLED_KEY = "batch_tracking_enabled";

export function decodeBatchTrackingEnabled(value: string | null | undefined): boolean {
  return value === "true";
}

// For the transaction that switches an article's flag ON.
export async function batchTrackingEnabledForShare(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY))
    .for("share");
  return decodeBatchTrackingEnabled(row?.value);
}

// For PATCH /settings switching the setting OFF — call AFTER the setting's
// row is written in the same transaction.
export async function countBatchTrackedArticles(db: Db | Tx): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(articles)
    .where(eq(articles.batchTracked, true));
  return row?.count ?? 0;
}
