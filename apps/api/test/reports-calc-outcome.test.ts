import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { costCalculations, db, manufacturingOrders } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createReportsService } from "../src/modules/reports/service/reports.service.js";
import type {
  AnalysisArticleRow,
  AnalysisOrderRow,
  AnalysisWorkCenterRow,
} from "../src/modules/reports/service/calc-outcome-calc.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

// Kalkylutfall against the real save paths: the förkalkyl is saved the only
// way the costing module saves one (on the article, no MO) and the
// efterkalkyl on the order, with its avvikelseanalys (#14, etapp 2).

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => ({
    costingMaterialSource: "standard" as const,
    costingSupplierPriceTier: "base" as const,
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 0,
  }),
});
// The margin report's self-cost reader is not exercised here; the costing
// service is the real implementation app.ts wires.
const reportsService = createReportsService(createReportsRepository(db), costingService);

// Receiving a lego IO row reports the TO's lego operation (app.ts's wiring).
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService
);

const TRUNCATE = sql`TRUNCATE cost_calculations, time_reports, employees, purchase_order_rows, purchase_orders, suppliers, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, articles, user_settings, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Parent with one unlinked component (standard cost 10, two per parent) and
// one operation (setup 30 min, run 6 min/st at 600 kr/h). A förkalkyl for
// 10 is 20 + (30 + 60) / 60 × 600 / 10 = 110 per unit.
async function makeProduct() {
  const user = await authRepo.create({
    email: `calc-outcome-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Kalkyl",
    role: "admin",
  });
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Bänk",
    type: "manufactured",
    active: true,
  });
  const component = await articleService.createArticle({
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Skiva",
    type: "purchased",
    standardCost: 10,
    active: true,
  });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2 });
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 600, overheadPercent: 0, active: true });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse!.id, name: "A1", active: true });
  await stockService.recordTransaction({ articleId: component.id, locationId: location.id, quantityDelta: 1000, transactionType: "inventory_adjustment" });
  const employee = await timeReportService.createEmployee({ employeeNumber: `E-${crypto.randomUUID().slice(0, 6)}`, name: "Kalle", active: true });
  return { user, parent, component, workCenter, location, employee };
}
type Product = Awaited<ReturnType<typeof makeProduct>>;

// An order of `quantity` with `drawn` of the component drawn and `hours`
// reported, then `received` delivered by Slutför order (omitted: left open).
async function makeOrder(p: Product, opts: { quantity: number; drawn?: number; hours?: number; received?: number }) {
  const order = await mfgService.createManufacturingOrder({ articleId: p.parent.id, quantity: opts.quantity }, p.user.id);
  const [material] = await mfgService.listMaterialConsumptions(order.id);
  const [operation] = await mfgService.listOperations(order.id);
  if (opts.drawn) await mfgService.consumeMaterial(order.id, material!.id, { locationId: p.location.id, quantity: opts.drawn }, p.user.id);
  if (opts.hours) {
    await timeReportService.createTimeReport({ employeeId: p.employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: opts.hours }, p.user.id);
  }
  if (opts.received !== undefined) await mfgService.complete(order.id, { quantity: opts.received, locationId: p.location.id }, p.user.id);
  return order;
}

// The orders the tests share, the förkalkyl saved first:
// - A: 10 ordered, 20 drawn, 2 h, kortstängd at 8. Efterkalkyl 200 + 1200 =
//   1400; Kalkylerat 16 × 10 + (30 + 48) / 60 × 600 = 940.
// - D: 5 ordered, 10 drawn, 1.5 h, all 5 delivered. 100 + 900 = 1000
//   against 100 + 600 = 700.
// - B: 5 ordered, 1 h, open — a preliminary analysis (Ej klar).
// - C: 5 ordered, delivered, its efterkalkyl saved before the analysis.
async function scenario() {
  const p = await makeProduct();
  const { calculation: pre } = await costingService.preCalculate(p.parent.id, 10, true);
  const a = await makeOrder(p, { quantity: 10, drawn: 20, hours: 2, received: 8 });
  const d = await makeOrder(p, { quantity: 5, drawn: 10, hours: 1.5, received: 5 });
  const b = await makeOrder(p, { quantity: 5, hours: 1 });
  const c = await makeOrder(p, { quantity: 5, received: 5 });
  const posts = {
    a: (await costingService.postCalculate(a.id, true)).calculation,
    d: (await costingService.postCalculate(d.id, true)).calculation,
    b: (await costingService.postCalculate(b.id, true)).calculation,
    c: (await costingService.postCalculate(c.id, true)).calculation,
  };
  // An efterkalkyl saved before migration 0187 has none of the analysis's columns.
  await db.execute(sql`update cost_calculations set output_quantity = null, preliminary = null, base_priced_at = null, base_material_source = null where id = ${posts.c.id}`);
  await db.execute(sql`update cost_calculation_material_rows set base_quantity = null, base_unit_cost = null, base_price_source = null, scrap_quantity = null where cost_calculation_id = ${posts.c.id}`);
  await db.execute(sql`update cost_calculation_operation_rows set base_setup_hours = null, base_run_hours = null, base_hourly_rate = null where cost_calculation_id = ${posts.c.id}`);
  return { p, pre, orders: { a, b, c, d }, posts };
}

