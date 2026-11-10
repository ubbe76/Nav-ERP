import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, db } from "@navet/db";
import { createArticleSchema, createStockLocationSchema, createWorkCenterSchema } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { manufacturingCost, perUnitDivisor } from "../src/modules/costing/service/cost-figures.js";
import { CostCalculationNotFinalError, createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import {
  computeCapacity,
  type CapacityInput,
  type CapacityOperationRow,
  type CapacityWorkCenter,
} from "../src/modules/planning/service/capacity-calc.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { errorBody } from "../src/modules/system/service/error-body.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
// Pure web files — no imports of their own beyond types (and lib/api, which
// only reads process.env at load), so vitest can load them directly.
import { noPerUnitNotice, perUnitDivisor as webPerUnitDivisor } from "../../web/lib/calculationDivisor.js";
import { formatDtcStep } from "../../web/lib/deliveryTimeCheck.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Kalkyl- och planeringsgranskningen (2026-11-10):
//   1. Prisåterföringen from an efterkalkyl divides by N = the received
//      quantity (the user's decision), and a preliminary efterkalkyl or one
//      with N = 0 sets no prices.
//   2. Leveranstidskontrollens step text when the ordinary resource gives no
//      week.
//   3. Beläggning: load in a week with 0 h capacity is overload.

const round4 = (value: number) => Math.round(value * 10000) / 10000;

// ---------------------------------------------------------------------------
// 1a. The divisor rule, pure — and the web's mirror of it.
// ---------------------------------------------------------------------------

describe("perUnitDivisor — what a saved calculation's totals are divided by", () => {
  const cases: { name: string; source: Parameters<typeof perUnitDivisor>[0]; expected: ReturnType<typeof perUnitDivisor> }[] = [
    { name: "förkalkyl: the quantity", source: { type: "pre", quantity: "10.0000", outputQuantity: null, preliminary: null }, expected: { divisor: 10, basis: "quantity" } },
    { name: "förkalkyl without the fields at all", source: { type: "pre", quantity: 4 }, expected: { divisor: 4, basis: "quantity" } },
    { name: "final efterkalkyl: N", source: { type: "post", quantity: "10.0000", outputQuantity: "8.0000", preliminary: false }, expected: { divisor: 8, basis: "output" } },
    { name: "final efterkalkyl, numbers as the analysis carries them", source: { type: "post", quantity: "10.0000", outputQuantity: 8, preliminary: false }, expected: { divisor: 8, basis: "output" } },
    { name: "preliminary efterkalkyl: none", source: { type: "post", quantity: "10.0000", outputQuantity: "4.0000", preliminary: true }, expected: { divisor: null, reason: "preliminary" } },
    { name: "preliminary with N = 0: preliminary wins", source: { type: "post", quantity: "10.0000", outputQuantity: "0.0000", preliminary: true }, expected: { divisor: null, reason: "preliminary" } },
    { name: "final with N = 0: none", source: { type: "post", quantity: "10.0000", outputQuantity: "0.0000", preliminary: false }, expected: { divisor: null, reason: "no-output" } },
    { name: "efterkalkyl saved before the analysis: the quantity", source: { type: "post", quantity: "10.0000", outputQuantity: null, preliminary: null }, expected: { divisor: 10, basis: "quantity" } },
    { name: "unusable quantity", source: { type: "pre", quantity: "0.0000", outputQuantity: null, preliminary: null }, expected: { divisor: null, reason: "invalid-quantity" } },
    { name: "unusable quantity on an old efterkalkyl", source: { type: "post", quantity: "-1", outputQuantity: null, preliminary: null }, expected: { divisor: null, reason: "invalid-quantity" } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(perUnitDivisor(c.source)).toEqual(c.expected);
      // The web's mirror (apps/web/lib/calculationDivisor.ts) answers the same.
      expect(webPerUnitDivisor(c.source)).toEqual(c.expected);
    });
  }

  it("the web explains why an efterkalkyl has no Per st — and only then", () => {
    expect(noPerUnitNotice({ divisor: 8, basis: "output" })).toBeNull();
    expect(noPerUnitNotice({ divisor: null, reason: "invalid-quantity" })).toBeNull();
    expect(noPerUnitNotice({ divisor: null, reason: "preliminary" })).toContain("preliminär");
    expect(noPerUnitNotice({ divisor: null, reason: "no-output" })).toContain("Inget är inlevererat");
  });
});

// ---------------------------------------------------------------------------
// 2. Leveranstidskontroll: the chain step on an alternative resource.
// ---------------------------------------------------------------------------

