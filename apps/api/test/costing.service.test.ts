import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { costCalculationMaterialRows, costCalculationOperationRows, costCalculations, db } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import {
  CostCalculationNotFoundError,
  PostCalculationLockedError,
  createCostingService,
} from "../src/modules/costing/service/costing.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  // Costing never touches payroll periods — always-open stub.
  { isDateLocked: async () => false },
  // Costing doesn't exercise corrections/audit — no-op writer.
  { log: async () => {} }
);
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
// Only used to fill the article supplier catalog for the material-source tests.
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  articleService,
  testSystemService,
  // Lego (Etapp G): SubcontractOperationReporter — never reached in this
  // suite, and loud if it ever is.
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);

// The costing settings live in system_settings, which is shared across test
// files — inject a stub instead so each test states its own configuration and
// nothing leaks between files.
const costingSettings = {
  costingMaterialSource: "standard" as "standard" | "supplier",
  costingSupplierPriceTier: "base" as "base" | "tiered",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
};
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => costingSettings,
});

// `suppliers` is deliberately absent: truncating it cascades across the whole
// purchase tree (orders, inquiries, invoices), which pushed this hook past
// vitest's 20 s limit. article_suppliers is reached by the articles cascade
// anyway, and the leftover supplier rows are harmless — each test creates its
// own uniquely named one. They are cleaned up once in afterAll.
const TRUNCATE = sql`TRUNCATE cost_calculations, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  // Defaults: standard cost, no markups — the calculation as it was before
  // System → Kalkyler existed.
  Object.assign(costingSettings, {
    costingMaterialSource: "standard",
    costingSupplierPriceTier: "base",
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 0,
  });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`TRUNCATE suppliers CASCADE`);
});

async function makeUser() {
  return authRepo.create({
    email: `cost-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Cost Clerk",
    role: "admin",
  });
}

async function makeParentWithBom(componentStandardCost: number | undefined, componentQtyPerParent: number) {
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Parent",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const component = await articleService.createArticle({
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Component",
    type: "purchased",
    unit: "st",
    standardCost: componentStandardCost,
    active: true,
  });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: componentQtyPerParent });
  return { parent, component };
}

// A service article in the structure = subcontracted work (lego).
async function addServiceComponent(parentId: string, standardCost: number, quantityPerParent: number) {
  const service = await articleService.createArticle({
    articleNumber: `LEGO-${crypto.randomUUID()}`,
    name: "Pulverlackering",
    type: "service",
    unit: "st",
    standardCost,
    active: true,
  });
  await articleService.addBomComponent(parentId, { componentArticleId: service.id, quantity: quantityPerParent });
  return service;
}

async function setPrimarySupplierPrice(
  articleId: string,
  price: number | undefined,
  priceBreaks?: { fromQuantity: number; price: number }[]
) {
  const supplier = await purchaseService.createSupplier({ name: `Lev-${crypto.randomUUID()}`, active: true });
  await purchaseService.addArticleSupplier(articleId, { supplierId: supplier.id, price, isPrimary: true, priceBreaks });
  return supplier;
}

// A released, started MO with 8 of 10 planned units consumed and 3 hours
// reported on its single operation — the scenario the post-calculation tests
// build inline. Material 8 x 10 = 80, labor 3 x 100 = 300, TO 50 % = 150.
async function makeOrderWithReportedWork() {
  const user = await makeUser();
  const { parent, component } = await makeParentWithBom(10, 2);
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 50, active: true });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });

  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
  await stockService.recordTransaction({
    articleId: component.id,
    locationId: location.id,
    quantityDelta: 100,
    transactionType: "inventory_adjustment",
  });

  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  await mfgService.start(order.id);
  const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
  await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 8 }, user.id);

  const [operation] = await mfgService.listOperations(order.id);
  const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Kalle", active: true });
  await timeReportService.createTimeReport(
    { employeeId: employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: 3 },
    user.id
  );
  return order;
}