describe("Kalkylutfall — Mot förkalkyl", () => {
  it("compares an order's efterkalkyl with the article's förkalkyl", async () => {
    const p = await makeProduct();
    const order = await makeOrder(p, { quantity: 4 });
    const { calculation: preCalc } = await costingService.preCalculate(p.parent.id, 10, true);
    expect(preCalc.manufacturingOrderId).toBeNull(); // the premise of the old bug
    const { calculation: postCalc } = await costingService.postCalculate(order.id, true);

    const result = await reportsService.getCalculationOutcome({});

    expect(result.view).toBe("pre");
    if (result.view !== "pre") throw new Error("view");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      calculationId: postCalc.id,
      manufacturingOrderId: order.id,
      orderNumber: order.orderNumber,
      articleNumber: p.parent.articleNumber,
      preSource: "article",
      preTvkPerUnit: 110,
      preCalculatedAt: new Date(preCalc.calculatedAt).toISOString(),
      postCalculatedAt: new Date(postCalc.calculatedAt).toISOString(),
    });
    expect(result.notComparable).toEqual({ onlyPost: 0, invalidQuantity: 0, noOutput: 0 });
  });

  it("does not use a förkalkyl saved after the efterkalkyl", async () => {
    const p = await makeProduct();
    const order = await makeOrder(p, { quantity: 4 });
    const { calculation: postCalc } = await costingService.postCalculate(order.id, true);
    const { calculation: preCalc } = await costingService.preCalculate(p.parent.id, 5, true);
    await db
      .update(costCalculations)
      .set({ calculatedAt: new Date(new Date(postCalc.calculatedAt).getTime() + 1000) })
      .where(eq(costCalculations.id, preCalc.id));

    const result = await reportsService.getCalculationOutcome({});

    expect(result.rows).toHaveLength(0);
    if (result.view !== "pre") throw new Error("view");
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0, noOutput: 0 });
  });

  // Pröva påslag (#16): a saved trial moves only the price markups, so as
  // the article's latest förkalkyl it gives the ordinary TVK/st.
  it("measures against a saved Pröva påslag with the ordinary TVK", async () => {
    const p = await makeProduct();
    const order = await makeOrder(p, { quantity: 4 });
    await costingService.preCalculate(p.parent.id, 10, true);
    const { calculation: trial } = await costingService.preCalculate(p.parent.id, 10, true, false, {
      generalMarkupPercent: 300,
      materialMarkupPercent: 50,
    });
    expect([trial.generalMarkupLevel, trial.materialMarkupLevel]).toEqual(["trial", "trial"]);
    await costingService.postCalculate(order.id, true);

    const result = await reportsService.getCalculationOutcome({});

    if (result.view !== "pre") throw new Error("view");
    expect(result.rows[0]).toMatchObject({ preTvkPerUnit: 110, preCalculatedAt: new Date(trial.calculatedAt).toISOString() });
  });

  it("divides by N on a kortstängd order, adds Kalkylerat TVK/st and marks Ej klar", async () => {
    const { posts } = await scenario();

    const result = await reportsService.getCalculationOutcome({ view: "pre" });

    if (result.view !== "pre") throw new Error("view");
    const byCalculation = new Map(result.rows.map((r) => [r.calculationId, r]));
    // A: 1400 / 8 delivered, not / 10 ordered; Kalkylerat 940 / 8.
    expect(byCalculation.get(posts.a.id)).toMatchObject({
      quantity: 10,
      outputQuantity: 8,
      preliminary: false,
      perUnitBasis: "output",
      preTvkPerUnit: 110,
      calculatedTvkPerUnit: 117.5,
      postTvkPerUnit: 175,
    });
    expect(byCalculation.get(posts.d.id)).toMatchObject({ outputQuantity: 5, calculatedTvkPerUnit: 140, postTvkPerUnit: 200 });
    // B is open: Ej klar, per the order quantity as before (600 / 5).
    expect(byCalculation.get(posts.b.id)).toMatchObject({ preliminary: true, perUnitBasis: "quantity", postTvkPerUnit: 120, calculatedTvkPerUnit: null });
    // C was saved before the analysis.
    expect(byCalculation.get(posts.c.id)).toMatchObject({ preliminary: null, outputQuantity: null, perUnitBasis: "quantity" });
    expect(result.summary.count).toBe(4);
  });

  it("measures a beställningsvara's TO against its configuration.cost, and counts an unknown cost as not comparable", async () => {
    const p = await makeProduct();
    await costingService.preCalculate(p.parent.id, 10, true);
    const known = await makeOrder(p, { quantity: 4, drawn: 8, hours: 1, received: 4 });
    const unknown = await makeOrder(p, { quantity: 4 });
    const { calculation } = await costingService.postCalculate(known.id, true);
    await costingService.postCalculate(unknown.id, true);
    // Only the configuration matters to the report.
    const configuration = (perUnit: number | null) => ({
      templateArticleId: p.parent.id,
      key: "k",
      selection: [],
      cost: { manufacturingCostPerUnit: perUnit, calculatedAt: "2026-08-02T09:00:00.000Z" },
    });
    await db.update(manufacturingOrders).set({ configuration: configuration(150) }).where(eq(manufacturingOrders.id, known.id));
    await db.update(manufacturingOrders).set({ configuration: configuration(null) }).where(eq(manufacturingOrders.id, unknown.id));

    const result = await reportsService.getCalculationOutcome({});

    if (result.view !== "pre") throw new Error("view");
    expect(result.rows).toHaveLength(1);
    // 80 + 600 = 680 over the 4 delivered = 170 against the configuration's 150, not the template's 110.
    expect(result.rows[0]).toMatchObject({
      calculationId: calculation.id,
      preSource: "configuration",
      preTvkPerUnit: 150,
      preCalculatedAt: "2026-08-02T09:00:00.000Z",
      postTvkPerUnit: 170,
    });
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0, noOutput: 0 });
  });

  it("counts a final analysis with nothing delivered as noOutput", async () => {
    const p = await makeProduct();
    await costingService.preCalculate(p.parent.id, 10, true);
    const order = await makeOrder(p, { quantity: 4, hours: 1, received: 0 });
    await costingService.postCalculate(order.id, true);

    const result = await reportsService.getCalculationOutcome({});

    if (result.view !== "pre") throw new Error("view");
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 0, invalidQuantity: 0, noOutput: 1 });
  });
});

