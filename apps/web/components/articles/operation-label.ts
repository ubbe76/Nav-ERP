import type { RoutingOperation } from "../../lib/types";

// The label a routing operation gets everywhere on the article card.
// Beskrivning is what the operation IS; the resource name is the fallback for
// rows that have none, so the label never goes blank.
export function operationLabel(op: Pick<RoutingOperation, "sequenceNo" | "description" | "workCenterName">) {
  return `${op.sequenceNo} — ${op.description ?? op.workCenterName}`;
}
