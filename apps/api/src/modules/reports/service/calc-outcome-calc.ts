// Kalkylutfall — pure, no database. Two views over the same calculations:
// every TO's LATEST efterkalkyl whose Stockholm month is in the period (the
// repository picks them with one DISTINCT ON subquery, so a TO counts in the
// period of its facit and in no other).
//
// Mot förkalkyl (`pre`): the efterkalkyl's TVK/st against the förkalkyl in
// force. A förkalkyl is always saved on the ARTICLE (Kalkyl tab: article +
// quantity, manufacturing_order_id null) — nothing ever saves one on a
// manufacturing order — so the pair for one TO is the article's latest
// förkalkyl saved AT OR BEFORE the efterkalkyl: the estimate in force when
// the order was costed, not one written afterwards with hindsight. A
// beställningsvara's TO is measured against its own configuration.cost
// instead (the template article's förkalkyl is not its estimate). TVK is
// compared per unit: the förkalkyl's own quantity on the one side, on the
// other N (Inlevererat) when the efterkalkyl has a final avvikelseanalys —
// a kortstängd order of 10 with 8 delivered carries its cost on 8 — and
// otherwise, as before 0187, the efterkalkyl's quantity.
//
// Avvikelseanalys (`analysis`): the saved analyses (cost-variance.ts,
// derived on read) summed per order, article or resource. Preliminary
// analyses and efterkalkyler saved before the analysis are left out and
// only counted.
import type { CalculationOutcomeGrouping, CostVarianceAnalysis, CostVarianceParts } from "@navet/shared";
import { manufacturingCost, type ManufacturingCostBuckets as Buckets } from "../../costing/service/cost-figures.js";
import { calculatedPerUnit } from "../../costing/service/cost-variance.js";
import { roundToDecimals } from "@navet/shared";

// One TO's latest efterkalkyl in the period.
export interface OutcomePostCalculation extends Buckets {
  calculationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  // The efterkalkyl's quantity — the order quantity.
  quantity: number;
  calculatedAt: string; // ISO timestamp
  // A beställningsvara's TO (manufacturing_orders.configuration): its
  // förkalkyl, TVK/st at creation (null = unknown). null = not configured.
  configurationCost: { manufacturingCostPerUnit: number | null; calculatedAt: string } | null;
  // The saved analysis; null = saved before 0187.
  analysis: CostVarianceAnalysis | null;
}

// An article-level förkalkyl (manufacturing_order_id null).
export interface OutcomePreCalculation extends Buckets {
  articleId: string;
  quantity: number;
  calculatedAt: string; // ISO timestamp
  // Whether it resolved sub-assemblies recursively. Such a förkalkyl carries
  // the sub-assembly's full manufacturing cost while the efterkalkyl carries
  // its receipt price, which reads as a deviation that is not one.
  multiLevel: boolean;
}

// ---------------------------------------------------------------------------
// Mot förkalkyl
// ---------------------------------------------------------------------------

export interface OutcomeRow {
  calculationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  // The efterkalkyl's quantity (the order quantity).
  quantity: number;
  // N = Inlevererat from the analysis; null on an efterkalkyl saved before it.
  outputQuantity: number | null;
  // true = Ej klar (the analysis is preliminary); null = saved before it.
  preliminary: boolean | null;
  // What Efterkalkyl TVK/st was divided by: "output" = N (a final analysis),
  // "quantity" = the efterkalkyl's quantity (preliminary, or no analysis).
  perUnitBasis: "output" | "quantity";
  // "configuration" = a beställningsvara's TO against configuration.cost.
  preSource: "article" | "configuration";
  preTvkPerUnit: number;
  // Kalkylerat TVK/st = the analysis's Kalkylerat ÷ N, on a final analysis
  // with N > 0; null otherwise. Förkalkyl → Kalkylerat → Utfall.
  calculatedTvkPerUnit: number | null;
  postTvkPerUnit: number;
  deltaPerUnit: number;
  deltaPct: number | null; // null when the förkalkyl's TVK/st is 0
  preCalculatedAt: string;
  postCalculatedAt: string;
  // The förkalkyl resolved sub-assemblies recursively — always on a
  // configuration (configuration.cost is the configurator's multi-level
  // previewStructure). A large deviation on such a row can be a difference
  // in method rather than in production.
  preMultiLevel: boolean;
}

