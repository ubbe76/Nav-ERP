import { eq, sql } from "drizzle-orm";
import { stockBalances, type Db, type Tx } from "@navet/db";

// Soft shortage check over material rows: "<name>: behöver N, tillgängligt
// M", measured against the component's TOTAL stock over every location.
// Warnings only, never a refusal — shared by the release (every row the TO
// got) and by Ändra material (the row just added or raised). Reads through
// `dbc` so it runs inside the caller's transaction.
export async function shortageWarnings(
  dbc: Db | Tx,
  rows: { componentArticleId: string; quantityPlanned: string }[],
  names: Map<string, string>
): Promise<string[]> {
  const warnings: string[] = [];
  for (const row of rows) {
    const [balance] = await dbc
      .select({ total: sql<string>`coalesce(sum(${stockBalances.quantityOnHand}), 0)` })
      .from(stockBalances)
      .where(eq(stockBalances.articleId, row.componentArticleId));
    const available = Number(balance?.total ?? 0);
    const needed = Number(row.quantityPlanned);
    if (available < needed) {
      warnings.push(`${names.get(row.componentArticleId) ?? row.componentArticleId}: behöver ${needed}, tillgängligt ${available}`);
    }
  }
  return warnings;
}
