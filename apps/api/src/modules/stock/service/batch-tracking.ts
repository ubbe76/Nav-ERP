import { eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { articles, systemSettings, type Db, type Tx } from "@navet/db";
import { stockTrackingOf, type StockTracking } from "./article-tracking.js";

export { isTracked, resolveTracking, mentionsTracking, stockTrackingOf, type ArticleTracking, type StockTracking } from "./article-tracking.js";

// In a SELECT/WHERE with `articles` (or an alias of it) in scope.
// trackedSql = LAGERSPÅRAD (stockTrackingOf in SQL — what the mechanics ask);
// `batchTracked` in a response is the backwards compatible alias = the sort
// is batch.
type TrackingColumns = { tracking: AnyPgColumn; serialAssignedAt: AnyPgColumn };
export function trackedSql(table: TrackingColumns = articles): SQL<boolean> {
  return sql<boolean>`(${table.tracking} = 'batch' or (${table.tracking} = 'serial' and ${table.serialAssignedAt} = 'receipt'))`;
}
export function batchTrackedSql(table: { tracking: AnyPgColumn } = articles): SQL<boolean> {
  return sql<boolean>`(${table.tracking} = 'batch')`;
}

// A Tjänst is never stocked (stocked-article.ts) and a phantom never stands
// in stock, so neither can carry a batch.
export function batchTrackableArticle(article: { type: string; isPhantom: boolean }): boolean {
  return article.type !== "service" && !article.isPhantom;
}

// The sort per LAGERSPÅRAD article among these (unknown ids, untracked
// articles and serial numbers created vid utleverans are simply absent).
// Read FOR KEY SHARE — the pattern and the reasoning of stockedArticleIds:
// it is the lock the writer's stock_transactions INSERT takes on the article
// anyway (its FK), only taken at the check. A change of Spårning (or of
// Serienummer skapas) holds the article FOR UPDATE (updateArticle under
// lockArticle), so an inflow that asks while one is in progress waits and
// then sees the new value, and the change waits for an inflow that has
// already asked. KEY SHARE conflicts with nothing else on articles (the
// outflow locks are FOR NO KEY UPDATE).
export async function articleTrackingByIds(db: Db | Tx, articleIds: readonly string[]): Promise<Map<string, StockTracking>> {
  const ids = [...new Set(articleIds)];
  const tracked = new Map<string, StockTracking>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ id: articles.id, tracking: articles.tracking, serialAssignedAt: articles.serialAssignedAt })
      .from(articles)
      .where(inArray(articles.id, ids.slice(i, i + 500)))
      .for("key share");
    for (const row of rows) {
      const sort = stockTrackingOf(row);
      if (sort !== null) tracked.set(row.id, sort);
    }
  }
  return tracked;
}

// The lagerspårade (batch, or serial numbers created vid inleverans) among these articles.
export async function trackedArticleIds(db: Db | Tx, articleIds: readonly string[]): Promise<Set<string>> {
  return new Set((await articleTrackingByIds(db, articleIds)).keys());
}

export async function isTrackedArticle(db: Db | Tx, articleId: string): Promise<boolean> {
  return (await articleTrackingByIds(db, [articleId])).has(articleId);
}

// The article's stock sort: "batch", "serial" or null (not lagerspårad).
export async function trackingOf(db: Db | Tx, articleId: string): Promise<StockTracking | null> {
  return (await articleTrackingByIds(db, [articleId])).get(articleId) ?? null;
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
export async function countTrackedArticles(db: Db | Tx): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(articles)
    .where(ne(articles.tracking, "none"));
  return row?.count ?? 0;
}
