import type { Db, Tx } from "@navet/db";
import { onHandByArticle } from "../../stock/repository/on-hand.js";

// Soft shortage check over material rows: "<name>: behöver N, tillgängligt
// M", measured against the component's USABLE stock — every location except
// a Spärrad lagerplats (onHandByArticle), the same basis as Materialbrist.
// Warnings only, never a refusal — shared by the release (every row the TO
// got) and by Ändra material (the row just added or raised). Reads through
// `dbc` so it runs inside the caller's transaction; one query for all rows.
export async function shortageWarnings(
  dbc: Db | Tx,
  rows: { componentArticleId: string; quantityPlanned: string }[],
  names: Map<string, string>
): Promise<string[]> {
  if (rows.length === 0) return [];
  const onHand = await onHandByArticle(
    dbc,
    rows.map((r) => r.componentArticleId)
  );
  const warnings: string[] = [];
  for (const row of rows) {
    const available = onHand.get(row.componentArticleId)?.usable ?? 0;
    const needed = Number(row.quantityPlanned);
    if (available < needed) {
      warnings.push(`${names.get(row.componentArticleId) ?? row.componentArticleId}: behöver ${needed}, tillgängligt ${available}`);
    }
  }
  return warnings;
}