export interface PreOutcomeResult {
  view: "pre";
  rows: OutcomeRow[]; // newest efterkalkyl first
  summary: { count: number; avgDeviationPct: number | null };
  // Period-scoped like the rows.
  // - onlyPost: no comparable förkalkyl — none saved on the article at or
  //   before the efterkalkyl, or a beställningsvara whose configuration cost
  //   is unknown. There is no "only pre": a förkalkyl belongs to the article.
  // - invalidQuantity: the förkalkyl's or the efterkalkyl's quantity ≤ 0.
  // - noOutput: a final analysis with N = 0 (closed at 0, or Makulerad) —
  //   there is no delivered unit to carry the cost.
  notComparable: { onlyPost: number; invalidQuantity: number; noOutput: number };
}

const newestFirst = (a: { postCalculatedAt: string }, b: { postCalculatedAt: string }) =>
  a.postCalculatedAt < b.postCalculatedAt ? 1 : a.postCalculatedAt > b.postCalculatedAt ? -1 : 0;

const finalAnalysis = (post: OutcomePostCalculation) =>
  post.analysis !== null && !post.analysis.preliminary ? post.analysis : null;

export function preCalculationOutcome(
  posts: OutcomePostCalculation[],
  pres: OutcomePreCalculation[]
): PreOutcomeResult {
  const presByArticle = new Map<string, OutcomePreCalculation[]>();
  for (const pre of pres) {
    const list = presByArticle.get(pre.articleId) ?? [];
    list.push(pre);
    presByArticle.set(pre.articleId, list);
  }

  // The article's latest förkalkyl saved at or before `at` (ISO strings
  // compare chronologically). Ties go to the later row in input order.
  const preInForceAt = (articleId: string, at: string) => {
    let found: OutcomePreCalculation | undefined;
    for (const pre of presByArticle.get(articleId) ?? []) {
      if (pre.calculatedAt > at) continue;
      if (!found || pre.calculatedAt >= found.calculatedAt) found = pre;
    }
    return found;
  };

  // The förkalkyl's TVK/st, or why there is none.
  const preFor = (post: OutcomePostCalculation) => {
    if (post.configurationCost) {
      const perUnit = post.configurationCost.manufacturingCostPerUnit;
      if (perUnit === null) return "onlyPost" as const;
      return { source: "configuration" as const, perUnit, calculatedAt: post.configurationCost.calculatedAt, multiLevel: true };
    }
    const pre = preInForceAt(post.articleId, post.calculatedAt);
    if (!pre) return "onlyPost" as const;
    if (pre.quantity <= 0) return "invalidQuantity" as const;
    return { source: "article" as const, perUnit: manufacturingCost(pre) / pre.quantity, calculatedAt: pre.calculatedAt, multiLevel: pre.multiLevel };
  };

  const rows: OutcomeRow[] = [];
  const notComparable = { onlyPost: 0, invalidQuantity: 0, noOutput: 0 };
  for (const post of posts) {
    const pre = preFor(post);
    if (typeof pre === "string") {
      notComparable[pre] += 1;
      continue;
    }
    const final = finalAnalysis(post);
    const perUnitBasis = final ? "output" : "quantity";
    const divisor = final ? final.outputQuantity : post.quantity;
    if (divisor <= 0) {
      notComparable[final ? "noOutput" : "invalidQuantity"] += 1;
      continue;
    }

    const postTvkPerUnit = manufacturingCost(post) / divisor;
    const deltaPerUnit = postTvkPerUnit - pre.perUnit;
    rows.push({
      calculationId: post.calculationId,
      manufacturingOrderId: post.manufacturingOrderId,
      orderNumber: post.orderNumber,
      articleNumber: post.articleNumber,
      articleName: post.articleName,
      quantity: post.quantity,
      outputQuantity: post.analysis?.outputQuantity ?? null,
      preliminary: post.analysis?.preliminary ?? null,
      perUnitBasis,
      preSource: pre.source,
      preTvkPerUnit: pre.perUnit,
      // Null unless the analysis is final; the divisor is > 0 here (above).
      calculatedTvkPerUnit: calculatedPerUnit(post.analysis),
      postTvkPerUnit,
      deltaPerUnit,
      deltaPct: pre.perUnit !== 0 ? roundToDecimals((deltaPerUnit / pre.perUnit) * 100, 1) : null,
      preMultiLevel: pre.multiLevel,
      preCalculatedAt: pre.calculatedAt,
      postCalculatedAt: post.calculatedAt,
    });
  }

  rows.sort(newestFirst);

  const withPct = rows.filter((r) => r.deltaPct !== null);
  return {
    view: "pre",
    rows,
    summary: {
      count: rows.length,
      avgDeviationPct:
        withPct.length > 0
          ? roundToDecimals(withPct.reduce((sum, r) => sum + r.deltaPct!, 0) / withPct.length, 1)
          : null,
    },
    notComparable,
  };
}

