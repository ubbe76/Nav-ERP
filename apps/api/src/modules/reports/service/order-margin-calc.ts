import { computeLineMargin, sumMargins, type MarginLine } from "../../costing/service/margin.js";

// Marginalrapport — täckningsbidrag per månad, kund eller artikel. Pure: the
// repository hands over the invoiced rows and the self cost per article, this
// decides how they add up.
//
// The basis is INVOICED rows, not order rows: the invoice is the realised
// revenue, and the figures then reconcile against Försäljningsstatistiken.
//
// The documented limitation, which belongs in the manual: the self cost is the
// article's LATEST pre-calculation, i.e. today's cost picture applied to
// historical revenue. The report does not say what the margin was back then.

export interface MarginRowInput {
  /** YYYY-MM of the invoice date. */
  month: string;
  customerId: string;
  customerName: string;
  /** null on a free-text invoice line, which therefore has no cost basis. */
  articleId: string | null;
  articleNumber: string;
  articleName: string;
  /** Sign already flipped for credit invoices. */
  quantity: number;
  netAmount: number;
  /**
   * Konfigurator 4c: the self cost per unit of the row's OWN förkalkyl — set
   * when the invoiced order row is a configured (beställningsvara) row, whose
   * article is the template and whose calculation therefore describes nothing
   * real. undefined = use the article's; null = known to be unknown.
   */
  rowSelfCostPerUnit?: number | null;
}

export interface MarginGroup {
  key: string;
  label: string;
  netRevenue: number;
  /** Revenue for the rows that had a calculation — what the margin is measured against. */
  costedNetRevenue: number;
  cost: number | null;
  contribution: number | null;
  marginPercent: number | null;
  rowsWithoutCost: number;
}

export interface OrderMarginResult {
  groups: MarginGroup[];
  total: MarginGroup;
}

function keyOf(row: MarginRowInput, groupBy: "month" | "customer" | "article") {
  if (groupBy === "month") return { key: row.month, label: row.month };
  if (groupBy === "customer") return { key: row.customerId, label: row.customerName };
  // Free-text lines have no article to group under, but their revenue is real
  // and must still appear in the total.
  if (row.articleId === null) return { key: "", label: "Utan artikel" };
  return { key: row.articleId, label: `${row.articleNumber} — ${row.articleName}` };
}

// netAmount is the row's already-discounted net, so the margin is computed from
// it directly rather than re-deriving price × quantity × discount.
function lineOf(row: MarginRowInput, selfCostPerUnit: number | null): MarginLine {
  return computeLineMargin({
    quantity: 1,
    unitPrice: row.netAmount,
    discountPercent: 0,
    selfCostPerUnit: selfCostPerUnit === null ? null : selfCostPerUnit * row.quantity,
  });
}

function toGroup(key: string, label: string, lines: MarginLine[]): MarginGroup {
  const total = sumMargins(lines);
  return {
    key,
    label,
    netRevenue: total.netRevenue,
    costedNetRevenue: total.costedNetRevenue,
    cost: total.cost,
    contribution: total.contribution,
    marginPercent: total.marginPercent,
    rowsWithoutCost: total.linesWithoutCost,
  };
}

export function groupOrderMargin(
  rows: MarginRowInput[],
  selfCostByArticle: Map<string, number>,
  groupBy: "month" | "customer" | "article"
): OrderMarginResult {
  const buckets = new Map<string, { label: string; lines: MarginLine[] }>();
  const all: MarginLine[] = [];

  for (const row of rows) {
    const perUnit =
      row.rowSelfCostPerUnit !== undefined
        ? row.rowSelfCostPerUnit
        : ((row.articleId === null ? null : selfCostByArticle.get(row.articleId)) ?? null);
    const line = lineOf(row, perUnit);
    all.push(line);
    const { key, label } = keyOf(row, groupBy);
    const bucket = buckets.get(key);
    if (bucket) bucket.lines.push(line);
    else buckets.set(key, { label, lines: [line] });
  }

  const groups = [...buckets.entries()].map(([key, b]) => toGroup(key, b.label, b.lines));
  // Month reads chronologically; the others by size, biggest first — the same
  // convention the sales statistics report already uses.
  groups.sort((a, b) => (groupBy === "month" ? a.key.localeCompare(b.key) : b.netRevenue - a.netRevenue));

  return { groups, total: toGroup("total", "Totalt", all) };
}
