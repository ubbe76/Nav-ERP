// Bakdaterade lagerrörelser (#19) and inventering per underlagets datum
// (#26) — the DB half both share: whether a day may still be written to (the
// period reader economy provides), whether the place was counted that day or
// later, and what the standard cost was at a moment. `Db | Tx` leaf: the
// stock log's two backdating writers (Lagerjustering in stock, inleverans in
// purchase) call assertStockBackdate inside their own transaction, after the
// place is resolved. The pure half (the day, the moment, the errors) is
// stock/service/backdating.ts.
import { and, asc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { articles, articleStandardCostHistory, stockCountRows, stockCountSessions, stockTransactions, type Db, type Tx } from "@navet/db";
import { stockholmDateOf, stockholmInstant } from "../../system/service/delivery-days.js";
import { STOCK_IMPORT_NOTE, StockBackdateRefusedError } from "../service/backdating.js";
import { stockValuedAt } from "./valued-at.js";

// Bookkeeping lives in the economy module, so whether a day may still be
// written to arrives through this reader (app.ts binds economy's
// postingPeriodLockOn). No covering accounting period is no lock — the stock
// log is not bookkeeping.
export interface PostingPeriodReader {
  lockOn(executor: Db | Tx, date: string): Promise<{ kind: "year_closed"; yearLabel: string } | { kind: "period_locked" } | null>;
}

// Tests that never backdate into a locked period build the repositories
// without economy; app.ts always passes the real reader.
export const noPostingPeriodLocks: PostingPeriodReader = { lockOn: async () => null };

// The year/period half of every backdating verdict, as the refusal text both
// writers and the count card show.
export async function periodLockText(executor: Db | Tx, periods: PostingPeriodReader, day: string): Promise<{ reason: "year_closed" | "period_locked"; text: string } | null> {
  const lock = await periods.lockOn(executor, day);
  if (lock?.kind === "year_closed") return { reason: "year_closed", text: `Räkenskapsåret ${lock.yearLabel} är stängt.` };
  if (lock?.kind === "period_locked") return { reason: "period_locked", text: `Bokföringsperioden för ${day} är låst.` };
  return null;
}

// May a movement of these articles on these places be booked per `day`? The
// first refusal wins (409 stock-backdate-refused):
//  1. the day is in a closed fiscal year or a locked period;
//  2. the article was COUNTED on the place that day or later — a session
//     that is not cancelled, with a row for the article (a posted one only
//     when the row was counted), frozen on a Stockholm day >= `day`. The
//     freeze decides: the counted figures describe that moment and the
//     difference was booked against its snapshot, so goods that came in
//     before it are in the count already and a backdated row would count
//     them twice;
//  3. the place got an IMPORTED balance for the article that day or later —
//     the saldoimport sets the balance like a count (STOCK_IMPORT_NOTE). An
//     import that changed nothing wrote no row and is not seen.
// Read inside the writer's transaction; not locked against a count started
// or a period locked meanwhile — the same accepted window as #26's verdict.
export async function assertStockBackdate(
  executor: Db | Tx,
  periods: PostingPeriodReader,
  day: string,
  places: { articleId: string; locationId: string }[]
): Promise<void> {
  const lock = await periodLockText(executor, periods, day);
  if (lock) throw new StockBackdateRefusedError(day, lock.reason, lock.text);
  const dayStart = new Date(stockholmInstant(day, "00:00"));
  for (const place of places) {
    const [counted] = await executor
      .select({ countNumber: stockCountSessions.countNumber, frozenAt: stockCountSessions.createdAt })
      .from(stockCountRows)
      .innerJoin(stockCountSessions, eq(stockCountSessions.id, stockCountRows.sessionId))
      .where(
        and(
          eq(stockCountSessions.locationId, place.locationId),
          eq(stockCountRows.articleId, place.articleId),
          gte(stockCountSessions.createdAt, dayStart),
          or(
            eq(stockCountSessions.status, "open"),
            and(eq(stockCountSessions.status, "posted"), isNotNull(stockCountRows.countedQuantity))
          )!
        )
      )
      .orderBy(asc(stockCountSessions.createdAt))
      .limit(1);
    if (counted) {
      throw new StockBackdateRefusedError(
        day,
        "counted",
        `Artikeln har inventerats på lagerplatsen ${stockholmDateOf(counted.frozenAt)} (${counted.countNumber}), samma dag eller senare.`
      );
    }
    const [imported] = await executor
      .select({ at: stockValuedAt })
      .from(stockTransactions)
      .where(
        and(
          eq(stockTransactions.articleId, place.articleId),
          eq(stockTransactions.locationId, place.locationId),
          eq(stockTransactions.transactionType, "inventory_adjustment"),
          eq(stockTransactions.note, STOCK_IMPORT_NOTE),
          sql`${stockValuedAt} >= ${dayStart.toISOString()}::timestamptz`
        )
      )
      .orderBy(asc(stockValuedAt))
      .limit(1);
    if (imported) {
      throw new StockBackdateRefusedError(
        day,
        "imported",
        `Artikeln fick ett importerat lagersaldo på lagerplatsen ${stockholmDateOf(imported.at)}, samma dag eller senare.`
      );
    }
  }
}

// The standard cost each article had at `at` (D1's history: the latest row
// with valid_from <= at). An article with no history at all keeps its
// current standard cost (articles from before the history); one whose
// history only starts later had none then — null, never 0 (D0).
export async function standardCostsAt(executor: Db | Tx, articleIds: string[], at: Date): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (articleIds.length === 0) return result;
  const history = await executor
    .select({
      articleId: articleStandardCostHistory.articleId,
      cost: articleStandardCostHistory.cost,
      validFrom: articleStandardCostHistory.validFrom,
    })
    .from(articleStandardCostHistory)
    .where(inArray(articleStandardCostHistory.articleId, articleIds))
    .orderBy(asc(articleStandardCostHistory.articleId), asc(articleStandardCostHistory.validFrom), asc(articleStandardCostHistory.id));
  const current = await executor
    .select({ id: articles.id, standardCost: articles.standardCost })
    .from(articles)
    .where(inArray(articles.id, articleIds));
  const withHistory = new Set<string>();
  for (const row of history) {
    withHistory.add(row.articleId);
    if (!result.has(row.articleId)) result.set(row.articleId, null);
    if (row.validFrom.getTime() <= at.getTime()) result.set(row.articleId, row.cost);
  }
  for (const article of current) {
    if (!withHistory.has(article.id)) result.set(article.id, article.standardCost ?? null);
  }
  return result;
}
