// Orimligt mycket tid (Planera, ny TO): how many normal weeks of its
// resource's capacity one operation's remaining time may fill before the
// planner warns. A leaf like posting-settings.ts — the key, the default and
// the decode live here so the settings page and the planning engine can
// never read the value differently.
export const PLANNING_LONG_OPERATION_WEEKS_KEY = "planning_long_operation_weeks";
export const DEFAULT_LONG_OPERATION_WEEKS = 4;

// Absent or junk ⇒ the default; 0 = no warning.
export function decodeLongOperationWeeks(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_LONG_OPERATION_WEEKS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LONG_OPERATION_WEEKS;
}
