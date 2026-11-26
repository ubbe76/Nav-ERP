// Planera om strukturen's two calls — called only by ReplanStructureDialog,
// which the pages mount for users with Tillverkning.
import { apiFetch } from "../../lib/api";
import type { ReplanStructureWrite } from "../../lib/replanStructure";
import type { ReplanStructureRequest, ReplanStructureResult } from "../../lib/types";

// The preview computes and writes nothing (a POST that only reads).
export function previewReplanStructure(topOrderId: string, request: ReplanStructureRequest): Promise<ReplanStructureResult> {
  return apiFetch<ReplanStructureResult>(`/api/v1/manufacturing-orders/${topOrderId}/replan-structure/preview`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

// Plans the top and the chosen halvfabrikat again, children first, and locks
// the days. `expected` is the shown preview's — 409 replan-structure-changed
// (with a fresh preview in the body) when it no longer holds.
export function writeReplanStructure(topOrderId: string, payload: ReplanStructureWrite): Promise<ReplanStructureResult> {
  return apiFetch<ReplanStructureResult>(`/api/v1/manufacturing-orders/${topOrderId}/replan-structure`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
