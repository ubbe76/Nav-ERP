// Kundens artikelnummer for document rows — ONE lookup shared by the sales
// repository (quote, order confirmation, pick list, delivery note) and the
// invoice repository (customer invoice). Db | Tx like the other leaves.
import { and, eq, inArray } from "drizzle-orm";
import { customerArticleNumbers, type Db, type Tx } from "@navet/db";

// articleId -> the customer's number for it; articles without one are absent.
export async function customerArticleNumberMap(
  db: Db | Tx,
  customerId: string,
  articleIds: (string | null)[]
): Promise<Map<string, string>> {
  const ids = [...new Set(articleIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ articleId: customerArticleNumbers.articleId, number: customerArticleNumbers.customerArticleNumber })
    .from(customerArticleNumbers)
    .where(and(eq(customerArticleNumbers.customerId, customerId), inArray(customerArticleNumbers.articleId, ids)));
  return new Map(rows.map((row) => [row.articleId, row.number]));
}
