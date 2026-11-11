import { roundToDecimals } from "@navet/shared";

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
  return roundToDecimals(parsed, 1);
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

// Prognos (#10): the history window (whole calendar months before the
// current one the average consumption is taken over) and the horizon (the
// current month plus the following ones that get a forecast demand). Whole
// months, 1–36 and 1–24; absent or junk ⇒ the defaults 12 and 6. The
// planning run and the settings page decode through this one function.
export const PLANNING_FORECAST_HISTORY_MONTHS_KEY = "planning_forecast_history_months";
export const PLANNING_FORECAST_HORIZON_MONTHS_KEY = "planning_forecast_horizon_months";
export const DEFAULT_FORECAST_HISTORY_MONTHS = 12;
export const DEFAULT_FORECAST_HORIZON_MONTHS = 6;
export const MAX_FORECAST_HISTORY_MONTHS = 36;
export const MAX_FORECAST_HORIZON_MONTHS = 24;

// Absent, blank or junk (NaN, not a whole number, below 1, above the cap)
// ⇒ the fallback.
export function decodeForecastMonths(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return fallback;
  return parsed;
}

export interface ForecastSettings {
  historyMonths: number;
  horizonMonths: number;
}

export function decodeForecastSettings(get: (key: string) => string | null | undefined): ForecastSettings {
  return {
    historyMonths: decodeForecastMonths(get(PLANNING_FORECAST_HISTORY_MONTHS_KEY), DEFAULT_FORECAST_HISTORY_MONTHS, MAX_FORECAST_HISTORY_MONTHS),
    horizonMonths: decodeForecastMonths(get(PLANNING_FORECAST_HORIZON_MONTHS_KEY), DEFAULT_FORECAST_HORIZON_MONTHS, MAX_FORECAST_HORIZON_MONTHS),
  };
}

// ABC-klassning (#10, etapp 2): the period (whole months before the current
// one the förbrukningsvärde is summed over, 1–36, default 12) and the class
// limits as cumulative percent of the total value — A while the cumulative
// share before the article is below the A limit, B while below the B limit,
// C the rest (defaults 80 and 95). The limits are a pair: 1 ≤ A < B ≤ 100,
// whole percent. A stored pair that breaks the rule (hand-edited rows, or
// one key written without the other) decodes to BOTH defaults, never to a
// half-valid pair. The planning read and the settings page decode here.
export const PLANNING_ABC_PERIOD_MONTHS_KEY = "planning_abc_period_months";
export const PLANNING_ABC_CLASS_A_PERCENT_KEY = "planning_abc_class_a_percent";
export const PLANNING_ABC_CLASS_B_PERCENT_KEY = "planning_abc_class_b_percent";
export const DEFAULT_ABC_PERIOD_MONTHS = 12;
export const DEFAULT_ABC_CLASS_A_PERCENT = 80;
export const DEFAULT_ABC_CLASS_B_PERCENT = 95;
export const MAX_ABC_PERIOD_MONTHS = 36;

export interface AbcLimits {
  aPercent: number;
  bPercent: number;
}

export interface AbcSettings extends AbcLimits {
  periodMonths: number;
}

// 1 ≤ A < B ≤ 100, both whole numbers — ONE rule for the decode, the PATCH
// (shared/system.ts mirrors it in zod) and the classification.
export function validAbcLimits(aPercent: unknown, bPercent: unknown): boolean {
  return (
    Number.isInteger(aPercent) &&
    Number.isInteger(bPercent) &&
    (aPercent as number) >= 1 &&
    (aPercent as number) < (bPercent as number) &&
    (bPercent as number) <= 100
  );
}

export function decodeAbcSettings(get: (key: string) => string | null | undefined): AbcSettings {
  const rawA = get(PLANNING_ABC_CLASS_A_PERCENT_KEY);
  const rawB = get(PLANNING_ABC_CLASS_B_PERCENT_KEY);
  const a = rawA == null || rawA.trim() === "" ? DEFAULT_ABC_CLASS_A_PERCENT : Number(rawA);
  const b = rawB == null || rawB.trim() === "" ? DEFAULT_ABC_CLASS_B_PERCENT : Number(rawB);
  const limits: AbcLimits = validAbcLimits(a, b)
    ? { aPercent: a, bPercent: b }
    : { aPercent: DEFAULT_ABC_CLASS_A_PERCENT, bPercent: DEFAULT_ABC_CLASS_B_PERCENT };
  return {
    periodMonths: decodeForecastMonths(get(PLANNING_ABC_PERIOD_MONTHS_KEY), DEFAULT_ABC_PERIOD_MONTHS, MAX_ABC_PERIOD_MONTHS),
    ...limits,
  };
}