describe("costing service — pre-calculation", () => {
  it("computes material, labor, and overhead from BOM x standardCost and Routing x hourly rate", async () => {
    const { parent } = await makeParentWithBom(10, 2); // 2 units component @ 10 SEK per parent unit
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    // material: 2 * 5 * 10 = 100
    expect(calculation.materialCost).toBe("100.0000");
    // minutes: 30 + 6*5 = 60 -> 1h * 60 SEK/h = 60
    expect(calculation.laborCost).toBe("60.0000");
    // overhead: 60 * 10% = 6 (TO, per work center)
    expect(calculation.overhead).toBe("6.0000");
    // No markups configured, so the påläggskalkyl is inert and the price is
    // just the direct cost: 100 + 60 + 6.
    expect(calculation.materialOverhead).toBe("0.0000");
    expect(calculation.subcontractCost).toBe("0.0000");
    expect(calculation.subcontractOverhead).toBe("0.0000");
    expect(calculation.businessOverhead).toBe("0.0000");
    expect(calculation.generalMarkup).toBe("0.0000");
    expect(calculation.salesPrice).toBe("166.0000");
    expect(calculation.type).toBe("pre");
    expect(calculation.manufacturingOrderId).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it("counts a Kalkyl operation in the pre-calculation's labor, self cost and sales price", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    // "Kalkyl": never released onto an MO, but its time is part of the price.
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 2,
      workCenterId: workCenter.id,
      setupTime: 30,
      runTimePerUnit: 6,
      costingOnly: true,
    });

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);

    // Both operations: 2 x (30 + 6*5) minutes = 2h * 60 SEK/h = 120.
    expect(calculation.laborCost).toBe("120.0000");
    expect(calculation.overhead).toBe("12.0000");
    // TVK/SVK are derived, never stored — with no markups configured the
    // sales price IS the self cost: 100 material + 120 labor + 12 TO.
    expect(calculation.salesPrice).toBe("232.0000");

    const detail = await costingService.getCostCalculation(calculation.id);
    expect(detail!.operationRows.map((r) => r.sequenceNo)).toEqual([1, 2]);
  });

  it("warns and treats missing standardCost as 0", async () => {
    const { parent } = await makeParentWithBom(undefined, 2);

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    expect(calculation.materialCost).toBe("0.0000");
    expect(warnings).toHaveLength(1);
  });

  it("reports one warning per distinct message when the same component is drawn at two operations", async () => {
    // The component sits both directly under the parent (drawn at no
    // particular operation) and inside a phantom that is drawn at one — the
    // explosion keys by article *and* operation, so this is two material
    // lines whose warning texts, naming only the component, come out
    // identical. (The same article cannot sit twice under one parent: unique
    // (parent_article_id, component_article_id).)
    const { parent, component } = await makeParentWithBom(undefined, 2);
    const workCenter = await mfgService.createWorkCenter({
      code: "200",
      name: "Montering",
      hourlyRate: 60,
      overheadPercent: 0,
      active: true,
    });
    const operation = await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 1,
      workCenterId: workCenter.id,
      setupTime: 0,
      runTimePerUnit: 6,
    });
    const phantom = await articleService.createArticle({
      articleNumber: `PHANTOM-${crypto.randomUUID()}`,
      name: "Phantom",
      type: "manufactured",
      isPhantom: true,
      unit: "st",
      active: true,
    });
    await articleService.addBomComponent(parent.id, {
      componentArticleId: phantom.id,
      quantity: 1,
      routingOperationId: operation.id,
    });
    await articleService.addBomComponent(phantom.id, { componentArticleId: component.id, quantity: 3 });

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    // Both lines are still costed (2*5 + 3*5 units, all at 0 SEK)...
    expect(calculation.materialCost).toBe("0.0000");
    // ...but the identical warning is only worth saying once.
    expect(warnings).toEqual(["Component: saknar standardpris, antar 0"]);
  });

  it("resolves a phantom component into its own components' standardCost, not the phantom's own (nonexistent) cost", async () => {
    const parent = await articleService.createArticle({
      articleNumber: `PARENT-${crypto.randomUUID()}`,
      name: "Parent",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const phantom = await articleService.createArticle({
      articleNumber: `PHANTOM-${crypto.randomUUID()}`,
      name: "Phantom",
      type: "manufactured",
      isPhantom: true,
      unit: "st",
      active: true,
    });
    const leaf = await articleService.createArticle({
      articleNumber: `LEAF-${crypto.randomUUID()}`,
      name: "Leaf",
      type: "purchased",
      unit: "st",
      standardCost: 10,
      active: true,
    });
    await articleService.addBomComponent(parent.id, { componentArticleId: phantom.id, quantity: 2 });
    await articleService.addBomComponent(phantom.id, { componentArticleId: leaf.id, quantity: 3 });

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    // 2 (parent->phantom) x 3 (phantom->leaf) x 5 (requested qty) x 10 SEK = 300
    expect(calculation.materialCost).toBe("300.0000");
    expect(warnings).toHaveLength(0);
  });
});

