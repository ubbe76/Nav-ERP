// Alternativa resurser (#15) — the beredning's rules for an own operation's
// alternative resources. Pure (no DB imports): the manufacturing service
// runs them under the routing operation's row lock, and the operation
// import's updateExisting (import/service/routing.ts) gives the same texts
// as row errors. Swedish texts, shown as they are.
//
// Alternatives exist only on an own operation that is worked: the ordinarie
// and every alternative are a machine or personnel, never a legoresurs (lego
// is reported through the receipt and carries supplier and prices, so
// another subcontractor is a purchasing question), and the operation is not
// Kalkyl (it never reaches a TO). An alternative is never the ordinarie.

import { MAX_ROUTING_ALTERNATIVES } from "@navet/shared";

export interface AlternativeResource {
  id: string;
  code: string;
  type: string;
  active: boolean;
}

// 400 routing-alternative-invalid: the set sent with the operation. `isNew`
// = not among the operation's alternatives before the edit — an inactive
// resource may stay where it already is but is never added (the same rule as
// an inactive or blocked stock location that is new in its role).
export function routingAlternativesProblem(input: {
  ordinary: { id: string; code: string; type: string };
  costingOnly: boolean;
  alternatives: { workCenter: AlternativeResource; isNew: boolean }[];
}): string | null {
  if (input.alternatives.length === 0) return null;
  if (input.costingOnly) return "En kalkyloperation kan inte ha alternativa resurser";
  if (input.ordinary.type === "subcontract") return "En legooperation kan inte ha alternativa resurser";
  if (input.alternatives.length > MAX_ROUTING_ALTERNATIVES) {
    return `En operation kan ha högst ${MAX_ROUTING_ALTERNATIVES} alternativa resurser`;
  }
  const seen = new Set<string>();
  for (const { workCenter, isNew } of input.alternatives) {
    if (workCenter.id === input.ordinary.id) {
      return `Resurs ${workCenter.code} är operationens ordinarie resurs och kan inte också vara alternativ`;
    }
    if (seen.has(workCenter.id)) return `Resurs ${workCenter.code} finns flera gånger bland alternativen`;
    seen.add(workCenter.id);
    if (workCenter.type === "subcontract") {
      return `Resurs ${workCenter.code} är en legoresurs — en alternativ resurs ska vara en maskin eller personal`;
    }
    if (isNew && !workCenter.active) return `Resurs ${workCenter.code} är inaktiv och kan inte läggas till som alternativ`;
  }
  return null;
}

// 409 routing-operation-has-alternatives: the operation keeps its
// alternatives (no set sent) but becomes something that cannot have them —
// moved to a legoresurs, made Kalkyl, or given one of its alternatives as
// ordinarie. The web swaps the two by sending the set along.
export function routingOperationHasAlternativesProblem(input: {
  alternativeWorkCenterIds: string[];
  ordinary: { id: string; code: string; type: string };
  costingOnly: boolean;
}): string | null {
  if (input.alternativeWorkCenterIds.length === 0) return null;
  if (input.ordinary.type === "subcontract") {
    return "Operationen har alternativa resurser — ta bort dem innan den läggs på en legoresurs";
  }
  if (input.costingOnly) return "Operationen har alternativa resurser — ta bort dem innan den görs till Kalkyl";
  if (input.alternativeWorkCenterIds.includes(input.ordinary.id)) {
    return `Resurs ${input.ordinary.code} är redan alternativ på operationen — ta bort den ur alternativen först`;
  }
  return null;
}
