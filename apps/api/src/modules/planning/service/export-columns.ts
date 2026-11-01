// F2: CSV columns for GET /planning/requirements/csv — the requirement rows
// are fully derived (never stored, see requirements-calc.ts), so this column
// set is specified directly rather than mirrored off a single web Table
// column list (behovsberäkningen's page shows a richer, more interactive
// breakdown than a flat CSV can carry).
//
// Tidsfasade förslag (#13): one line per PROPOSAL (RequirementExportRow —
// the article row repeated with `proposal`), so Förslag, Behovsdatum,
// Senaste datum and Passerat are the proposal's; a row without proposals
// (showAll) is one line with those columns empty.
import { type CsvColumn } from "@navet/shared";
import type { RequirementRow } from "./requirements-calc.js";
import type { RequirementExportRow } from "./planning.service.js";

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

export const requirementsExportColumns: CsvColumn<RequirementExportRow>[] = [
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
  { label: "Förslag", value: (r) => r.proposal?.quantity ?? null, format: "number" },
  { label: "Behovsdatum", value: (r) => r.proposal?.needDate ?? null, format: "date" },
  { label: "Senaste datum", value: (r) => r.proposal?.latestDate ?? null, format: "date" },
  { label: "Passerat", value: (r) => (r.proposal?.late ? "Ja" : r.proposal ? "Nej" : null) },
  // The supplier's lead time for a purchase; the manufacturing lead time
  // (field or routing) for a manufactured article.
  { label: "Ledtid (dagar)", value: (r) => r.primarySupplier?.leadTimeDays ?? r.leadDays ?? null, format: "number" },
  { label: "Huvudleverantör", value: (r) => r.primarySupplier?.supplierName ?? null },
];
