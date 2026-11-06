import { toUnitQuantity, type UnitFactor } from "./units";

// Suggestions for the TO card's Förbruka material and Rapportera tid forms:
// what theoretically remains to be drawn/worked. "" = no suggestion (nothing
// left, or nothing to base it on) — the user types the value instead.

// What remains of the material row's planned quantity (BOM × order quantity),
// in the row's display unit.
export function suggestedConsumeQuantity(
  row: { quantityPlanned: string; quantityConsumed: string; unitFactor: UnitFactor } | undefined
): string {
  if (!row) return "";
  const remaining = Number(row.quantityPlanned) - Number(row.quantityConsumed);
  if (!(remaining > 0)) return "";
  return String(toUnitQuantity(remaining, row.unitFactor));
}

// The operation's theoretical time — setup + run time per unit × order
// quantity, both stored in minutes — less the hours already reported on it,
// in hours with two decimals (the time report's precision).
//
// With a kind (Dela tid i ställ och produktion) the suggestion is per kind:
// setup = planned setup time less the hours reported as setup; run = run time
// per unit × quantity less the hours reported as run. Without a kind
// (setting off, or Ej uppdelad picked) it is the whole operation as before,
// whatever kinds the earlier reports carry.
export function suggestedReportHours(
  operation: { id: string; setupTime: string; runTimePerUnit: string } | undefined,
  orderQuantity: string,
  timeReports: { moOperationId: string; hours: string; kind?: "setup" | "run" | null }[],
  kind: "setup" | "run" | "" | null = ""
): string {
  if (!operation) return "";
  const plannedMinutes =
    kind === "setup"
      ? Number(operation.setupTime)
      : kind === "run"
        ? Number(operation.runTimePerUnit) * Number(orderQuantity)
        : Number(operation.setupTime) + Number(operation.runTimePerUnit) * Number(orderQuantity);
  const reportedHours = timeReports
    .filter((r) => r.moOperationId === operation.id && (!kind || r.kind === kind))
    .reduce((sum, r) => sum + Number(r.hours), 0);
  const remaining = Math.round((plannedMinutes / 60 - reportedHours) * 100) / 100;
  return remaining > 0 ? String(remaining) : "";
}

// Typ's förval in Rapportera tid and Ny tidrapport: Produktion when the time
// is split (Dela tid i ställ och produktion) — most manual time is
// production, and the suggestion above is then the run time's. "" (Ej
// uppdelad) without the setting, where the field is not shown.
export function defaultReportKind(timeKindSplit: boolean): "run" | "" {
  return timeKindSplit ? "run" : "";
}
