import { round4 } from "@navet/shared";

// Terminal readiness (beredskap) for MO operations — pure, no DB imports.
// The first operation (lowest sequence number) is always ready; any other
// one is ready when the nearest previous operation is done, partially ready
// while the previous has reported more OK than this one (the difference is
// what can be worked on), otherwise not ready. Scrap doesn't count: scrapped
// units are made again and show up in Kvar. Lego (subcontract) operations
// are never listed at the terminal but still count as "previous".
export type Readiness = "ready" | "partial" | "not_ready";
export interface ReadinessInput { id: string; sequenceNo: number; status: "pending" | "done"; quantityCompleted: string | null }
export interface ReadinessResult { readiness: Readiness; available: number }

const ok = (op: ReadinessInput) => Number(op.quantityCompleted ?? 0);

// Antal kvar of an operation: the order quantity minus its OK quantity,
// never below 0 (scrap does not count — scrapped units are made again). The
// ONE rule for the terminal's readiness and the körplan's Antal kvar.
export function remainingOperationQuantity(orderQuantity: number, quantityCompleted: string | number | null): number {
  return round4(Math.max(orderQuantity - Number(quantityCompleted ?? 0), 0));
}

// The order's operations in route order, each with the nearest previous one
// (null for the first) — the "previous operation" every readiness answer is
// about, lego operations included.
function withPrevious<T extends { sequenceNo: number }>(operations: T[]): { operation: T; previous: T | null }[] {
  const sorted = [...operations].sort((a, b) => a.sequenceNo - b.sequenceNo);
  return sorted.map((operation, i) => ({ operation, previous: sorted[i - 1] ?? null }));
}

export function computeReadiness(orderQuantity: number, operations: ReadinessInput[]): Map<string, ReadinessResult> {
  const result = new Map<string, ReadinessResult>();
  for (const { operation, previous } of withPrevious(operations)) {
    const remaining = remainingOperationQuantity(orderQuantity, operation.quantityCompleted);
    if (!previous || previous.status === "done") {
      result.set(operation.id, { readiness: "ready", available: remaining });
      continue;
    }
    const available = round4(Math.min(Math.max(ok(previous) - ok(operation), 0), remaining));
    result.set(operation.id, available > 0 ? { readiness: "partial", available } : { readiness: "not_ready", available: 0 });
  }
  return result;
}

// The sequence number of the operation each one waits for: its nearest
// previous operation (the one computeReadiness reads), null for the first.
// The körplan's "Väntar på op N" — the same neighbour, never an own rule.
export function previousSequenceNumbers(operations: Pick<ReadinessInput, "id" | "sequenceNo">[]): Map<string, number | null> {
  return new Map(withPrevious(operations).map(({ operation, previous }) => [operation.id, previous?.sequenceNo ?? null]));
}