describe("costing service — material source", () => {
  it("uses the primary supplier's price instead of the standard cost", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 25);
    costingSettings.costingMaterialSource = "supplier";

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    // 2 * 5 * 25 (supplier price), not 2 * 5 * 10 (standard cost)
    expect(calculation.materialCost).toBe("250.0000");
    expect(warnings).toHaveLength(0);
  });

  // Stafflade leverantörspriser (System → Kalkyler: Leverantörspris vid staffel).
  it("keeps the grundpris whatever the quantity with Leverantörspris vid staffel = Grundpris", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 25, [{ fromQuantity: 5, price: 20 }]);
    costingSettings.costingMaterialSource = "supplier";

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    // 2 * 5 = 10 units would reach the 5+ step, but the default ignores it.
    expect(calculation.materialCost).toBe("250.0000");
    expect(warnings).toHaveLength(0);
  });

  it("uses the step for the component's total quantity with Staffelpris för kalkylantalet", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 25, [{ fromQuantity: 5, price: 20 }]);
    costingSettings.costingMaterialSource = "supplier";
    costingSettings.costingSupplierPriceTier = "tiered";

    // 2 per parent × 5 = 10 ≥ 5 → the step price 20.
    const atStep = await costingService.preCalculate(parent.id, 5, true);
    expect(atStep.calculation.materialCost).toBe("200.0000");
    expect(atStep.warnings).toHaveLength(0);

    // 2 × 2 = 4 < 5 → grundpriset 25.
    const below = await costingService.preCalculate(parent.id, 2, true);
    expect(below.calculation.materialCost).toBe("100.0000");
  });

  it("falls back to the standard cost and warns when the component has no supplier", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    costingSettings.costingMaterialSource = "supplier";

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    expect(calculation.materialCost).toBe("100.0000");
    expect(warnings).toEqual(["Component: inget leverantörspris, använder standardpris"]);
  });

  it("falls back when the primary supplier is listed without a price", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, undefined);
    costingSettings.costingMaterialSource = "supplier";

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    expect(calculation.materialCost).toBe("100.0000");
    expect(warnings).toHaveLength(1);
  });

  it("ignores the supplier price when the source is standard", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 25);

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    expect(calculation.materialCost).toBe("100.0000");
    expect(warnings).toHaveLength(0);
  });
});

describe("costing service — markups", () => {
  it("counts a service article in the structure as lego, not direct material", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    await addServiceComponent(parent.id, 40, 1);

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);

    expect(calculation.materialCost).toBe("100.0000"); // 2 * 5 * 10
    expect(calculation.subcontractCost).toBe("200.0000"); // 1 * 5 * 40
  });

  it("applies MO on material, LO on lego, Affo on TVK and the general markup on SVK", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    await addServiceComponent(parent.id, 40, 1);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    Object.assign(costingSettings, {
      costingMoPercent: 10,
      costingLoPercent: 5,
      costingAffoPercent: 12,
      costingGeneralMarkupPercent: 20,
    });

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);

    expect(calculation.materialCost).toBe("100.0000"); // dM
    expect(calculation.materialOverhead).toBe("10.0000"); // MO: 100 * 10%
    expect(calculation.laborCost).toBe("60.0000"); // dL
    expect(calculation.overhead).toBe("6.0000"); // TO: 60 * 10%
    expect(calculation.subcontractCost).toBe("200.0000"); // Lego
    expect(calculation.subcontractOverhead).toBe("10.0000"); // LO: 200 * 5%
    // TVK = 100 + 10 + 60 + 6 + 200 + 10 = 386; Affo = 386 * 12% = 46.32
    expect(calculation.businessOverhead).toBe("46.3200");
    // SVK = 432.32; generellt påslag = 432.32 * 20% = 86.464
    expect(calculation.generalMarkup).toBe("86.4640");
    expect(calculation.salesPrice).toBe("518.7840");
  });

  it("snapshots the material source and the markups that applied", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    Object.assign(costingSettings, {
      costingMaterialSource: "supplier",
      costingMoPercent: 10,
      costingLoPercent: 5,
      costingAffoPercent: 12.5,
      costingGeneralMarkupPercent: 20,
    });

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);

    // Without this the calculation stops being explainable the moment
    // System → Kalkyler changes.
    expect(calculation.materialSource).toBe("supplier");
    expect(calculation.moPercent).toBe("10.00");
    expect(calculation.loPercent).toBe("5.00");
    expect(calculation.affoPercent).toBe("12.50");
    expect(calculation.generalMarkupPercent).toBe("20.00");
  });

  it("applies the same markups to the post-calculation", async () => {
    const user = await makeUser();
    const { parent, component } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 0, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });

    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    await stockService.recordTransaction({
      articleId: component.id,
      locationId: location.id,
      quantityDelta: 100,
      transactionType: "inventory_adjustment",
    });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    await mfgService.start(order.id);
    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
    await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 10 }, user.id);

    const [operation] = await mfgService.listOperations(order.id);
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Kalle", active: true });
    await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: 1 },
      user.id
    );

    Object.assign(costingSettings, { costingMoPercent: 10, costingAffoPercent: 50, costingGeneralMarkupPercent: 100 });

    const { calculation } = await costingService.postCalculate(order.id, true);

    expect(calculation.materialCost).toBe("100.0000"); // 10 consumed * 10
    expect(calculation.materialOverhead).toBe("10.0000"); // MO: 100 * 10%
    expect(calculation.laborCost).toBe("100.0000"); // 1 reported hour * 100
    // TVK = 100 + 10 + 100 = 210; Affo = 105; SVK = 315; generellt = 315
    expect(calculation.businessOverhead).toBe("105.0000");
    expect(calculation.salesPrice).toBe("630.0000");
  });
});

