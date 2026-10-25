import { round2 } from "@navet/shared";

// Bankavstämning — the summary equation, pure:
//   saldo bank − saldo bok = Σ omatchade poster − Σ omatchade rader + I transit
// Both sides are measured on the same day (the statement balance's day), the
// ledger balance as debit − credit on the account's ledger account up to and
// including that day, the unmatched sums over everything up to it. I transit
// is what the live matchings that CROSS the day contribute: an entry the bank
// booked on or before the day whose row is dated after it counts +, a row on
// or before the day whose entry is dated after it counts − (a matching wholly
// on one side nets to 0). When the equation does not hold the page shows a
// deviation (a missing statement, a change after the import …).

export interface ReconciliationSummaryInput {
  statementBalance: number | null;
  statementBalanceDate: string | null;
  ledgerBalance: number;
  unmatchedEntriesSum: number;
  unmatchedRowsSum: number;
  inTransit: number;
}

export interface ReconciliationSummary extends ReconciliationSummaryInput {
  difference: number | null;
  // The right-hand side: what the unmatched items and the crossing
  // matchings together say the difference should be.
  expectedDifference: number;
  explained: boolean;
}

export function expectedDifference(input: Pick<ReconciliationSummaryInput, "unmatchedEntriesSum" | "unmatchedRowsSum" | "inTransit">): number {
  return round2(input.unmatchedEntriesSum - input.unmatchedRowsSum + input.inTransit);
}

export function reconciliationSummary(input: ReconciliationSummaryInput): ReconciliationSummary {
  const difference = input.statementBalance === null ? null : round2(input.statementBalance - input.ledgerBalance);
  const expected = expectedDifference(input);
  return {
    ...input,
    ledgerBalance: round2(input.ledgerBalance),
    unmatchedEntriesSum: round2(input.unmatchedEntriesSum),
    unmatchedRowsSum: round2(input.unmatchedRowsSum),
    inTransit: round2(input.inTransit),
    difference,
    expectedDifference: expected,
    explained: difference !== null && difference === expected,
  };
}
