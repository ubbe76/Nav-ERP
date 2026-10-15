// Lagervärdering (D1) — on-hand quantity (from the append-only
// stock_transactions log, arkitekturprincip 1) times a chosen valuation
// price, as of any date. Quantities are already historical (SUM(quantity_delta)
// WHERE created_at <= X); the three methods below only differ in how they
// answer "what was the price". See TODO.md's D1 entry for the full rationale.
//
// KNOWN LIMITATION (documented, not fixed here — same one D0 noted for
// unit_cost): stock_transactions only carries created_at, a timestamptz, not
// a separate business date. Every date bound in this service therefore
// compares the DATE PART of created_at/valid_from in the database's session
// timezone — "as of {asOf}" really means "as booked by the end of {asOf}",
// and a movement can never be backdated onto an earlier valuation.
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  articleGroups,
  articles,
  articleStandardCostHistory,
  purchaseReceipts,
  stockTransactions,
  units,
  type Db,
} from "@navet/db";
import { round2, type ValuationMethod, type ValuationQuery } from "@navet/shared";
import { computeMovingAverage, type MovingAverageRow } from "./moving-average.js";
import { formatNumber, type FinancialStatementPdfInput } from "../../mail/service/document-pdf.js";

export interface ValuationRow {
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string;
  active: boolean;
  quantity: number;
  // null when the method could not find a price (see each fetch* function).
  unitCost: number | null;
  value: number | null;
}

export interface ValuationGroup {
  groupId: string | null;
  groupName: string;
  rows: ValuationRow[];
  // Excludes rows with value === null.
  total: number;
}

export interface ValuationResponse {
  asOf: string;
  method: ValuationMethod;
  groups: ValuationGroup[];
  // Excludes rows with value === null, same as every group total.
  totalValue: number;
  unvaluedCount: number;
}

const NO_GROUP_NAME = "Utan artikelgrupp";

// Exported: the year-end closing's lagerförändring names the method the same
// way in its verification text.
export const METHOD_LABELS: Record<ValuationMethod, string> = {
  standard: "Standardpris",
  latest_purchase: "Senaste inköp",
  moving_average: "Vägt snitt",
};

// Quantities live in numeric(14,4) — rounding at 2 decimals (money) would
// corrupt fractional stock. Same helper as moving-average.ts/units.ts, kept
// local rather than shared: three modules independently agreeing to round a
// numeric(14,4) to 4 decimals is not worth a shared dependency.
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

export interface ValuationPdfRenderer {
  renderFinancialStatement(input: FinancialStatementPdfInput): Promise<Buffer>;
}