describe("costing service — post-calculation", () => {
  it("uses actual consumption and actually reported hours, not planned values", async () => {
    const user = await makeUser();
    const { parent, component } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 50, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 999, runTimePerUnit: 999 });

    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    await stockService.recordTransaction({
      articleId: component.id,
      locationId: location.id,
      quantityDelta: 100,
      transactionType: "inventory_adjustment",
    });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    await mfgService.start(order.id);

    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
    await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 8 }, user.id);

    const [operation] = await mfgService.listOperations(order.id);
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Kalle", active: true });
    await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: 3 },
      user.id
    );

    const { calculation, warnings } = await costingService.postCalculate(order.id, true);

    // material: 8 (actual, not the planned 10) * 10 = 80
    expect(calculation.materialCost).toBe("80.0000");
    // labor: 3 reported hours (ignoring the absurd planned setup/run times) * 100 = 300
    expect(calculation.laborCost).toBe("300.0000");
    // overhead: 300 * 50% = 150
    expect(calculation.overhead).toBe("150.0000");
    expect(calculation.type).toBe("post");
    expect(calculation.manufacturingOrderId).toBe(order.id);
    expect(warnings).toHaveLength(0);
  });

  it("warns when an operation has no reported hours", async () => {
    const user = await makeUser();
    const { parent } = await makeParentWithBom(10, 1);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 0, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 1 }, user.id);

    const { warnings } = await costingService.postCalculate(order.id, true);
    expect(warnings.some((w) => w.includes("ingen rapporterad tid"))).toBe(true);
  });
});

