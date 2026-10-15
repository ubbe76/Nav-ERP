// F1: pre- vs post-calculation outcome — pure pairing calc, no database.
// The repository feeds every MO-linked cost calculation; this module pairs
// each MO's LATEST pre with its LATEST post, compares per-unit TVK (each
// calculation's own quantity — pre and post lot sizes can differ) and
// filters on the post calculation's month.

export interface CalcRowInput {
  manufacturingOrderId: string;
  orderNumber: string;
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
  notComparable: { onlyPre: number; onlyPost: number; invalidQuantity: number };
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
  const byOrder = new Map<string, { pre?: CalcRowInput; post?: CalcRowInput }>();
  for (const calc of calcs) {
    const entry = byOrder.get(calc.manufacturingOrderId) ?? {};
    const current = entry[calc.type];
    if (!current || calc.calculatedAt > current.calculatedAt) entry[calc.type] = calc;
    byOrder.set(calc.manufacturingOrderId, entry);
  }

  const inRange = (isoTimestamp: string) => {
    const month = stockholmDate.format(new Date(isoTimestamp)).slice(0, 7);
    return month >= range.from && month <= range.to;
  };

  const rows: OutcomeRow[] = [];
  // All counters are period-scoped (on the calculation's own month) so the
  // footer reconciles with the filtered table instead of showing all-time
  // numbers under a period view.
  const notComparable = { onlyPre: 0, onlyPost: 0, invalidQuantity: 0 };
  for (const entry of byOrder.values()) {
    if (!entry.pre && entry.post) {
      if (inRange(entry.post.calculatedAt)) notComparable.onlyPost += 1;
      continue;
    }
    if (entry.pre && !entry.post) {
      if (inRange(entry.pre.calculatedAt)) notComparable.onlyPre += 1;
      continue;
    }
    const pre = entry.pre!;
    const post = entry.post!;

    if (!inRange(post.calculatedAt)) continue;

    if (pre.quantity <= 0 || post.quantity <= 0) {
      notComparable.invalidQuantity += 1;
      continue;
    }

    const preTvkPerUnit = tvk(pre) / pre.quantity;
    const postTvkPerUnit = tvk(post) / post.quantity;
    const deltaPerUnit = postTvkPerUnit - preTvkPerUnit;
    rows.push({
      manufacturingOrderId: post.manufacturingOrderId,
      orderNumber: post.orderNumber,
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
