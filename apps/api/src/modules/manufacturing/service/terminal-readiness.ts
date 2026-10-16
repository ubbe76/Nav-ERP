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

export function computeReadiness(orderQuantity: number, operations: ReadinessInput[]): Map<string, ReadinessResult> {
  const sorted = [...operations].sort((a, b) => a.sequenceNo - b.sequenceNo);
  const result = new Map<string, ReadinessResult>();
  sorted.forEach((operation, i) => {
    const remaining = Math.max(orderQuantity - ok(operation), 0);
    const previous = sorted[i - 1];
    if (!previous || previous.status === "done") {
      result.set(operation.id, { readiness: "ready", available: remaining });
      return;
    }
    const available = Math.min(Math.max(ok(previous) - ok(operation), 0), remaining);
    result.set(operation.id, available > 0 ? { readiness: "partial", available } : { readiness: "not_ready", available: 0 });
  });
  return result;
}
