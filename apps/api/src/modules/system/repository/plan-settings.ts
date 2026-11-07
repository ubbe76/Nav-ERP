import { eq, inArray } from "drizzle-orm";
import { systemSettings, type Db, type Tx } from "@navet/db";
import {
  decodeAbcSettings,
  decodeForecastSettings,
  decodeLeadTimeDefaults,
  decodeLongOperationWeeks,
  PLANNING_ABC_CLASS_A_PERCENT_KEY,
  PLANNING_ABC_CLASS_B_PERCENT_KEY,
  PLANNING_ABC_PERIOD_MONTHS_KEY,
  PLANNING_DEFAULT_LEAD_TIME_DAYS_KEY,
  PLANNING_FORECAST_HISTORY_MONTHS_KEY,
  PLANNING_FORECAST_HORIZON_MONTHS_KEY,
  PLANNING_LONG_OPERATION_WEEKS_KEY,
  PLANNING_QUEUE_TIME_DAYS_KEY,
  type AbcSettings,
  type ForecastSettings,
} from "../service/plan-settings.js";

// The planner's Orimligt mycket tid limit, read in the planning run's own
// transaction (Db | Tx like loadDeliveryContext).
export async function loadLongOperationWeeks(dbc: Db | Tx): Promise<number> {
  const [row] = await dbc
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, PLANNING_LONG_OPERATION_WEEKS_KEY));
  return decodeLongOperationWeeks(row?.value);
}

// Standardledtid and Standardkötid in ONE query, read together with the
// dating inputs once per planning run (Db | Tx for the same reason).
export async function loadLeadTimeDefaults(dbc: Db | Tx): Promise<{ defaultLeadDays: number; queueDays: number }> {
  const rows = await dbc
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, [PLANNING_DEFAULT_LEAD_TIME_DAYS_KEY, PLANNING_QUEUE_TIME_DAYS_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return decodeLeadTimeDefaults((key) => byKey.get(key));
}

// Prognos (#10): the history window and the horizon in ONE query, read once
// per planning run / overview batch / forecast read (Db | Tx).
export async function loadForecastSettings(dbc: Db | Tx): Promise<ForecastSettings> {
  const rows = await dbc
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, [PLANNING_FORECAST_HISTORY_MONTHS_KEY, PLANNING_FORECAST_HORIZON_MONTHS_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return decodeForecastSettings((key) => byKey.get(key));
}

// ABC-klassning (#10, etapp 2): the period and the two class limits in ONE
// query, read once per classification (Db | Tx).
export async function loadAbcSettings(dbc: Db | Tx): Promise<AbcSettings> {
  const rows = await dbc
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, [PLANNING_ABC_PERIOD_MONTHS_KEY, PLANNING_ABC_CLASS_A_PERCENT_KEY, PLANNING_ABC_CLASS_B_PERCENT_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return decodeAbcSettings((key) => byKey.get(key));
}
