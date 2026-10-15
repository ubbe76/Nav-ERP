// apps/api/src/modules/configurator/service/configurator-derive.ts
import type {
  ConfiguratorCondition, ConfiguratorEvaluation, DerivedMaterial, DerivedOperation, DerivedOperationRef,
} from "@navet/shared";
import { conditionHolds, type EffectiveValue, type EngineGroup, type EngineTemplate } from "./configurator-engine.js";
import { evaluateFormula, type FormulaValues } from "./configurator-formula.js";
import { findCoverageGaps, selectionCoverageWarnings } from "./structure-coverage.js";

// Produktkonfigurator — derivation of structure (BOM) and route for ONE finished product of a configuration.
// Pure (no DB imports): the single source the test panel, the costing preview and later variants/MOs use.
// The template's ordinary structure/route (bom_components/routing_operations) follow unchanged; conditional
// structure lines and operations are added when all their conditions hold, judged on the engine's effective
// values after pass A exactly like rules. Same component from several rows is never merged.

export type BaseBomRow = {
  id: string; // bom_components.id
  componentArticleId: string; quantity: number; unitId: string | null; unitFactor: string | null; routingOperationId: string | null;
};
export type BaseOperation = {
  id: string; sequenceNo: number; workCenterId: string; description: string | null; setupTime: number; runTimePerUnit: number;
  setupPrice: number | null; unitPrice: number | null; // lego pricing, null = unpriced
  costingOnly: boolean; // "Bara kalkyl": costed, but never an MO operation (delprojekt 4 skips it)
};
export type DeriveBomLine = {
  id: string; sortOrder: number; conditions: ConfiguratorCondition[]; source: "article" | "group";
  componentArticleId: string | null; componentGroupId: string | null; quantity: number | null; quantityFormula: string | null;
  routingOperationId: string | null; configuratorOperationId: string | null;
  label: string; // "Strukturrad N (komponentnamn)" — prefix of this line's messages
};
export type DeriveOperation = {
  id: string; sequenceNo: number; conditions: ConfiguratorCondition[]; workCenterId: string; description: string | null;
  setupTime: number | null; setupFormula: string | null; runTimePerUnit: number | null; runFormula: string | null;
  setupPrice: number | null; unitPrice: number | null;
};

// The spec's DerivedStructure without the display enrichment (article/unit/work-center names).
export type DerivedMaterialCore = Omit<DerivedMaterial, "articleNumber" | "articleName" | "unitCode">;
export type DerivedOperationCore = Omit<DerivedOperation, "workCenterCode" | "workCenterName">;
export type DerivedStructureCore = {
  derivable: boolean;
  materials: DerivedMaterialCore[];
  operations: DerivedOperationCore[];
  errors: string[];
  warnings: string[];
};

export const CONFIGURATION_NOT_VALID = "Konfigurationen är inte giltig";

const sv = (n: number) => String(Number(n.toFixed(4))).replace(".", ",");

