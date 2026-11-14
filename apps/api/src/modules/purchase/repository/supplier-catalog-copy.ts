import { asc, eq, sql } from "drizzle-orm";
import { articleSuppliers, type Tx } from "@navet/db";

// Kopiera från befintlig artikel → Inköp: the source's supplier catalog
// (huvudleverantör flag included) with each row's stafflade priser, onto the
// new article inside the article's create transaction. The purchase
// module's own Tx leaf — the catalog is its table, like copyRouting is
// manufacturing's (article-copy.ts calls both). Price breaks are copied with
// INSERT … SELECT; the catalog's price history follows by its deferred
// trigger (purchase.md), so nothing else is written here.
export async function copySupplierCatalogInTx(tx: Tx, sourceArticleId: string, targetArticleId: string): Promise<void> {
  const rows = await tx
    .select()
    .from(articleSuppliers)
    .where(eq(articleSuppliers.articleId, sourceArticleId))
    .orderBy(asc(articleSuppliers.createdAt), asc(articleSuppliers.id));
  for (const { id: oldId, createdAt: _createdAt, articleId: _articleId, ...rest } of rows) {
    const [inserted] = await tx
      .insert(articleSuppliers)
      .values({ ...rest, articleId: targetArticleId })
      .returning({ id: articleSuppliers.id });
    await tx.execute(sql`
      INSERT INTO article_supplier_price_breaks (article_supplier_id, from_quantity, price)
      SELECT ${inserted!.id}, from_quantity, price
      FROM article_supplier_price_breaks WHERE article_supplier_id = ${oldId}`);
  }
}
