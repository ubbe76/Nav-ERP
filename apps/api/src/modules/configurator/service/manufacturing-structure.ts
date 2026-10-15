// apps/api/src/modules/configurator/service/manufacturing-structure.ts
import type { DerivedOperationCore } from "./configurator-derive.js";
import type { ExplodedDerivedMaterial } from "./configurator-explode.js";
import type { VariantRoutingRow } from "./variant-structure.js";

// Konfigurator 4c: the derived structure of one configuration as a TO's own
// rows — what manufacturing writes into mo_operations / mo_material_consumptions
// when a beställningsvara's TO is CREATED. Pure (no DB imports). The same
// rule as release: "Kalkyl" operations (costingOnly) are priced, never worked,
// so they never reach a TO. Template route rows keep their link
// (routingOperationId — the drawing is read live through it, as on any TO).

export type ManufacturingOperation = {
  sequenceNo: number; routingOperationId: string | null; workCenterId: string; description: string | null;
  setupTime: string; runTimePerUnit: string; timeUnit: "minutes_per_unit" | "units_per_hour";
  comment: string | null; printOnWorkCard: boolean; packingInstructions: string | null;
  subcontractSupplierId: string | null; setupPrice: string | null; unitPrice: string | null; showNetWeight: boolean;
};
export type ManufacturingMaterial = {
  componentArticleId: string; componentName: string; totalQuantity: number;
  operationSequenceNo: number | null; unitId: string | null; unitFactor: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: number | null): string | null => (v === null ? null : String(v));
const round4 = (n: number) => Number(n.toFixed(4));

export function manufacturingOperations(routing: VariantRoutingRow[]): ManufacturingOperation[] {
  return routing
    .filter((r) => !r.costingOnly)
    .map((r) => {
      const c = r.copyFrom;
      return {
        sequenceNo: r.sequenceNo,
        routingOperationId: c ? c.id : null,
        workCenterId: r.workCenterId,
        description: r.description,
        setupTime: String(r.setupTime),
        runTimePerUnit: String(r.runTimePerUnit),
        timeUnit: c?.timeUnit === "units_per_hour" ? "units_per_hour" : "minutes_per_unit",
        comment: str(c?.comment),
        printOnWorkCard: c?.printOnWorkCard === true,
        packingInstructions: str(c?.packingInstructions),
        subcontractSupplierId: r.subcontractSupplierId,
        setupPrice: num(r.setupPrice),
        unitPrice: num(r.unitPrice),
        showNetWeight: c?.showNetWeight === true,
      };
    });
}

// `operationId` on an exploded row is the DERIVED operation's id (template
// routing id or configurator operation id). A row whose operation is not one
// of the kept operations — a phantom part's link to the phantom's own route,
// or a costing-only operation — is unlinked and drawn at final reporting,
// exactly as release treats an unknown routing id today.
//
// The explosion merged per (article, DERIVED operation id); two rows of one
// article whose ids differ but both resolve to "unlinked" (or to the same
// kept operation) must become ONE row here, because mo_material_consumptions
// is unique per (TO, article, operation) with NULLS NOT DISTINCT. Same merge
// rule as explodeDerivedMaterials: quantities summed (4 decimals), the base
// unit when the display units differ, first-occurrence order kept.
export function linkMaterialsToOperations(
  exploded: ExplodedDerivedMaterial[], operations: DerivedOperationCore[], kept: Set<number>
): ManufacturingMaterial[] {
  const seqById = new Map(operations.map((o) => [o.id, o.sequenceNo]));
  const merged = new Map<string, ManufacturingMaterial>();
  for (const m of exploded) {
    const seq = m.operationId === null ? undefined : seqById.get(m.operationId);
    const operationSequenceNo = seq !== undefined && kept.has(seq) ? seq : null;
    const key = `${m.componentArticleId}:${operationSequenceNo ?? ""}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        componentArticleId: m.componentArticleId,
        componentName: m.componentName,
        totalQuantity: round4(m.totalQuantity),
        operationSequenceNo,
        unitId: m.unitId,
        unitFactor: m.unitFactor,
      });
      continue;
    }
    existing.totalQuantity = round4(existing.totalQuantity + m.totalQuantity);
    if (existing.unitId !== m.unitId || existing.unitFactor !== m.unitFactor) {
      existing.unitId = null;
      existing.unitFactor = null;
    }
  }
  return [...merged.values()];
}