// ---------------------------------------------------------------------------
// Avvikelseanalys
// ---------------------------------------------------------------------------

// Money summed in whole öre (the analysis's amounts are already öre), so the
// groups and totals add up exactly like the analysis itself.
interface Money {
  base: number;
  actual: number;
  parts: { [K in keyof CostVarianceParts]: number };
}

const toOre = (kronor: number) => Math.round(kronor * 100);

function emptyMoney(): Money {
  return { base: 0, actual: 0, parts: { price: 0, quantity: 0, scrap: 0, rate: 0, setup: 0, run: 0, unclassified: 0, markups: 0 } };
}

function addMoney(into: Money, from: { base: number; actual: number; parts: CostVarianceParts }) {
  into.base += toOre(from.base);
  into.actual += toOre(from.actual);
  for (const key of Object.keys(into.parts) as (keyof CostVarianceParts)[]) into.parts[key] += toOre(from.parts[key]);
}

export interface OutcomeAmounts {
  base: number;
  actual: number;
  deviation: number;
  // Avvikelse ÷ Kalkylerat in %, one decimal; null when Kalkylerat is 0.
  deviationPct: number | null;
  // Pris, Mängd (varav kassation = scrap, not summed), Timpris, Ställ,
  // Stycke, Ej uppdelad, Påslag: the parts add up to `deviation` exactly.
  parts: CostVarianceParts;
}

function amounts(money: Money): OutcomeAmounts {
  const deviation = money.actual - money.base;
  const parts = Object.fromEntries(Object.entries(money.parts).map(([key, value]) => [key, value / 100])) as unknown as CostVarianceParts;
  return {
    base: money.base / 100,
    actual: money.actual / 100,
    deviation: deviation / 100,
    deviationPct: money.base !== 0 ? roundToDecimals((deviation / money.base) * 100, 1) : null,
    parts,
  };
}

export interface AnalysisOrderRow extends OutcomeAmounts {
  calculationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  calculatedAt: string;
  // N = Inlevererat.
  outputQuantity: number;
}

export interface AnalysisArticleRow extends OutcomeAmounts {
  articleId: string;
  articleNumber: string;
  articleName: string;
  // Antal TO.
  orderCount: number;
  // Σ N over the article's orders.
  outputQuantity: number;
}

// One resource (and kind: a resource that changed type between two orders
// gives one row per kind). Only the operation rows of the analyses: material
// and Påslag have no resource.
export interface AnalysisWorkCenterRow extends OutcomeAmounts {
  key: string; // `${workCenterId}:${kind}`
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  kind: "time" | "subcontract";
  operationCount: number;
  orderCount: number;
  // Time resources (null on lego): Planerad ställ/stycke, Verklig ställ/
  // stycke (null while no operation has its time registered as ställ/
  // produktion — etapp 3), Ej uppdelad (h) and all reported hours.
  baseSetupHours: number | null;
  baseRunHours: number | null;
  setupHours: number | null;
  runHours: number | null;
  unclassifiedHours: number | null;
  hours: number | null;
  // Tidsavvikelse (kr) = Timpris + Ställ + Stycke + Ej uppdelad (= deviation
  // on a time row); null on lego.
  timeDeviation: number | null;
  // Lego resources (null on time): Kalkylerat antal (Σ N) and the received
  // quantity the cost was taken for.
  baseQuantity: number | null;
  subcontractQuantity: number | null;
}

