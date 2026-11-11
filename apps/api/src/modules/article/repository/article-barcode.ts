import { and, inArray, ne, sql } from "drizzle-orm";
import { gtinForms, gtinKey } from "@navet/shared";
import { articles, type Db, type Tx } from "@navet/db";

// Streckkod (EAN, #4) is unique when set: 409 duplicate-article-barcode. The
// leaf's error (its write path throws it); the service re-exports it for the
// routes.
export class DuplicateArticleBarcodeError extends Error {
  constructor(barcode: string) {
    super(`Another article already has the barcode "${barcode}"`);
    this.name = "DuplicateArticleBarcodeError";
  }
}

// The duplicate check compares the GTIN, not the string (gtinKey: a 12-digit
// UPC-A and the EAN-13 with a leading 0 are one code). The partial unique
// index articles_barcode_unique only sees the exact string, so the check runs
// in the writer's transaction under an advisory lock on the key: a concurrent
// save of the same GTIN in another form waits and then sees this one. The
// index stays the backstop for the exact form (throwIfBarcodeTaken).
// `exceptArticleId`: the article being saved keeps its own code.
export async function assertBarcodeFree(tx: Db | Tx, barcode: string, exceptArticleId: string | null): Promise<void> {
  const key = gtinKey(barcode);
  // The schema only lets valid GTINs through; anything else is left to the
  // exact-string index.
  if (key === null) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('article_barcode'), hashtext(${key}))`);
  const [holder] = await tx
    .select({ id: articles.id })
    .from(articles)
    .where(
      exceptArticleId
        ? and(inArray(articles.barcode, gtinForms(barcode)), ne(articles.id, exceptArticleId))
        : inArray(articles.barcode, gtinForms(barcode))
    )
    .limit(1);
  if (holder) throw new DuplicateArticleBarcodeError(barcode);
}
