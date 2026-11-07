import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { articleGroups, articles, costCalculations, type Db, type Tx } from "@navet/db";

// Kalkylpris (#16 etapp 2) and täckningsbidrag read the SAME calculation: an
// article's latest saved förkalkyl. A leaf on `Db | Tx` so the price chain can
// read it through the caller's transaction (etapp 3 reprices the order's rows
// inside the header's transaction) — the costing repository's
// findLatestPreCalculationsByArticles (TB: the order card, the margin report,
// the Kalkyl tab) is this very query, so price and TB can never come from two
// different calculations.
//
// The selection: type "pre", newest calculated_at, id as the tiebreaker. A
// saved Pröva påslag is a förkalkyl like any other and may be the latest —
// the Kalkylpris is a delta against the calculation's own percentages, so it
// is right on a trial too (and TVK/SVK are identical by construction).
export async function latestPreCalculations(dbc: Db | Tx, articleIds: string[]) {
  if (articleIds.length === 0) return [];
  return dbc
    .selectDistinctOn([costCalculations.articleId], {
      articleId: costCalculations.articleId,
      id: costCalculations.id,
      quantity: costCalculations.quantity,
      calculatedAt: costCalculations.calculatedAt,
      materialCost: costCalculations.materialCost,
      materialOverhead: costCalculations.materialOverhead,
      laborCost: costCalculations.laborCost,
      overhead: costCalculations.overhead,
      subcontractCost: costCalculations.subcontractCost,
      subcontractOverhead: costCalculations.subcontractOverhead,
      semiFinishedCost: costCalculations.semiFinishedCost,
      businessOverhead: costCalculations.businessOverhead,
      // The Kalkylpris's inputs: F₀, g₀, m₀ and B (null on a multi-level
      // calculation saved before 0194 that 0195 could not backfill).
      salesPrice: costCalculations.salesPrice,
      generalMarkupPercent: costCalculations.generalMarkupPercent,
      materialMarkupPercent: costCalculations.materialMarkupPercent,
      materialMarkupBase: costCalculations.materialMarkupBase,
    })
    .from(costCalculations)
    .where(and(eq(costCalculations.type, "pre"), inArray(costCalculations.articleId, articleIds)))
    .orderBy(asc(costCalculations.articleId), desc(costCalculations.calculatedAt), desc(costCalculations.id));
}

export type LatestPreCalculation = Awaited<ReturnType<typeof latestPreCalculations>>[number];

// What one Kalkylpris needs from the database: the article's latest förkalkyl
// (null = none saved) and its varugrupp's two price markups (null = no group;
// a field null = the group inherits). The company's percentages come from the
// settings, read by the caller.
export async function readCalculatedPriceBasis(dbc: Db | Tx, articleId: string) {
  const [calculation] = await latestPreCalculations(dbc, [articleId]);
  const [group] = await dbc
    .select({
      generalMarkupPercent: articleGroups.generalMarkupPercent,
      materialMarkupPercent: articleGroups.materialMarkupPercent,
    })
    .from(articles)
    .innerJoin(articleGroups, eq(articleGroups.id, articles.groupId))
    .where(eq(articles.id, articleId));
  return { calculation: calculation ?? null, group: group ?? null };
}
