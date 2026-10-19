import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { articles, numberSeries, type Db } from "@navet/db";
import { DEFAULT_ARTICLE_SERIES_KEY, SeriesExhaustedError } from "../../system/service/number-series.js";

// Artikelnummerserier (migration 0127). Unlike the order series, an article
// series runs into numbers that are already taken — imported articles and
// hand-typed numbers are never reserved in it — so a number is issued as the
// first FREE one at or after the series' next number, and the counter jumps
// past it. Leaf file: number_series + articles only.

type SeriesRow = typeof numberSeries.$inferSelect;

// Candidates checked per round trip, and how many rounds before the series
// counts as full (10 000 taken numbers in a row).
const SCAN_BATCH = 200;
const SCAN_ROUNDS = 50;

function format(series: Pick<SeriesRow, "prefix" | "digits">, n: number) {
  const numberPart = series.digits > 0 ? String(n).padStart(series.digits, "0") : String(n);
  return `${series.prefix}${numberPart}`;
}

// The first number at or after `from` that no article has. Never writes.
async function firstFree(db: Db, series: SeriesRow, from: number): Promise<{ n: number; articleNumber: string }> {
  for (let round = 0; round < SCAN_ROUNDS; round++) {
    const start = from + round * SCAN_BATCH;
    const candidates = Array.from({ length: SCAN_BATCH }, (_, i) => format(series, start + i));
    const taken = new Set(
      (
        await db
          .select({ articleNumber: articles.articleNumber })
          .from(articles)
          .where(inArray(articles.articleNumber, candidates))
      ).map((r) => r.articleNumber)
    );
    const index = candidates.findIndex((c) => !taken.has(c));
    if (index >= 0) return { n: start + index, articleNumber: candidates[index]! };
  }
  throw new SeriesExhaustedError(series.key);
}

// The article number series, default ("article") first, then by name.
export async function listArticleNumberSeries(db: Db) {
  return db
    .select()
    .from(numberSeries)
    .where(eq(numberSeries.forArticles, true))
    .orderBy(desc(eq(numberSeries.key, DEFAULT_ARTICLE_SERIES_KEY)), asc(numberSeries.name));
}

export async function findArticleNumberSeries(db: Db, key: string) {
  const [row] = await db
    .select()
    .from(numberSeries)
    .where(and(eq(numberSeries.key, key), eq(numberSeries.forArticles, true)));
  return row ?? null;
}

// What Ny artikel shows under the field: the number the next article would
// get right now. A preview only — nothing is reserved.
export async function previewArticleNumber(db: Db, series: SeriesRow) {
  return (await firstFree(db, series, series.nextNumber)).articleNumber;
}

// Issues a number: finds the first free one and claims it with a
// compare-and-set on the counter (only while nobody has moved it past the
// candidate), so two concurrent creators never get the same number. Like the
// register series (insertWithSeriesNumber) the claim commits on its own,
// outside the article's transaction — a failed insert burns the number,
// which an article series has no reason to avoid. null = no such series.
export async function claimArticleNumber(db: Db, key: string): Promise<string | null> {
  for (;;) {
    const series = await findArticleNumberSeries(db, key);
    if (!series) return null;
    const { n, articleNumber } = await firstFree(db, series, series.nextNumber);
    const [claimed] = await db
      .update(numberSeries)
      .set({ nextNumber: n + 1 })
      .where(and(eq(numberSeries.key, key), lte(numberSeries.nextNumber, n)))
      .returning({ key: numberSeries.key });
    if (claimed) return articleNumber;
    // Someone moved the counter past the candidate — look again from there.
  }
}
