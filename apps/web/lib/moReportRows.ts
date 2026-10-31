// Grouping rule for the TO card's Rapportera panel: one group per operation
// (sorted by sequenceNo) with the material rows linked to it, plus the
// material that is drawn at final reporting. Pure — no React, no fetch.

export interface ReportRowOperation {
  id: string;
  sequenceNo: number;
}

export interface ReportRowMaterial {
  moOperationId: string | null;
}

export interface OperationReportGroup<O extends ReportRowOperation, M extends ReportRowMaterial> {
  operation: O;
  materials: M[];
}

export interface MoReportRows<O extends ReportRowOperation, M extends ReportRowMaterial> {
  groups: OperationReportGroup<O, M>[];
  // moOperationId null, or pointing at an operation that is not in the list.
  unlinked: M[];
}

export function groupReportRows<O extends ReportRowOperation, M extends ReportRowMaterial>(
  operations: O[],
  materials: M[]
): MoReportRows<O, M> {
  const groups = [...operations]
    .sort((a, b) => a.sequenceNo - b.sequenceNo)
    .map((operation) => ({ operation, materials: [] as M[] }));
  const byId = new Map(groups.map((g) => [g.operation.id, g]));
  const unlinked: M[] = [];
  for (const material of materials) {
    const group = material.moOperationId ? byId.get(material.moOperationId) : undefined;
    if (group) group.materials.push(material);
    else unlinked.push(material);
  }
  return { groups, unlinked };
}

// Every place an operation is named on the TO card. Beskrivning is what the
// step IS; the resource name is the fallback so the label is never blank.
export function moOperationLabel(op: { sequenceNo: number; description: string | null; workCenterName: string }) {
  return `${op.sequenceNo} — ${op.description ?? op.workCenterName}`;
}
