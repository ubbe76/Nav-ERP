// F2: CSV columns for GET /planning/requirements/csv — the requirement rows
// are fully derived (never stored, see requirements-calc.ts), so this column
// set is specified directly rather than mirrored off a single web Table
// column list (behovsberäkningen's page shows a richer, more interactive
// breakdown than a flat CSV can carry).
import { type CsvColumn } from "@navet/shared";
import type { RequirementRow } from "./requirements-calc.js";

const TYPE_LABELS: Record<RequirementRow["type"], string> = {
  purchased: "Inköp",
  manufactured: "Tillverkad",
};

function typeLabel(r: RequirementRow): string {
  if (r.proposalKind === "subcontract") return "Lego";
  // Konfigurator 4c: a configured KO row's proposal.
  if (r.proposalKind === "configured") return "Konfigurerad";
  return TYPE_LABELS[r.type];
}

// Subcontract rows: the TO operation the proposal buys. Configured rows: the
// KO the row belongs to.
function reference(r: RequirementRow): string | null {
  if (r.moOrderNumber) return `${r.moOrderNumber} · ${r.moOperationLabel ?? ""}`.trim();
  if (r.proposalKind === "configured") return r.salesOrderNumber ?? null;
  return null;
}

export const requirementsExportColumns: CsvColumn<RequirementRow>[] = [
  { label: "Artikelnummer", value: (r) => r.articleNumber },
  // A configured row carries its choices after the template's name.
  {
    label: "Benämning",
    value: (r) => (r.configurationSummary ? `${r.articleName} — ${r.configurationSummary}` : r.articleName),
  },
  { label: "Typ", value: typeLabel },
  { label: "Referens", value: reference },
  { label: "Saldo", value: (r) => r.onHand, format: "number" },
  { label: "Behov", value: (r) => r.demandSales + r.demandMo + r.demandDerived, format: "number" },
  { label: "Inkommande", value: (r) => r.supplyPo + r.supplyPoDraft + r.supplyMo, format: "number" },
  { label: "Netto", value: (r) => r.projected, format: "number" },
  { label: "Beställningspunkt", value: (r) => r.reorderPoint, format: "number" },
  { label: "Förslag", value: (r) => r.proposalQuantity, format: "number" },
  { label: "Ledtid (dagar)", value: (r) => r.primarySupplier?.leadTimeDays ?? null, format: "number" },
  { label: "Huvudleverantör", value: (r) => r.primarySupplier?.supplierName ?? null },
];