describe("costing service — specification rows", () => {
  it("writes one material row per component and one operation row per routing step", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);
    const detail = await costingService.getCostCalculation(calculation.id);

    expect(detail!.materialRows).toHaveLength(1);
    const material = detail!.materialRows[0]!;
    expect(material.componentArticleId).toBe(component.id);
    expect(material.articleName).toBe("Component");
    expect(material.kind).toBe("material");
    expect(material.quantity).toBe("10.0000"); // 2 per parent x 5
    expect(material.unitCost).toBe("10.0000");
    expect(material.priceSource).toBe("standard");
    expect(material.amount).toBe("100.0000");

    expect(detail!.operationRows).toHaveLength(1);
    const operation = detail!.operationRows[0]!;
    expect(operation.sequenceNo).toBe(1);
    expect(operation.workCenterName).toBe("Svets");
    expect(operation.hours).toBe("1.0000"); // (30 + 6*5) minutes
    // The setup share is snapshotted separately so the specification can show
    // how much of the unit price is amortised setup cost.
    expect(operation.setupHours).toBe("0.5000"); // 30 minutes
    expect(operation.hourlyRate).toBe("60.00");
    expect(operation.overheadPercent).toBe("10.00");
    expect(operation.laborAmount).toBe("60.0000");
    expect(operation.overheadAmount).toBe("6.0000");
  });

  it("adds the rows up to exactly the header's direct costs", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    await addServiceComponent(parent.id, 40, 1);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    Object.assign(costingSettings, { costingMoPercent: 10, costingLoPercent: 5, costingAffoPercent: 12 });

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);
    const detail = await costingService.getCostCalculation(calculation.id);

    // The invariant that makes the specification trustworthy: every krona in
    // the header is accounted for by a row.
    const sum = (rows: { amount: string }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
    const material = detail!.materialRows.filter((r) => r.kind === "material");
    const lego = detail!.materialRows.filter((r) => r.kind === "subcontract");

    expect(sum(material)).toBe(Number(calculation.materialCost));
    expect(sum(lego)).toBe(Number(calculation.subcontractCost));
    expect(detail!.operationRows.reduce((t, r) => t + Number(r.laborAmount), 0)).toBe(Number(calculation.laborCost));
    expect(detail!.operationRows.reduce((t, r) => t + Number(r.overheadAmount), 0)).toBe(Number(calculation.overhead));
  });

  it("marks a service article's row as lego rather than material", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    const service = await addServiceComponent(parent.id, 40, 1);

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);
    const detail = await costingService.getCostCalculation(calculation.id);

    const legoRow = detail!.materialRows.find((r) => r.componentArticleId === service.id);
    expect(legoRow?.kind).toBe("subcontract");
    expect(legoRow?.amount).toBe("200.0000"); // 1 x 5 x 40
    expect(detail!.materialRows.filter((r) => r.kind === "material")).toHaveLength(1);
  });

  it("records on the row which price was actually used when the supplier source falls back", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    costingSettings.costingMaterialSource = "supplier";

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);
    const detail = await costingService.getCostCalculation(calculation.id);

    // The header records what was configured, the row what was available.
    expect(calculation.materialSource).toBe("supplier");
    expect(detail!.materialRows[0]!.priceSource).toBe("standard");
  });

  it("writes operation rows from the hours actually reported on a post-calculation", async () => {
    const user = await makeUser();
    const { parent, component } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 50, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 999, runTimePerUnit: 999 });

    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    await stockService.recordTransaction({
      articleId: component.id,
      locationId: location.id,
      quantityDelta: 100,
      transactionType: "inventory_adjustment",
    });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    await mfgService.start(order.id);
    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
    await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: 8 }, user.id);

    const [operation] = await mfgService.listOperations(order.id);
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Kalle", active: true });
    await timeReportService.createTimeReport(
      { employeeId: employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: 3 },
      user.id
    );

    const { calculation } = await costingService.postCalculate(order.id, true);
    const detail = await costingService.getCostCalculation(calculation.id);

    // 3 reported hours, not the absurd planned setup/run times.
    expect(detail!.operationRows[0]!.hours).toBe("3.0000");
    // Reported time has no setup/run split — the post-calculation stores none.
    expect(detail!.operationRows[0]!.setupHours).toBeNull();
    expect(detail!.operationRows[0]!.laborAmount).toBe("300.0000");
    expect(detail!.operationRows[0]!.overheadAmount).toBe("150.0000");
    expect(detail!.materialRows[0]!.quantity).toBe("8.0000"); // consumed, not planned
  });

  it("deletes the specification rows with the calculation", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    const { calculation } = await costingService.preCalculate(parent.id, 5, true);

    await costingService.deleteCostCalculation(calculation.id);

    expect(await costingService.getCostCalculation(calculation.id)).toBeNull();
    const material = await db
      .select()
      .from(costCalculationMaterialRows)
      .where(eq(costCalculationMaterialRows.costCalculationId, calculation.id));
    const operations = await db
      .select()
      .from(costCalculationOperationRows)
      .where(eq(costCalculationOperationRows.costCalculationId, calculation.id));
    expect(material).toHaveLength(0);
    expect(operations).toHaveLength(0);
  });

  it("returns no rows for a calculation saved before the row tables existed", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    const { calculation } = await costingService.preCalculate(parent.id, 5, true);
    await db.delete(costCalculationMaterialRows).where(eq(costCalculationMaterialRows.costCalculationId, calculation.id));

    const detail = await costingService.getCostCalculation(calculation.id);

    expect(detail!.materialRows).toEqual([]);
    expect(detail!.materialCost).toBe("100.0000");
  });
});

