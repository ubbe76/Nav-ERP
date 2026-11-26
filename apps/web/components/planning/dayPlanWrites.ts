// Dagplan's writes — the ONLY place the page changes anything, so Mötesläget
// (which never imports a caller of these) cannot write by accident
// (web-day-plan.test.ts). The first three are the existing planning routes;
// the co-run pair is called only by CoRunDialog, which the pages mount for
// users with Tillverkning.
import { apiFetch } from "../../lib/api";
import type { CoRunInput, CoRunResult, MoveOperationResult, RunPlanOrderResult, UnlockOperationResult } from "../../lib/types";

// Ordningen inom dagen: the day's full list of reorderable operations.
export function saveDayOrder(workCenterId: string, date: string, moOperationIds: string[]): Promise<RunPlanOrderResult> {
  return apiFetch<RunPlanOrderResult>("/api/v1/planning/run-plan/order", {
    method: "PUT",
    body: JSON.stringify({ workCenterId, date, moOperationIds }),
  });
}

// I morgon / Lägg på i dag: Flytta with the following operations (locks).
// `expectedStartDate` = the start day the row showed (null = unplanned) —
// the server refuses the move with 409 operation-plan-changed when the
// operation has been moved since the page was read.
export function moveOperationTo(moOperationId: string, date: string, expectedStartDate: string | null): Promise<MoveOperationResult> {
  return apiFetch<MoveOperationResult>(`/api/v1/planning/operations/${moOperationId}/move`, {
    method: "POST",
    body: JSON.stringify({ date, moveFollowing: true, expectedStartDate }),
  });
}

export function unlockOperation(moOperationId: string): Promise<UnlockOperationResult> {
  return apiFetch<UnlockOperationResult>(`/api/v1/planning/operations/${moOperationId}/unlock`, { method: "POST" });
}

// Samkör — the preview computes and writes nothing (a POST that only reads).
export function previewCoRun(input: CoRunInput): Promise<CoRunResult> {
  return apiFetch<CoRunResult>("/api/v1/planning/co-run/preview", { method: "POST", body: JSON.stringify(input) });
}

// Samkör — moves the chosen operations to the day, locks them and lays them
// next to each other in the run order.
export function writeCoRun(input: CoRunInput): Promise<CoRunResult> {
  return apiFetch<CoRunResult>("/api/v1/planning/co-run", { method: "POST", body: JSON.stringify(input) });
}
