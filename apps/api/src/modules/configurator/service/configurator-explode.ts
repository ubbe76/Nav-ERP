// apps/api/src/modules/configurator/service/configurator-explode.ts
// Produktkonfigurator — the derived structure's material one level down, as the costing preview costs it.
// Pure (no DB imports; explodeBom is injected): a phantom (fantomartikel) is never costed itself but dissolved
// into its own components, and rows are merged per (article, operation) exactly like bom-explosion.ts — sum the
// quantities, base unit when the units differ. A phantom's parts inherit the phantom row's operation unless
// they carry their own. The derivation itself never merges (rule 7); only the costing view does.

export type ExplodeBomRow = {
  componentArticleId: string; componentName: string; totalQuantity: number; unitId: string | null; unitFactor: string | null;
  routingOperationId?: string | null;
};
export type ExplodeBom = (articleId: string, quantity: number) => Promise<ExplodeBomRow[]>;

// One derived material row with its total quantity (per-unit quantity × the level's quantity).
export type DerivedMaterialToExplode = {
  componentArticleId: string; componentName: string; totalQuantity: number; unitId: string | null; unitFactor: string | null;
  operationId: string | null; isPhantom: boolean;
};
export type ExplodedDerivedMaterial = {
  componentArticleId: string; componentName: string; totalQuantity: number; unitId: string | null; unitFactor: string | null;
  operationId: string | null;
};

export async function explodeDerivedMaterials(
  materials: DerivedMaterialToExplode[], explodeBom: ExplodeBom
): Promise<ExplodedDerivedMaterial[]> {
  const merged = new Map<string, ExplodedDerivedMaterial>();
  const add = (row: ExplodedDerivedMaterial) => {
    const key = `${row.componentArticleId}:${row.operationId ?? ""}`;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, row); return; }
    existing.totalQuantity += row.totalQuantity;
    if (existing.unitId !== row.unitId) { existing.unitId = null; existing.unitFactor = null; }
  };
  for (const m of materials) {
    if (m.isPhantom) {
      for (const e of await explodeBom(m.componentArticleId, m.totalQuantity)) {
        add({
          componentArticleId: e.componentArticleId, componentName: e.componentName, totalQuantity: e.totalQuantity,
          unitId: e.unitId, unitFactor: e.unitFactor, operationId: e.routingOperationId ?? m.operationId,
        });
      }
    } else {
      add({
        componentArticleId: m.componentArticleId, componentName: m.componentName, totalQuantity: m.totalQuantity,
        unitId: m.unitId, unitFactor: m.unitFactor, operationId: m.operationId,
      });
    }
  }
  return [...merged.values()];
}
