import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, moOperationPlanWeeks } from "@navet/db";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService, NothingToReserveError, type ManufacturingPlanReader } from "../src/modules/planning/service/planning.service.js";
import { buildToOrderWithStructure, CONFIGURED_MFG_TRUNCATE, confirmedRow, FULL, resetCostingSettings } from "./helpers/configured-manufacturing.js";
import { configurator, makeCustomer, makeUser, purchaseService, resetConfiguredRows, salesRepository, salesService } from "./helpers/configured-rows.js";
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
    // The promised weeks are locked.
    expect(ops.map((o) => o.planLocked)).toEqual([true, true]);

    // The row now has its TO: the next check nets it (the same rule as
    // behovsberäkningen's uncoveredConfiguredQuantity), shows the TO in the
    // chain and finds nothing to make — a second reservation is refused,
    // never a second TO for the same row.
    const again = await planning.checkDeliveryTime({ salesOrderId: order.id });
    expect(again.batches).toEqual([]);
    expect(again.rows[0]).toMatchObject({ quantity: 2, readyDate: expect.any(String), notes: [] });
    expect(again.rows[0]!.chain).toEqual([
      expect.objectContaining({ kind: "supply", documentType: "manufacturing_order", documentNumber: mo.orderNumber, quantity: 2 }),
    ]);
    expect(again.deliveryDate).toBe(check.deliveryDate);
    await expect(planning.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: again.deliveryDate! }, user.id)).rejects.toBeInstanceOf(
      NothingToReserveError
    );
    expect(await mfg.coverageForSalesOrderRows([row.id])).toEqual(new Map([[row.id, expect.objectContaining({ quantity: 2 })]]));
  });

  it("rounds the batch up to the template's step and answers with the TO's own quantity", async () => {
    const user = await makeUser();
    const { s, order, row } = await confirmedRow(2);
    // Set after the order so the row itself stays 2 (the sales row is
    // rounded too, on its own).
    await testArticleService.updateArticle(s.article.id, { rounding: 5 } as never);
    const check = await planning.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.rows[0]).toMatchObject({ quantity: 2 });
    expect(check.batches[0]).toMatchObject({ rowKey: row.id, quantity: 5 });
    // The structure is derived for the batch: op 10 is 6 + 5 × 3 = 21 min.
    expect(check.batches[0]!.operations[0]!.weeks.map((w) => w.minutes)).toEqual([21]);

    const applied = await planning.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate!, expectedOrders: 1 }, user.id);
    expect(applied.manufacturingOrders[0]).toMatchObject({ quantity: 5, salesOrderRowId: row.id });
    const mo = (await mfg.getManufacturingOrder(applied.manufacturingOrders[0]!.id))!;
    expect(Number(mo.quantity)).toBe(5);
    expect(applied.warnings).toContain(`${mo.orderNumber}: Skruv: behöver 40, tillgängligt 0`);
    // The plan written is the check's (21 minutes), not a re-plan.
    const ops = await mfg.listOperations(mo.id);
    expect(await planRows(ops[0]!.id)).toEqual(check.batches[0]!.operations[0]!.weeks);
  });

  it("locks every KO row before the first TO: a row edit during the reservation waits instead of deadlocking", async () => {
    const user = await makeUser();
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order, rows } = await salesService.createQuote(
      {
        customerId: c.id,
        confirm: true,
        rows: [
          { articleId: s.article.id, quantity: 1, configuration: { selection: FULL } },
          { articleId: s.article.id, quantity: 2, configuration: { selection: { ...FULL, AVLOPP: false } } },
        ],
      } as never,
      null
    );
    const check = await planning.checkDeliveryTime({ salesOrderId: order.id });
    expect(check.batches.map((b) => [b.rowKey, b.quantity])).toEqual([
      [rows[0]!.id, 1],
      [rows[1]!.id, 2],
    ]);

    // While the first TO is being created the reservation already holds
    // both rows (advisory → rows → order header): an edit of row 2 blocks
    // on its row lock until the commit. Without the up-front row locks the
    // edit would take row 2 and wait for the header (held since TO 1's
    // markInProduction) while TO 2 waits for row 2 — a deadlock.
    let edit: Promise<unknown> | null = null;
    const racing = createPlanningService(createPlanningRepository(db), {
      purchase: purchaseService as never,
      manufacturing: {
        ...mfg,
        createManufacturingOrderInTx: async (tx, input, createdBy, opts) => {
          if (!edit) {
            edit = salesService.updateRow(order.id, rows[1]!.id, { unitPrice: 999 }, user.id);
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
          return mfg.createManufacturingOrderInTx(tx, input, createdBy, opts);
        },
      },
      configuredStructure: (t, sel, q, o) => configurator.deriveForManufacturing(t, sel, q, o),
      requirementsCacheMs: 0,
      salesOrderDates: salesService,
    });
    let applied;
    try {
      applied = await racing.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: check.deliveryDate!, expectedOrders: 2 }, user.id);
    } finally {
      // Never leave the edit running into the next test's truncate.
      if (edit) await (edit as Promise<unknown>).catch(() => undefined);
    }
    expect(applied.manufacturingOrders.map((m) => [m.salesOrderRowId, m.quantity])).toEqual([
      [rows[0]!.id, 1],
      [rows[1]!.id, 2],
    ]);
    // The edit went through after the commit (the row → TO links are the
    // salesOrderRowIds above — this salesService has no coverage reader).
    await edit!;
    const after = await salesService.listRows(order.id);
    expect(after.map((r) => Number(r.unitPrice))).toEqual([Number(rows[0]!.unitPrice), 999]);
    expect(await salesService.getSalesOrder(order.id)).toMatchObject({ status: "in_production", expectedDeliveryDate: check.deliveryDate });
  });
});
