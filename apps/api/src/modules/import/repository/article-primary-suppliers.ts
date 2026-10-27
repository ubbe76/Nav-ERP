// The article import's Leverantörsnr step, run inside executeArticlePlan's
// transaction after the articles exist: the named supplier becomes the
// article's primary supplier on the Inköp tab. A missing article_suppliers
// row is added WITHOUT a price (in the supplier's currency, as the catalog
// dialog does) — prices come from the Prislista Inköp import; an existing
// row only gets the flag. The previous primary is demoted first, since the
// partial unique index allows one per article.
import { inArray, sql } from "drizzle-orm";
import { articleSuppliers, suppliers, type Tx } from "@navet/db";

const CHUNK_SIZE = 500;

function chunk<T>(items: T[]): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) parts.push(items.slice(i, i + CHUNK_SIZE));
  return parts;
}

export interface ImportedPrimarySupplier {
  articleId: string;
  supplierId: string;
}

export async function applyPrimarySuppliers(tx: Tx, rows: ImportedPrimarySupplier[]): Promise<void> {
  if (rows.length === 0) return;
  // One supplier per article — the planner refuses duplicate article numbers.
  const targets = new Map(rows.map((row) => [row.articleId, row.supplierId]));

  const currencyBySupplier = new Map<string, string>();
  for (const part of chunk([...new Set(targets.values())])) {
    const found = await tx
      .select({ id: suppliers.id, currency: suppliers.currency })
      .from(suppliers)
      .where(inArray(suppliers.id, part));
    for (const row of found) currencyBySupplier.set(row.id, row.currency);
  }

  for (const part of chunk([...targets])) {
    // One statement per chunk: demote every primary row of these articles
    // that is not the target supplier's.
    const pairs = sql.join(
      part.map(([articleId, supplierId]) => sql`(${articleId}::uuid, ${supplierId}::uuid)`),
      sql`, `
    );
    await tx.execute(sql`
      update ${articleSuppliers} set is_primary = false
      from (values ${pairs}) as target(article_id, supplier_id)
      where ${articleSuppliers.articleId} = target.article_id
        and ${articleSuppliers.isPrimary}
        and ${articleSuppliers.supplierId} <> target.supplier_id
    `);
    await tx
      .insert(articleSuppliers)
      .values(
        part.map(([articleId, supplierId]) => ({
          articleId,
          supplierId,
          currency: currencyBySupplier.get(supplierId) ?? "SEK",
          isPrimary: true,
        }))
      )
      .onConflictDoUpdate({
        target: [articleSuppliers.articleId, articleSuppliers.supplierId],
        set: { isPrimary: sql`true` },
      });
  }
}
