import type { ErasureFacts } from "../repository/employee-erasure.js";

// Radera eller anonymisera en anställd (GDPR, #2) — the rule, pure. An
// employee without history (never stamped, never paid) is deleted; one with
// history is anonymized, and only when nothing of it is still in play: the
// employee is inactive, no session is open and every month with its time,
// absence or pay is a locked payroll period. An anonymized employee is done.

export type ErasureBlocker = { code: "active" } | { code: "open-session" } | { code: "open-period"; months: string[] };

export interface ErasurePlan {
  action: "delete" | "anonymize" | "anonymized";
  blockers: ErasureBlocker[];
}

export function erasurePlan(employee: { active: boolean; anonymizedAt: Date | string | null }, facts: ErasureFacts): ErasurePlan {
  if (employee.anonymizedAt !== null) return { action: "anonymized", blockers: [] };
  const blockers: ErasureBlocker[] = [];
  if (employee.active) blockers.push({ code: "active" });
  if (facts.openSession) blockers.push({ code: "open-session" });
  if (facts.openMonths.length > 0) blockers.push({ code: "open-period", months: facts.openMonths });
  return { action: facts.hasHistory ? "anonymize" : "delete", blockers };
}
