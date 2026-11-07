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
import type { AbcRow, RequirementExportRow } from "./planning.service.js";

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
  // Prognos (#10): the forecast is part of Behov, as on the web, and shown
  // on its own right after it.
  { label: "Behov", value: (r) => r.demandSales + r.demandMo + r.demandDerived + r.demandForecast, format: "number" },
  { label: "Varav prognos", value: (r) => r.demandForecast, format: "number" },
  { label: "Inkommande", value: (r) => r.supplyPo + r.supplyPoDraft + r.supplyMo, format: "number" },
  { label: "Netto", value: (r) => r.projected, format: "number" },
  { label: "Beställningspunkt", value: (r) => r.reorderPoint, format: "number" },
  { label: "Förslag", value: (r) => r.proposal?.quantity ?? null, format: "number" },
  { label: "Behovsdatum", value: (r) => r.proposal?.needDate ?? null, format: "date" },
  { label: "Senaste datum", value: (r) => r.proposal?.latestDate ?? null, format: "date" },
  { label: "Passerat", value: (r) => (r.proposal?.late ? "Ja" : r.proposal ? "Nej" : null) },
  // The supplier's lead time for a purchase; the manufacturing lead time
  // (field or routing) for a manufactured article.
  // Manufactured: the lead time the proposals were dated with (field or
  // routing); purchased: the main supplier's catalogue lead time.
  {
    label: "Ledtid (dagar)",
    value: (r) => (r.type === "manufactured" ? r.leadDays : r.primarySupplier?.leadTimeDays) ?? null,
    format: "number",
  },
  { label: "Huvudleverantör", value: (r) => r.primarySupplier?.supplierName ?? null },
];

// ABC-klassning (#10, etapp 2): CSV columns for GET /planning/abc/csv. The
// price columns (Standardkostnad, Förbrukningsvärde, Andel, Ackumulerad
// andel) are left out entirely for a user without price permission — the
// same way the avvikelse export drops Avvikelsekostnad — so the file never
// carries an empty price column that looks like a zero.
export function abcExportColumns(seePrices: boolean): CsvColumn<AbcRow>[] {
  const columns: CsvColumn<AbcRow>[] = [
    { label: "Artikelnummer", value: (r) => r.articleNumber },
    { label: "Benämning", value: (r) => r.name },
    { label: "Typ", value: (r) => TYPE_LABELS[r.type] },
    { label: "ABC-klass", value: (r) => r.abcClass },
    { label: "Förbrukat antal", value: (r) => r.consumed, format: "number" },
  ];
  if (seePrices) {
    columns.push(
      { label: "Standardkostnad", value: (r) => r.standardCost, format: "money" },
      { label: "Förbrukningsvärde", value: (r) => r.value, format: "money" },
      { label: "Andel (%)", value: (r) => r.share, format: "number" },
      { label: "Ackumulerad andel (%)", value: (r) => r.cumulativeShare, format: "number" }
    );
  }
  columns.push(
    { label: "Saknar standardpris", value: (r) => (r.missingStandardCost ? "Ja" : "Nej") },
    { label: "Beställningspunkt", value: (r) => r.reorderPoint, format: "number" },
    { label: "Säkerhetslager", value: (r) => r.safetyStock, format: "number" },
    { label: "Prognosstyrd", value: (r) => (r.forecastControlled ? "Ja" : "Nej") }
  );
  return columns;
}
