// Alternativa resurser (#15) — small pure helpers for the beredning's
// alternative-resource editor. The rules themselves live on the server
// (routing-alternatives.ts); the web only keeps the list tidy.

// Mirrors MAX_ROUTING_ALTERNATIVES in packages/shared/src/manufacturing.ts.
export const MAX_ROUTING_ALTERNATIVES = 5;

// A suggestion never lands on a resource without a week schedule or hours per
// day (the planning's hasCapacityCalendar rule) — shown as a warning.
export function workCenterHasCapacity(wc: { weekScheduleId: string | null; hoursPerDay: string | null }): boolean {
  return wc.weekScheduleId != null || wc.hoursPerDay != null;
}

// The list's order is the rank: moves the row at `index` one step, or returns
// the list as it is at either end.
export function moveItem<T>(rows: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
