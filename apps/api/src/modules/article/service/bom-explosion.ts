import { eq } from "drizzle-orm";
import { articles, bomComponents, type Db, type Tx } from "@navet/db";

export interface ExplodedComponent {
  componentArticleId: string;
  componentName: string;
  standardCost: string | null;
  totalQuantity: number;
  // The routing operation that consumes this component, if the BOM row (or
  // the phantom row it came through) links to one.
  routingOperationId: string | null;
  // Display unit from the BOM row (null = the component's base unit).
  // totalQuantity is always in the base unit; merged branches that disagree
  // on the unit fall back to base display.
  unitId: string | null;
  unitFactor: string | null;
}

// Walks parentArticleId's BOM recursively; any isPhantom component is skipped
// past into ITS OWN components (multiplying quantities down the chain)
// instead of being emitted as a material line itself — a phantom is never
// stocked/costed on its own, per CLAUDE.md's fantomartikel requirement.
//
// Leaf components reached via multiple branches (e.g. the same phantom used
// twice in a structure) are merged by summing totalQuantity. `path` tracks
// only the current branch (not everything ever visited), so legitimate
// diamond-shaped reuse isn't mistaken for a cycle. True cycles can't exist
// today — article.service.ts's isDescendant check runs on every
// addBomComponent call, phantom or not — but this throws rather than
// recursing forever if that invariant is ever violated.
export async function explodeBom(db: Db | Tx, parentArticleId: string, quantity: number): Promise<ExplodedComponent[]> {
  const merged = new Map<string, ExplodedComponent>();

  async function walk(
    articleId: string,
    multiplier: number,
    path: Set<string>,
    inheritedOperationId: string | null
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
        name: articles.name,
        standardCost: articles.standardCost,
        isPhantom: articles.isPhantom,
      })
      .from(bomComponents)
      .innerJoin(articles, eq(articles.id, bomComponents.componentArticleId))
      .where(eq(bomComponents.parentArticleId, articleId));

    for (const row of rows) {
      const rowMultiplier = multiplier * Number(row.quantity);
      // A component's own link wins; otherwise it inherits the phantom row's
      // link, since a phantom's parts are consumed where the phantom was.
      const operationId = row.routingOperationId ?? inheritedOperationId;

      if (row.isPhantom) {
        await walk(row.componentArticleId, rowMultiplier, nextPath, operationId);
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
      } else {
        merged.set(key, {
          componentArticleId: row.componentArticleId,
          componentName: row.name,
          standardCost: row.standardCost,
          routingOperationId: operationId,
          totalQuantity: rowMultiplier,
          unitId: row.unitId,
          unitFactor: row.unitFactor,
        });
      }
    }
  }

  await walk(parentArticleId, quantity, new Set(), null);
  return [...merged.values()];
}