describe("formatDtcStep — alternativ resurs", () => {
  const step = (toWeek: string | null) =>
    formatDtcStep({
      kind: "operation",
      articleNumber: "BÄNK-1",
      quantity: 5,
      sequenceNo: 20,
      description: "Bocka",
      workCenterCode: "120",
      workCenterName: "Kantpress 2",
      fromWeek: "2026-11-09",
      toWeek: "2026-11-09",
      date: "2026-11-12",
      alternativeOf: { workCenterId: "w-110", workCenterCode: "110", workCenterName: "Kantpress 1", toWeek },
    });

  it("names the week the ordinary resource would have given", () => {
    expect(step("2026-11-30")).toBe(
      "BÄNK-1 op 20 Bocka — Kantpress 2 (120) (alternativ till 110, ordinarie v. 49), vecka 46, klar 2026-11-12"
    );
  });

  it("does not crash when the ordinary resource gives no week within the horizon", () => {
    expect(step(null)).toBe(
      "BÄNK-1 op 20 Bocka — Kantpress 2 (120) (alternativ till 110, ordinarie ger ingen vecka inom två år), vecka 46, klar 2026-11-12"
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Beläggning: 0 h capacity with load is overload.
// ---------------------------------------------------------------------------

describe("computeCapacity — a week with 0 h capacity", () => {
  // Wednesday 2026-08-19 → ISO week 34.
  const TODAY = "2026-08-19";

  const wc = (over: Partial<CapacityWorkCenter> & { workCenterId: string }): CapacityWorkCenter => ({
    code: "100",
    name: `Resurs ${over.workCenterId}`,
    type: "machine",
    productionGroupId: null,
    weekScheduleId: null,
    hoursPerDay: null,
    capacityFactor: 1,
    active: true,
    ...over,
  });

  const op = (over: Partial<CapacityOperationRow>): CapacityOperationRow => ({
    moOperationId: `op-${over.workCenterId ?? "wc-1"}-${over.sequenceNo ?? 10}`,
    manufacturingOrderId: "mo-1",
    orderNumber: "PO-1",
    articleNumber: "ART-1",
    articleName: "Artikel",
    workCenterId: "wc-1",
    orderQuantity: 10,
    dueDate: null,
    sequenceNo: 10,
    setupTime: 0,
    runTimePerUnit: 6,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    ...over,
  });

  const STD_WEEK = {
    weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
    daySchedules: [{ id: "ds-480", netMinutes: 480 }],
  };

  const input = (partial: Partial<CapacityInput>): CapacityInput => ({
    workCenters: [],
    productionGroups: [],
    operations: [],
    weekScheduleDays: [],
    daySchedules: [],
    holidays: [],
    ...partial,
  });

  const cellOf = (result: ReturnType<typeof computeCapacity>, workCenterId: string) => {
    const row = result.groups.flatMap((g) => g.resources).find((r) => r.workCenterId === workCenterId);
    if (!row) throw new Error(`no resource row for ${workCenterId}`);
    return row.weeks[0]!;
  };

  it("with load: overloaded and counted, the percentage still null", () => {
    const result = computeCapacity(
      input({
        // A schedule that exists but has no days: 0 h every week.
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-empty" })],
        daySchedules: STD_WEEK.daySchedules,
        operations: [op({ dueDate: "2026-08-19" })],
      }),
      { today: TODAY, weeks: 1 }
    );
    const cell = cellOf(result, "wc-1");
    expect(cell).toMatchObject({ loadHours: 1, availableHours: 0, loadPercent: null, overloaded: true });
    expect(result.summary.overloadedCells).toBe(1);
  });

  it("without load: not overloaded", () => {
    const result = computeCapacity(
      input({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-empty" })],
        daySchedules: STD_WEEK.daySchedules,
      }),
      { today: TODAY, weeks: 1 }
    );
    expect(cellOf(result, "wc-1")).toMatchObject({ loadHours: 0, availableHours: 0, loadPercent: null, overloaded: false });
    expect(result.summary.overloadedCells).toBe(0);
  });

  it("a resource without a schedule is never overloaded — no capacity is known", () => {
    const result = computeCapacity(
      input({ workCenters: [wc({ workCenterId: "wc-1" })], operations: [op({ dueDate: "2026-08-19" })] }),
      { today: TODAY, weeks: 1 }
    );
    expect(cellOf(result, "wc-1")).toMatchObject({ loadHours: 1, availableHours: null, loadPercent: null, overloaded: false });
    expect(result.summary.overloadedCells).toBe(0);
  });

  it("the flag follows the percentage otherwise: over 100 % yes, exactly 100 % no", () => {
    const result = computeCapacity(
      input({
        workCenters: [
          wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" }),
          wc({ workCenterId: "wc-2", code: "200", weekScheduleId: "ws-40" }),
        ],
        ...STD_WEEK,
        operations: [
          // 45 h against 40 h, and exactly 40 h against 40 h.
          op({ workCenterId: "wc-1", dueDate: "2026-08-19", orderQuantity: 450 }),
          op({ workCenterId: "wc-2", dueDate: "2026-08-19", orderQuantity: 400, manufacturingOrderId: "mo-2", orderNumber: "PO-2" }),
        ],
      }),
      { today: TODAY, weeks: 1 }
    );
    expect(cellOf(result, "wc-1")).toMatchObject({ loadPercent: 113, overloaded: true });
    expect(cellOf(result, "wc-2")).toMatchObject({ loadPercent: 100, overloaded: false });
    expect(result.summary.overloadedCells).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 1b. Prisåterföringen against the database.
// ---------------------------------------------------------------------------

describe("prisåterföring från en efterkalkyl", () => {
  const articleService = createArticleService(createArticleRepository(db));
  const stockService = createStockService(createStockRepository(db));
  const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
  const timeReportService = createTimeReportService(
    createTimeReportRepository(db),
    mfgService,
    { isDateLocked: async () => false },
    { log: async () => {} }
  );
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
  const PASSWORD = "correcthorsebattery";

  // 20 % general markup, nothing else: sales price = TVK × 1.2.
  const costingSettings = {
    costingMaterialSource: "standard" as "standard" | "supplier",
    costingSupplierPriceTier: "base" as "base" | "tiered",
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 20,
    costingMaterialMarkupPercent: 0,
  };
  const costingService = createCostingService(createCostingRepository(db), { getSettings: async () => costingSettings }, articleService);

  const TRUNCATE = sql`TRUNCATE cost_calculations, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, article_groups, audit_log, user_settings, users CASCADE`;

  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  beforeEach(async () => {
    await db.execute(TRUNCATE);
  });

  afterAll(async () => {
    await app.close();
    await db.execute(TRUNCATE);
  });

  // A parent of 10 with one unlinked component (2 per unit, standard cost 10)
  // and operation 10 (setup 30 min, run 6 min/st, 600 kr/h) — the fixture of
  // costing.service.test.ts's variance block.
  async function makeFixture() {
    const email = `kalkyl-${crypto.randomUUID()}@example.com`;
    const user = await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
    const parent = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `PARENT-${crypto.randomUUID()}`, name: "Parent", type: "manufactured", active: true,
    }));
    const component = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `COMP-${crypto.randomUUID()}`, name: "Component", type: "purchased", standardCost: 10, active: true,
    }));
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 600, overheadPercent: 0, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2 });
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
    await stockService.recordTransaction({ articleId: component.id, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 10 }, user.id);
    const [operation] = await mfgService.listOperations(order.id);
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Kalle", active: true });
    return { email, user, parent, location, order, operation: operation!, employee };
  }
  type Fixture = Awaited<ReturnType<typeof makeFixture>>;

  async function reportHours(f: Fixture, hours: number) {
    await timeReportService.createTimeReport({ employeeId: f.employee.id, moOperationId: f.operation.id, date: "2026-07-07", hours }, f.user.id);
  }

  // `ok` pieces reported on the only (last) operation: they are received and
  // the unlinked material is drawn for them. The order stays open.
  async function reportOk(f: Fixture, ok: number) {
    await mfgService.reportOperationQuantities(f.operation.id, { quantityOk: ok, quantityScrapped: 0, markDone: false, locationId: f.location.id, createdBy: f.user.id });
  }

  // Kortstängd at 8 of 10: a FINAL efterkalkyl with N = 8.
  async function finalWithEightOfTen() {
    const f = await makeFixture();
    await reportOk(f, 8);
    await reportHours(f, 2);
    await mfgService.complete(f.order.id, { quantity: 0, locationId: f.location.id }, f.user.id);
    const { calculation } = await costingService.postCalculate(f.order.id, true);
    expect(calculation).toMatchObject({ type: "post", quantity: "10.0000", outputQuantity: "8.0000", preliminary: false });
    return { f, calculation };
  }

  const readArticle = async (id: string) => (await db.select().from(articles).where(eq(articles.id, id)))[0]!;

  async function login(email: string) {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("a final efterkalkyl with N below the order quantity: TVK and price are divided by N", async () => {
    const { f, calculation } = await finalWithEightOfTen();
    const tvk = manufacturingCost(calculation);
    expect(tvk).toBeGreaterThan(0);

    await costingService.applyStandardCostFromCalculation(calculation.id);
    await costingService.applySalesPriceFromCalculation(calculation.id);

    const article = await readArticle(f.parent.id);
    // What the 8 delivered pieces cost — not spread over the 10 ordered.
    expect(Number(article.standardCost)).toBe(round4(tvk / 8));
    expect(Number(article.standardCost)).not.toBe(round4(tvk / 10));
    expect(Number(article.salesPrice)).toBe(round4(Number(calculation.salesPrice) / 8));
    // The markup is in the price and not in the standard cost.
    expect(Number(article.salesPrice)).toBeGreaterThan(Number(article.standardCost));
  });

  it("a preliminary efterkalkyl sets no prices: the domain error, and the article untouched", async () => {
    const f = await makeFixture();
    await reportOk(f, 4);
    await reportHours(f, 1);
    const { calculation } = await costingService.postCalculate(f.order.id, true);
    expect(calculation).toMatchObject({ preliminary: true, outputQuantity: "4.0000" });

    const standard = await costingService.applyStandardCostFromCalculation(calculation.id).catch((err: unknown) => err);
    expect(standard).toBeInstanceOf(CostCalculationNotFinalError);
    expect(standard).toMatchObject({ reason: "preliminary" });
    expect(errorBody(standard as Error).code).toBe("cost-calculation-not-final");
    await expect(costingService.applySalesPriceFromCalculation(calculation.id)).rejects.toBeInstanceOf(CostCalculationNotFinalError);

    const article = await readArticle(f.parent.id);
    expect(article.standardCost).toBeNull();
    expect(article.salesPrice).toBeNull();
  });

  it("answers 400 cost-calculation-not-final on both routes", async () => {
    const f = await makeFixture();
    await reportOk(f, 4);
    const { calculation } = await costingService.postCalculate(f.order.id, true);
    const cookie = await login(f.email);

    for (const route of ["apply-standard-cost", "apply-sales-price"]) {
      const res = await app.inject({ method: "POST", url: `/api/v1/cost-calculations/${calculation.id}/${route}`, headers: { cookie } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "cost-calculation-not-final" });
      expect(res.json().error).toContain("preliminär");
    }
    const article = await readArticle(f.parent.id);
    expect(article.standardCost).toBeNull();
    expect(article.salesPrice).toBeNull();
  });

  it("a final efterkalkyl with nothing received (Makulerad, N = 0) sets no prices", async () => {
    const f = await makeFixture();
    // A manual time report outlives the cancellation, so there is a cost to divide.
    await reportHours(f, 2);
    await mfgService.cancel(f.order.id, f.user.id);
    const { calculation } = await costingService.postCalculate(f.order.id, true);
    expect(calculation).toMatchObject({ preliminary: false, outputQuantity: "0.0000" });

    const standard = await costingService.applyStandardCostFromCalculation(calculation.id).catch((err: unknown) => err);
    expect(standard).toBeInstanceOf(CostCalculationNotFinalError);
    expect(standard).toMatchObject({ reason: "no-output" });
    await expect(costingService.applySalesPriceFromCalculation(calculation.id)).rejects.toBeInstanceOf(CostCalculationNotFinalError);

    const article = await readArticle(f.parent.id);
    expect(article.standardCost).toBeNull();
    expect(article.salesPrice).toBeNull();
  });

  it("an efterkalkyl saved before the analysis (0187) divides by the order quantity, as it always did", async () => {
    const { f, calculation } = await finalWithEightOfTen();
    // As costing.service.test.ts does it: none of the analysis columns.
    await db.execute(sql`update cost_calculations set output_quantity = null, preliminary = null, base_priced_at = null, base_material_source = null where id = ${calculation.id}`);
    await db.execute(sql`update cost_calculation_material_rows set base_quantity = null, base_unit_cost = null, base_price_source = null, scrap_quantity = null where cost_calculation_id = ${calculation.id}`);
    await db.execute(sql`update cost_calculation_operation_rows set base_setup_hours = null, base_run_hours = null, base_hourly_rate = null where cost_calculation_id = ${calculation.id}`);

    await costingService.applyStandardCostFromCalculation(calculation.id);
    await costingService.applySalesPriceFromCalculation(calculation.id);

    const article = await readArticle(f.parent.id);
    expect(Number(article.standardCost)).toBe(round4(manufacturingCost(calculation) / 10));
    expect(Number(article.salesPrice)).toBe(round4(Number(calculation.salesPrice) / 10));
  });

  it("a förkalkyl is unchanged: divided by its own quantity", async () => {
    const f = await makeFixture();
    const { calculation } = await costingService.preCalculate(f.parent.id, 5, true);
    // 5 × 2 × 10 material + (30 + 6 × 5) min at 600 kr/h = 100 + 600.
    expect(manufacturingCost(calculation)).toBe(700);

    await costingService.applyStandardCostFromCalculation(calculation.id);
    await costingService.applySalesPriceFromCalculation(calculation.id);

    const article = await readArticle(f.parent.id);
    expect(Number(article.standardCost)).toBe(140);
    expect(Number(article.salesPrice)).toBe(168); // 700 × 1.2 / 5
  });
});
