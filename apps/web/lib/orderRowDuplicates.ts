// Samma artikel flera rader på en order (migration 0177): allowed, but the
// add-row forms say so. Pure, derived from the rows the form already has —
// nothing is stored and nothing blocks saving. Tested from
// apps/api/test/order-row-duplicates-web.test.ts.

type DocumentRowLike = {
  id?: string;
  articleId: string;
  setupForRowId?: string | null;
  configuration?: unknown;
};

// "ordern" | "offerten" | "förfrågan" — the word the page already uses.
export type DocumentWord = "ordern" | "offerten" | "förfrågan";

// Does the article already sit on one of the rows? A ställkostnadsrad follows
// its owner row and does not count, and neither does a configured
// beställningsvara row (the same template with other choices is another
// product); `ignoreRowId` leaves out the row being edited.
export function articleAlreadyOnDocument(rows: DocumentRowLike[], articleId: string, ignoreRowId?: string | null): boolean {
  return rows.some(
    (row) =>
      row.articleId === articleId &&
      !row.setupForRowId &&
      row.configuration == null &&
      (ignoreRowId == null || row.id !== ignoreRowId)
  );
}

// The notice under the article picker; null when there is nothing to say.
export function alreadyOnDocumentText(
  rows: DocumentRowLike[],
  articleId: string | null | undefined,
  word: DocumentWord,
  ignoreRowId?: string | null
): string | null {
  if (!articleId || !articleAlreadyOnDocument(rows, articleId, ignoreRowId)) return null;
  return `Artikeln finns redan på ${word} — den läggs till som en egen rad.`;
}