describe("Kalkylutfall — Avvikelseanalys", () => {
  it("groups the final analyses per order, article and resource, with the KPIs and the counters", async () => {
    const { p, orders, posts } = await scenario();

    const byOrder = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "order" });
    if (byOrder.view !== "analysis") throw new Error("view");
    // B (preliminary) and C (saved before the analysis) are only counted.
    expect(byOrder.counts).toEqual({ analysed: 2, preliminary: 1, withoutAnalysis: 1 });
    const rows = byOrder.rows as AnalysisOrderRow[];
    expect(rows.map((r) => r.calculationId).sort()).toEqual([posts.a.id, posts.d.id].sort());
    const a = rows.find((r) => r.manufacturingOrderId === orders.a.id)!;
    // 4 drawn over the 16 calculated × 10, and 2 h against 1.3 h at 600.
    expect(a).toMatchObject({ orderNumber: orders.a.orderNumber, outputQuantity: 8, base: 940, actual: 1400, deviation: 460, deviationPct: 48.9 });
    expect(a.parts).toMatchObject({ price: 0, quantity: 40, unclassified: 420, markups: 0 });
    expect(byOrder.kpis).toEqual({
      base: 1640,
      actual: 2400,
      deviation: 760,
      deviationPct: 46.3,
      price: 0,
      quantity: 40,
      scrap: 0,
      time: 720,
      markups: 0,
    });
    expect(byOrder.totals).toMatchObject({ base: 1640, actual: 2400, deviation: 760 });

    const byArticle = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "article" });
    if (byArticle.view !== "analysis") throw new Error("view");
    expect(byArticle.rows as AnalysisArticleRow[]).toEqual([
      expect.objectContaining({ articleId: p.parent.id, orderCount: 2, outputQuantity: 13, base: 1640, actual: 2400, deviation: 760 }),
    ]);

    const byResource = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "workCenter" });
    if (byResource.view !== "analysis") throw new Error("view");
    expect(byResource.rows as AnalysisWorkCenterRow[]).toEqual([
      expect.objectContaining({
        key: `${p.workCenter.id}:time`,
        workCenterCode: "100",
        kind: "time",
        operationCount: 2,
        orderCount: 2,
        // A: 0.5 + 0.8 h planned, D: 0.5 + 0.5 h; 2 + 1.5 h reported, not split.
        baseSetupHours: 1,
        baseRunHours: 1.3,
        setupHours: null,
        runHours: null,
        unclassifiedHours: 3.5,
        hours: 3.5,
        timeDeviation: 720,
        base: 1380,
        actual: 2100,
        deviation: 720,
      }),
    ]);
    // The KPIs are the orders' whatever the grouping; the table sums the operations.
    expect(byResource.kpis.deviation).toBe(760);
    expect(byResource.totals.deviation).toBe(720);
  });

  it("picks each TO's latest efterkalkyl, and the period is its Stockholm month", async () => {
    const p = await makeProduct();
    const order = await makeOrder(p, { quantity: 5, drawn: 10, hours: 1, received: 5 });
    const { calculation: first } = await costingService.postCalculate(order.id, true);
    // Efterrapportering on the Klar order, then a new efterkalkyl: the facit.
    const [operation] = await mfgService.listOperations(order.id);
    await timeReportService.createTimeReport({ employeeId: p.employee.id, moOperationId: operation!.id, date: "2026-07-08", hours: 1 }, p.user.id);
    const { calculation: latest } = await costingService.postCalculate(order.id, true);

    const now = await reportsService.getCalculationOutcome({ view: "analysis" });
    if (now.view !== "analysis") throw new Error("view");
    expect(now.rows.map((r) => (r as AnalysisOrderRow).calculationId)).toEqual([latest.id]);
    expect(now.rows[0]).toMatchObject({ actual: 1300 }); // 100 + 2 h × 600

    // The first in July; the latest on 31 July 23:30 UTC = 1 August in Stockholm.
    await db.update(costCalculations).set({ calculatedAt: new Date("2026-07-15T10:00:00Z") }).where(eq(costCalculations.id, first.id));
    await db.update(costCalculations).set({ calculatedAt: new Date("2026-07-31T23:30:00Z") }).where(eq(costCalculations.id, latest.id));
    const august = await reportsService.getCalculationOutcome({ view: "analysis", from: "2026-08", to: "2026-08" });
    if (august.view !== "analysis") throw new Error("view");
    expect(august.rows.map((r) => (r as AnalysisOrderRow).calculationId)).toEqual([latest.id]);
    // July holds the older efterkalkyl, but it is not the TO's facit.
    const july = await reportsService.getCalculationOutcome({ view: "analysis", from: "2026-07", to: "2026-07" });
    if (july.view !== "analysis") throw new Error("view");
    expect(july.rows).toEqual([]);
    expect(july.counts).toEqual({ analysed: 0, preliminary: 0, withoutAnalysis: 0 });
    // A later period does not see it either.
    expect((await reportsService.getCalculationOutcome({ view: "analysis", from: "2026-09", to: "2026-12" })).rows).toEqual([]);
  });

  // The headers, the row tables and the förkalkyler are separate statements,
  // and each one evaluates "the latest efterkalkyl per TO" again. A Spara
  // committed between them must not give the report header A with the rows
  // of B (A then has no rows, and its whole Utfall lands in Påslag): the
  // report reads one snapshot. Deterministic with two clients — the other
  // one holds the row table, so the report's second statement waits on it
  // while the new efterkalkyl is saved and committed through the real path.
  it("reads one snapshot: an efterkalkyl saved between the statements is not half read", async () => {
    const p = await makeProduct();
    const order = await makeOrder(p, { quantity: 5, drawn: 10, hours: 1.5, received: 5 });
    const { calculation: first } = await costingService.postCalculate(order.id, true);
    const [operation] = await mfgService.listOperations(order.id);

    const locked = gate();
    const release = gate();
    let second: { id: string } | null = null;
    const saving = db.transaction(async (tx) => {
      await tx.execute(sql`lock table cost_calculation_material_rows in access exclusive mode`);
      locked.open();
      await release.promise;
      // Efterrapportering, then Spara — committed while the report waits.
      await tx.execute(
        sql`insert into time_reports (employee_id, mo_operation_id, date, hours) values (${p.employee.id}, ${operation!.id}, '2026-07-08', 1)`
      );
      const inTx = createCostingService(createCostingRepository(tx), {
        getSettings: async () => ({
          costingMaterialSource: "standard" as const,
          costingMoPercent: 0,
          costingLoPercent: 0,
          costingAffoPercent: 0,
          costingGeneralMarkupPercent: 0,
        }),
      });
      second = (await inTx.postCalculate(order.id, true)).calculation;
    });
    saving.catch(() => locked.open());
    await locked.promise;
    const report = reportsService.getCalculationOutcome({ view: "analysis" });
    await waitForLockWaiter().finally(release.open);
    await saving;
    const result = await report;

    if (result.view !== "analysis") throw new Error("view");
    // The snapshot's facit is the first efterkalkyl, with its own rows: 100 + 1.5 h × 600.
    expect(result.rows.map((r) => (r as AnalysisOrderRow).calculationId)).toEqual([first.id]);
    expect(result.rows[0]).toMatchObject({ base: 700, actual: 1000, deviation: 300 });
    expect((result.rows[0] as AnalysisOrderRow).parts).toMatchObject({ quantity: 0, unclassified: 300, markups: 0 });
    // Read again, the report sees the new facit.
    const after = await reportsService.getCalculationOutcome({ view: "analysis" });
    expect(after.rows.map((r) => (r as AnalysisOrderRow).calculationId)).toEqual([second!.id]);
    expect(after.rows[0]).toMatchObject({ actual: 1600 });
  });
});

