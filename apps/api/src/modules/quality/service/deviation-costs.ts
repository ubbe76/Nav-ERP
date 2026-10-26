import type { DeviationCostKind } from "@navet/shared";

// Avvikelsens kostnader — pure. The ONE place the net cost is computed: the
// card, the list, the CSV and the leveransprecision's Avvikelsekostnad all go
// through summarizeDeviationCosts. Never stored.
//
// Material, Arbete, Frakt, Kreditering, Övrigt add; Ersättning (recovery)
// subtracts. The derived lines (an issued kreditfaktura linked to the case
// = Kreditering, an attested/paid leverantörskreditnota = Ersättning) enter
// as ordinary lines — drafts and cancelled documents never do; the
// repository decides which documents qualify.

export interface DeviationCostLine {
  kind: DeviationCostKind;
  amount: number; // SEK, positive
}

export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function isRecovery(kind: DeviationCostKind): boolean {
  return kind === "recovery";
}

export function summarizeDeviationCosts(lines: readonly DeviationCostLine[]): {
  totalCosts: number;
  totalRecovery: number;
  netCost: number;
} {
  let costs = 0;
  let recovery = 0;
  for (const line of lines) {
    if (isRecovery(line.kind)) recovery += line.amount;
    else costs += line.amount;
  }
  return { totalCosts: round2(costs), totalRecovery: round2(recovery), netCost: round2(costs - recovery) };
}
