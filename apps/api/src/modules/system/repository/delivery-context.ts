import { and, gte, inArray, isNull, lte } from "drizzle-orm";
import { holidays, systemSettings, type Db, type Tx } from "@navet/db";
import {
  decodeDeliveryDefaults,
  DELIVERY_SETTING_KEYS,
  type DeliveryDefaults,
} from "../service/delivery-days.js";

// Fasta leveransdagar: what the pure delivery-days.ts rules need from the
// database — the system defaults for mode/transit days and the holiday
// register's full days off in the window (deliveryHolidayWindow). A holiday
// WITH a day schedule is a shortened working day, not off. Db | Tx like
// resolveStockLocation, so purchase, sales and planning can all call it.
export async function loadDeliveryContext(
  dbc: Db | Tx,
  window: { from: string; to: string }
): Promise<{ defaults: DeliveryDefaults; offDays: Set<string> }> {
  const settingRows = await dbc
    .select({ key: systemSettings.key, value: systemSettings.value })
    .from(systemSettings)
    .where(inArray(systemSettings.key, Object.values(DELIVERY_SETTING_KEYS)));
  const byKey = new Map(settingRows.map((r) => [r.key, r.value] as const));

  const holidayRows = await dbc
    .select({ date: holidays.date })
    .from(holidays)
    .where(and(gte(holidays.date, window.from), lte(holidays.date, window.to), isNull(holidays.dayScheduleId)));

  return {
    defaults: decodeDeliveryDefaults((key) => byKey.get(key)),
    offDays: new Set(holidayRows.map((r) => r.date)),
  };
}
