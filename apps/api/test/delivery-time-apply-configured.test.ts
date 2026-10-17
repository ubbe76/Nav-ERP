import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, moOperationPlanWeeks } from "@navet/db";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService, type ManufacturingPlanReader } from "../src/modules/planning/service/planning.service.js";
import { CONFIGURED_MFG_TRUNCATE, confirmedRow, resetCostingSettings } from "./helpers/configured-manufacturing.js";
import { configurator, makeUser, purchaseService, resetConfiguredRows, salesRepository, salesService } from "./helpers/configured-rows.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Reservationen on a configured (beställningsvara) KO row: the TO goes the
// createFromSalesOrderRow way inside the reservation's transaction — the
// structure is derived from the row — and is planned in the weeks the check
// booked for the derived operations (10 and 20; the Kalkyl operation 30 is
// never on a TO). The resources have no schedule, so every operation lands
// whole in the floor's week.

beforeEach(async () => {
  await resetConfiguredRows();
  await db.execute(CONFIGURED_MFG_TRUNCATE);
  await resetCostingSettings();
});
afterAll(resetConfiguredRows);

// The manufacturing service as app.ts wires it for 4c + the plan reader.
const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
const mfg = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  (t, s, q, o) => configurator.deriveForManufacturing(t, s, q, o),
  undefined,
  undefined,
  {
    planNewOrderInTx: (tx, moId, given) => planReaderRef.current!.planNewOrderInTx(tx, moId, given),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
  }
);
const planning = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseService as never,
  manufacturing: mfg,
  configuredStructure: (t, s, q, o) => configurator.deriveForManufacturing(t, s, q, o),
  requirementsCacheMs: 0,
  salesOrderDates: salesService,
});
planReaderRef.current = planning;

async function planRows(opId: string) {
  const rows = await db
    .select({ monday: moOperationPlanWeeks.weekMonday, minutes: moOperationPlanWeeks.minutes })
    .from(moOperationPlanWeeks)
    .where(eq(moOperationPlanWeeks.moOperationId, opId))
    .orderBy(moOperationPlanWeeks.weekMonday);
  return rows.map((r) => ({ monday: r.monday, minutes: Number(r.minutes) }));
}

describe("reservationen — configured row", () => {
  it("creates the row's configured TO with the check's weeks on the derived operations", async () => {
    const user = await makeUser();
    const { order, row } = await confirmedRow(2);
    const check = await planning.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.deliveryDate).not.toBeNull();
    expect(check.batches).toHaveLength(1);
    const batch = check.batches[0]!;
    expect(batch).toMatchObject({ level: 1, rowKey: row.id, quantity: 2 });
    expect(batch.operations.map((o) => o.sequenceNo)).toEqual([10, 20]);
    // Op 10: setup 6 + 2 × 3 = 12 min; op 20 (LOCK B): 2 × 4 = 8 min, both
    // whole in one week (no schedule = unlimited).
    expect(batch.operations.map((o) => o.weeks.map((w) => w.minutes))).toEqual([[12], [8]]);

    const applied = await planning.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate! }, user.id);
    expect(applied.manufacturingOrders).toEqual([
      expect.objectContaining({ level: 1, quantity: 2, salesOrderRowId: row.id }),
    ]);
    const mo = (await mfg.getManufacturingOrder(applied.manufacturingOrders[0]!.id))!;
    // The release's shortage warnings for the derived material (nothing in
    // stock), prefixed with the TO number — warnings, never a refusal.
    expect(applied.warnings).toEqual(
      ["Avlopp: behöver 2, tillgängligt 0", "Del 1: behöver 4, tillgängligt 0", "Del 2: behöver 2, tillgängligt 0", "Plåt: behöver 2.4, tillgängligt 0", "Skruv: behöver 16, tillgängligt 0"].map(
        (w) => `${mo.orderNumber}: ${w}`
      )
    );
    expect(mo.salesOrderRowId).toBe(row.id);
    expect(mo.configuration).not.toBeNull();
    expect(mo.configuration!.key).toBe(row.configuration!.key);
    const ops = await mfg.listOperations(mo.id);
    expect(ops.map((o) => o.sequenceNo)).toEqual([10, 20]);
    expect(await planRows(ops[0]!.id)).toEqual(batch.operations[0]!.weeks);
    expect(await planRows(ops[1]!.id)).toEqual(batch.operations[1]!.weeks);
    const after = await salesService.getSalesOrder(order.id);
    expect(after).toMatchObject({ status: "in_production", expectedDeliveryDate: check.deliveryDate });
  });
});
