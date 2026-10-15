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
export function suggestedReportHours(
  operation: { id: string; setupTime: string; runTimePerUnit: string } | undefined,
  orderQuantity: string,
  timeReports: { moOperationId: string; hours: string }[]
): string {
  if (!operation) return "";
  const theoreticalMinutes = Number(operation.setupTime) + Number(operation.runTimePerUnit) * Number(orderQuantity);
  const reportedHours = timeReports
    .filter((r) => r.moOperationId === operation.id)
    .reduce((sum, r) => sum + Number(r.hours), 0);
  const remaining = Math.round((theoreticalMinutes / 60 - reportedHours) * 100) / 100;
  return remaining > 0 ? String(remaining) : "";
}