export function deriveStructure(input: {
  template: EngineTemplate;
  evaluation: ConfiguratorEvaluation;
  effective: Map<string, EffectiveValue>;
  baseBom: BaseBomRow[];
  baseOperations: BaseOperation[];
  lines: DeriveBomLine[];
  operations: DeriveOperation[];
}): DerivedStructureCore {
  const { template, evaluation, effective } = input;
  // Rule 1: only a valid configuration is derived.
  if (!evaluation.valid) return { derivable: false, materials: [], operations: [], errors: [CONFIGURATION_NOT_VALID], warnings: [] };

  const groupsById = new Map<string, EngineGroup>(template.groups.map((g) => [g.id, g]));
  const formulaValues: FormulaValues = new Map(
    template.groups.map((g) => [g.code.toUpperCase(), { kind: g.kind, value: effective.get(g.id)?.value ?? null }])
  );
  const holds = (conditions: ConfiguratorCondition[]) => conditions.every((c) => conditionHolds(c, groupsById, effective));
  const errors: string[] = [];
  const warnings: string[] = [];

  // Rule 2: the ordinary route follows unchanged.
  const operations: DerivedOperationCore[] = input.baseOperations.map((o) => ({
    kind: "base", id: o.id, sequenceNo: o.sequenceNo, workCenterId: o.workCenterId, description: o.description,
    setupTime: o.setupTime, runTimePerUnit: o.runTimePerUnit, costingOnly: o.costingOnly,
    setupPrice: o.setupPrice, unitPrice: o.unitPrice,
  }));
  const baseOpsById = new Map(input.baseOperations.map((o) => [o.id, o]));
  const baseSequenceNos = new Set(input.baseOperations.map((o) => o.sequenceNo));

  // Rule 4: conditional operations whose conditions hold, with fixed or formula times.
  const conditionalOps = [...input.operations].sort((a, b) => a.sequenceNo - b.sequenceNo);
  const conditionalOpsById = new Map(conditionalOps.map((o) => [o.id, o]));
  const applicableOpIds = new Set<string>(); // conditions hold (even when a time failed)
  const includedOpIds = new Set<string>(); // in the derived route
  for (const o of conditionalOps) {
    if (!holds(o.conditions)) continue;
    applicableOpIds.add(o.id);
    const label = `Operation ${o.sequenceNo}`;
    // Rule 6: the ordinary route may have changed after the save-time check.
    if (baseSequenceNos.has(o.sequenceNo)) {
      errors.push(`Operationsnummer ${o.sequenceNo} finns både i rutten och bland konfiguratorns operationer`);
    }
    const time = (fixed: number | null, formula: string | null, what: "ställtiden" | "stycktiden"): number | null => {
      let value = fixed ?? 0;
      if (formula !== null) {
        const r = evaluateFormula(formula, formulaValues);
        if (!r.ok) { errors.push(`${label}: ${r.message}`); return null; }
        value = r.value;
      }
      if (value < 0) { errors.push(`${label}: ${what} blev negativ`); return null; }
      return value;
    };
    const setupTime = time(o.setupTime, o.setupFormula, "ställtiden");
    const runTimePerUnit = time(o.runTimePerUnit, o.runFormula, "stycktiden");
    if (setupTime === null || runTimePerUnit === null) continue;
    includedOpIds.add(o.id);
    operations.push({
      kind: "configurator", id: o.id, sequenceNo: o.sequenceNo, workCenterId: o.workCenterId, description: o.description,
      setupTime, runTimePerUnit, costingOnly: false, setupPrice: o.setupPrice, unitPrice: o.unitPrice,
    });
  }
  // Stable: on a (reported) sequence-number clash the ordinary operation comes first.
  operations.sort((a, b) => a.sequenceNo - b.sequenceNo);

  const baseRef = (routingOperationId: string | null): DerivedOperationRef | null => {
    const o = routingOperationId ? baseOpsById.get(routingOperationId) : undefined;
    return o ? { kind: "base", id: o.id, sequenceNo: o.sequenceNo } : null;
  };

  // Rule 2: ordinary structure rows unchanged (quantity, display unit, link).
  const materials: DerivedMaterialCore[] = input.baseBom.map((b) => ({
    source: "base", lineId: null, baseRowId: b.id, componentArticleId: b.componentArticleId, quantity: b.quantity,
    unitId: b.unitId, unitFactor: b.unitFactor, operation: baseRef(b.routingOperationId),
  }));

  // Rule 3 + 5 + 7: conditional lines in sortOrder, each its own material row.
  for (const l of [...input.lines].sort((a, b) => a.sortOrder - b.sortOrder)) {
    if (!holds(l.conditions)) continue;
    let componentArticleId: string | null = l.componentArticleId;
    if (l.source === "group") {
      const group = l.componentGroupId ? groupsById.get(l.componentGroupId) : undefined;
      const valueId = group ? effective.get(group.id)?.valueId ?? null : null;
      const value = group && valueId ? group.values.find((v) => v.id === valueId) : undefined;
      if (!group || !value) { errors.push(`${l.label}: ${group?.name ?? "valgruppen"} saknar valt alternativ`); continue; }
      if (!value.articleId) { errors.push(`${l.label}: alternativet ${value.name} i ${group.name} saknar artikel`); continue; }
      componentArticleId = value.articleId;
    }
    if (!componentArticleId) { errors.push(`${l.label}: komponent saknas`); continue; }

    let quantity = l.quantity ?? 0;
    if (l.quantityFormula !== null) {
      const r = evaluateFormula(l.quantityFormula, formulaValues);
      if (!r.ok) { errors.push(`${l.label}: ${r.message}`); continue; }
      quantity = r.value;
    }
    if (!(quantity > 0)) {
      errors.push(`${l.label}: antalet blev ${sv(quantity)} — använd ett villkor om raden inte ska ingå`);
      continue;
    }

    let operation: DerivedOperationRef | null = null;
    if (l.routingOperationId) operation = baseRef(l.routingOperationId);
    else if (l.configuratorOperationId) {
      const o = conditionalOpsById.get(l.configuratorOperationId);
      if (o && includedOpIds.has(o.id)) operation = { kind: "configurator", id: o.id, sequenceNo: o.sequenceNo };
      // Not included ⇒ unlinked, drawn at final reporting like any unlinked material. An applicable operation
      // that failed already carries an error, so no warning on top of it.
      else if (o && !applicableOpIds.has(o.id)) {
        warnings.push(`${l.label} kopplad till operation ${o.sequenceNo} som inte ingår — dras vid slutrapporteringen`);
      }
    }
    materials.push({ source: "line", lineId: l.id, baseRowId: null, componentArticleId, quantity, unitId: null, unitFactor: null, operation });
  }

  // Täckningsvarning: a line family (one line per alternative) that has no line for the chosen alternative.
  warnings.push(...selectionCoverageWarnings(template.groups, findCoverageGaps(template.groups, input.lines), effective, holds));

  return { derivable: errors.length === 0, materials, operations, errors, warnings };
}
