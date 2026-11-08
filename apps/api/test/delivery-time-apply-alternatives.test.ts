import { createArticleSchema, createCustomerSchema, createWeekScheduleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, manufacturingOrders, moOperationPlanWeeks, moOperations, salesOrders } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { lockProductionPlan } from "../src/modules/planning/repository/plan-lock.js";
import {
  createPlanningService,
  DeliveryTimeChangedError,
  type ManufacturingPlanReader,
} from "../src/modules/planning/service/planning.service.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { parsed } from "./helpers/parsed.js";

// Alternativa resurser (#15, etapp 3) — Leveranstidskontrollen and the
// reservation against Postgres. The check runs with and without the
// alternatives on the same input; the reservation (Skapa tillverkningsordrar
// för det som saknas) reruns it under the production_plan lock in the mode
// the client chose and writes the alternative as Vald för hand — only on the
// operations the check put on one. "Today" is pinned to Monday 2030-03-04 as
// in delivery-time-apply.integration.test.ts.
const W1 = "2030-03-04";
const W2 = "2030-03-11";
const W3 = "2030-03-18";
const TODAY = W1;

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const stockService = createStockService(createStockRepository(db));
const salesRepository = createSalesRepository(db);
const auditEntries: { entityType: string; entityId: string | null; action: string; detail?: unknown }[] = [];

const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  undefined,
  undefined,
  undefined,
  {
    planNewOrderInTx: (tx, moId, given, opts) => planReaderRef.current!.planNewOrderInTx(tx, moId, given, opts),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
    operationResourceSuggestions: (moId) => planReaderRef.current!.operationResourceSuggestions!(moId),
  }
);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  undefined,
  mfgService
);
const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
  isDateLocked: async () => false,
});
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: {
    createPurchaseOrder: async () => {
      throw new Error("not used");
    },
    addRow: async () => {},
    cancel: async () => {},
  },
  manufacturing: mfgService,
  requirementsCacheMs: 0,
  today: () => TODAY,
  audit: {
    async log(entry) {
      auditEntries.push({ entityType: entry.entityType, entityId: entry.entityId, action: entry.action, detail: entry.detail });
    },
  },
  salesOrderDates: salesService,
});
planReaderRef.current = planningService;

