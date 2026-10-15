import type { CostingMaterialSource, CostingSupplierPriceTier } from "@navet/shared";
import type { MaterialRowWrite, OperationRowWrite } from "../repository/costing.repository.js";
import { resolveUnitCost, type ArticleCostBasis } from "./markup.js";

// Costing ONE level of a structure: turn a level's exploded components and its
// routing into specification rows, and add those rows up into the direct-cost
// buckets. Extracted from costing.service.ts when multi-level costing arrived,
// because the recursion has to cost a sub-assembly with EXACTLY the same rules
// as the top level — a second, parallel implementation would drift, and the
// drift would show up as an unexplainable à-pris rather than as a crash.

// A component priced and classified: service articles in the structure are
// subcontracted work (lego) and carry the LO markup, everything else is
// direct material and carries MO.
export interface CostBasis extends ArticleCostBasis {
  type: string;
  // Multi-level only: whether a manufactured component can be costed from its
  // own structure at all. Absent on the single-level path, which never asks.
  hasBom?: boolean;
  hasRouting?: boolean;
}

// Costs one component into a specification row. Returning the row rather than
// accumulating into a running total makes the material/lego split a property
// of the row, and guarantees the rows add up to the header's totals.
export function buildMaterialRow(
  component: { componentArticleId: string; quantity: number; unitId: string | null; unitFactor: string | null },
  basis: CostBasis | undefined,
  source: CostingMaterialSource,
  // Stafflat leverantörspris: the step is matched on THIS row's quantity —
  // the component's total for the calculation (or the consumed quantity).
  supplierPriceTier: CostingSupplierPriceTier = "base"
): { row: MaterialRowWrite; warning: string | null } {
  const { cost, used, warning } = resolveUnitCost(basis, source, { supplierPriceTier, quantity: component.quantity });
  return {
    row: {
      componentArticleId: component.componentArticleId,
      kind: basis?.type === "service" ? "subcontract" : "material",
      quantity: component.quantity,
      unitId: component.unitId,
      unitFactor: component.unitFactor,
      unitCost: cost,
      priceSource: used,
      amount: component.quantity * cost,
    },
    warning,
  };
}

// A manufactured sub-assembly costed from its OWN structure and routing. The
// amount is the sub-calculation's exact manufacturing cost and the à-pris is
// derived from it — never the other way round: `quantity × round(unitCost)`
// would drift from the sub-level's own TVK by up to quantity × 0,00005, and
// the parent's bucket would then stop agreeing with the calculation it came
// from. priceSource "calculated" is what makes the row legible in the
// specification; kind "semi" is what keeps the MO markup off it.
export function buildSemiFinishedRow(
  component: { componentArticleId: string; quantity: number; unitId: string | null; unitFactor: string | null },
  manufacturingCostTotal: number
): MaterialRowWrite {
  return {
    componentArticleId: component.componentArticleId,
    kind: "semi",
    quantity: component.quantity,
    unitId: component.unitId,
    unitFactor: component.unitFactor,
    unitCost: component.quantity !== 0 ? manufacturingCostTotal / component.quantity : 0,
    priceSource: "calculated",
    amount: manufacturingCostTotal,
  };
}

// `setupHours` is the setup share of `hours`, snapshotted so the
// specification can show the amortised setup cost per unit after the routing
// changes; null when the split does not exist (post-calculation's reported
// time).
export function buildOperationRow(op: {
  sequenceNo: number;
  workCenterId: string;
  hourlyRate: string;
  overheadPercent: string;
  hours: number;
  setupHours: number | null;
}): OperationRowWrite {
  const hourlyRate = Number(op.hourlyRate);
  const overheadPercent = Number(op.overheadPercent);
  const laborAmount = op.hours * hourlyRate;
  return {
    sequenceNo: op.sequenceNo,
    workCenterId: op.workCenterId,
    hours: op.hours,
    setupHours: op.setupHours,
    hourlyRate,
    overheadPercent,
    laborAmount,
    overheadAmount: laborAmount * (overheadPercent / 100),
    subcontractAmount: null,
  };
}

// A lego operation is bought, not worked: no hours/rate/TO — the whole cost
// is subcontractAmount, which directCosts feeds into subcontractCost (LO).
export function buildSubcontractOperationRow(
  op: { sequenceNo: number; workCenterId: string },
  amount: number
): OperationRowWrite {
  return {
    sequenceNo: op.sequenceNo,
    workCenterId: op.workCenterId,
    hours: 0,
    setupHours: null,
    hourlyRate: 0,
    overheadPercent: 0,
    laborAmount: 0,
    overheadAmount: 0,
    subcontractAmount: amount,
  };
}

// One routing turned into operation rows for a planned quantity. Setup time is
// charged once for the whole batch and run time per unit, which is what makes
// a larger quantity cheaper per unit — the same amortisation the sub-level
// relies on when a parent asks for the cascade quantity.
export interface RoutingRow {
  sequenceNo: number;
  setupTime: string;
  runTimePerUnit: string;
  workCenterId: string;
  workCenterName: string;
  workCenterType: string;
  hourlyRate: string;
  overheadPercent: string;
  setupPrice: string | null;
  unitPrice: string | null;
}

export function buildOperationRows(
  operations: RoutingRow[],
  quantity: number,
  warnings: string[]
): OperationRowWrite[] {
  return operations.map((op) => {
    if (op.workCenterType === "subcontract") {
      // Lego: ställpris amortised over the calculation quantity + styckpris
      // per unit — as an absolute amount for `quantity` units here.
      if (op.setupPrice === null && op.unitPrice === null) {
        warnings.push(`Operation ${op.sequenceNo} (${op.workCenterName}): legooperation saknar pris, antar 0`);
      }
      const amount = Number(op.setupPrice ?? 0) + Number(op.unitPrice ?? 0) * quantity;
      return buildSubcontractOperationRow(op, amount);
    }
    return buildOperationRow({
      ...op,
      // Setup and run times are MINUTES on routing_operations.
      hours: (Number(op.setupTime) + Number(op.runTimePerUnit) * quantity) / 60,
      setupHours: Number(op.setupTime) / 60,
    });
  });
}

function sumRows<T>(rows: T[], amount: (row: T) => number): number {
  return rows.reduce((total, row) => total + amount(row), 0);
}

export function directCosts(materialRows: MaterialRowWrite[], operationRows: OperationRowWrite[]) {
  return {
    materialCost: sumRows(materialRows.filter((r) => r.kind === "material"), (r) => r.amount),
    // Lego (LO markup) comes from two places: service articles in the
    // structure, and subcontract operations in the routing (setup + unit
    // price bought from a supplier instead of time × hourly rate).
    subcontractCost:
      sumRows(materialRows.filter((r) => r.kind === "subcontract"), (r) => r.amount) +
      sumRows(operationRows, (r) => r.subcontractAmount ?? 0),
    laborCost: sumRows(operationRows, (r) => r.laborAmount),
    // TO — tillverkningsomkostnad, a percentage of labor set per work center.
    overhead: sumRows(operationRows, (r) => r.overheadAmount),
    // Halvfabrikat — manufactured sub-assemblies costed from their own
    // structure and routing (multi-level). The three filters partition the
    // material rows by `kind`, so no row can land in two buckets. Always 0 in
    // a single-level run, since nothing produces a "semi" row then.
    semiFinishedCost: sumRows(materialRows.filter((r) => r.kind === "semi"), (r) => r.amount),
  };
}
