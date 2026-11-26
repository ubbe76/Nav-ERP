// Dagplan's writes — the ONLY place the page changes anything, so Mötesläget
// (which never imports a caller of these) cannot write by accident
// (web-day-plan.test.ts). All three are the existing planning routes.
import { apiFetch } from "../../lib/api";
import type { MoveOperationResult, RunPlanOrderResult, UnlockOperationResult } from "../../lib/types";

// Ordningen inom dagen: the day's full list of reorderable operations.
export function saveDayOrder(workCenterId: string, date: string, moOperationIds: string[]): Promise<RunPlanOrderResult> {
  return apiFetch<RunPlanOrderResult>("/api/v1/planning/run-plan/order", {
    method: "PUT",
    body: JSON.stringify({ workCenterId, date, moOperationIds }),
  });
}

// I morgon / Lägg på i dag: Flytta with the following operations (locks).
export function moveOperationTo(moOperationId: string, date: string): Promise<MoveOperationResult> {
  return apiFetch<MoveOperationResult>(`/api/v1/planning/operations/${moOperationId}/move`, {
    method: "POST",
    body: JSON.stringify({ date, moveFollowing: true }),
  });
}

export function unlockOperation(moOperationId: string): Promise<UnlockOperationResult> {
  return apiFetch<UnlockOperationResult>(`/api/v1/planning/operations/${moOperationId}/unlock`, { method: "POST" });
}