export function createValuationService(deps: { db: Db; pdf?: ValuationPdfRenderer }) {
  const { db } = deps;
  // The PDF renderer is optional so unit tests can build the service without
  // dragging pdfkit in (financial-reports.service.ts's pattern) — the routes
  // always pass it.
  const pdf = deps.pdf;
  function renderer(): ValuationPdfRenderer {
    if (!pdf) throw new Error("valuation service was created without a PDF renderer");
    return pdf;
  }

  // Latest article_standard_cost_history row with valid_from <= asOf, per
  // article; falls back to the EARLIEST row when asOf predates every row
  // (documented convention — "the price before any known price is the first
  // one we ever recorded", not an invented one). No rows at all -> null.
  async function fetchStandardPrices(articleIds: string[], asOf: string) {
    const prices = new Map<string, number | null>();
    if (articleIds.length === 0) return prices;

    const rows = await db
      .select({
        articleId: articleStandardCostHistory.articleId,
        cost: articleStandardCostHistory.cost,
        withinBound: sql<boolean>`${articleStandardCostHistory.validFrom}::date <= ${asOf}::date`,
      })
      .from(articleStandardCostHistory)
      .where(inArray(articleStandardCostHistory.articleId, articleIds))
      .orderBy(asc(articleStandardCostHistory.articleId), asc(articleStandardCostHistory.validFrom));

    const byArticle = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byArticle.get(row.articleId) ?? [];
      list.push(row);
      byArticle.set(row.articleId, list);
    }

    for (const [articleId, list] of byArticle) {
      // list is ascending by valid_from (the ORDER BY above): the last
      // within-bound row is therefore the latest one as of asOf, and
      // list[0] is the earliest row overall for the fallback.
      const withinBound = list.filter((row) => row.withinBound);
      const chosen = withinBound.length > 0 ? withinBound[withinBound.length - 1]! : list[0]!;
      prices.set(articleId, Number(chosen.cost));
    }
    return prices;
  }

  // Most recent priced purchase_receipt row (created_at <= asOf) per
  // article. Rows with unit_cost null (pre-D0, or an article without a
  // standard cost at receipt time) are excluded rather than treated as a
  // zero price.
  async function fetchLatestPurchasePrices(articleIds: string[], asOf: string) {
    const prices = new Map<string, number | null>();
    if (articleIds.length === 0) return prices;

    const rows = await db
      .select({
        articleId: stockTransactions.articleId,
        unitCost: stockTransactions.unitCost,
      })
      .from(stockTransactions)
      .where(
        and(
          inArray(stockTransactions.articleId, articleIds),
          eq(stockTransactions.transactionType, "purchase_receipt"),
          isNotNull(stockTransactions.unitCost),
          // An undone receipt is no purchase price (its reversal has no cost).
          sql`NOT EXISTS (SELECT 1 FROM ${purchaseReceipts} pr WHERE pr.stock_transaction_id = ${stockTransactions.id} AND pr.undone_at IS NOT NULL)`,
          sql`${stockTransactions.createdAt}::date <= ${asOf}::date`
        )
      )
      .orderBy(
        asc(stockTransactions.articleId),
        asc(stockTransactions.createdAt),
        asc(stockTransactions.id)
      );

    // Ascending order per article — the last row seen is the latest receipt.
    for (const row of rows) {
      prices.set(row.articleId, row.unitCost !== null ? Number(row.unitCost) : null);
    }
    return prices;
  }

  // Replays every stock_transactions row up to asOf through
  // computeMovingAverage — THE weighted-average authority (moving-average.ts)
  // — per article. The average is the price; the quantity it also returns is
  // discarded here, since the caller already has the authoritative quantity
  // from the same-bound SUM query.
  async function fetchMovingAveragePrices(articleIds: string[], asOf: string) {
    const prices = new Map<string, number | null>();
    if (articleIds.length === 0) return prices;

    const rows = await db
      .select({
        articleId: stockTransactions.articleId,
        quantityDelta: stockTransactions.quantityDelta,
        unitCost: stockTransactions.unitCost,
      })
      .from(stockTransactions)
      .where(
        and(
          inArray(stockTransactions.articleId, articleIds),
          sql`${stockTransactions.createdAt}::date <= ${asOf}::date`
        )
      )
      .orderBy(
        asc(stockTransactions.articleId),
        asc(stockTransactions.createdAt),
        asc(stockTransactions.id)
      );

    const byArticle = new Map<string, MovingAverageRow[]>();
    for (const row of rows) {
      const list = byArticle.get(row.articleId) ?? [];
      list.push({
        quantityDelta: Number(row.quantityDelta),
        unitCost: row.unitCost !== null ? Number(row.unitCost) : null,
      });
      byArticle.set(row.articleId, list);
    }

    for (const [articleId, list] of byArticle) {
      prices.set(articleId, computeMovingAverage(list).average);
    }
    return prices;
  }

  async function pricesFor(method: ValuationMethod, articleIds: string[], asOf: string) {
    switch (method) {
      case "standard":
        return fetchStandardPrices(articleIds, asOf);
      case "latest_purchase":
        return fetchLatestPurchasePrices(articleIds, asOf);
      case "moving_average":
        return fetchMovingAveragePrices(articleIds, asOf);
    }
  }

  // Named object (B6a's pattern) so the PDF wrapper can call the JSON
  // builder without relying on `this`.
  const service = {
    async getValuation(query: ValuationQuery): Promise<ValuationResponse> {
      const asOf = query.asOf ?? new Date().toLocaleDateString("sv-SE");

      // One sweep: net quantity per article within the bound, joined to
      // every field the report/grouping needs. unitId is NOT NULL (inner
      // join is safe); groupId is nullable (left join).
      const quantityRows = await db
        .select({
          articleId: stockTransactions.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          active: articles.active,
          unit: units.code,
          groupId: articles.groupId,
          groupName: articleGroups.name,
          quantity: sql<string>`sum(${stockTransactions.quantityDelta})`,
        })
        .from(stockTransactions)
        .innerJoin(articles, eq(articles.id, stockTransactions.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(articleGroups, eq(articleGroups.id, articles.groupId))
        .where(
          and(
            sql`${stockTransactions.createdAt}::date <= ${asOf}::date`,
            query.groupId ? eq(articles.groupId, query.groupId) : undefined
          )
        )
        .groupBy(
          stockTransactions.articleId,
          articles.articleNumber,
          articles.name,
          articles.active,
          units.code,
          articles.groupId,
          articleGroups.name
        );

      // Drop articles netting to 0 — a netted-out article carries no
      // information at this asOf, same rule as stock.repository's balances.
      const nonZero = quantityRows
        .map((row) => ({ ...row, quantity: round4(Number(row.quantity)) }))
        .filter((row) => row.quantity !== 0);

      if (nonZero.length === 0) {
        return { asOf, method: query.method, groups: [], totalValue: 0, unvaluedCount: 0 };
      }

      const articleIds = nonZero.map((row) => row.articleId);
      const prices = await pricesFor(query.method, articleIds, asOf);

      const groupsMap = new Map<string | null, { groupName: string; rows: ValuationRow[] }>();
      for (const row of nonZero) {
        const price = prices.get(row.articleId) ?? null;
        const value = price !== null ? round2(row.quantity * price) : null;
        const valuationRow: ValuationRow = {
          articleId: row.articleId,
          articleNumber: row.articleNumber,
          articleName: row.articleName,
          unit: row.unit,
          active: row.active,
          quantity: row.quantity,
          unitCost: price,
          value,
        };
        const bucket = groupsMap.get(row.groupId) ?? {
          groupName: row.groupName ?? NO_GROUP_NAME,
          rows: [],
        };
        bucket.rows.push(valuationRow);
        groupsMap.set(row.groupId, bucket);
      }

      let totalValue = 0;
      let unvaluedCount = 0;
      const groups: ValuationGroup[] = [...groupsMap.entries()]
        .map(([groupId, { groupName, rows }]) => {
          rows.sort((a, b) => a.articleNumber.localeCompare(b.articleNumber, "sv"));
          let groupTotal = 0;
          for (const row of rows) {
            if (row.value !== null) groupTotal = round2(groupTotal + row.value);
            else unvaluedCount++;
          }
          totalValue = round2(totalValue + groupTotal);
          return { groupId, groupName, rows, total: groupTotal };
        })
        .sort((a, b) => {
          // Null group ("Utan artikelgrupp") always last, everyone else by name.
          if (a.groupId === null) return 1;
          if (b.groupId === null) return -1;
          return a.groupName.localeCompare(b.groupName, "sv");
        });

      return { asOf, method: query.method, groups, totalValue, unvaluedCount };
    },

    // --- PDF ---

    async getValuationPdf(query: ValuationQuery) {
      const valuation = await service.getValuation(query);
      const rows: FinancialStatementPdfInput["rows"] = [];

      for (const group of valuation.groups) {
        rows.push({ kind: "group", label: group.groupName, amount: null });
        for (const row of group.rows) {
          rows.push({
            kind: "account",
            label: `${row.articleNumber} ${row.articleName}`,
            // "—" (not null) so an unvalued row still prints a visible
            // marker instead of a blank cell that reads as a rendering bug.
            amount: row.value !== null ? formatNumber(row.value) : "—",
          });
        }
        rows.push({ kind: "subtotal", label: `Summa ${group.groupName}`, amount: formatNumber(group.total) });
      }
      rows.push({ kind: "total", label: "SUMMA LAGERVÄRDE", amount: formatNumber(valuation.totalValue) });
      if (valuation.unvaluedCount > 0) {
        rows.push({
          kind: "line",
          label: `varav ovärderat: ${valuation.unvaluedCount} artiklar utan pris`,
          amount: null,
        });
      }

      const content = await renderer().renderFinancialStatement({
        title: "Lagervärdering",
        subtitle: `Per ${valuation.asOf} · ${METHOD_LABELS[valuation.method]}`,
        rows,
      });
      return { filename: `lagervardering-${valuation.asOf}-${valuation.method}.pdf`, content };
    },
  };

  return service;
}

export type ValuationService = ReturnType<typeof createValuationService>;
