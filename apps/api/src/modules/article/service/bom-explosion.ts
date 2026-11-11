import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { articles, bomComponents, type Db, type Tx } from "@navet/db";

export interface ExplodedComponent {
  componentArticleId: string;
  componentName: string;
  standardCost: string | null;
  totalQuantity: number;
  // The routing operation that consumes this component: the link of the
  // exploded article's own row it came through (a direct row, or the phantom
  // row a phantom's part came in by). See the link rule on explodeBom.
  routingOperationId: string | null;
  // Display unit from the BOM row (null = the component's base unit).
  // totalQuantity is always in the base unit; merged branches that disagree
  // on the unit fall back to base display.
  unitId: string | null;
  unitFactor: string | null;
  // "Kalkyl" — the line comes only from costing-only rows (or rows under a
  // costing-only phantom). Always false in "exclude" mode. A line merged from
  // a costing-only and an ordinary row is ordinary: the material IS drawn.
  costingOnly: boolean;
}

// Who is asking decides what a "Kalkyl" row (bom_components.costing_only) is:
//  - "include": the pre-calculation — such rows are priced like any other and
//    emitted with costingOnly: true (the subtree under a costing-only phantom
//    inherits the flag).
//  - "exclude": release / configured TO / anything that becomes stock
//    movement or demand — such rows are skipped, and a costing-only phantom
//    is not descended into (its whole subtree is costing-only).
// Required rather than defaulted so a new caller has to state its side.
export type CostingOnlyMode = "include" | "exclude";

// Walks parentArticleId's BOM recursively; any isPhantom component is skipped
// past into ITS OWN components (multiplying quantities down the chain)
// instead of being emitted as a material line itself — a phantom is never
// stocked/costed on its own, per CLAUDE.md's fantomartikel requirement.
//
// Leaf components reached via multiple branches (e.g. the same phantom used
// twice in a structure) are merged by summing totalQuantity. `path` tracks
// only the current branch (not everything ever visited), so legitimate
// diamond-shaped reuse isn't mistaken for a cycle. True cycles can't exist
// today — article.service.ts's cycle check runs on every addBomComponent
// call (under the structure lock), phantom or not — but this throws rather
// than recursing forever if that invariant is ever violated.
//
// The link rule (ONE rule for release, the förkalkyl, the configured TO and
// the configurator's/costing preview's phantom explosion): a row's
// routing_operation_id points at its PARENT's routing, so it only means
// something on the article whose TO (or calculation) this is. A phantom never
// gets a TO of its own, so a link on a phantom's rows — to the phantom's own
// operations, which never exist on the exploded article's TO — is ignored:
// the phantom's parts take the link of the phantom row they came in by. A
// phantom exploded as the root (the configurator and the costing preview
// dissolve a phantom material this way) therefore yields unlinked parts and
// the caller applies its phantom row's link. Without the rule the phantom's
// own link became an unknown operation at release, the line went unlinked,
// and the same component on an unlinked row hit mo_material_unique_per_operation
// (500).
export async function explodeBom(
  db: Db | Tx,
  parentArticleId: string,
  quantity: number,
  costingOnlyRows: CostingOnlyMode
): Promise<ExplodedComponent[]> {
  const merged = new Map<string, ExplodedComponent>();
  const parentArticles = alias(articles, "bom_parent");

  async function walk(
    articleId: string,
    multiplier: number,
    path: Set<string>,
    inheritedOperationId: string | null,
    inheritedCostingOnly: boolean
  ) {
    if (path.has(articleId)) {
      throw new Error(`Cyclic BOM detected at article ${articleId} — this should be impossible`);
    }
    const nextPath = new Set(path).add(articleId);

    const rows = await db
      .select({
        componentArticleId: bomComponents.componentArticleId,
        quantity: bomComponents.quantity,
        unitId: bomComponents.unitId,
        unitFactor: bomComponents.unitFactor,
        routingOperationId: bomComponents.routingOperationId,
        costingOnly: bomComponents.costingOnly,
        name: articles.name,
        standardCost: articles.standardCost,
        isPhantom: articles.isPhantom,
        parentIsPhantom: parentArticles.isPhantom,
      })
      .from(bomComponents)
      .innerJoin(articles, eq(articles.id, bomComponents.componentArticleId))
      .innerJoin(parentArticles, eq(parentArticles.id, bomComponents.parentArticleId))
      .where(eq(bomComponents.parentArticleId, articleId));

    for (const row of rows) {
      // A costing-only row — and everything under a costing-only phantom —
      // is the pre-calculation's business only.
      const costingOnly = inheritedCostingOnly || row.costingOnly;
      if (costingOnly && costingOnlyRows === "exclude") continue;

      const rowMultiplier = multiplier * Number(row.quantity);
      // The link rule (see above): a row's own link counts only when its
      // parent is not a phantom — i.e. on the exploded article's own rows.
      // Below a phantom (every level after the first, since only phantoms
      // are descended into) the phantom row's link is inherited, since a
      // phantom's parts are consumed where the phantom was.
      const operationId = row.parentIsPhantom ? inheritedOperationId : row.routingOperationId;

      if (row.isPhantom) {
        await walk(row.componentArticleId, rowMultiplier, nextPath, operationId, costingOnly);
        continue;
      }

      // Keyed by article *and* operation: the same article needed at two
      // operations becomes two material lines, each drawn at its own step.
      const key = `${row.componentArticleId}:${operationId ?? ""}`;
      const existing = merged.get(key);
      if (existing) {
        existing.totalQuantity += rowMultiplier;
        if (existing.unitId !== row.unitId) {
          existing.unitId = null;
          existing.unitFactor = null;
        }
        existing.costingOnly = existing.costingOnly && costingOnly;
      } else {
        merged.set(key, {
          componentArticleId: row.componentArticleId,
          componentName: row.name,
          standardCost: row.standardCost,
          routingOperationId: operationId,
          totalQuantity: rowMultiplier,
          unitId: row.unitId,
          unitFactor: row.unitFactor,
          costingOnly,
        });
      }
    }
  }

  await walk(parentArticleId, quantity, new Set(), null, false);
  return [...merged.values()];
}