// #14 etapp 3: time reported as ställ/produktion reaches Resurs as Verklig
// ställ and stycke. Order X (5): 0.75 h ställ + 0.4 h produktion against
// 0.5 + 0.5 planned; order Y (5): 1.5 h without a type, ej uppdelad.
describe("Kalkylutfall — verklig ställ och stycke", () => {
  it("sums the split time per resource next to the ej uppdelad, and the parts add up", async () => {
    const p = await makeProduct();
    const x = await makeOrder(p, { quantity: 5, drawn: 10 });
    const [xOperation] = await mfgService.listOperations(x.id);
    for (const [hours, kind] of [[0.75, "setup"], [0.4, "run"]] as const) {
      await timeReportService.createTimeReport({ employeeId: p.employee.id, moOperationId: xOperation!.id, date: "2026-07-07", hours, kind }, p.user.id);
    }
    await mfgService.complete(x.id, { quantity: 5, locationId: p.location.id }, p.user.id);
    const y = await makeOrder(p, { quantity: 5, drawn: 10, hours: 1.5, received: 5 });
    await costingService.postCalculate(x.id, true);
    await costingService.postCalculate(y.id, true);

    const byResource = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "workCenter" });
    if (byResource.view !== "analysis") throw new Error("view");
    expect(byResource.rows as AnalysisWorkCenterRow[]).toEqual([
      expect.objectContaining({
        kind: "time",
        operationCount: 2,
        baseSetupHours: 1,
        baseRunHours: 1,
        setupHours: 0.75,
        runHours: 0.4,
        unclassifiedHours: 1.5,
        hours: 2.65,
        // X: Ställ 150, Stycke −60; Y: Ej uppdelad 300.
        timeDeviation: 390,
        base: 1200,
        actual: 1590,
      }),
    ]);
    expect((byResource.rows[0] as AnalysisWorkCenterRow).parts).toMatchObject({ setup: 150, run: -60, unclassified: 300, rate: 0 });
    expect(byResource.kpis).toMatchObject({ deviation: 390, time: 390 });

    const byOrder = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "order" });
    if (byOrder.view !== "analysis") throw new Error("view");
    const xRow = (byOrder.rows as AnalysisOrderRow[]).find((r) => r.manufacturingOrderId === x.id)!;
    expect(xRow.parts).toMatchObject({ setup: 150, run: -60, unclassified: 0 });
  });
});

