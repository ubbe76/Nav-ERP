// apps/api/src/modules/configurator/service/variant-structure.ts
import type { DerivedMaterialCore, DerivedOperationCore } from "./configurator-derive.js";

// Produktkonfigurator — lagerförda varianter: turns the derived structure of one configuration into the rows
// a variant article gets as its own BOM and route. Pure (no DB imports). `deriveStructure` never merges the
// same component from several rows (the test panel shows each source); a stored BOM is one row per component,
// so the materials are merged here: quantities summed in the base unit, the operation link kept when the rows
// agree and otherwise the lowest operation with a warning, the display unit kept only when every row has it.

export type VariantBomRow = {
  componentArticleId: string;
  quantity: number;
  unitId: string | null;
  unitFactor: string | null;
  operationSequenceNo: number | null; // mapped to the new routing row's id by the caller
};

const round4 = (n: number) => Number(n.toFixed(4));

export function mergeVariantMaterials(
  materials: DerivedMaterialCore[],
  componentLabel: (articleId: string) => string
): { rows: VariantBomRow[]; warnings: string[] } {
  const byComponent = new Map<string, DerivedMaterialCore[]>(); // insertion order = first occurrence
  for (const m of materials) {
    const list = byComponent.get(m.componentArticleId);
    if (list) list.push(m);
    else byComponent.set(m.componentArticleId, [m]);
  }

  const rows: VariantBomRow[] = [];
  const warnings: string[] = [];
  for (const [componentArticleId, group] of byComponent) {
    const first = group[0]!;
    const quantity = round4(group.reduce((sum, m) => sum + m.quantity, 0));

    const sequenceNos = group.map((m) => m.operation?.sequenceNo ?? null);
    let operationSequenceNo = sequenceNos[0]!;
    if (sequenceNos.some((n) => n !== operationSequenceNo)) {
      // Mixed links (including null against a number): the component is drawn in the lowest operation.
      const linked = sequenceNos.filter((n): n is number => n !== null);
      operationSequenceNo = Math.min(...linked);
      warnings.push(`Komponent ${componentLabel(componentArticleId)} kopplad till flera operationer — dras i operation ${operationSequenceNo}`);
    }

    const sameUnit = group.every((m) => m.unitId === first.unitId && m.unitFactor === first.unitFactor);
    rows.push({
      componentArticleId, quantity,
      unitId: sameUnit ? first.unitId : null,
      unitFactor: sameUnit ? first.unitFactor : null,
      operationSequenceNo,
    });
  }
  return { rows, warnings };
}

/** A full routing_operations row of the template, keyed by its id in `variantRoutingRows`. */
export type TemplateRoutingRow = { id: string } & Record<string, unknown>;

export type VariantRoutingRow = {
  sequenceNo: number;
  workCenterId: string;
  description: string | null;
  setupTime: number;
  runTimePerUnit: number;
  costingOnly: boolean;
  setupPrice: number | null;
  unitPrice: number | null;
  subcontractSupplierId: string | null;
  // Only for kind "base": the template's row, whose other columns (comment, timeUnit, printOnWorkCard,
  // packingInstructions, showNetWeight, useArticleDrawing, subcontractSupplierId) the insert copies verbatim.
  copyFrom: TemplateRoutingRow | null;
};

export function variantRoutingRows(
  operations: DerivedOperationCore[],
  templateRows: Map<string, TemplateRoutingRow>,
  workCenters: Map<string, { type: string; supplierId: string | null }>
): VariantRoutingRow[] {
  const rows = operations.map((op): VariantRoutingRow => {
    const common = {
      sequenceNo: op.sequenceNo, workCenterId: op.workCenterId, description: op.description,
      setupTime: op.setupTime, runTimePerUnit: op.runTimePerUnit, setupPrice: op.setupPrice, unitPrice: op.unitPrice,
    };
    if (op.kind === "base") {
      const copyFrom = templateRows.get(op.id);
      // The derived base operations come from the same routing_operations rows the map is built from, so a
      // miss is an internal inconsistency — better loud than a variant whose route silently lost its columns.
      if (!copyFrom) throw new Error(`Template routing operation ${op.id} (sequence ${op.sequenceNo}) is missing`);
      const supplier = copyFrom.subcontractSupplierId;
      return { ...common, costingOnly: op.costingOnly, subcontractSupplierId: typeof supplier === "string" ? supplier : null, copyFrom };
    }
    // Conditional operation: default columns, and on a subcontract resource the resource's supplier (Beredning's default).
    const wc = workCenters.get(op.workCenterId);
    return {
      ...common, costingOnly: false,
      subcontractSupplierId: wc?.type === "subcontract" ? wc.supplierId : null,
      copyFrom: null,
    };
  });
  return rows.sort((a, b) => a.sequenceNo - b.sequenceNo);
}
