import { eq } from "drizzle-orm";
import { systemSettings, type Db, type Tx } from "@navet/db";
import { decodeLongOperationWeeks, PLANNING_LONG_OPERATION_WEEKS_KEY } from "../service/plan-settings.js";

// The planner's Orimligt mycket tid limit, read in the planning run's own
// transaction (Db | Tx like loadDeliveryContext).
export async function loadLongOperationWeeks(dbc: Db | Tx): Promise<number> {
  const [row] = await dbc
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, PLANNING_LONG_OPERATION_WEEKS_KEY));
  return decodeLongOperationWeeks(row?.value);
}