// Timkostnad per datum (#14 etapp 4): the efterkalkyl prices the work day
// at that day's hourly rate and the base at T₀'s, so Kalkylutfall carries a
// real Timpris — per order and inside the resource's Tidsavvikelse.
describe("Kalkylutfall — Timpris", () => {
  it("carries Timpris when the hourly rate was raised between T₀ and the work day", async () => {
    const p = await makeProduct();
    const order = await makeOrder(p, { quantity: 5, drawn: 10 });
    // 600 kr/h at T₀ (1 March), 720 from 1 June; the 1.5 h worked on 7 July.
    await db.execute(sql`update manufacturing_orders set created_at = '2026-03-01T09:00:00Z' where id = ${order.id}`);
    await db.execute(sql`update work_center_rate_history set valid_from = '2026-02-01T09:00:00Z' where work_center_id = ${p.workCenter.id}`);
    await mfgService.updateWorkCenter(p.workCenter.id, { hourlyRate: 720 });
    await db.execute(sql`update work_center_rate_history set valid_from = '2026-06-01T09:00:00Z' where work_center_id = ${p.workCenter.id} and hourly_rate = 720`);
    const [operation] = await mfgService.listOperations(order.id);
    await timeReportService.createTimeReport({ employeeId: p.employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: 1.5 }, p.user.id);
    await mfgService.complete(order.id, { quantity: 5, locationId: p.location.id }, p.user.id);
    const { analysis } = await costingService.postCalculate(order.id, true);
    // Utfall 100 + 1.5 × 720 = 1180, Kalkylerat 100 + 1 × 600 = 700:
    // Timpris 1080 − 900 = 180, Ej uppdelad (1.5 − 1) × 600 = 300.
    expect(analysis).toMatchObject({ base: 700, actual: 1180, deviation: 480 });

    const byOrder = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "order" });
    if (byOrder.view !== "analysis") throw new Error("view");
    expect((byOrder.rows[0] as AnalysisOrderRow).parts).toMatchObject({ price: 0, quantity: 0, rate: 180, unclassified: 300, markups: 0 });
    expect(byOrder.kpis).toMatchObject({ deviation: 480, time: 480 });

    const byResource = await reportsService.getCalculationOutcome({ view: "analysis", groupBy: "workCenter" });
    if (byResource.view !== "analysis") throw new Error("view");
    const [resource] = byResource.rows as AnalysisWorkCenterRow[];
    expect(resource).toMatchObject({ kind: "time", hours: 1.5, unclassifiedHours: 1.5, timeDeviation: 480 });
    expect(resource!.parts).toMatchObject({ rate: 180, unclassified: 300 });
  });
});

