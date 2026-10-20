import type { CostingMaterialSource, CostingSupplierPriceTier } from "@navet/shared";
import type { MaterialRowWrite } from "../repository/costing.repository.js";
import { applyMarkups, type CostingMarkups } from "./markup.js";
import {
  buildMaterialRow,
  buildOperationRows,
  buildSemiFinishedRow,
  directCosts,
  type CostBasis,
  type RoutingRow,
} from "./level-costing.js";

// Flernivåkalkyl — costing a manufactured sub-assembly (halvfabrikat) from its
// OWN structure and routing instead of from its manually maintained standard
// cost. Opt-in per run: with the flag off, nothing here executes and the
// calculation is byte-identical to what it has always produced.
//
// What travels up to the parent is the sub-level's TILLVERKNINGSKOSTNAD (TVK),
// not its självkostnad: MO/LO belong to the level that incurred them, while
// Affo and the general markup are company-wide and must land exactly once, on
// the finished article. The parent therefore books the figure into its own TVK
// through a "semi" row that carries no markup of its own (see markup.ts).
//
// TO is the exception: it is outside TVK altogether (added to the sales price
// last, markup.ts), so the sub-level's TO travels up SEPARATELY, on the semi
// row's overheadAmount, and lands in the parent's TO bucket — recursively, so
// the finished article's TO is the sum of every level's TO. Nothing is lost
// and nothing is marked up on the way.

// One BOM level, as the article module's explodeBom returns it (phantoms
// already dissolved).
export interface ExplodedRow {
  componentArticleId: string;
  componentName: string;
  totalQuantity: number;
  unitId: string | null;
  unitFactor: string | null;
}

// The narrow slice of the repository the recursion needs. An interface rather
// than the repository itself so the whole thing can be exercised with stubs.
export interface SubAssemblyPort {
  explodeBom(articleId: string, quantity: number): Promise<ExplodedRow[]>;
  getComponentCostBasis(articleIds: string[]): Promise<(CostBasis & { id: string })[]>;
  getRoutingWithWorkCenters(articleId: string): Promise<RoutingRow[]>;
}

// A structure nested deeper than this is a data error, not a product. The cap
// is a termination proof that does not depend on the cycle guard being right:
// even if an ancestor set were ever bypassed, the recursion still ends.
const MAX_DEPTH = 10;

export interface LevelResult {
  materialRows: MaterialRowWrite[];
  operationRows: ReturnType<typeof buildOperationRows>;
  warnings: string[];
}

interface Context {
  port: SubAssemblyPort;
  source: CostingMaterialSource;
  supplierPriceTier: CostingSupplierPriceTier;
  markups: CostingMarkups;
  // Memoised on article AND quantity: TVK per unit is not linear in the
  // quantity, because setup time is charged once per batch. Keying on the
  // article alone would hand a 10-off price to a 1000-off branch.
  memo: Map<string, SubAssemblyCost | null>;
}

// What a costed sub-assembly hands up: its TVK (into the parent's semi row)
// and its TO (into the parent's TO bucket), both for the cascade quantity.
interface SubAssemblyCost {
  manufacturingCost: number;
  overhead: number;
}

// Whether a component should be resolved into its own calculation rather than
// priced from its standard cost. A manufactured article with neither a
// structure nor a routing has nothing to compute from — pricing it at 0 would
// be worse than the standard cost it already has.
function isCostableSubAssembly(basis: CostBasis | undefined): boolean {
  return basis?.type === "manufactured" && (basis.hasBom === true || basis.hasRouting === true);
}