export type AnalysisRow = AnalysisOrderRow | AnalysisArticleRow | AnalysisWorkCenterRow;

export interface AnalysisOutcomeResult {
  view: "analysis";
  groupBy: CalculationOutcomeGrouping;
  // order: newest efterkalkyl first; article: article number; workCenter:
  // resource code, time before lego.
  rows: AnalysisRow[];
  // The table's sums (on workCenter only the operations).
  totals: OutcomeAmounts;
  // The KPI tiles, over every analysed order whatever the grouping:
  // Avvikelse = Pris + Mängd + Tid + Påslag, exactly; Tid = Timpris + Ställ +
  // Stycke + Ej uppdelad; varav kassation is part of Mängd.
  kpis: { base: number; actual: number; deviation: number; deviationPct: number | null; price: number; quantity: number; scrap: number; time: number; markups: number };
  // analysed: the orders in the sums; preliminary (Ej klar) and
  // withoutAnalysis (efterkalkyl saved before 0187) are outside them.
  counts: { analysed: number; preliminary: number; withoutAnalysis: number };
}

// Hours summed in integer units of their scale (4 decimals for reported
// hours, 8 for the planned hours), so a sum shows no binary tail.
function sumScaled(values: number[], scale: number): number {
  const factor = 10 ** scale;
  return values.reduce((t, v) => t + Math.round(v * factor), 0) / factor;
}

const collator = new Intl.Collator("sv", { numeric: true });

