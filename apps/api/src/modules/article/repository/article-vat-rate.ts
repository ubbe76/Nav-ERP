import { eq, sql } from "drizzle-orm";
import { articleGroups, articles, type Db, type Tx } from "@navet/db";

// Varugrupp styr momsen (0155): an article's VAT rate is its group's
// article_groups.vat_rate, 25 % (DEFAULT_VAT_RATE) without a group. The ONE
// derivation every reader uses — the article GET's `vatRate`, the invoice
// rows' default and the documents' gross-up — so the rule cannot drift.
// A correlated subquery rather than a join, so it drops into any select
// that has `articles` in scope (even one that already joins article_groups
// for another purpose). Returns numeric text with two decimals ("25.00"),
// the shape the old articles.vat_rate column had.
export const articleVatRateSql = sql<string>`coalesce((select ${articleGroups.vatRate} from ${articleGroups} where ${articleGroups.id} = ${articles.groupId}), 25.00)`;

// The article's rate and type (goods or service) — what salesVatCode reads.
// null = no such article.
export async function articleVatFacts(ex: Db | Tx, articleId: string): Promise<{ vatRate: number; type: string } | null> {
  const [row] = await ex
    .select({ vatRate: articleVatRateSql, type: articles.type })
    .from(articles)
    .where(eq(articles.id, articleId));
  return row ? { vatRate: Number(row.vatRate), type: row.type as string } : null;
}