// MO and LO on both sides, and a lego operation bought on an IO: the
// report's sums and its Resurs grouping read the saved analysis exactly as
// GET /cost-calculations/:id derives it.
describe("Kalkylutfall — MO, LO och lego", () => {
  const markedUp = createCostingService(createCostingRepository(db), {
    getSettings: async () => ({
      costingMaterialSource: "standard" as const,
      costingMoPercent: 10,
      costingLoPercent: 20,
      costingAffoPercent: 0,
      costingGeneralMarkupPercent: 0,
    }),
  });
  const markedUpReports = createReportsService(createReportsRepository(db), markedUp);

  // The product of makeProduct plus a lego operation 20 (ställpris 500,
  // styckpris 100). An order of 5: the component's price raised from 10 to
  // 11 after T₀ and then the planned 10 drawn, 1.5 h (1 planned), and the
  // lego bought on an IO at 450 + 90 × 5, whose receipt — the last
  // operation — delivers the 5 and makes the order Klar.
  //   Utfall:     110 + MO 11 + 900 + lego 900 + LO 180 = 2101
  //   Kalkylerat: 100 + MO 10 + 600 + lego 1000 + LO 200 = 1910
  //   Pris 10 − 100, Ej uppdelad 300, Påslag 191 − 210 = −19.
  async function legoOrder() {
    const p = await makeProduct();
    const supplier = await purchaseService.createSupplier({ name: "Lego AB", active: true });
    const lego = await mfgService.createWorkCenter({ code: "900", name: "Ytbehandling", type: "subcontract", supplierId: supplier.id, active: true });
    await mfgService.createRoutingOperation(p.parent.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0, setupPrice: 500, unitPrice: 100 });
    const order = await makeOrder(p, { quantity: 5, hours: 1.5 });
    await articleService.updateStandardCost(p.component.id, 11);
    const [material] = await mfgService.listMaterialConsumptions(order.id);
    await mfgService.consumeMaterial(order.id, material!.id, { locationId: p.location.id, quantity: 10 }, p.user.id);
    const legoOperation = (await mfgService.listOperations(order.id)).find((op) => op.sequenceNo === 20)!;
    const io = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, p.user.id);
    const row = await purchaseService.addRow(io.id, { articleId: p.parent.id, quantity: 5, unitPrice: 90, setupPrice: 450, moOperationId: legoOperation.id });
    await purchaseService.confirm(io.id);
    await purchaseService.receiveGoods(io.id, row.id, { quantity: 5 }, p.user.id);
    return { p, lego, order };
  }

  it("sums MO, LO and the lego operation per order, and groups the time and the lego per resource", async () => {
    const { p, lego, order } = await legoOrder();
    // Förkalkyl for 5 at today's price: 110 + 11 + 600 + 1000 + 200 = 1921.
    await markedUp.preCalculate(p.parent.id, 5, true);
    const { calculation, analysis } = await markedUp.postCalculate(order.id, true);
    expect(analysis).toMatchObject({ preliminary: false, outputQuantity: 5, base: 1910, actual: 2101, deviation: 191 });

    const byOrder = await markedUpReports.getCalculationOutcome({ view: "analysis", groupBy: "order" });
    if (byOrder.view !== "analysis") throw new Error("view");
    expect(byOrder.rows).toEqual([
      expect.objectContaining({ calculationId: calculation.id, outputQuantity: 5, base: 1910, actual: 2101, deviation: 191, deviationPct: 10 }),
    ]);
    expect((byOrder.rows[0] as AnalysisOrderRow).parts).toEqual(analysis!.parts);
    expect(byOrder.kpis).toMatchObject({ base: 1910, actual: 2101, deviation: 191, price: -90, quantity: 0, time: 300, markups: -19 });
    // Pris + Mängd + Tid + Påslag = Avvikelse, exactly.
    expect(Math.round((byOrder.kpis.price + byOrder.kpis.quantity + byOrder.kpis.time + byOrder.kpis.markups) * 100)).toBe(19100);

    const byResource = await markedUpReports.getCalculationOutcome({ view: "analysis", groupBy: "workCenter" });
    if (byResource.view !== "analysis") throw new Error("view");
    expect(byResource.rows as AnalysisWorkCenterRow[]).toEqual([
      expect.objectContaining({
        key: `${p.workCenter.id}:time`,
        kind: "time",
        baseSetupHours: 0.5,
        baseRunHours: 0.5,
        hours: 1.5,
        unclassifiedHours: 1.5,
        timeDeviation: 300,
        base: 600,
        actual: 900,
        baseQuantity: null,
      }),
      expect.objectContaining({
        key: `${lego.id}:subcontract`,
        workCenterCode: "900",
        kind: "subcontract",
        operationCount: 1,
        orderCount: 1,
        baseQuantity: 5,
        subcontractQuantity: 5,
        hours: null,
        timeDeviation: null,
        base: 1000,
        actual: 900,
        deviation: -100,
      }),
    ]);
    expect((byResource.rows[1] as AnalysisWorkCenterRow).parts).toMatchObject({ price: -100, quantity: 0, markups: 0 });
    // The table is the operations; material, MO and LO are only in the KPIs.
    expect(byResource.totals).toMatchObject({ base: 1600, actual: 1800, deviation: 200 });
    expect(byResource.kpis.deviation).toBe(191);

    // Mot förkalkyl: each TVK with its MO/LO, the efterkalkyl's and Kalkylerat divided by N.
    const pre = await markedUpReports.getCalculationOutcome({ view: "pre" });
    if (pre.view !== "pre") throw new Error("view");
    expect(pre.rows[0]).toMatchObject({ preTvkPerUnit: 384.2, calculatedTvkPerUnit: 382, postTvkPerUnit: 420.2, perUnitBasis: "output" });
  });
});

