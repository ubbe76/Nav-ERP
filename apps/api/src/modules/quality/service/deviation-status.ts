import type { DeviationAction, DeviationStatus, DeviationType } from "@navet/shared";

// Avvikelsens statusflöde — the whitelist (pure, no DB). Every action names
// the statuses it may start from and the one it leads to:
//
//   registered ──start──▶ investigating ──close──▶ closed ──reopen──▶ investigating
//   registered ──close──▶ closed (simple cases)
//   registered | investigating ──cancel──▶ cancelled
//
// The repository's UPDATE is conditional on the same `from` list, so a
// concurrent change loses with InvalidStatusTransitionError (409).

export const DEVIATION_TRANSITIONS: Record<DeviationAction, { from: readonly DeviationStatus[]; to: DeviationStatus }> = {
  start: { from: ["registered"], to: "investigating" },
  close: { from: ["registered", "investigating"], to: "closed" },
  cancel: { from: ["registered", "investigating"], to: "cancelled" },
  reopen: { from: ["closed"], to: "investigating" },
};

export function canPerform(status: DeviationStatus, action: DeviationAction): boolean {
  return DEVIATION_TRANSITIONS[action].from.includes(status);
}

// The card's buttons, in a fixed order.
export function allowedActions(status: DeviationStatus): DeviationAction[] {
  return (Object.keys(DEVIATION_TRANSITIONS) as DeviationAction[]).filter((action) => canPerform(status, action));
}

// Fields, costs, links and files change only while the case is open.
export function isEditable(status: DeviationStatus): boolean {
  return status === "registered" || status === "investigating";
}

// What Avsluta still needs: Åtgärd always, Beslut for customer and supplier
// cases (an internal case has no counterparty to decide for).
export function closeRequirementsMissing(c: {
  type: DeviationType;
  correctiveAction: string | null;
  decision: string | null;
}): ("correctiveAction" | "decision")[] {
  const missing: ("correctiveAction" | "decision")[] = [];
  if (!c.correctiveAction || c.correctiveAction.trim() === "") missing.push("correctiveAction");
  if (c.type !== "internal" && !c.decision) missing.push("decision");
  return missing;
}
