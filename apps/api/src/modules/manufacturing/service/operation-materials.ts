import { round4 } from "@navet/shared";

// The material linked to an MO operation (mo_material_consumptions.
// mo_operation_id) — pure, no DB imports. The ONE grouping the terminal's
// operation list and the planning views (körplan, dagplan) share: the
// terminal shows every linked row, the planning views add isCoRunMaterial.
export interface OperationMaterialRow {
  // mo_material_consumptions.id. Within ONE operation the article is unique
  // (mo_material_unique_per_operation), but an order can carry it on several
  // operations and unlinked — the row is what the pegging's demand is of.
  rowId: string;
  moOperationId: string | null;
  articleId: string;
  articleNumber: string;
  articleName: string;
  articleType: "manufactured" | "purchased" | "service";
  // The article's base unit (units.code) — the quantities are base-unit.
  unit: string | null;
  quantityPlanned: number;
  quantityConsumed: number;
}

export interface OperationMaterial {
  rowId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  articleType: OperationMaterialRow["articleType"];
  unit: string | null;
  // Planned − consumed, never below 0 (an over-draw leaves nothing).
  remainingQuantity: number;
}

// Natural number order, the same collation as the web's material sort
// (lib/terminalOperations.ts) — so a row's first material IS its sort key
// there, and a picker lists 2 before 10.
export function compareArticleNumbers(a: { articleNumber: string }, b: { articleNumber: string }): number {
  return a.articleNumber.localeCompare(b.articleNumber, "sv", { numeric: true });
}

// Every LINKED material per operation, sorted by article number — one entry
// per material row. Unlinked rows (moOperationId null) are skipped.
export function linkedOperationMaterials(rows: OperationMaterialRow[]): Map<string, OperationMaterial[]> {
  const byOperation = new Map<string, OperationMaterial[]>();
  for (const row of rows) {
    if (!row.moOperationId) continue;
    const materials = byOperation.get(row.moOperationId) ?? [];
    materials.push({
      rowId: row.rowId,
      articleId: row.articleId,
      articleNumber: row.articleNumber,
      articleName: row.articleName,
      articleType: row.articleType,
      unit: row.unit,
      remainingQuantity: round4(Math.max(row.quantityPlanned - row.quantityConsumed, 0)),
    });
    byOperation.set(row.moOperationId, materials);
  }
  for (const materials of byOperation.values()) materials.sort(compareArticleNumbers);
  return byOperation;
}

// Samma ingående material (B3): a purchased article with something left to
// draw. A halvfabrikat, a service or a fully drawn row is never co-run
// material.
export function isCoRunMaterial(material: OperationMaterial): boolean {
  return material.articleType === "purchased" && material.remainingQuantity > 0;
}