describe("Kalkylutfall — rutterna och CSV", () => {
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const PASSWORD = "correcthorsebattery";
  let app: ReturnType<typeof buildApp>;
  let cookie: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });
  beforeEach(async () => {
    const email = `admin-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

  it("serves both views and refuses an unknown view or grouping", async () => {
    await scenario();
    const pre = await get("/reports/calculation-outcome");
    expect(pre.statusCode).toBe(200);
    expect(pre.json()).toMatchObject({ view: "pre", summary: { count: 4 } });
    const analysis = await get("/reports/calculation-outcome?view=analysis&groupBy=workCenter");
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json()).toMatchObject({ view: "analysis", groupBy: "workCenter", counts: { analysed: 2 } });
    expect((await get("/reports/calculation-outcome?view=nope")).statusCode).toBe(400);
    expect((await get("/reports/calculation-outcome?view=analysis&groupBy=month")).statusCode).toBe(400);
  });

  it("exports every column with Swedish number formatting, varav kassation as a column and a Totalt row", async () => {
    const { orders } = await scenario();

    const pre = await get("/reports/calculation-outcome/csv");
    expect(pre.statusCode).toBe(200);
    expect(pre.headers["content-disposition"]).toMatch(/kalkylutfall-\d{4}-\d{2}-\d{4}-\d{2}\.csv/);
    const preLines = pre.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(preLines[0]).toBe(
      "TO;Artikel;Benämning;Antal;Inlevererat;Förkalkyl TVK/st;Kalkylerat TVK/st;Efterkalkyl TVK/st;Avvikelse/st;Avvikelse %;Delat med;Förkalkyl;Flernivå;Ej klar;Förkalkylerad;Efterkalkylerad"
    );
    const preA = preLines.find((l) => l.startsWith(`${orders.a.orderNumber};`))!;
    expect(preA.split(";").slice(3, 13)).toEqual(["10", "8", "110,00", "117,50", "175,00", "65,00", "59,1", "Inlevererat", "Artikel", ""]);
    const preB = preLines.find((l) => l.startsWith(`${orders.b.orderNumber};`))!;
    expect(preB.split(";")[13]).toBe("Ja");

    const byOrder = await get("/reports/calculation-outcome/csv?view=analysis&groupBy=order");
    expect(byOrder.statusCode).toBe(200);
    expect(byOrder.headers["content-disposition"]).toMatch(/kalkylutfall-avvikelseanalys-order-/);
    const lines = byOrder.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(
      "TO;Artikel;Benämning;Efterkalkylerad;Inlevererat;Kalkylerat;Utfall;Avvikelse;Avvikelse %;Pris;Mängd;varav kassation;Timpris;Ställ;Stycke;Ej uppdelad;Påslag"
    );
    const a = lines.find((l) => l.startsWith(`${orders.a.orderNumber};`))!;
    expect(a.split(";").slice(4)).toEqual(["8", "940,00", "1400,00", "460,00", "48,9", "0,00", "40,00", "0,00", "0,00", "0,00", "0,00", "420,00", "0,00"]);
    expect(lines).toHaveLength(4); // header, A, D, Totalt
    expect(lines[3]!.split(";").slice(0, 9)).toEqual(["Totalt", "", "", "", "", "1640,00", "2400,00", "760,00", "46,3"]);

    const byResource = await get("/reports/calculation-outcome/csv?view=analysis&groupBy=workCenter");
    const resourceLines = byResource.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(resourceLines[0]!.split(";").slice(0, 14)).toEqual([
      "Resurs",
      "Benämning",
      "Typ",
      "Antal operationer",
      "Antal TO",
      "Planerad ställ (h)",
      "Verklig ställ (h)",
      "Planerad stycke (h)",
      "Verklig stycke (h)",
      "Ej uppdelad (h)",
      "Rapporterad tid (h)",
      "Tidsavvikelse",
      "Kalkylerat antal",
      "Mottaget antal",
    ]);
    expect(resourceLines[1]!.split(";").slice(0, 14)).toEqual(["100", "Svets", "Tid", "2", "2", "1", "", "1,3", "", "3,5", "3,5", "720,00", "", ""]);
  });
});
