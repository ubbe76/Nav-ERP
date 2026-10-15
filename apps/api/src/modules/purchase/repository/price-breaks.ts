import { asc, eq, inArray } from "drizzle-orm";
import { articleSupplierPriceBreaks, type Db, type Tx } from "@navet/db";

// Staffelsteg (article_supplier_price_breaks) — the DB leaf shared by the
// purchase catalog, planning's order creation and the cost calculation.
// Works on Db or Tx like resolveStockLocation, so the catalog's create/update
// transaction can replace the set atomically.

export interface PriceBreakRow {
  id: string;
  fromQuantity: number;
  price: number;
}

// One query for all rows, grouped in JS and sorted by from_quantity — the
// openInquiriesByOperation pattern in planning.repository.ts.
export async function loadPriceBreaks(dbc: Db | Tx, articleSupplierIds: string[]): Promise<Map<string, PriceBreakRow[]>> {
  const result = new Map<string, PriceBreakRow[]>();
  if (articleSupplierIds.length === 0) return result;
  const rows = await dbc
    .select({
      id: articleSupplierPriceBreaks.id,
      articleSupplierId: articleSupplierPriceBreaks.articleSupplierId,
      fromQuantity: articleSupplierPriceBreaks.fromQuantity,
      price: articleSupplierPriceBreaks.price,
    })
    .from(articleSupplierPriceBreaks)
    .where(inArray(articleSupplierPriceBreaks.articleSupplierId, articleSupplierIds))
    .orderBy(asc(articleSupplierPriceBreaks.fromQuantity));
  for (const row of rows) {
    const entry = { id: row.id, fromQuantity: Number(row.fromQuantity), price: Number(row.price) };
    const list = result.get(row.articleSupplierId);
    if (list) list.push(entry);
    else result.set(row.articleSupplierId, [entry]);
  }
  return result;
}

// Replace-the-set semantics: the form edits the whole staffel and saves it
// at once, so delete + insert inside the caller's transaction is simpler
// and safer than diffing rows (and the unique constraint can never bite).
export async function replacePriceBreaks(
  tx: Tx,
  articleSupplierId: string,
  breaks: { fromQuantity: number; price: number }[]
): Promise<void> {
  await tx.delete(articleSupplierPriceBreaks).where(eq(articleSupplierPriceBreaks.articleSupplierId, articleSupplierId));
  if (breaks.length === 0) return;
  await tx.insert(articleSupplierPriceBreaks).values(
    breaks.map((b) => ({
      articleSupplierId,
      fromQuantity: String(b.fromQuantity),
      price: String(b.price),
    }))
  );
}
