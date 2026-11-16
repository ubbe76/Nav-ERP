import { afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, systemSettings } from "@navet/db";
import { MULTIPLE_WAREHOUSES_KEY } from "../../src/modules/stock/service/warehouse-mode.js";

// Flera lager is off by default, and then a second warehouse in use is
// refused (stock/service/warehouse-mode.ts). A test file whose fixtures use
// two warehouses calls this at the top level: the setting is on before each
// of its tests and gone after the file, so the next file in the same worker
// database starts from the default again.
export function allowMultipleWarehouses(): void {
  beforeEach(async () => {
    await db
      .insert(systemSettings)
      .values({ key: MULTIPLE_WAREHOUSES_KEY, value: "true" })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: "true" } });
  });
  afterAll(async () => {
    await db.delete(systemSettings).where(eq(systemSettings.key, MULTIPLE_WAREHOUSES_KEY));
  });
}
