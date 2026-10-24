import { round2 } from "@navet/shared";

// Bankavstämning — the summary equation, pure:
//   saldo bank − saldo bok = Σ omatchade poster − Σ omatchade rader
// Both sides are measured on the same day (the statement balance's day),
// the ledger balance as debit − credit on the account's ledger account up to
// and including that day, the unmatched sums over everything up to it. When
// the equation does not hold the page shows a deviation (a missing
// statement, a row dated on the other side of the balance day …).

export interface ReconciliationSummaryInput {
  statementBalance: number | null;
  statementBalanceDate: string | null;
  ledgerBalance: number;
  unmatchedEntriesSum: number;
  unmatchedRowsSum: number;
}

export interface ReconciliationSummary extends ReconciliationSummaryInput {
  difference: number | null;
  explained: boolean;
}

export function reconciliationSummary(input: ReconciliationSummaryInput): ReconciliationSummary {
  const difference = input.statementBalance === null ? null : round2(input.statementBalance - input.ledgerBalance);
  const explained = difference !== null && difference === round2(input.unmatchedEntriesSum - input.unmatchedRowsSum);
  return {
    ...input,
    ledgerBalance: round2(input.ledgerBalance),
    unmatchedEntriesSum: round2(input.unmatchedEntriesSum),
    unmatchedRowsSum: round2(input.unmatchedRowsSum),
    difference,
    explained,
  };
}