describe("costing service — förhandsvisning eller sparning", () => {
  it("writes no row when the pre-calculation is only previewed", async () => {
    const { parent } = await makeParentWithBom(10, 2);

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5);

    expect(calculation.id).toBeNull();
    expect(calculation.calculatedAt).toBeNull();
    // The numbers are the real ones — a preview is not a stub.
    expect(calculation.materialCost).toBe("100.0000");
    expect(calculation.type).toBe("pre");
    expect(warnings).toHaveLength(0);
    expect(await db.select().from(costCalculations)).toHaveLength(0);
  });

  it("gives a previewed and a saved pre-calculation identical numbers", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    await addServiceComponent(parent.id, 40, 1);
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    Object.assign(costingSettings, {
      costingMoPercent: 10,
      costingLoPercent: 5,
      costingAffoPercent: 12,
      costingGeneralMarkupPercent: 20,
    });

    const { calculation: preview } = await costingService.preCalculate(parent.id, 5);
    const { calculation: saved } = await costingService.preCalculate(parent.id, 5, true);

    // Every column, not a hand-picked few: this is what proves splitting the
    // service into compute + persist moved no number, and that the draft is
    // formatted to exactly the scale the numeric columns hand back.
    expect({ ...preview, id: saved.id, calculatedAt: saved.calculatedAt }).toEqual(saved);
  });

  it("gives a previewed and a saved pre-calculation identical numbers at a rounding half-way boundary", async () => {
    // 20.0005 x 1 x 5 = materialCost 100.0025; a 50 % MO markup lands the
    // overhead exactly halfway between 50.0012 and 50.0013 — the kind of
    // value where rounding the exact binary float (toFixed) and rounding the
    // decimal text of String(value) (Postgres) can disagree on the last
    // digit. salesPrice (150.00375, since Affo/general markup are both 0 %
    // here) lands on the same kind of boundary.
    const { parent } = await makeParentWithBom(20.0005, 1);
    Object.assign(costingSettings, { costingMoPercent: 50 });

    const { calculation: preview } = await costingService.preCalculate(parent.id, 5);
    const { calculation: saved } = await costingService.preCalculate(parent.id, 5, true);

    expect({ ...preview, id: saved.id, calculatedAt: saved.calculatedAt }).toEqual(saved);
    // Postgres rounds half-up: verified directly (`select '50.00125'::numeric(14,4)`
    // -> 50.0013), so the saved/preview figure isn't just self-consistent —
    // it's the one true rounding of the halfway value, not the other one.
    expect(saved.materialOverhead).toBe("50.0013");
    expect(saved.salesPrice).toBe("150.0038");
  });

  it("writes no row when the post-calculation is only previewed", async () => {
    const order = await makeOrderWithReportedWork();

    const { calculation } = await costingService.postCalculate(order.id);

    expect(calculation.id).toBeNull();
    expect(calculation.calculatedAt).toBeNull();
    expect(calculation.manufacturingOrderId).toBe(order.id);
    expect(calculation.materialCost).toBe("80.0000"); // 8 consumed x 10
    expect(calculation.laborCost).toBe("300.0000"); // 3 reported hours x 100
    expect(await db.select().from(costCalculations)).toHaveLength(0);
  });

  it("gives a previewed and a saved post-calculation identical numbers", async () => {
    const order = await makeOrderWithReportedWork();
    Object.assign(costingSettings, { costingMoPercent: 10, costingAffoPercent: 12, costingGeneralMarkupPercent: 20 });

    const { calculation: preview } = await costingService.postCalculate(order.id);
    const { calculation: saved } = await costingService.postCalculate(order.id, true);

    expect({ ...preview, id: saved.id, calculatedAt: saved.calculatedAt }).toEqual(saved);
  });
});

describe("costing service — borttagning", () => {
  it("refuses to delete a post-calculation", async () => {
    const order = await makeOrderWithReportedWork();
    const { calculation } = await costingService.postCalculate(order.id, true);

    await expect(costingService.deleteCostCalculation(calculation.id)).rejects.toThrow(PostCalculationLockedError);

    // The order's record of what it actually cost is untouched.
    expect(await costingService.getCostCalculation(calculation.id)).not.toBeNull();
  });

  it("throws for an unknown calculation id", async () => {
    await expect(costingService.deleteCostCalculation(crypto.randomUUID())).rejects.toThrow(CostCalculationNotFoundError);
  });
});
