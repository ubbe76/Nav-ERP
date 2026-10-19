// F1: pre- vs post-calculation outcome — pure pairing calc, no database.
//
// A förkalkyl is always saved on the ARTICLE (Kalkyl tab: article + quantity,
// manufacturing_order_id null) — nothing ever saves a pre-calculation on a
// manufacturing order. An efterkalkyl is always saved on its MO. So the pair
// for one MO is its LATEST post-calculation against the article's latest
// pre-calculation saved AT OR BEFORE that post: the estimate in force when
// the order was costed, not one written afterwards with hindsight. TVK is
// compared per unit (each calculation's own quantity — pre and post lot
// sizes can differ) and the period filters on the post calculation's month.

export interface CalcRowInput {
  articleId: string;
  // Post: the MO it was saved on. Pre: null (article-level). A pre that
  // somehow carries an MO is ignored — no code path writes one.
  manufacturingOrderId: string | null;
  orderNumber: string | null;
  // The MO is a beställningsvara's TO (manufacturing_orders.configuration).
  // Its estimate is the configuration's own förkalkyl, not the template
  // article's, so it is never paired with an article pre-calculation.
  configured: boolean;
  articleNumber: string;
  articleName: string;
  type: "pre" | "post";
  quantity: number;
  calculatedAt: string; // ISO timestamp
  materialCost: number;
  materialOverhead: number;
  laborCost: number;
  overhead: number;
  subcontractCost: number;
  subcontractOverhead: number;
  semiFinishedCost: number;
  // Whether the calculation resolved sub-assemblies recursively. Only a
  // pre-calculation can be multi-level; the report surfaces it because such a
  // pre carries the sub-assembly's full manufacturing cost while the post
  // carries its receipt price, which reads as a deviation that is not one.
  multiLevel: boolean;
}

export interface OutcomeRow {
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  quantity: number; // the post calculation's quantity
  preTvkPerUnit: number;
  postTvkPerUnit: number;
  deltaPerUnit: number;
  deltaPct: number | null; // null when pre TVK is 0
  preCalculatedAt: string;
  postCalculatedAt: string;
  // The pre-calculation resolved sub-assemblies recursively, so its TVK holds
  // each sub-assembly's own manufacturing cost while the post-calculation holds
  // what the sub-assembly was received at. The pair is still worth comparing —
  // the two agree once the sub-assembly's standard cost has been set from its
  // own calculation — but the row is flagged so a large deviation can be read
  // for what it is rather than mistaken for a production overrun.
  preMultiLevel: boolean;
}

export interface OutcomeResult {
  rows: OutcomeRow[]; // newest post first
  summary: { count: number; avgDeviationPct: number | null };
  // onlyPost: MOs whose latest post has no comparable pre-calculation — the
  // article had none saved at or before it, or the MO is a beställningsvara.
  // There is no "only pre" counterpart: a pre-calculation belongs to the
  // article, not to an order, so it never makes an order unpaired.
  notComparable: { onlyPost: number; invalidQuantity: number };
}

const stockholmDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });

// TVK (tillverkningskostnad) from the stored cost columns — the same formula
// markup.ts derives at calculation time: dM + MO + dL + TO + Lego + LO.
const tvk = (c: CalcRowInput) =>
  c.materialCost +
  c.materialOverhead +
  c.laborCost +
  c.overhead +
  c.subcontractCost +
  c.subcontractOverhead +
  c.semiFinishedCost;

export function pairCalculationOutcomes(
  calcs: CalcRowInput[],
  range: { from: string; to: string } // YYYY-MM inclusive, on the post calc's month
): OutcomeResult {
  // Latest post per MO, and every article-level pre per article.
  const latestPostByOrder = new Map<string, CalcRowInput>();
  const presByArticle = new Map<string, CalcRowInput[]>();
  for (const calc of calcs) {
    if (calc.type === "post") {
      if (calc.manufacturingOrderId === null) continue;
      const current = latestPostByOrder.get(calc.manufacturingOrderId);
      if (!current || calc.calculatedAt > current.calculatedAt) latestPostByOrder.set(calc.manufacturingOrderId, calc);
    } else if (calc.manufacturingOrderId === null) {
      const list = presByArticle.get(calc.articleId) ?? [];
      list.push(calc);
      presByArticle.set(calc.articleId, list);
    }
  }

  // The article's latest pre saved at or before `at` (ISO strings compare
  // chronologically). Ties go to the later row in input order.
  const preInForceAt = (articleId: string, at: string) => {
    let found: CalcRowInput | undefined;
    for (const pre of presByArticle.get(articleId) ?? []) {
      if (pre.calculatedAt > at) continue;
      if (!found || pre.calculatedAt >= found.calculatedAt) found = pre;
    }
    return found;
  };

  const inRange = (isoTimestamp: string) => {
    const month = stockholmDate.format(new Date(isoTimestamp)).slice(0, 7);
    return month >= range.from && month <= range.to;
  };

  const rows: OutcomeRow[] = [];
  // Counters are period-scoped (on the post calculation's month) so the
  // footer reconciles with the filtered table instead of showing all-time
  // numbers under a period view.
  const notComparable = { onlyPost: 0, invalidQuantity: 0 };
  for (const post of latestPostByOrder.values()) {
    if (!inRange(post.calculatedAt)) continue;

    const pre = post.configured ? undefined : preInForceAt(post.articleId, post.calculatedAt);
    if (!pre) {
      notComparable.onlyPost += 1;
      continue;
    }

    if (pre.quantity <= 0 || post.quantity <= 0) {
      notComparable.invalidQuantity += 1;
      continue;
    }

    const preTvkPerUnit = tvk(pre) / pre.quantity;
    const postTvkPerUnit = tvk(post) / post.quantity;
    const deltaPerUnit = postTvkPerUnit - preTvkPerUnit;
    rows.push({
      manufacturingOrderId: post.manufacturingOrderId!,
      orderNumber: post.orderNumber ?? "",
      articleNumber: post.articleNumber,
      articleName: post.articleName,
      quantity: post.quantity,
      preTvkPerUnit,
      postTvkPerUnit,
      deltaPerUnit,
      deltaPct: preTvkPerUnit !== 0 ? Math.round((deltaPerUnit / preTvkPerUnit) * 1000) / 10 : null,
      preMultiLevel: pre.multiLevel,
      preCalculatedAt: pre.calculatedAt,
      postCalculatedAt: post.calculatedAt,
    });
  }

  rows.sort((a, b) => (a.postCalculatedAt < b.postCalculatedAt ? 1 : a.postCalculatedAt > b.postCalculatedAt ? -1 : 0));

  const withPct = rows.filter((r) => r.deltaPct !== null);
  return {
    rows,
    summary: {
      count: rows.length,
      avgDeviationPct:
        withPct.length > 0
          ? Math.round((withPct.reduce((sum, r) => sum + r.deltaPct!, 0) / withPct.length) * 10) / 10
          : null,
    },
    notComparable,
  };
}
