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

// Standardledtid and Standardkötid för tillverkning (working days), read by
// the planning repository with the rest of the dating inputs and applied by
// manufacturing-lead-time.ts: the Standardledtid is a manufactured article's
// lead time when the field Ledtid (dagar) is empty AND it has no operations
// (no routing — or an existing TO without any); the Standardkötid is waited
// BETWEEN consecutive operations when the lead time comes from them. Both
// default to 0 (= today's behaviour); at most one decimal like a resource's
// Kötid (dagar), never above 60 — longer than that is a typo, not a lead
// time. They do not touch Planera or Leveranstidskontrollen's capacity book.
export const PLANNING_DEFAULT_LEAD_TIME_DAYS_KEY = "planning_default_lead_time_days";
export const PLANNING_QUEUE_TIME_DAYS_KEY = "planning_queue_time_days";
export const DEFAULT_LEAD_TIME_DAYS = 0;
export const DEFAULT_QUEUE_TIME_DAYS = 0;
export const MAX_LEAD_TIME_SETTING_DAYS = 60;

// Absent, blank or junk (NaN, negative, above the cap) ⇒ the default; the
// value is kept to one decimal so a hand-edited row can never leak more.
export function decodeLeadTimeSettingDays(raw: string | null | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_LEAD_TIME_SETTING_DAYS) return fallback;
  return Math.round(parsed * 10) / 10;
}

// The pair as manufacturing-lead-time.ts takes it (LeadTimeDefaults), from
// a key → raw value lookup, so the settings page and the planning run can
// never read the two values differently.
export function decodeLeadTimeDefaults(get: (key: string) => string | null | undefined): {
  defaultLeadDays: number;
  queueDays: number;
} {
  return {
    defaultLeadDays: decodeLeadTimeSettingDays(get(PLANNING_DEFAULT_LEAD_TIME_DAYS_KEY), DEFAULT_LEAD_TIME_DAYS),
    queueDays: decodeLeadTimeSettingDays(get(PLANNING_QUEUE_TIME_DAYS_KEY), DEFAULT_QUEUE_TIME_DAYS),
  };
}
