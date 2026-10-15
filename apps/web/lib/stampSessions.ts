import type { StampSession } from "./types";

// Worked time excludes pauses (gone home): accumulated pausedSeconds plus
// any ongoing pause up to "now".
export function formatElapsed(session: Pick<StampSession, "startedAt" | "pausedAt" | "pausedSeconds">, now: number) {
  const ongoingPauseMs = session.pausedAt ? Math.max(0, now - Date.parse(session.pausedAt)) : 0;
  const pausedMs = Number(session.pausedSeconds) * 1000 + ongoingPauseMs;
  const totalSeconds = Math.max(0, Math.floor((now - Date.parse(session.startedAt) - pausedMs) / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatQuantity(value: number) {
  return value.toLocaleString("sv-SE", { maximumFractionDigits: 4 });
}

// Planned vs. reported on one operation. Kvar is planned − OK only: scrapped
// units have to be made again, so they don't shrink what remains.
export function operationProgress(orderQuantity: string, completed: string | null, scrapped: string) {
  const planned = Number(orderQuantity);
  const ok = Number(completed ?? 0);
  return { planned, ok, scrapped: Number(scrapped), remaining: Math.max(planned - ok, 0) };
}

export type OperationProgress = ReturnType<typeof operationProgress>;
