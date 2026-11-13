// Skanning vid inventering (#4, etapp 4) — the pure rule of what a scanned
// code means on Lager → Inventering: a lagerplats label opens that place's
// count, an article selects (or adds) its row on the count sheet so the
// counted quantity can be typed, and a batch or serienummer (#8 etapp 2: a
// GS1 code's AI 10/21, or the number itself) names the row. No imports, so the API test suite loads it
// directly (test/web-count-scan.test.ts).

export type CountScanMatch =
  // stockTracking (articles only): "serial" = one row per serienummer,
  // "batch" = one per batch.
  | { kind: "location" | "article" | "purchaseOrder" | "salesOrder" | "manufacturingOrder"; id: string; stockTracking?: "batch" | "serial" | null }
  // A batch or serienummer that exists under the scanned number.
  | { kind: "batch"; id: string; articleId: string; batchKind: "batch" | "serial"; batchNumber: string };

// What a GS1 code carried next to its GTIN (GET /scan's `gs1`).
export interface CountScanGs1 {
  batch: string | null;
  serial: string | null;
}

// A row of the count sheet: batchId/batchNumber null = the article's one row
// (untracked) or its Okänd row.
export interface CountScanRow {
  id: string;
  articleId: string;
  batchId?: string | null;
  batchNumber?: string | null;
  batchKind?: "batch" | "serial" | null;
}

type ArticleOf<M> = Extract<M, { kind: "article" }>;

export type CountScanIntent<M extends CountScanMatch> =
  // The label of the count's own place: nothing to change.
  | { kind: "thisLocation"; match: Extract<M, { kind: "location" }> }
  // Another place (or no count open yet): open that place's count.
  | { kind: "otherLocation"; match: Extract<M, { kind: "location" }> }
  // An article with ONE row on the sheet: Räknat takes the cursor.
  | { kind: "row"; match: ArticleOf<M>; rowId: string }
  // An article the sheet does not have: added, as Lägg till artikel does.
  | { kind: "addArticle"; match: ArticleOf<M> }
  // A spårad article scanned without a number that says which row: the
  // user chooses among its rows — for serienummer, scans the number.
  | { kind: "chooseRow"; match: ArticleOf<M>; rowIds: string[]; serial: boolean }
  // A serienummer with a row: counted 1 at once — one styck is one styck.
  | { kind: "serialRow"; articleId: string; rowId: string; serialNumber: string }
  // A serienummer the sheet does not have: added with the number, then 1.
  | { kind: "addSerial"; articleId: string; serialNumber: string }
  // A batch with a row: THAT row's Räknat takes the cursor.
  | { kind: "batchRow"; articleId: string; rowId: string; batchNumber: string }
  // A batch the sheet does not have: added with the batch.
  | { kind: "addBatch"; articleId: string; batchNumber: string }
  // The number exists on several articles and none of them is on the sheet.
  | { kind: "ambiguousNumber"; batchNumber: string }
  // An article (or a number) while the count is registered or cancelled, or
  // before one is open.
  | { kind: "articleNotCounting"; match: ArticleOf<M> }
  | { kind: "numberNotCounting" }
  | { kind: "order"; match: Extract<M, { kind: "purchaseOrder" | "salesOrder" | "manufacturingOrder" }> }
  | { kind: "unknown" };

const sameNumber = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

// A location wins over an article of the same code; among articles, one
// that already has a row wins. A GS1 code's serienummer (AI 21) or batch (AI
// 10) — whichever the article is tracked by — names the row; without an
// article in the code, a number that exists as a batch or serienummer does.
export function resolveCountScan<M extends CountScanMatch>(
  matches: M[],
  count: { locationId: string; open: boolean; rows: CountScanRow[] } | null,
  gs1?: CountScanGs1 | null
): CountScanIntent<M> {
  const location = matches.find((m): m is Extract<M, { kind: "location" }> => m.kind === "location");
  if (location) {
    return location.id === count?.locationId ? { kind: "thisLocation", match: location } : { kind: "otherLocation", match: location };
  }
  const articles = matches.filter((m): m is ArticleOf<M> => m.kind === "article");
  if (articles.length > 0) {
    if (!count?.open) return { kind: "articleNotCounting", match: articles[0]! };
    const rowsOf = (articleId: string) => count.rows.filter((r) => r.articleId === articleId);
    const tracking = (a: ArticleOf<M>) => (a as { stockTracking?: "batch" | "serial" | null }).stockTracking ?? null;
    // The number the code carries for this article, if it carries one.
    const sorted = [...articles].sort((a, b) => Number(rowsOf(b.id).length > 0) - Number(rowsOf(a.id).length > 0));
    for (const article of sorted) {
      if (tracking(article) === "serial" && gs1?.serial) {
        const serialNumber = gs1.serial;
        const row = rowsOf(article.id).find((r) => r.batchKind === "serial" && sameNumber(r.batchNumber, serialNumber));
        return row
          ? { kind: "serialRow", articleId: article.id, rowId: row.id, serialNumber }
          : { kind: "addSerial", articleId: article.id, serialNumber };
      }
      if (tracking(article) === "batch" && gs1?.batch) {
        const batchNumber = gs1.batch;
        const row = rowsOf(article.id).find((r) => r.batchKind !== "serial" && sameNumber(r.batchNumber, batchNumber));
        return row
          ? { kind: "batchRow", articleId: article.id, rowId: row.id, batchNumber }
          : { kind: "addBatch", articleId: article.id, batchNumber };
      }
    }
    // Only the article: its row when there is exactly one to mean.
    const single = sorted.find((a) => tracking(a) !== "serial" && rowsOf(a.id).length === 1);
    if (single) return { kind: "row", match: single, rowId: rowsOf(single.id)[0]!.id };
    const several = sorted.find((a) => tracking(a) === "serial" || rowsOf(a.id).length > 1);
    if (several) {
      return { kind: "chooseRow", match: several, rowIds: rowsOf(several.id).map((r) => r.id), serial: tracking(several) === "serial" };
    }
    return { kind: "addArticle", match: articles[0]! };
  }
  const numbers = matches.filter((m): m is Extract<M, { kind: "batch" }> => m.kind === "batch");
  if (numbers.length > 0) {
    if (!count?.open) return { kind: "numberNotCounting" };
    const intent = (m: Extract<M, { kind: "batch" }>, rowId: string | null): CountScanIntent<M> => {
      const n = m as Extract<CountScanMatch, { kind: "batch" }>;
      if (n.batchKind === "serial") {
        return rowId
          ? { kind: "serialRow", articleId: n.articleId, rowId, serialNumber: n.batchNumber }
          : { kind: "addSerial", articleId: n.articleId, serialNumber: n.batchNumber };
      }
      return rowId
        ? { kind: "batchRow", articleId: n.articleId, rowId, batchNumber: n.batchNumber }
        : { kind: "addBatch", articleId: n.articleId, batchNumber: n.batchNumber };
    };
    for (const m of numbers) {
      const row = count.rows.find((r) => r.batchId === m.id);
      if (row) return intent(m, row.id);
    }
    if (numbers.length > 1) {
      return { kind: "ambiguousNumber", batchNumber: (numbers[0] as Extract<CountScanMatch, { kind: "batch" }>).batchNumber };
    }
    return intent(numbers[0]!, null);
  }
  const order = matches.find(
    (m): m is Extract<M, { kind: "purchaseOrder" | "salesOrder" | "manufacturingOrder" }> =>
      m.kind === "purchaseOrder" || m.kind === "salesOrder" || m.kind === "manufacturingOrder"
  );
  return order ? { kind: "order", match: order } : { kind: "unknown" };
}