export function analysisOutcome(posts: OutcomePostCalculation[], groupBy: CalculationOutcomeGrouping): AnalysisOutcomeResult {
  const counts = { analysed: 0, preliminary: 0, withoutAnalysis: 0 };
  const analysed: (OutcomePostCalculation & { analysis: CostVarianceAnalysis })[] = [];
  for (const post of posts) {
    if (post.analysis === null) counts.withoutAnalysis += 1;
    else if (post.analysis.preliminary) counts.preliminary += 1;
    else analysed.push(post as OutcomePostCalculation & { analysis: CostVarianceAnalysis });
  }
  counts.analysed = analysed.length;

  const all = emptyMoney();
  for (const post of analysed) addMoney(all, post.analysis);
  const allAmounts = amounts(all);
  const p = all.parts;
  const kpis = {
    base: allAmounts.base,
    actual: allAmounts.actual,
    deviation: allAmounts.deviation,
    deviationPct: allAmounts.deviationPct,
    price: p.price / 100,
    quantity: p.quantity / 100,
    scrap: p.scrap / 100,
    time: (p.rate + p.setup + p.run + p.unclassified) / 100,
    markups: p.markups / 100,
  };

  const result = (rows: AnalysisRow[], totals: OutcomeAmounts): AnalysisOutcomeResult => ({
    view: "analysis",
    groupBy,
    rows,
    totals,
    kpis,
    counts,
  });

  if (groupBy === "order") {
    const rows: AnalysisOrderRow[] = analysed
      .map((post) => {
        const money = emptyMoney();
        addMoney(money, post.analysis);
        return {
          calculationId: post.calculationId,
          manufacturingOrderId: post.manufacturingOrderId,
          orderNumber: post.orderNumber,
          articleId: post.articleId,
          articleNumber: post.articleNumber,
          articleName: post.articleName,
          calculatedAt: post.calculatedAt,
          outputQuantity: post.analysis.outputQuantity,
          ...amounts(money),
        };
      })
      .sort((a, b) => newestFirst({ postCalculatedAt: a.calculatedAt }, { postCalculatedAt: b.calculatedAt }));
    return result(rows, allAmounts);
  }

  if (groupBy === "article") {
    const groups = new Map<string, { post: OutcomePostCalculation; money: Money; orderCount: number; output: number[] }>();
    for (const post of analysed) {
      const group = groups.get(post.articleId) ?? { post, money: emptyMoney(), orderCount: 0, output: [] };
      addMoney(group.money, post.analysis);
      group.orderCount += 1;
      group.output.push(post.analysis.outputQuantity);
      groups.set(post.articleId, group);
    }
    const rows: AnalysisArticleRow[] = [...groups.values()]
      .map((g) => ({
        articleId: g.post.articleId,
        articleNumber: g.post.articleNumber,
        articleName: g.post.articleName,
        orderCount: g.orderCount,
        outputQuantity: sumScaled(g.output, 4),
        ...amounts(g.money),
      }))
      .sort((a, b) => collator.compare(a.articleNumber, b.articleNumber));
    return result(rows, allAmounts);
  }

  // workCenter: the operation rows only.
  interface WorkCenterGroup {
    row: { workCenterId: string; workCenterCode: string; workCenterName: string; kind: "time" | "subcontract" };
    money: Money;
    orders: Set<string>;
    operationCount: number;
    baseSetup: number[];
    baseRun: number[];
    setup: number[];
    run: number[];
    split: boolean;
    unclassified: number[];
    hours: number[];
    baseQuantity: number[];
    subcontractQuantity: number[];
  }
  const groups = new Map<string, WorkCenterGroup>();
  const operationsMoney = emptyMoney();
  for (const post of analysed) {
    for (const op of post.analysis.operationRows) {
      const key = `${op.workCenterId}:${op.kind}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          row: { workCenterId: op.workCenterId, workCenterCode: op.workCenterCode, workCenterName: op.workCenterName, kind: op.kind },
          money: emptyMoney(),
          orders: new Set(),
          operationCount: 0,
          baseSetup: [],
          baseRun: [],
          setup: [],
          run: [],
          split: false,
          unclassified: [],
          hours: [],
          baseQuantity: [],
          subcontractQuantity: [],
        };
        groups.set(key, group);
      }
      addMoney(group.money, op);
      addMoney(operationsMoney, op);
      group.orders.add(post.manufacturingOrderId);
      group.operationCount += 1;
      if (op.kind === "time") {
        group.baseSetup.push(op.baseSetupHours ?? 0);
        group.baseRun.push(op.baseRunHours ?? 0);
        // Hours reconcile with the kronor: a split operation's hours are
        // Verklig ställ/stycke, a half-typed (or untyped) one's are all Ej
        // uppdelad (h) — its unclassifiedHours is H, as its deviation is all
        // Ej uppdelad — so it adds nothing to Verklig ställ/stycke.
        const split = op.split && (op.setupHours !== null || op.runHours !== null);
        if (split) group.split = true;
        group.setup.push(split ? (op.setupHours ?? 0) : 0);
        group.run.push(split ? (op.runHours ?? 0) : 0);
        group.unclassified.push(op.unclassifiedHours);
        group.hours.push(op.hours);
      } else {
        group.baseQuantity.push(op.baseQuantity ?? 0);
        group.subcontractQuantity.push(op.subcontractQuantity ?? 0);
      }
    }
  }
  const rows: AnalysisWorkCenterRow[] = [...groups.entries()]
    .map(([key, g]) => {
      const time = g.row.kind === "time";
      const { rate, setup, run, unclassified } = g.money.parts;
      return {
        key,
        ...g.row,
        operationCount: g.operationCount,
        orderCount: g.orders.size,
        baseSetupHours: time ? sumScaled(g.baseSetup, 8) : null,
        baseRunHours: time ? sumScaled(g.baseRun, 8) : null,
        setupHours: time && g.split ? sumScaled(g.setup, 4) : null,
        runHours: time && g.split ? sumScaled(g.run, 4) : null,
        unclassifiedHours: time ? sumScaled(g.unclassified, 4) : null,
        hours: time ? sumScaled(g.hours, 4) : null,
        timeDeviation: time ? (rate + setup + run + unclassified) / 100 : null,
        baseQuantity: time ? null : sumScaled(g.baseQuantity, 4),
        subcontractQuantity: time ? null : sumScaled(g.subcontractQuantity, 4),
        ...amounts(g.money),
      };
    })
    .sort((a, b) => collator.compare(a.workCenterCode, b.workCenterCode) || (a.kind === b.kind ? 0 : a.kind === "time" ? -1 : 1));
  return result(rows, amounts(operationsMoney));
}