// The sub-assembly's total manufacturing cost and TO for `quantity` units, or
// null when it could not be computed and the caller should fall back to the
// standard cost. Warnings are appended to the caller's list so every fallback
// is visible in the calculation, exactly like resolveUnitCost's own.
async function manufacturingCostOf(
  articleId: string,
  articleName: string,
  quantity: number,
  ctx: Context,
  ancestors: Set<string>,
  depth: number,
  warnings: string[]
): Promise<SubAssemblyCost | null> {
  if (ancestors.has(articleId)) {
    // Guarded at BOM edit time by isDescendant, and again by the CSV import's
    // own cycle check — but a structure that slipped past both must degrade to
    // today's behaviour, not 500 the article card's Kalkyl tab. explodeBom
    // throws in the same situation; here the calculation is decision support,
    // so an honest standard price beats an error page.
    warnings.push(`${articleName}: cyklisk struktur, använder standardpris`);
    return null;
  }
  if (depth >= MAX_DEPTH) {
    warnings.push(`${articleName}: strukturen är djupare än ${MAX_DEPTH} nivåer, använder standardpris`);
    return null;
  }

  const key = `${articleId}|${quantity}`;
  const memoised = ctx.memo.get(key);
  if (memoised !== undefined) return memoised;

  const level = await costLevel(articleId, quantity, ctx, new Set(ancestors).add(articleId), depth + 1);
  warnings.push(...level.warnings);

  const costs = applyMarkups(directCosts(level.materialRows, level.operationRows), ctx.markups);
  // TVK, not SVK — and TO alongside it, not inside it. See the file header.
  // costs.overhead already includes what THIS level's own sub-assemblies
  // lifted up (directCosts adds the semi rows' overheadAmount), so the
  // recursion carries every level's TO to the top.
  const total: SubAssemblyCost = { manufacturingCost: costs.manufacturingCost, overhead: costs.overhead };
  ctx.memo.set(key, total);
  return total;
}

// Costs one level: its components (recursing into manufactured sub-assemblies)
// and its routing. Shared by the top level and every level below it, so the
// rules cannot drift between them.
export async function costLevel(
  articleId: string,
  quantity: number,
  ctx: Context,
  ancestors: Set<string>,
  depth: number
): Promise<LevelResult> {
  const warnings: string[] = [];

  const components = await ctx.port.explodeBom(articleId, quantity);
  const basisById = new Map(
    (await ctx.port.getComponentCostBasis(components.map((c) => c.componentArticleId))).map((b) => [b.id, b])
  );

  const materialRows: MaterialRowWrite[] = [];
  for (const c of components) {
    const component = {
      componentArticleId: c.componentArticleId,
      quantity: c.totalQuantity,
      unitId: c.unitId,
      unitFactor: c.unitFactor,
    };
    const basis = basisById.get(c.componentArticleId);

    if (isCostableSubAssembly(basis)) {
      // The cascade quantity: this level needs c.totalQuantity of the
      // sub-assembly, so that is what its setup time is amortised over. It
      // also keeps the row's amount equal to the sub-calculation's own TVK,
      // so the parent's bucket always agrees with the calculation behind it.
      const total = await manufacturingCostOf(
        c.componentArticleId,
        c.componentName,
        c.totalQuantity,
        ctx,
        ancestors,
        depth,
        warnings
      );
      if (total !== null) {
        materialRows.push(buildSemiFinishedRow(component, total.manufacturingCost, total.overhead));
        continue;
      }
      // Fell back: priced from the standard cost, kind "material", and so it
      // carries MO exactly as it did before multi-level existed.
    } else if (basis?.type === "manufactured") {
      warnings.push(`${c.componentName}: saknar struktur och rutt, använder standardpris`);
    }

    const { row, warning } = buildMaterialRow(component, basis, ctx.source, ctx.supplierPriceTier);
    if (warning) warnings.push(`${c.componentName}: ${warning}`);
    materialRows.push(row);
  }

  const operations = await ctx.port.getRoutingWithWorkCenters(articleId);
  const operationRows = buildOperationRows(operations, quantity, warnings);

  return { materialRows, operationRows, warnings };
}

// Entry point for the top level of a multi-level pre-calculation.
export async function costMultiLevel(
  port: SubAssemblyPort,
  articleId: string,
  quantity: number,
  source: CostingMaterialSource,
  markups: CostingMarkups,
  supplierPriceTier: CostingSupplierPriceTier = "base"
): Promise<LevelResult> {
  return costLevel(
    articleId,
    quantity,
    { port, source, supplierPriceTier, markups, memo: new Map() },
    new Set([articleId]),
    0
  );
}
