// Skanning vid inventering (#4, etapp 4) — the pure rule of what a scanned
// code means on Lager → Inventering: a lagerplats label opens that place's
// count, an article selects (or adds) its row on the count sheet so the
// counted quantity can be typed. No imports, so the API test suite loads it
// directly (test/web-count-scan.test.ts).

export type CountScanMatch = { kind: "location" | "article" | "purchaseOrder" | "salesOrder" | "manufacturingOrder"; id: string };

export type CountScanIntent<M extends CountScanMatch> =
  // The label of the count's own place: nothing to change.
  | { kind: "thisLocation"; match: Extract<M, { kind: "location" }> }
  // Another place (or no count open yet): open that place's count.
  | { kind: "otherLocation"; match: Extract<M, { kind: "location" }> }
  // An article with a row on the sheet.
  | { kind: "row"; match: Extract<M, { kind: "article" }>; rowId: string }
  // An article the sheet does not have: added, as Lägg till artikel does.
  | { kind: "addArticle"; match: Extract<M, { kind: "article" }> }
  // An article while the count is registered or cancelled, or before one is open.
  | { kind: "articleNotCounting"; match: Extract<M, { kind: "article" }> }
  | { kind: "order"; match: Extract<M, { kind: "purchaseOrder" | "salesOrder" | "manufacturingOrder" }> }
  | { kind: "unknown" };

// A location wins over an article of the same code; among articles, one
// that already has a row wins.
export function resolveCountScan<M extends CountScanMatch>(
  matches: M[],
  count: { locationId: string; open: boolean; rows: { id: string; articleId: string }[] } | null
): CountScanIntent<M> {
  const location = matches.find((m): m is Extract<M, { kind: "location" }> => m.kind === "location");
  if (location) {
    return location.id === count?.locationId ? { kind: "thisLocation", match: location } : { kind: "otherLocation", match: location };
  }
  const articles = matches.filter((m): m is Extract<M, { kind: "article" }> => m.kind === "article");
  if (articles.length > 0) {
    if (!count?.open) return { kind: "articleNotCounting", match: articles[0]! };
    for (const article of articles) {
      const row = count.rows.find((r) => r.articleId === article.id);
      if (row) return { kind: "row", match: article, rowId: row.id };
    }
    return { kind: "addArticle", match: articles[0]! };
  }
  const order = matches.find(
    (m): m is Extract<M, { kind: "purchaseOrder" | "salesOrder" | "manufacturingOrder" }> =>
      m.kind === "purchaseOrder" || m.kind === "salesOrder" || m.kind === "manufacturingOrder"
  );
  return order ? { kind: "order", match: order } : { kind: "unknown" };
}