const TRUNCATE = sql`TRUNCATE mo_operation_plan_weeks, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, sales_order_rows, sales_orders, customers, routing_operations, work_centers, production_groups, holidays, week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  auditEntries.length = 0;
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function planRows(opId: string) {
  const rows = await db
    .select({ monday: moOperationPlanWeeks.weekMonday, minutes: moOperationPlanWeeks.minutes })
    .from(moOperationPlanWeeks)
    .where(eq(moOperationPlanWeeks.moOperationId, opId))
    .orderBy(moOperationPlanWeeks.weekMonday);
  return rows.map((r) => ({ monday: r.monday, minutes: Number(r.minutes) }));
}

async function orderCount() {
  return (await db.select({ id: manufacturingOrders.id }).from(manufacturingOrders)).length;
}

async function allOperations() {
  return db
    .select({ id: moOperations.id, workCenterId: moOperations.workCenterId, resourceLocked: moOperations.resourceLocked, planLocked: moOperations.planLocked })
    .from(moOperations)
    .orderBy(moOperations.id);
}

async function salesOrderRow(id: string) {
  const [row] = await db
    .select({ status: salesOrders.status, expectedDeliveryDate: salesOrders.expectedDeliveryDate })
    .from(salesOrders)
    .where(eq(salesOrders.id, id));
  return row!;
}

// 110 Kantpress, 120 Kantpress 2 and 130 Svets on a 40 h week. The product:
// Op 10 on 110 (60 min/st) with 120 as an alternative "som ordinarie", then
// Op 20 on 130 (6 min/st, no alternatives). A filler TO of 40 h on 110 is
// released first, so 110 is full in W1.
//   Only the ordinarie: Op 10 (10 st = 10 h) in W2, ready Friday 15 March,
//   shipped Monday W3.
//   With the alternative: Op 10 on 120 in W1, Op 20 in W1, ready Friday
//   8 March, shipped Monday W2.
async function seedWorld(opts: { fill110?: boolean } = { fill110: true }) {
  const user = await authRepo.create({ email: `alt3-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Säljare", role: "admin" });
  const day = await scheduleService.createDaySchedule({ code: "D8", name: "Dagtid 8h", startTime: "07:00", endTime: "15:00", breaks: [], active: true });
  const week = await scheduleService.createWeekSchedule(parsed(createWeekScheduleSchema, {
    code: "VS40",
    name: "Veckoschema 40h",
    days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
    active: true,
  }));
  const wc = (code: string, name: string) => mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code, name, weekScheduleId: week.id, capacityFactor: 1, active: true }));
  const r110 = await wc("110", "Kantpress");
  const r120 = await wc("120", "Kantpress 2");
  const r130 = await wc("130", "Svets");
  const product = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID().slice(0, 6)}`, name: "Produkt", type: "manufactured", active: true }));
  await mfgService.createRoutingOperation(product.id, {
    sequenceNo: 10,
    workCenterId: r110.id,
    setupTime: 0,
    runTimePerUnit: 60,
    alternatives: [{ workCenterId: r120.id }],
  });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 20, workCenterId: r130.id, setupTime: 0, runTimePerUnit: 6 });
  const fillerArticle = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `F-${crypto.randomUUID().slice(0, 6)}`, name: "Fyllnad", type: "manufactured", active: true }));
  await mfgService.createRoutingOperation(fillerArticle.id, { sequenceNo: 10, workCenterId: r110.id, setupTime: 2400, runTimePerUnit: 0 });
  const filler120 = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `G-${crypto.randomUUID().slice(0, 6)}`, name: "Fyllnad 120", type: "manufactured", active: true }));
  await mfgService.createRoutingOperation(filler120.id, { sequenceNo: 10, workCenterId: r120.id, setupTime: 2400, runTimePerUnit: 0 });
  if (opts.fill110) await mfgService.createManufacturingOrder({ articleId: fillerArticle.id, quantity: 1 }, user.id);
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  const { order, rows } = await salesService.createQuote(
    { customerId: customer.id, confirm: true, rows: [{ articleId: product.id, quantity: 10, unitPrice: 100 }] },
    user.id
  );
  return { user, week, wc, r110, r120, r130, product, fillerArticle, filler120, customer, order, row: rows[0]! };
}

// A manufactured article with one operation per entry (setup minutes,
// minutes per piece, alternatives) — the extra worlds below.
async function madeArticle(
  prefix: string,
  operations: { workCenterId: string; setupTime?: number; runTimePerUnit?: number; alternatives?: { workCenterId: string; runTimePerUnit?: number }[] }[]
) {
  const article = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `${prefix}-${crypto.randomUUID().slice(0, 6)}`, name: prefix, type: "manufactured", active: true }));
  for (const [i, o] of operations.entries()) {
    await mfgService.createRoutingOperation(article.id, {
      sequenceNo: (i + 1) * 10,
      workCenterId: o.workCenterId,
      setupTime: o.setupTime ?? 0,
      runTimePerUnit: o.runTimePerUnit ?? 0,
      ...(o.alternatives ? { alternatives: o.alternatives } : {}),
    });
  }
  return article;
}

const opStep = (check: { rows: { chain: unknown[] }[] }, sequenceNo: number) =>
  check.rows[0]!.chain.find((s) => (s as { kind: string; sequenceNo?: number }).kind === "operation" && (s as { sequenceNo: number }).sequenceNo === sequenceNo) as
    | Record<string, unknown>
    | undefined;

describe("Leveranstidskontrollen med alternativa resurser", () => {
  it("a full ordinarie: the date with the alternative, the ordinarie's date beside it, and the resource per operation", async () => {
    const w = await seedWorld();
    const check = await planningService.checkDeliveryTime({ salesOrderId: w.order.id });
    expect(check).toMatchObject({
      usesAlternatives: true,
      shipDate: W2,
      deliveryDate: W2,
      ordinaryShipDate: W3,
      ordinaryDeliveryDate: W3,
    });
    expect(check.rows[0]).toMatchObject({ readyDate: "2030-03-08", ordinaryReadyDate: "2030-03-15" });
    expect(opStep(check, 10)).toMatchObject({
      workCenterCode: "120",
      fromWeek: W1,
      toWeek: W1,
      alternativeOf: { workCenterId: w.r110.id, workCenterCode: "110", workCenterName: "Kantpress", toWeek: W2 },
    });
    expect(opStep(check, 20)).toMatchObject({ workCenterCode: "130", alternativeOf: null });
    // Every operation of the batch names the resource it was placed on.
    expect(check.batches.map((b) => b.operations.map((o) => [o.sequenceNo, o.workCenterId, o.workCenterCode, o.alternativeOf?.workCenterCode ?? null, o.weeks]))).toEqual([
      [
        [10, w.r120.id, "120", "110", [{ monday: W1, minutes: 600 }]],
        [20, w.r130.id, "130", null, [{ monday: W1, minutes: 60 }]],
      ],
    ]);
  });

  it("equal weeks keep the ordinarie: 110 free, or 120 full the same week — one date, no alternative", async () => {
    const free = await seedWorld({ fill110: false });
    const check = await planningService.checkDeliveryTime({ salesOrderId: free.order.id });
    expect(check).toMatchObject({ usesAlternatives: false, deliveryDate: W2, ordinaryDeliveryDate: null, ordinaryShipDate: null });
    expect(opStep(check, 10)).toMatchObject({ workCenterCode: "110", alternativeOf: null });
    expect(check.batches[0]!.operations[0]!.workCenterId).toBe(free.r110.id);

    await db.execute(TRUNCATE);
    const tie = await seedWorld();
    await mfgService.createManufacturingOrder({ articleId: tie.filler120.id, quantity: 1 }, tie.user.id);
    const tied = await planningService.checkDeliveryTime({ salesOrderId: tie.order.id });
    expect(tied).toMatchObject({ usesAlternatives: false, deliveryDate: W3, ordinaryDeliveryDate: null });
    expect(tied.batches[0]!.operations[0]!.workCenterId).toBe(tie.r110.id);
  });
});

describe("reservationen med alternativa resurser", () => {
  it("writes the alternative as Vald för hand only where the check put one, locks the weeks with it, and logs the switch", async () => {
    const w = await seedWorld();
    const check = await planningService.checkDeliveryTime({ salesOrderId: w.order.id });
    const applied = await planningService.applyDeliveryTime({ salesOrderId: w.order.id, deliveryDate: check.deliveryDate!, expectedOrders: 1 }, w.user.id);
    const switch10 = { sequenceNo: 10, fromWorkCenterId: w.r110.id, fromCode: "110", toWorkCenterId: w.r120.id, toCode: "120" };
    expect(applied).toMatchObject({
      deliveryDate: W2,
      shipDate: W2,
      usesAlternatives: true,
      manufacturingOrders: [expect.objectContaining({ level: 1, salesOrderRowId: w.row.id, resourceSwitches: [switch10] })],
    });
    const moId = applied.manufacturingOrders[0]!.id;
    const ops = await mfgService.listOperations(moId);
    // Op 10 on 120 with the row's times, Vald för hand, its weeks the check's
    // and locked; Op 20 stayed on its ordinarie — not flagged.
    expect(ops.map((o) => [o.sequenceNo, o.workCenterId, o.resourceLocked, o.planLocked, o.setupTime, o.runTimePerUnit])).toEqual([
      [10, w.r120.id, true, true, "0.00", "60.0000"],
      [20, w.r130.id, false, true, "0.00", "6.0000"],
    ]);
    expect(ops[0]!.resources.map((r) => [r.code, r.rank])).toEqual([
      ["110", 0],
      ["120", 1],
    ]);
    expect(await planRows(ops[0]!.id)).toEqual([{ monday: W1, minutes: 600 }]);
    expect(await planRows(ops[1]!.id)).toEqual([{ monday: W1, minutes: 60 }]);
    expect(await salesOrderRow(w.order.id)).toEqual({ status: "in_production", expectedDeliveryDate: W2 });
    // Vald för hand: no förslag back to 110, and Planera keeps it all.
    expect(ops[0]!.suggestion).toBeNull();
    await planningService.planProductionRun(w.user.id);
    expect((await mfgService.listOperations(moId)).map((o) => [o.workCenterId, o.resourceLocked, o.planLocked])).toEqual([
      [w.r120.id, true, true],
      [w.r130.id, false, true],
    ]);

    const mo = applied.manufacturingOrders[0]!;
    expect(auditEntries.filter((e) => e.action === "released" || e.action === "delivery_time_applied")).toEqual([
      {
        entityType: "manufacturing_order",
        entityId: mo.orderNumber,
        action: "released",
        detail: { resourceSwitches: [{ sequenceNo: 10, fromCode: "110", toCode: "120" }] },
      },
      {
        entityType: "sales_order",
        entityId: w.order.orderNumber,
        action: "delivery_time_applied",
        detail: expect.objectContaining({
          deliveryDate: W2,
          usesAlternatives: true,
          manufacturingOrders: [expect.objectContaining({ orderNumber: mo.orderNumber, resourceSwitches: [{ sequenceNo: 10, fromCode: "110", toCode: "120" }] })],
        }),
      },
    ]);
  });

  it("Med ordinarie resurser (useAlternatives false) makes the TO on the ordinarie; the other date is refused in that mode", async () => {
    const w = await seedWorld();
    const check = await planningService.checkDeliveryTime({ salesOrderId: w.order.id });
    expect(check.ordinaryDeliveryDate).toBe(W3);
    // The alternative's date in the ordinarie mode: a changed outcome, nothing written.
    const failure = await planningService
      .applyDeliveryTime({ salesOrderId: w.order.id, deliveryDate: W2, useAlternatives: false }, w.user.id)
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(DeliveryTimeChangedError);
    expect((failure as DeliveryTimeChangedError).deliveryDate).toBe(W3);
    // The body is the check's own answer, both dates again.
    expect((failure as DeliveryTimeChangedError).result).toMatchObject({ usesAlternatives: true, deliveryDate: W2, ordinaryDeliveryDate: W3 });
    expect(await orderCount()).toBe(1);

    const applied = await planningService.applyDeliveryTime(
      { salesOrderId: w.order.id, deliveryDate: check.ordinaryDeliveryDate!, useAlternatives: false },
      w.user.id
    );
    expect(applied).toMatchObject({ deliveryDate: W3, usesAlternatives: false, manufacturingOrders: [expect.objectContaining({ resourceSwitches: [] })] });
    const ops = await mfgService.listOperations(applied.manufacturingOrders[0]!.id);
    expect(ops.map((o) => [o.sequenceNo, o.workCenterId, o.resourceLocked, o.planLocked])).toEqual([
      [10, w.r110.id, false, true],
      [20, w.r130.id, false, true],
    ]);
    expect(await planRows(ops[0]!.id)).toEqual([{ monday: W2, minutes: 600 }]);
    expect(auditEntries.find((e) => e.action === "released")).toMatchObject({ detail: undefined });
  });

  it("Använd datumet (the KO date alone) writes no resource and no TO", async () => {
    const w = await seedWorld();
    const before = await allOperations();
    const check = await planningService.checkDeliveryTime({ salesOrderId: w.order.id });
    expect(check.usesAlternatives).toBe(true);
    await salesService.updateSalesOrderHeader(w.order.id, { expectedDeliveryDate: check.deliveryDate! }, w.user.id);
    expect(await salesOrderRow(w.order.id)).toMatchObject({ expectedDeliveryDate: W2 });
    expect(await orderCount()).toBe(1); // the filler only
    expect(await allOperations()).toEqual(before);
  });

  it("a TO whose operation cannot take the check's resource is planned by the engine on the ordinarie, with the warning", async () => {
    const w = await seedWorld({ fill110: false });
    const created = await db.transaction((tx) =>
      mfgService.createManufacturingOrderInTx(tx, { articleId: w.product.id, quantity: 10, dueDate: W2 }, w.user.id, {
        // 130 is no possible resource of Op 10.
        plannedWeeks: [
          { sequenceNo: 10, workCenterId: w.r130.id, weeks: [{ monday: W2, minutes: 600 }] },
          { sequenceNo: 20, workCenterId: w.r130.id, weeks: [{ monday: W2, minutes: 60 }] },
        ],
      })
    );
    expect(created.releaseWarnings).toEqual([expect.stringContaining("stämmer inte med leveranstidskontrollens")]);
    const ops = await mfgService.listOperations(created.id);
    expect(ops.map((o) => [o.workCenterId, o.resourceLocked])).toEqual([
      [w.r110.id, false],
      [w.r130.id, false],
    ]);
    // The engine's own plan: this week, on free capacity.
    expect(await planRows(ops[0]!.id)).toEqual([{ monday: W1, minutes: 600 }]);
  });

  it("races a concurrent change: the reservation waits for the plan lock, reruns the check and refuses the date that no longer holds", async () => {
    const w = await seedWorld();
    const check = await planningService.checkDeliveryTime({ salesOrderId: w.order.id });
    expect(check).toMatchObject({ usesAlternatives: true, deliveryDate: W2 });

    // A TO that fills 120 in W1 is being created (its transaction holds the
    // production_plan lock) while the reservation starts.
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    let created!: () => void;
    const inside = new Promise<void>((resolve) => (created = resolve));
    const concurrent = db.transaction(async (tx) => {
      await lockProductionPlan(tx);
      await mfgService.createManufacturingOrderInTx(tx, { articleId: w.filler120.id, quantity: 1 }, w.user.id);
      created();
      await holding;
    });
    await inside;
    const reservation = planningService.applyDeliveryTime({ salesOrderId: w.order.id, deliveryDate: W2, expectedOrders: 1 }, w.user.id);
    // Released even when the wait fails, so the open transaction never hangs the file.
    await waitForLockWaiter().finally(open);
    const [first, second] = await Promise.allSettled([concurrent, reservation]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    // Under the lock it saw the committed filler: 120 is full in W1 too, so
    // the alternative is no earlier — the date is the ordinarie's W3.
    const changed = (second as PromiseRejectedResult).reason as DeliveryTimeChangedError;
    expect(changed).toBeInstanceOf(DeliveryTimeChangedError);
    expect(changed.deliveryDate).toBe(W3);
    expect(changed.result).toMatchObject({ usesAlternatives: false, deliveryDate: W3 });
    expect(await orderCount()).toBe(2); // the two fillers, nothing of the reservation's
    expect(await salesOrderRow(w.order.id)).toMatchObject({ status: "confirmed", expectedDeliveryDate: null });

    // The new date goes through, on the ordinarie, nothing Vald för hand.
    const applied = await planningService.applyDeliveryTime({ salesOrderId: w.order.id, deliveryDate: W3 }, w.user.id);
    expect(applied).toMatchObject({ usesAlternatives: false, manufacturingOrders: [expect.objectContaining({ resourceSwitches: [] })] });
    expect((await mfgService.listOperations(applied.manufacturingOrders[0]!.id))[0]).toMatchObject({ workCenterId: w.r110.id, resourceLocked: false });
  });
});

// The reservation's planning service with another manufacturing service —
// to step in between the check under the lock and a TO's snapshot.
function planningServiceWith(manufacturing: typeof mfgService) {
  return createPlanningService(createPlanningRepository(db), {
    purchase: {
      createPurchaseOrder: async () => {
        throw new Error("not used");
      },
      addRow: async () => {},
      cancel: async () => {},
    },
    manufacturing,
    requirementsCacheMs: 0,
    today: () => TODAY,
    audit: {
      async log(entry) {
        auditEntries.push({ entityType: entry.entityType, entityId: entry.entityId, action: entry.action, detail: entry.detail });
      },
    },
    salesOrderDates: salesService,
  });
}

describe("granskningen av etapp 3", () => {
  it("only the operations the date needs get the alternative: a row that is not critical is made on its ordinarie", async () => {
    // Row A (the product): Op 10 would be a week earlier on 120 (110 full
    // in W1). Row C: 10 h on 140 (full W1–W2) with 150 as an alternative
    // (full W1): ready Friday W2 on 150, W3 on 140 — C decides the date, and
    // A on its ordinarie is ready Friday W2 as well.
    const w = await seedWorld();
    const r140 = await w.wc("140", "Svets 2");
    const r150 = await w.wc("150", "Svets 3");
    const f140 = await madeArticle("F140", [{ workCenterId: r140.id, setupTime: 4800 }]);
    const f150 = await madeArticle("F150", [{ workCenterId: r150.id, setupTime: 2400 }]);
    await mfgService.createManufacturingOrder({ articleId: f140.id, quantity: 1 }, w.user.id);
    await mfgService.createManufacturingOrder({ articleId: f150.id, quantity: 1 }, w.user.id);
    const c = await madeArticle("C", [{ workCenterId: r140.id, setupTime: 600, alternatives: [{ workCenterId: r150.id }] }]);
    const { order, rows } = await salesService.createQuote(
      {
        customerId: w.customer.id,
        confirm: true,
        rows: [
          { articleId: w.product.id, quantity: 10, unitPrice: 100 },
          { articleId: c.id, quantity: 1, unitPrice: 100 },
        ],
      },
      w.user.id
    );
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(check).toMatchObject({ usesAlternatives: true, deliveryDate: W3, ordinaryDeliveryDate: "2030-03-25" });
    const batchResources = check.batches.map((b) => [b.rowKey, b.operations.map((o) => [o.sequenceNo, o.workCenterCode, o.alternativeOf?.workCenterCode ?? null])]);
    expect(batchResources).toEqual([
      [rows[0]!.id, [[10, "110", null], [20, "130", null]]],
      [rows[1]!.id, [[10, "150", "140"]]],
    ]);

    // The reservation writes exactly that: Vald för hand on C's operation only.
    const applied = await planningService.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: W3, expectedOrders: 2 }, w.user.id);
    expect(applied.manufacturingOrders.map((m) => [m.salesOrderRowId, m.resourceSwitches.map((s) => [s.sequenceNo, s.fromCode, s.toCode])])).toEqual([
      [rows[0]!.id, []],
      [rows[1]!.id, [[10, "140", "150"]]],
    ]);
    const resources = async (moId: string) => (await mfgService.listOperations(moId)).map((o) => [o.workCenterId, o.resourceLocked]);
    expect(await resources(applied.manufacturingOrders[0]!.id)).toEqual([
      [w.r110.id, false],
      [w.r130.id, false],
    ]);
    expect(await resources(applied.manufacturingOrders[1]!.id)).toEqual([[r150.id, true]]);
  });

  it("refuses with a fresh check when the alternative is gone before the TO's snapshot (a deactivated resource) — nothing written", async () => {
    const w = await seedWorld();
    expect(await planningService.checkDeliveryTime({ salesOrderId: w.order.id })).toMatchObject({ usesAlternatives: true, deliveryDate: W2 });
    // 120 is deactivated (committed) after the check under the lock has read
    // it, just before the TO is created: the snapshot no longer has it.
    let deactivated = false;
    const stepping = planningServiceWith({
      ...mfgService,
      async createManufacturingOrderInTx(tx, input, createdBy, opts) {
        if (!deactivated) {
          deactivated = true;
          await mfgService.updateWorkCenter(w.r120.id, { active: false });
        }
        return mfgService.createManufacturingOrderInTx(tx, input, createdBy, opts);
      },
    });
    const failure = await stepping
      .applyDeliveryTime({ salesOrderId: w.order.id, deliveryDate: W2, expectedOrders: 1 }, w.user.id)
      .then(() => null, (err: unknown) => err);
    expect(deactivated).toBe(true);
    // Not the engine's plan on 110 with a warning: the date rested on 120.
    expect(failure).toBeInstanceOf(DeliveryTimeChangedError);
    expect((failure as DeliveryTimeChangedError).deliveryDate).toBe(W3);
    expect((failure as DeliveryTimeChangedError).result).toMatchObject({ usesAlternatives: false, deliveryDate: W3, ordinaryDeliveryDate: null });
    expect(await orderCount()).toBe(1); // the filler only
    expect(await salesOrderRow(w.order.id)).toEqual({ status: "confirmed", expectedDeliveryDate: null });
    expect(auditEntries.filter((e) => e.action === "released" || e.action === "delivery_time_applied")).toEqual([]);

    // The new date goes through, on the ordinarie.
    const applied = await planningService.applyDeliveryTime({ salesOrderId: w.order.id, deliveryDate: W3 }, w.user.id);
    expect(applied).toMatchObject({ usesAlternatives: false, manufacturingOrders: [expect.objectContaining({ resourceSwitches: [] })] });
  });

  it("an ordinarie without a date and an alternative with one: the reservation with useAlternatives false has no date to promise", async () => {
    const w = await seedWorld();
    // 60 min/st on 110 but 1 min/st on 120: 5000 st is 5000 h on 110 — more
    // than two years of 40 h weeks — and 83 h on 120 (ready Friday W3).
    const big = await madeArticle("B", [{ workCenterId: w.r110.id, runTimePerUnit: 60, alternatives: [{ workCenterId: w.r120.id, runTimePerUnit: 1 }] }]);
    const { order } = await salesService.createQuote(
      { customerId: w.customer.id, confirm: true, rows: [{ articleId: big.id, quantity: 5000, unitPrice: 100 }] },
      w.user.id
    );
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(check).toMatchObject({ usesAlternatives: true, shipDate: "2030-03-25", deliveryDate: "2030-03-25", ordinaryShipDate: null, ordinaryDeliveryDate: null });
    expect(check.rows[0]).toMatchObject({ readyDate: "2030-03-22", ordinaryReadyDate: null });

    // Med ordinarie resurser: the ordinarie run has no date, so nothing can be promised.
    const failure = await planningService
      .applyDeliveryTime({ salesOrderId: order.id, deliveryDate: "2030-03-25", useAlternatives: false }, w.user.id)
      .then(() => null, (err: unknown) => err);
    expect(failure).toBeInstanceOf(DeliveryTimeChangedError);
    expect((failure as DeliveryTimeChangedError).deliveryDate).toBeNull();
    expect((failure as Error).message).toBe("Läget har ändrats sedan kontrollen — det går inte längre att lova ett datum");
    // The body is the check's own answer: the alternative's date, no ordinarie date.
    expect((failure as DeliveryTimeChangedError).result).toMatchObject({ usesAlternatives: true, deliveryDate: "2030-03-25", ordinaryDeliveryDate: null });
    expect(await orderCount()).toBe(1);

    // Left out (förval true): the alternative's date, made on 120.
    const applied = await planningService.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: "2030-03-25" }, w.user.id);
    expect(applied).toMatchObject({ usesAlternatives: true, manufacturingOrders: [expect.objectContaining({ resourceSwitches: [expect.objectContaining({ toCode: "120" })] })] });
  });

  it("a component's TO on an alternative in a tree of several levels: only its operation is Vald för hand", async () => {
    // K (10 h on 110, 120 as an alternative) under T (1 h on 130). 110 is
    // full in W1: K on 120 is ready Friday W1, and T after it the same day.
    const w = await seedWorld();
    const part = await madeArticle("K", [{ workCenterId: w.r110.id, runTimePerUnit: 60, alternatives: [{ workCenterId: w.r120.id }] }]);
    const top = await madeArticle("T", [{ workCenterId: w.r130.id, runTimePerUnit: 6 }]);
    await articleService.addBomComponent(top.id, { componentArticleId: part.id, quantity: 1 });
    const { order, rows } = await salesService.createQuote(
      { customerId: w.customer.id, confirm: true, rows: [{ articleId: top.id, quantity: 10, unitPrice: 100 }] },
      w.user.id
    );
    const check = await planningService.checkDeliveryTime({ salesOrderId: order.id });
    expect(check).toMatchObject({ usesAlternatives: true, deliveryDate: W2, ordinaryDeliveryDate: W3 });
    expect(check.batches.map((b) => [b.level, b.articleId, b.operations.map((o) => [o.workCenterCode, o.alternativeOf?.workCenterCode ?? null])])).toEqual([
      [2, part.id, [["120", "110"]]],
      [1, top.id, [["130", null]]],
    ]);

    const applied = await planningService.applyDeliveryTime({ salesOrderId: order.id, deliveryDate: W2, expectedOrders: 2 }, w.user.id);
    expect(applied.manufacturingOrders.map((m) => [m.level, m.salesOrderRowId, m.resourceSwitches.map((s) => [s.sequenceNo, s.fromCode, s.toCode])])).toEqual([
      [2, null, [[10, "110", "120"]]],
      [1, rows[0]!.id, []],
    ]);
    const [partMo, topMo] = applied.manufacturingOrders;
    const partOps = await mfgService.listOperations(partMo!.id);
    expect(partOps.map((o) => [o.workCenterId, o.resourceLocked, o.planLocked])).toEqual([[w.r120.id, true, true]]);
    expect(await planRows(partOps[0]!.id)).toEqual([{ monday: W1, minutes: 600 }]);
    expect((await mfgService.listOperations(topMo!.id)).map((o) => [o.workCenterId, o.resourceLocked, o.planLocked])).toEqual([[w.r130.id, false, true]]);
    expect(auditEntries.filter((e) => e.action === "released").map((e) => [e.entityId, e.detail])).toEqual([
      [partMo!.orderNumber, { resourceSwitches: [{ sequenceNo: 10, fromCode: "110", toCode: "120" }] }],
      [topMo!.orderNumber, undefined],
    ]);
  });
});
