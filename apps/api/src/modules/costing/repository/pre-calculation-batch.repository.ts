import { and, asc, eq, exists, inArray, not, or, sql, type SQL } from "drizzle-orm";
import { articles, configuratorTemplates, type Db, type Tx } from "@navet/db";
import type { ArticleNumberRange, ArticleType } from "@navet/shared";

// Förkalkylera flera (#27): which articles a batch runs over. A Db | Tx leaf
// like calculated-price.ts. Configurator templates (a configurator_templates
// row, mode variants or to_order) never take part — a template's structure
// is a menu, not a product, and its variants are articles of their own.

export interface BatchArticle {
  id: string;
  articleNumber: string;
  name: string;
  type: ArticleType;
  // The article's current Standardpris and Försäljningspris, shown beside
  // the new figures; null when the article has none.
  standardCost: string | null;
  salesPrice: string | null;
}

export interface BatchArticleFilter {
  // Any of the ranges (or); each bound inclusive, compared in byte order
  // (collate "C") — see the shared schema.
  articleNumberRanges?: readonly ArticleNumberRange[];
  groupId?: string;
  type?: ArticleType;
  articleCodeId?: string;
  activeOnly: boolean;
}

const columns = {
  id: articles.id,
  articleNumber: articles.articleNumber,
  name: articles.name,
  type: articles.type,
  standardCost: articles.standardCost,
  salesPrice: articles.salesPrice,
};

const notTemplate = not(
  exists(sql`(select 1 from ${configuratorTemplates} where ${configuratorTemplates.articleId} = ${articles.id})`)
);

// The article number ranges as ONE condition: the or of the ranges, each
// range the and of its bounds. A range without bounds restricts nothing, and
// since it is or:ed with the rest, the whole condition then falls away —
// hence null (no condition) rather than an always-true SQL fragment. An
// empty list restricts nothing either.
export function articleNumberRangesCondition(ranges: readonly ArticleNumberRange[] | undefined): SQL | null {
  if (!ranges || ranges.length === 0) return null;
  const parts: SQL[] = [];
  for (const range of ranges) {
    const bounds: SQL[] = [];
    if (range.from !== undefined) bounds.push(sql`${articles.articleNumber} collate "C" >= ${range.from}`);
    if (range.to !== undefined) bounds.push(sql`${articles.articleNumber} collate "C" <= ${range.to}`);
    if (bounds.length === 0) return null;
    parts.push(and(...bounds)!);
  }
  return parts.length === 1 ? parts[0]! : or(...parts)!;
}

// The filter variant, in article number order — byte order too, so the list
// reads as the ranges the from/to bounds cut out of it.
export async function selectBatchArticles(dbc: Db | Tx, filter: BatchArticleFilter): Promise<BatchArticle[]> {
  const where: SQL[] = [notTemplate];
  const ranges = articleNumberRangesCondition(filter.articleNumberRanges);
  if (ranges) where.push(ranges);
  if (filter.groupId !== undefined) where.push(eq(articles.groupId, filter.groupId));
  if (filter.type !== undefined) where.push(eq(articles.type, filter.type));
  if (filter.articleCodeId !== undefined) where.push(eq(articles.articleCodeId, filter.articleCodeId));
  if (filter.activeOnly) where.push(eq(articles.active, true));
  return dbc
    .select(columns)
    .from(articles)
    .where(and(...where))
    .orderBy(sql`${articles.articleNumber} collate "C"`, asc(articles.id));
}

// The Kopierat variant: the given ids (templates and unknown ids dropped),
// returned in the ORDER GIVEN — the SQL answers in any order.
export async function selectBatchArticlesByIds(dbc: Db | Tx, articleIds: readonly string[]): Promise<BatchArticle[]> {
  if (articleIds.length === 0) return [];
  const rows = await dbc
    .select(columns)
    .from(articles)
    .where(and(inArray(articles.id, [...articleIds]), notTemplate));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: BatchArticle[] = [];
  for (const id of articleIds) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

// The save's labels: the given ids with whether each is a template, so the
// save can name an article in its answer and refuse a template the same way
// the selection excludes it. Unknown ids are simply absent.
export async function labelBatchArticles(
  dbc: Db | Tx,
  articleIds: readonly string[]
): Promise<Map<string, { articleNumber: string; isTemplate: boolean }>> {
  if (articleIds.length === 0) return new Map();
  const rows = await dbc
    .select({
      id: articles.id,
      articleNumber: articles.articleNumber,
      isTemplate: sql<boolean>`${exists(sql`(select 1 from ${configuratorTemplates} where ${configuratorTemplates.articleId} = ${articles.id})`)}`,
    })
    .from(articles)
    .where(inArray(articles.id, [...new Set(articleIds)]));
  return new Map(rows.map((row) => [row.id, { articleNumber: row.articleNumber, isTemplate: row.isTemplate }]));
}
