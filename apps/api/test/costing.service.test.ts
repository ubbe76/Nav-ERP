import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { asc, eq, sql } from "drizzle-orm";
import { articleGroups, articles, costCalculationMaterialRows, costCalculationOperationRows, costCalculations, db, systemSettings } from "@navet/db";
import { preCalculateSchema, stampOutSchema, type CostVarianceOperationRow, createArticleSchema, createStockLocationSchema, createSupplierSchema, createWorkCenterSchema } from "@navet/shared";
import { manufacturingCost, selfCost } from "../src/modules/costing/service/cost-figures.js";
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
import { ExchangeRateUnavailableError } from "../src/modules/system/service/exchange-rates.js";
import { stockholmDateOf } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";
import { editStockLog } from "./helpers/stock-log.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
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
  costingMaterialMarkupPercent: 0,
};
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => costingSettings,
});

// `suppliers` is deliberately absent: truncating it cascades across the whole
// purchase tree (orders, inquiries, invoices), which pushed this hook past
// vitest's 20 s limit. article_suppliers is reached by the articles cascade
// anyway, and the leftover supplier rows are harmless — each test creates its
// own uniquely named one. They are cleaned up once in afterAll.
const TRUNCATE = sql`TRUNCATE cost_calculations, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, article_groups, users CASCADE`;

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
    costingMaterialMarkupPercent: 0,
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
  const parent = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Parent",
    type: "manufactured",
    active: true,
  }));
  const component = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Component",
    type: "purchased",
    standardCost: componentStandardCost,
    active: true,
  }));
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: componentQtyPerParent });
  return { parent, component };
}

// A service article in the structure = subcontracted work (lego).
async function addServiceComponent(parentId: string, standardCost: number, quantityPerParent: number) {
  const service = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `LEGO-${crypto.randomUUID()}`,
    name: "Pulverlackering",
    type: "service",
    standardCost,
    active: true,
  }));
  await articleService.addBomComponent(parentId, { componentArticleId: service.id, quantity: quantityPerParent });
  return service;
}

async function setPrimarySupplierPrice(
  articleId: string,
  price: number | undefined,
  priceBreaks?: { fromQuantity: number; price: number }[],
  currency = "SEK"
) {
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: `Lev-${crypto.randomUUID()}`, active: true }));
  await purchaseService.addArticleSupplier(articleId, { supplierId: supplier.id, price, currency, isPrimary: true, priceBreaks });
  return supplier;
}

// A released, started MO with 8 of 10 planned units consumed and 3 hours
// reported on its single operation — the scenario the post-calculation tests
// build inline. Material 8 x 10 = 80, labor 3 x 100 = 300, TO 50 % = 150.
async function makeOrderWithReportedWork() {
  const user = await makeUser();
  const { parent, component } = await makeParentWithBom(10, 2);
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 50, active: true }));
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });

  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 5, true);

    // material: 2 * 5 * 10 = 100
    expect(calculation.materialCost).toBe("100.0000");
    // minutes: 30 + 6*5 = 60 -> 1h * 60 SEK/h = 60
    expect(calculation.laborCost).toBe("60.0000");
    // overhead: 60 * 10% = 6 (TO, per work center)
    expect(calculation.overhead).toBe("6.0000");
    // No markups configured, so the påläggskalkyl is inert and the price is
    // just the direct cost plus TO: 100 + 60 + 6.
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
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
    // sales price is the self cost plus TO: 100 material + 120 labor + 12 TO.
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, {
      code: "200",
      name: "Montering",
      hourlyRate: 60,
      overheadPercent: 0,
      active: true,
    }));
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
    const parent = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `PARENT-${crypto.randomUUID()}`,
      name: "Parent",
      type: "manufactured",
      active: true,
    }));
    const phantom = await articleService.createArticle({
      articleNumber: `PHANTOM-${crypto.randomUUID()}`,
      name: "Phantom",
      type: "manufactured",
      isPhantom: true,
      active: true,
    });
    const leaf = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `LEAF-${crypto.randomUUID()}`,
      name: "Leaf",
      type: "purchased",
      standardCost: 10,
      active: true,
    }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
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
    // TVK = 100 + 10 + 60 + 200 + 10 = 380 (TO is outside); Affo = 380 * 12% = 45.6
    expect(calculation.businessOverhead).toBe("45.6000");
    // SVK = 425.6; generellt påslag = 425.6 * 20% = 85.12
    expect(calculation.generalMarkup).toBe("85.1200");
    // SVK + generellt påslag + TO = 425.6 + 85.12 + 6
    expect(calculation.salesPrice).toBe("516.7200");
  });

  it("puts the materialpåslag on dM + MO, towards the sales price only", async () => {
    const { parent } = await makeParentWithBom(10, 2);
    await addServiceComponent(parent.id, 40, 1);
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    Object.assign(costingSettings, {
      costingMoPercent: 10,
      costingLoPercent: 5,
      costingAffoPercent: 12,
      costingGeneralMarkupPercent: 20,
      costingMaterialMarkupPercent: 25,
    });

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);

    // 25 % of dM 100 + MO 10 — lego, LO and labor get none of it.
    expect(calculation.materialMarkup).toBe("27.5000");
    expect(calculation.materialMarkupPercent).toBe("25.00");
    // Affo and the general markup are the same as without it (see above).
    expect(calculation.businessOverhead).toBe("45.6000");
    expect(calculation.generalMarkup).toBe("85.1200");
    // SVK 425.6 + generellt 85.12 + materialpåslag 27.5 + TO 6
    expect(calculation.salesPrice).toBe("544.2200");

    // Prisåterföring writes the price with the markup; the standard cost
    // (TVK) and the TB basis (SVK) stay without it.
    const { calculation: draft } = await costingService.preCalculate(parent.id, 5);
    expect(draft.materialMarkup).toBe("27.5000");
    expect(draft.salesPrice).toBe("544.2200");
    const selfCosts = await costingService.latestPreCalculationSelfCost([parent.id]);
    expect(selfCosts.get(parent.id)!.selfCostPerUnit).toBeCloseTo(425.6 / 5, 10);
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 0, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });

    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 50, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 999, runTimePerUnit: 999 });

    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 0, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 1 }, user.id);

    const { warnings } = await costingService.postCalculate(order.id, true);
    expect(warnings.some((w) => w.includes("ingen rapporterad tid"))).toBe(true);
  });
});

describe("costing service — specification rows", () => {
  it("writes one material row per component and one operation row per routing step", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 100, overheadPercent: 50, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 999, runTimePerUnit: 999 });

    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
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
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
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

// Leverantörspris i valuta (#1): a supplier price in another currency is costed
// at today's rate, recorded on the specification row, and a currency without a
// rate falls back to the standard cost with a warning — never read as kronor.
describe("costing service — supplier price in another currency", () => {
  const lookups: { currency: string; date: string }[] = [];
  const knownRates: Record<string, number> = { EUR: 11.5, USD: 10 };
  const ratedService = createCostingService(
    createCostingRepository(db),
    { getSettings: async () => costingSettings },
    undefined,
    {
      getRate: async (currency, date) => {
        lookups.push({ currency, date });
        const rate = knownRates[currency];
        if (rate === undefined) throw new ExchangeRateUnavailableError(currency, date);
        return { currency, requestedDate: date, date, rate, source: "riksbank" };
      },
    },
    () => "2026-10-29"
  );

  beforeEach(() => {
    lookups.length = 0;
    costingSettings.costingMaterialSource = "supplier";
  });

  async function materialRowsOf(calculationId: string) {
    return db.select().from(costCalculationMaterialRows).where(eq(costCalculationMaterialRows.costCalculationId, calculationId));
  }

  it("converts the price at today's rate and records currency, price and rate on the row", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 2.5, undefined, "EUR");

    const { calculation, warnings } = await ratedService.preCalculate(parent.id, 5, true);

    // 2 × 5 × (2.5 EUR × 11.5) = 10 × 28.75
    expect(calculation.materialCost).toBe("287.5000");
    expect(warnings).toEqual([]);
    expect(lookups).toEqual([{ currency: "EUR", date: "2026-10-29" }]);
    const [row] = await materialRowsOf(calculation.id);
    expect(row).toMatchObject({
      unitCost: "28.7500",
      priceSource: "supplier",
      supplierCurrency: "EUR",
      supplierUnitPrice: "2.5000",
      exchangeRate: "11.500000",
    });
  });

  it("looks a currency up once per calculation however many rows use it", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 2.5, undefined, "EUR");
    const second = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `COMP-${crypto.randomUUID()}`,
      name: "Second",
      type: "purchased",
      active: true,
    }));
    await articleService.addBomComponent(parent.id, { componentArticleId: second.id, quantity: 1 });
    await setPrimarySupplierPrice(second.id, 4, undefined, "EUR");

    const { calculation } = await ratedService.preCalculate(parent.id, 1, false);

    // 2 × 28.75 + 1 × 46
    expect(calculation.materialCost).toBe("103.5000");
    expect(lookups).toHaveLength(1);
  });

  it("falls back to the standard cost and names the currency when there is no rate", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 2.5, undefined, "NOK");

    const { calculation, warnings } = await ratedService.preCalculate(parent.id, 5, true);

    expect(calculation.materialCost).toBe("100.0000");
    expect(warnings).toEqual(["Component: ingen kurs för leverantörspriset i NOK, använder standardpris"]);
    const [row] = await materialRowsOf(calculation.id);
    expect(row).toMatchObject({ priceSource: "standard", supplierCurrency: null, supplierUnitPrice: null, exchangeRate: null });
  });

  it("never looks up a rate for a SEK price or for another material source", async () => {
    const sek = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(sek.component.id, 25);
    const sekResult = await ratedService.preCalculate(sek.parent.id, 5, true);
    expect(sekResult.calculation.materialCost).toBe("250.0000");
    const [sekRow] = await materialRowsOf(sekResult.calculation.id);
    expect(sekRow).toMatchObject({ supplierCurrency: null, exchangeRate: null });

    const eur = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(eur.component.id, 2.5, undefined, "EUR");
    costingSettings.costingMaterialSource = "standard";
    const standard = await ratedService.preCalculate(eur.parent.id, 5, false);
    expect(standard.calculation.materialCost).toBe("100.0000");

    expect(lookups).toEqual([]);
  });

  it("converts on a sub-level of a multi-level calculation", async () => {
    const top = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `TOP-${crypto.randomUUID()}`,
      name: "Top",
      type: "manufactured",
      active: true,
    }));
    const { parent: semi, component: leaf } = await makeParentWithBom(10, 3);
    await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 2 });
    await setPrimarySupplierPrice(leaf.id, 1.5, undefined, "USD");

    const { calculation, warnings } = await ratedService.preCalculate(top.id, 1, true, true);

    // 2 × 3 leaves × (1.5 USD × 10) = 90, carried up as the halvfabrikat's TVK.
    expect(calculation.semiFinishedCost).toBe("90.0000");
    expect(warnings).toEqual([]);
    expect(lookups).toEqual([{ currency: "USD", date: "2026-10-29" }]);
  });

  it("converts in the configurator's derived-structure preview", async () => {
    const { parent, component } = await makeParentWithBom(10, 2);
    await setPrimarySupplierPrice(component.id, 2.5, undefined, "EUR");

    const preview = await ratedService.previewStructure(parent.id, 1, {
      components: [{ componentArticleId: component.id, quantity: 2, unitId: null, unitFactor: null }],
      operations: [],
    });

    expect(preview.materialCost).toBe(57.5);
    expect(preview.warnings).toEqual([]);
  });

  it("converts the consumed material in a post-calculation", async () => {
    const order = await makeOrderWithReportedWork();
    const [consumption] = await mfgService.listMaterialConsumptions(order.id);
    await setPrimarySupplierPrice(consumption!.componentArticleId, 2, undefined, "USD");

    const { calculation } = await ratedService.postCalculate(order.id, true);

    // 8 consumed × (2 USD × 10)
    expect(calculation.materialCost).toBe("160.0000");
    const [row] = await materialRowsOf(calculation.id);
    expect(row).toMatchObject({ supplierCurrency: "USD", supplierUnitPrice: "2.0000", exchangeRate: "10.000000" });
  });
});

// Efterkalkylen prissätter vid uttaget: with Standardpris or Aktiv
// leverantörs pris the post-calculation reads each component's price — and
// the rate — as of its latest withdrawal on the order, from the histories
// (D1 and migration 0169). And it has its own material source.
describe("costing service — post-calculation priced at the withdrawal", () => {
  const lookups: { currency: string; date: string }[] = [];
  const ratedService = createCostingService(
    createCostingRepository(db),
    { getSettings: async () => costingSettings },
    undefined,
    {
      getRate: async (currency, date) => {
        lookups.push({ currency, date });
        return { currency, requestedDate: date, date, rate: date === "2026-03-03" ? 11 : 12, source: "riksbank" };
      },
    },
    () => "2026-10-29"
  );

  beforeEach(() => {
    lookups.length = 0;
  });

  // Moves the order's withdrawals and every recorded price of the component
  // onto fixed days, so "as of the withdrawal" can be told apart from "now".
  async function backdate(orderId: string, componentId: string, drawnAt: string, firstPriceAt: string) {
    await editStockLog((tx) => tx.execute(sql`update stock_transactions set created_at = ${drawnAt}::timestamptz where reference_id = ${orderId} and transaction_type = 'mo_consumption'`));
    await db.execute(sql`update article_standard_cost_history set valid_from = ${firstPriceAt}::timestamptz where article_id = ${componentId}`);
    await db.execute(sql`update article_supplier_price_history set valid_from = ${firstPriceAt}::timestamptz where article_id = ${componentId}`);
  }

  it("prices the standard cost as it was at the withdrawal", async () => {
    const order = await makeOrderWithReportedWork();
    const [consumption] = await mfgService.listMaterialConsumptions(order.id);
    const componentId = consumption!.componentArticleId;
    await backdate(order.id, componentId, "2026-03-03T09:00:00Z", "2026-03-01T09:00:00Z");
    await articleService.updateStandardCost(componentId, 20);

    const { calculation } = await ratedService.postCalculate(order.id, true);

    // 8 consumed × 10, the standard cost on 3 March — not today's 20.
    expect(calculation.materialCost).toBe("80.0000");
    const [row] = await db.select().from(costCalculationMaterialRows).where(eq(costCalculationMaterialRows.costCalculationId, calculation.id));
    expect(row).toMatchObject({ priceSource: "standard", priceDate: "2026-03-03" });
  });

  it("prices the supplier price and its rate as they were at the withdrawal", async () => {
    const order = await makeOrderWithReportedWork();
    const [consumption] = await mfgService.listMaterialConsumptions(order.id);
    const componentId = consumption!.componentArticleId;
    const supplier = await setPrimarySupplierPrice(componentId, 2, undefined, "EUR");
    await backdate(order.id, componentId, "2026-03-03T09:00:00Z", "2026-03-01T09:00:00Z");
    const [catalogRow] = await purchaseService.listArticleSuppliers(componentId);
    await purchaseService.updateArticleSupplier(componentId, catalogRow!.id, { price: 3 });
    expect(catalogRow!.supplierId).toBe(supplier.id);
    costingSettings.costingMaterialSource = "supplier";

    const { calculation } = await ratedService.postCalculate(order.id, true);

    // 8 × (2 EUR × 11, the rate of 3 March) — not today's price 3 or rate 12.
    expect(calculation.materialCost).toBe("176.0000");
    // The efterkalkyl looks the rate up for 3 March; the avvikelseanalys's
    // base (#14) then looks up its own, for T₀ = the order's created_at.
    expect(lookups).toEqual([
      { currency: "EUR", date: "2026-03-03" },
      { currency: "EUR", date: stockholmDateOf(order.createdAt) },
    ]);
    const [row] = await db.select().from(costCalculationMaterialRows).where(eq(costCalculationMaterialRows.costCalculationId, calculation.id));
    expect(row).toMatchObject({ supplierUnitPrice: "2.0000", exchangeRate: "11.000000", priceDate: "2026-03-03" });
  });

  it("uses the efterkalkyl's own material source", async () => {
    const order = await makeOrderWithReportedWork();
    const [consumption] = await mfgService.listMaterialConsumptions(order.id);
    await setPrimarySupplierPrice(consumption!.componentArticleId, 25);
    Object.assign(costingSettings, { costingMaterialSource: "standard", costingPostMaterialSource: "supplier" });
    try {
      const { calculation } = await ratedService.postCalculate(order.id, false);
      expect(calculation.materialSource).toBe("supplier");
      expect(calculation.materialCost).toBe("200.0000"); // 8 × 25

      const pre = await ratedService.preCalculate(order.articleId, 5, false);
      expect(pre.calculation.materialSource).toBe("standard");
    } finally {
      delete (costingSettings as { costingPostMaterialSource?: string }).costingPostMaterialSource;
    }
  });
});

// "Kalkyl" on a structure row (bom_components.costing_only): priced in the
// förkalkyl like any other row — single and multi-level — but never on the
// MO, so the efterkalkyl (which prices the actual withdrawals) never sees it.
describe("costing service — Kalkyl structure rows", () => {
  it("counts the row in the pre-calculation and leaves it out of the post-calculation", async () => {
    const user = await makeUser();
    const { parent, component } = await makeParentWithBom(10, 2);
    const kalkyl = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `KALKYL-${crypto.randomUUID()}`, name: "Kalkylmaterial", type: "purchased", standardCost: 5, active: true,
    }));
    await articleService.addBomComponent(parent.id, { componentArticleId: kalkyl.id, quantity: 1, costingOnly: true });
    // A phantom on a Kalkyl row: its parts are costed, flagged all the way down.
    const phantom = await articleService.createArticle({
      articleNumber: `PH-${crypto.randomUUID()}`, name: "Fantom", type: "manufactured", isPhantom: true, active: true,
    });
    const underPhantom = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `UP-${crypto.randomUUID()}`, name: "Under fantom", type: "purchased", standardCost: 1, active: true,
    }));
    await articleService.addBomComponent(phantom.id, { componentArticleId: underPhantom.id, quantity: 3 });
    await articleService.addBomComponent(parent.id, { componentArticleId: phantom.id, quantity: 1, costingOnly: true });

    // 5 units: ordinary 2 × 5 × 10 = 100, Kalkyl 1 × 5 × 5 = 25, phantom part 3 × 5 × 1 = 15.
    const { calculation: pre } = await costingService.preCalculate(parent.id, 5, true);
    expect(pre.materialCost).toBe("140.0000");
    const preDetail = await costingService.getCostCalculation(pre.id);
    expect(preDetail!.materialRows.map((r) => r.componentArticleId).sort()).toEqual([component.id, kalkyl.id, underPhantom.id].sort());
    // Räkna om underliggande nivåer gives the same material for a one-level structure.
    const { calculation: multi } = await costingService.preCalculate(parent.id, 5, false, true);
    expect(multi.materialCost).toBe("140.0000");

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    expect((await mfgService.listMaterialConsumptions(order.id)).map((m) => m.componentArticleId)).toEqual([component.id]);
    const { calculation: post } = await costingService.postCalculate(order.id, true);
    const postDetail = await costingService.getCostCalculation(post.id);
    expect(postDetail!.materialRows.map((r) => r.componentArticleId)).toEqual([component.id]);
  });
});

// Avvikelseanalys (#14): the efterkalkyl's base — the order's own rows for
// N, material priced with the förkalkyl's rules as of T₀ = the order's
// created_at — saved on the specification rows, and the parts derived on
// read (cost-variance.ts, tested on its own in costing-variance.test.ts).
describe("costing service — variance analysis", () => {
  const lookups: { currency: string; date: string }[] = [];
  const ratedService = createCostingService(
    createCostingRepository(db),
    { getSettings: async () => costingSettings },
    undefined,
    {
      getRate: async (currency, date) => {
        lookups.push({ currency, date });
        return { currency, requestedDate: date, date, rate: date === "2026-03-03" ? 11 : 12, source: "riksbank" };
      },
    },
    () => "2026-10-29"
  );

  beforeEach(() => {
    lookups.length = 0;
  });

  // A parent of `quantity` with one component (2 per unit, standard cost 10)
  // and operation 10 (setup 30 min, run 6 min/st, 600 kr/h), optionally an
  // operation 20 (setup 12, run 3) and the component drawn at operation 10.
  async function makeFixture(
    opts: { quantity?: number; linked?: boolean; secondOperation?: boolean; service?: { standardCost: number; quantity: number } } = {}
  ) {
    const user = await makeUser();
    const parent = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `PARENT-${crypto.randomUUID()}`, name: "Parent", type: "manufactured", active: true,
    }));
    const component = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `COMP-${crypto.randomUUID()}`, name: "Component", type: "purchased", standardCost: 10, active: true,
    }));
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 600, overheadPercent: 0, active: true }));
    const routingOp = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 30, runTimePerUnit: 6 });
    if (opts.secondOperation) {
      await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 12, runTimePerUnit: 3 });
    }
    await articleService.addBomComponent(parent.id, {
      componentArticleId: component.id,
      quantity: 2,
      ...(opts.linked ? { routingOperationId: routingOp.id } : {}),
    });
    // A tjänst in the structure (lego under LO), unlinked.
    const service = opts.service ? await addServiceComponent(parent.id, opts.service.standardCost, opts.service.quantity) : null;
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
    await stockService.recordTransaction({ articleId: component.id, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: opts.quantity ?? 5 }, user.id);
    const [operation] = await mfgService.listOperations(order.id);
    const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Kalle", active: true });
    return { user, parent, component, service, location, order, operation: operation!, materialRow: materialRow!, employee, workCenter };
  }
  type Fixture = Awaited<ReturnType<typeof makeFixture>>;

  async function reportHours(f: Fixture, hours: number) {
    await timeReportService.createTimeReport({ employeeId: f.employee.id, moOperationId: f.operation.id, date: "2026-07-07", hours }, f.user.id);
  }

  // T₀ and the component's first recorded prices on fixed days, so "as of
  // T₀" can be told apart from "at the withdrawal" (now).
  async function backdate(f: Fixture, createdAt: string, firstPriceAt: string) {
    await db.execute(sql`update manufacturing_orders set created_at = ${createdAt}::timestamptz where id = ${f.order.id}`);
    await db.execute(sql`update article_standard_cost_history set valid_from = ${firstPriceAt}::timestamptz where article_id = ${f.component.id}`);
    await db.execute(sql`update article_supplier_price_history set valid_from = ${firstPriceAt}::timestamptz where article_id = ${f.component.id}`);
  }

  const withoutIds = <T extends { id: string | null }>(rows: T[]) => rows.map((r) => ({ ...r, id: null }));

  it("prices the base at T₀: a price change after T₀ is a price deviation, the efterkalkyl is unchanged", async () => {
    const f = await makeFixture();
    await backdate(f, "2026-03-01T09:00:00Z", "2026-02-01T09:00:00Z");
    await articleService.updateStandardCost(f.component.id, 12);
    await mfgService.consumeMaterial(f.order.id, f.materialRow.id, { locationId: f.location.id, quantity: 10 }, f.user.id);
    await reportHours(f, 1.5);
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const preview = await costingService.postCalculate(f.order.id);
    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    // The efterkalkyl as before: 10 drawn × 12 (the price at the withdrawal), 1.5 h × 600.
    expect(calculation.materialCost).toBe("120.0000");
    expect(calculation.laborCost).toBe("900.0000");
    expect(calculation).toMatchObject({ outputQuantity: "5.0000", preliminary: false, baseMaterialSource: "standard" });
    expect(analysis).toMatchObject({
      outputQuantity: 5,
      preliminary: false,
      basePricedAt: "2026-03-01T09:00:00.000Z",
      baseMaterialSource: "standard",
      // Kalkylerat: 10 × 10 + (30 + 6 × 5) / 60 h × 600 = 700; utfall 120 + 900.
      base: 700,
      actual: 1020,
      deviation: 320,
    });
    expect(analysis!.materialRows[0]).toMatchObject({
      componentArticleId: f.component.id,
      baseQuantity: 10,
      baseUnitCost: 10,
      basePriceSource: "standard",
      quantity: 10,
      unitCost: 12,
      base: 100,
      actual: 120,
    });
    expect(analysis!.materialRows[0]!.parts).toMatchObject({ price: 20, quantity: 0, scrap: 0 });
    expect(analysis!.operationRows[0]).toMatchObject({
      kind: "time",
      baseSetupHours: 0.5,
      baseRunHours: 0.5,
      baseHourlyRate: 600,
      hours: 1.5,
      setupHours: null,
      runHours: null,
      split: false,
      base: 600,
      actual: 900,
    });
    expect(analysis!.parts).toEqual({ price: 20, quantity: 0, scrap: 0, rate: 0, setup: 0, run: 0, unclassified: 300, markups: 0 });

    // The preview and the saved calculation give the same analysis; GET derives it from the stored rows.
    const detail = await costingService.getCostCalculation(calculation.id);
    expect(detail!.analysis).toEqual(analysis);
    expect(detail!.analysis!.materialRows[0]!.id).toBe(detail!.materialRows[0]!.id);
    expect({
      ...preview.analysis!,
      materialRows: withoutIds(preview.analysis!.materialRows),
      operationRows: withoutIds(preview.analysis!.operationRows),
    }).toEqual({ ...analysis!, materialRows: withoutIds(analysis!.materialRows), operationRows: withoutIds(analysis!.operationRows) });
  });

  it("prices a supplier price in another currency at T₀ with the rate of T₀'s day", async () => {
    const f = await makeFixture();
    await setPrimarySupplierPrice(f.component.id, 2, undefined, "EUR");
    await backdate(f, "2026-03-03T09:00:00Z", "2026-02-01T09:00:00Z");
    const [catalogRow] = await purchaseService.listArticleSuppliers(f.component.id);
    await purchaseService.updateArticleSupplier(f.component.id, catalogRow!.id, { price: 3 });
    await mfgService.consumeMaterial(f.order.id, f.materialRow.id, { locationId: f.location.id, quantity: 10 }, f.user.id);
    costingSettings.costingMaterialSource = "supplier";

    const { calculation, analysis } = await ratedService.postCalculate(f.order.id);

    // Efterkalkyl: 10 × (3 EUR × 12, the withdrawal's day). Base: 2 EUR × 11, the rate of 3 March.
    expect(calculation.materialCost).toBe("360.0000");
    expect(analysis!.baseMaterialSource).toBe("supplier");
    expect(analysis!.materialRows[0]).toMatchObject({ baseUnitCost: 22, basePriceSource: "supplier", unitCost: 36 });
    expect(analysis!.materialRows[0]!.parts.price).toBe(140); // (36 − 22) × 10
    expect(lookups).toContainEqual({ currency: "EUR", date: "2026-03-03" });
  });

  it("calculates a kortstängd order for the received quantity, scrap as varav kassation", async () => {
    // A scrap reason of its own: the requirement depends on whether any active one exists.
    const [reason] = (await db.execute(
      sql`insert into deviation_reasons (code, name, applies_scrap) values ('VARIANS', 'Avvikelseanalys', true) returning id`
    )) as unknown as { id: string }[];
    try {
      const f = await makeFixture({ quantity: 10, linked: true });
      // 8 OK + 1 kasserat on the last operation: top-up draws 2 × 9 = 18, 8 are received.
      await mfgService.reportOperationQuantities(f.operation.id, {
        quantityOk: 8,
        quantityScrapped: 1,
        scrapReasonId: reason!.id,
        markDone: true,
        locationId: f.location.id,
        createdBy: f.user.id,
      });
      await reportHours(f, 2);
      await mfgService.complete(f.order.id, { quantity: 0, locationId: f.location.id }, f.user.id);
      await mfgService.close(f.order.id, f.user.id);

      const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

      // The efterkalkyl keeps the order quantity; the analysis runs on N = 8.
      expect(calculation.quantity).toBe("10.0000");
      expect(calculation.materialCost).toBe("180.0000");
      expect(analysis).toMatchObject({ outputQuantity: 8, preliminary: false });
      // SQ = 20 / 10 × 8 = 16 against AQ 18; the 1 scrapped unit drew 2 × 10 of it.
      expect(analysis!.materialRows[0]).toMatchObject({ baseQuantity: 16, quantity: 18, scrapQuantity: 2, base: 160, actual: 180 });
      expect(analysis!.materialRows[0]!.parts).toMatchObject({ price: 0, quantity: 20, scrap: 20 });
      // (30 + 6 × 8) / 60 = 1.3 h at 600 = 780 against 2 h = 1200.
      expect(analysis!.operationRows[0]).toMatchObject({ baseSetupHours: 0.5, baseRunHours: 0.8, base: 780, actual: 1200 });
      expect(analysis).toMatchObject({ base: 940, actual: 1380, deviation: 440 });
      expect(analysis!.parts).toMatchObject({ quantity: 20, scrap: 20, unclassified: 420 });
    } finally {
      await db.execute(sql`delete from mo_operation_scrap where reason_id = ${reason!.id}`);
      await db.execute(sql`delete from deviation_reasons where id = ${reason!.id}`);
    }
  });

  it("gives an open order a preliminary analysis on each operation's OK, an added row as the new plan", async () => {
    const f = await makeFixture({ quantity: 10, linked: true, secondOperation: true });
    // Ändrad TO: material added after release is part of the plan (1 per unit, unlinked).
    const extra = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `EXTRA-${crypto.randomUUID()}`, name: "Tillägg", type: "purchased", standardCost: 5, active: true,
    }));
    await mfgService.addMaterial(f.order.id, { componentArticleId: extra.id, quantity: 10 }, f.user.id);
    await mfgService.reportOperationQuantities(f.operation.id, { quantityOk: 4, quantityScrapped: 0, markDone: false, createdBy: f.user.id });
    await reportHours(f, 1);

    const { analysis } = await costingService.postCalculate(f.order.id);

    expect(analysis).toMatchObject({ preliminary: true, outputQuantity: 0 });
    const byArticle = new Map(analysis!.materialRows.map((r) => [r.componentArticleId, r]));
    // Linked: 2 × 4 OK drawn and calculated — work in progress is no deviation.
    expect(byArticle.get(f.component.id)).toMatchObject({ baseQuantity: 8, quantity: 8, deviation: 0 });
    // Unlinked: on the received quantity (0), but priced in the base.
    expect(byArticle.get(extra.id)).toMatchObject({ baseQuantity: 0, baseUnitCost: 5, quantity: 0, deviation: 0 });
    // Op 10 worked: setup 0.5 h + 0.1 h × 4 at 600 = 540 against 1 h. Op 20 untouched: no setup yet, nothing planned.
    const [op10, op20] = analysis!.operationRows;
    expect(op10).toMatchObject({ baseSetupHours: 0.5, baseRunHours: 0.4, base: 540, actual: 600 });
    expect(op20).toMatchObject({ baseSetupHours: 0, baseRunHours: 0, base: 0, actual: 0, deviation: 0 });
    expect(analysis!.deviation).toBe(60);
  });

  it("keeps a saved analysis when prices and time change after the save", async () => {
    const f = await makeFixture();
    await mfgService.consumeMaterial(f.order.id, f.materialRow.id, { locationId: f.location.id, quantity: 10 }, f.user.id);
    await reportHours(f, 1);
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);
    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    await articleService.updateStandardCost(f.component.id, 99);
    await reportHours(f, 3); // efterrapportering on the Klar order

    expect((await costingService.getCostCalculation(calculation.id))!.analysis).toEqual(analysis);
    // A new run sees the new time; its base is still priced at T₀.
    const { analysis: again } = await costingService.postCalculate(f.order.id);
    expect(again!.operationRows[0]).toMatchObject({ hours: 4 });
    expect(again!.materialRows[0]).toMatchObject({ baseUnitCost: 10, unitCost: 10 });
  });

  it("has no analysis on a förkalkyl or on an efterkalkyl saved before it, and the base is all or nothing", async () => {
    const f = await makeFixture();
    const { calculation } = await costingService.postCalculate(f.order.id, true);
    expect((await costingService.getCostCalculation(calculation.id))!.analysis).not.toBeNull();

    // An efterkalkyl saved before migration 0187 has none of the columns.
    await db.execute(sql`update cost_calculations set output_quantity = null, preliminary = null, base_priced_at = null, base_material_source = null where id = ${calculation.id}`);
    await db.execute(sql`update cost_calculation_material_rows set base_quantity = null, base_unit_cost = null, base_price_source = null, scrap_quantity = null where cost_calculation_id = ${calculation.id}`);
    await db.execute(sql`update cost_calculation_operation_rows set base_setup_hours = null, base_run_hours = null, base_hourly_rate = null where cost_calculation_id = ${calculation.id}`);
    expect((await costingService.getCostCalculation(calculation.id))!.analysis).toBeNull();

    const { calculation: pre } = await costingService.preCalculate(f.parent.id, 5, true);
    expect(pre).toMatchObject({ outputQuantity: null, preliminary: null, basePricedAt: null, baseMaterialSource: null });
    expect((await costingService.getCostCalculation(pre.id))!.analysis).toBeNull();

    await expect(db.execute(sql`update cost_calculations set output_quantity = 5 where id = ${calculation.id}`)).rejects.toThrow();
    await expect(
      db.execute(sql`update cost_calculations set output_quantity = 5, preliminary = false, base_priced_at = now(), base_material_source = 'standard' where id = ${pre.id}`)
    ).rejects.toThrow();
  });

  it("is final on a Makulerad order: N = 0, so the time spent on it is a deviation", async () => {
    const f = await makeFixture();
    // A manual time report outlives the cancellation.
    await reportHours(f, 2);
    await mfgService.cancel(f.order.id, f.user.id);

    const { analysis } = await costingService.postCalculate(f.order.id, true);

    expect(analysis).toMatchObject({ preliminary: false, outputQuantity: 0 });
    // Worked ⇒ the setup counts (0.5 h), no run time for N = 0: 300 against 2 h × 600.
    expect(analysis!.operationRows[0]).toMatchObject({ baseSetupHours: 0.5, baseRunHours: 0, base: 300, actual: 1200 });
    expect(analysis!.materialRows[0]).toMatchObject({ baseQuantity: 0, quantity: 0, deviation: 0 });
    expect(analysis).toMatchObject({ base: 300, actual: 1200, deviation: 900 });
  });

  it("matches the base's staffel on the row's planned quantity", async () => {
    const f = await makeFixture({ quantity: 5 });
    // 10 at 8 from the step at 10, else 10.
    await setPrimarySupplierPrice(f.component.id, 10, [{ fromQuantity: 10, price: 8 }]);
    Object.assign(costingSettings, { costingMaterialSource: "supplier", costingSupplierPriceTier: "tiered" });
    // Kortstängd at 4 of 5: the unlinked material is drawn up to 2 × 4 = 8.
    await mfgService.complete(f.order.id, { quantity: 4, locationId: f.location.id }, f.user.id);

    const { analysis } = await costingService.postCalculate(f.order.id, true);

    // The efterkalkyl prices the 8 drawn below the step (10); the base prices
    // SQ = 8 at the step its PLANNED 10 reaches (8).
    expect(analysis!.materialRows[0]).toMatchObject({ quantity: 8, unitCost: 10, baseQuantity: 8, baseUnitCost: 8, basePriceSource: "supplier" });
    expect(analysis!.materialRows[0]!.parts).toMatchObject({ price: 16, quantity: 0 });
  });

  it("prices the efterkalkyl with its own source (actual) and the base with the förkalkyl's (standard)", async () => {
    const f = await makeFixture();
    await editStockLog((tx) => tx.execute(sql`update stock_transactions set unit_cost = 14 where article_id = ${f.component.id} and transaction_type = 'inventory_adjustment'`));
    await mfgService.consumeMaterial(f.order.id, f.materialRow.id, { locationId: f.location.id, quantity: 10 }, f.user.id);
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);
    Object.assign(costingSettings, { costingPostMaterialSource: "actual" });
    try {
      const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

      expect(calculation.materialSource).toBe("actual");
      expect(analysis!.baseMaterialSource).toBe("standard");
      // AP = the moving average 14, SP = the standard cost 10 at T₀.
      expect(analysis!.materialRows[0]).toMatchObject({ quantity: 10, unitCost: 14, baseQuantity: 10, baseUnitCost: 10, basePriceSource: "standard" });
      expect(analysis!.materialRows[0]!.parts).toMatchObject({ price: 40, quantity: 0 });
    } finally {
      delete (costingSettings as { costingPostMaterialSource?: string }).costingPostMaterialSource;
    }
  });

  it("calculates a delinleverans on an open order: unlinked material on the received quantity", async () => {
    const f = await makeFixture({ quantity: 10 });
    // 4 OK on the only (last) operation: 4 received, the unlinked material drawn for them (2 × 4).
    await mfgService.reportOperationQuantities(f.operation.id, { quantityOk: 4, quantityScrapped: 0, markDone: false, locationId: f.location.id, createdBy: f.user.id });
    await reportHours(f, 1);

    const { analysis } = await costingService.postCalculate(f.order.id, true);

    expect(analysis).toMatchObject({ preliminary: true, outputQuantity: 4 });
    expect(analysis!.materialRows[0]).toMatchObject({ baseQuantity: 8, quantity: 8, deviation: 0 });
    // (30 + 6 × 4) / 60 h × 600 = 540 against 1 h.
    expect(analysis!.operationRows[0]).toMatchObject({ baseSetupHours: 0.5, baseRunHours: 0.4, base: 540, actual: 600 });
    expect(analysis!.deviation).toBe(60);
  });

  it("counts material returned through Ångra as never drawn: AQ is the net", async () => {
    const f = await makeFixture({ quantity: 5, linked: true });
    await mfgService.reportOperationQuantities(f.operation.id, { quantityOk: 3, quantityScrapped: 0, markDone: false, locationId: f.location.id, createdBy: f.user.id });
    await mfgService.reportOperationQuantities(f.operation.id, { quantityOk: 2, quantityScrapped: 0, markDone: false, locationId: f.location.id, createdBy: f.user.id });
    expect((await mfgService.getManufacturingOrder(f.order.id))!.status).toBe("done");
    // Ångra the second report: 4 back to stock, 2 out again, the order open.
    const second = (await mfgService.listReports(f.order.id)).find((r) => r.undoneAt === null && Number(r.quantityOk) === 2)!;
    await mfgService.undoReport(f.order.id, second.id, f.user.id);
    // Kortstängd at the 3 received.
    await mfgService.complete(f.order.id, { quantity: 0, locationId: f.location.id }, f.user.id);

    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    // 10 drawn, 4 returned: 6 × 10, and N = 3 calculates 2 × 3 = 6.
    expect(calculation.materialCost).toBe("60.0000");
    expect(analysis).toMatchObject({ preliminary: false, outputQuantity: 3 });
    expect(analysis!.materialRows[0]).toMatchObject({ baseQuantity: 6, quantity: 6, deviation: 0 });
  });

  it("makes Utfall the efterkalkyl's TVK with MO and LO, and the preview the saved analysis, on uneven figures", async () => {
    Object.assign(costingSettings, { costingMoPercent: 12.5, costingLoPercent: 7.5 });
    const f = await makeFixture({ quantity: 5, service: { standardCost: 7.7777, quantity: 1 } });
    await articleService.updateStandardCost(f.component.id, 3.3337);
    await mfgService.consumeMaterial(f.order.id, f.materialRow.id, { locationId: f.location.id, quantity: 10 }, f.user.id);
    await reportHours(f, 1.2345);
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const preview = await costingService.postCalculate(f.order.id);
    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    const tvk =
      Number(calculation.materialCost) +
      Number(calculation.materialOverhead) +
      Number(calculation.laborCost) +
      Number(calculation.subcontractCost) +
      Number(calculation.subcontractOverhead) +
      Number(calculation.semiFinishedCost);
    expect(Number(calculation.materialOverhead)).toBeGreaterThan(0);
    expect(Number(calculation.subcontractOverhead)).toBeGreaterThan(0);
    // Utfall is the chain's TVK to the öre; the parts add up to the deviation.
    expect(Math.round(analysis!.actual * 100)).toBe(Math.round(Math.round(tvk * 10000) / 100));
    const ore = (value: number) => Math.round(value * 100);
    const { price, quantity, rate, setup, run, unclassified, markups } = analysis!.parts;
    expect([price, quantity, rate, setup, run, unclassified, markups].reduce((t, p) => t + ore(p), 0)).toBe(ore(analysis!.deviation));
    expect(ore(analysis!.actual) - ore(analysis!.base)).toBe(ore(analysis!.deviation));
    expect(markups).not.toBe(0);
    // The preview reads exactly what the saved calculation reads back.
    expect({
      ...preview.analysis!,
      materialRows: withoutIds(preview.analysis!.materialRows),
      operationRows: withoutIds(preview.analysis!.operationRows),
    }).toEqual({ ...analysis!, materialRows: withoutIds(analysis!.materialRows), operationRows: withoutIds(analysis!.operationRows) });
    expect((await costingService.getCostCalculation(calculation.id))!.analysis).toEqual(analysis);
  });

  // Kalkylerat is the base's TVK, summed like the header's: an outcome
  // exactly as calculated has Påslag 0, also when the rows' öre rounding
  // leaves a rest (10.004 → 10.00 twice, TVK 622.0091 → 622.01). A markup
  // on the rounded base rows gave 1 öre here.
  it("gives Påslag 0 when the outcome is exactly the calculation, with MO, LO and a rounding rest", async () => {
    Object.assign(costingSettings, { costingMoPercent: 12.5, costingLoPercent: 7.5 });
    const f = await makeFixture({ quantity: 5, service: { standardCost: 1.0004, quantity: 2 } });
    await articleService.updateStandardCost(f.component.id, 1.0004);
    // T₀ after the price change, so both sides price the component at 1.0004.
    await db.execute(sql`update manufacturing_orders set created_at = now() where id = ${f.order.id}`);
    await mfgService.consumeMaterial(f.order.id, f.materialRow.id, { locationId: f.location.id, quantity: 10 }, f.user.id);
    await reportHours(f, 1); // (30 + 6 × 5) / 60
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    expect(calculation.materialCost).toBe("10.0040");
    expect(calculation.subcontractCost).toBe("10.0040");
    expect(analysis!.materialRows.map((r) => [r.base, r.actual])).toEqual([[10, 10], [10, 10]]);
    expect([analysis!.base, analysis!.actual, analysis!.deviation]).toEqual([622.01, 622.01, 0]);
    expect(Object.values(analysis!.parts).every((p) => p === 0)).toBe(true);
  });

  // #14 etapp 3: time reported as ställ/produktion (time_reports.kind) is
  // the efterkalkyl's setup_hours/run_hours, and the analysis splits the
  // deviation in Ställ and Stycke; an operation with any ej uppdelad time is
  // Tid (ej uppdelad) as a whole. Op 10 plans 0.5 + 0.5 h, op 20 0.2 + 0.25 h
  // (12 min, 3 min × 5), both at 600 kr/h.
  it("reads ställ and produktion from the time reports: split, half split and the parts adding up exactly", async () => {
    const f = await makeFixture({ quantity: 5, secondOperation: true });
    const op20 = (await mfgService.listOperations(f.order.id)).find((op) => op.sequenceNo === 20)!;
    const report = (moOperationId: string, hours: number, kind?: "setup" | "run") =>
      timeReportService.createTimeReport({ employeeId: f.employee.id, moOperationId, date: "2026-07-07", hours, ...(kind ? { kind } : {}) }, f.user.id);
    await report(f.operation.id, 0.5, "setup");
    await report(f.operation.id, 0.25, "setup");
    await report(f.operation.id, 0.4, "run");
    await report(op20.id, 0.25, "setup");
    await report(op20.id, 0.3, "run");
    await report(op20.id, 0.1);
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const preview = await costingService.postCalculate(f.order.id);
    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    const saved = (await costingService.getCostCalculation(calculation.id))!.operationRows;
    expect(saved.map((r) => [r.sequenceNo, r.hours, r.setupHours, r.runHours])).toEqual([
      [10, "1.1500", "0.7500", "0.4000"],
      [20, "0.6500", "0.2500", "0.3000"],
    ]);
    const [op10Row, op20Row] = analysis!.operationRows as Extract<CostVarianceOperationRow, { kind: "time" }>[];
    // Op 10 is split: Ställ (0.75 − 0.5) × 600 = 150, Stycke 690 − 600 − 150 = −60.
    expect(op10Row).toMatchObject({ setupHours: 0.75, runHours: 0.4, unclassifiedHours: 0, split: true, base: 600, actual: 690 });
    expect(op10Row!.parts).toMatchObject({ setup: 150, run: -60, unclassified: 0, rate: 0 });
    // Op 20 has 0.1 h ej uppdelad: the whole operation is Tid (ej uppdelad), 390 − 270,
    // and Ej uppdelad (h) is all its 0.65 h, so the hours match the kronor.
    expect(op20Row).toMatchObject({ setupHours: 0.25, runHours: 0.3, unclassifiedHours: 0.65, split: false, base: 270, actual: 390 });
    expect(op20Row!.parts).toMatchObject({ setup: 0, run: 0, unclassified: 120 });
    // The order: material on plan, so Avvikelse = Ställ + Stycke + Ej uppdelad, exactly.
    expect(analysis).toMatchObject({ base: 970, actual: 1180, deviation: 210 });
    expect(analysis!.parts).toMatchObject({ price: 0, quantity: 0, setup: 150, run: -60, unclassified: 120, markups: 0 });
    expect({ ...preview.analysis!, operationRows: withoutIds(preview.analysis!.operationRows), materialRows: withoutIds(preview.analysis!.materialRows) }).toEqual({
      ...analysis!,
      operationRows: withoutIds(analysis!.operationRows),
      materialRows: withoutIds(analysis!.materialRows),
    });
  });

  // Typed time on a lego operation is ignored: a lego operation is bought,
  // its cost is the IO (or the reserve), never hours — no Ställ or Stycke.
  it("ignores typed time reported on a lego operation", async () => {
    const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "900", name: "Lack", type: "subcontract", active: true }));
    const f = await makeFixture({ quantity: 5 });
    // The lego operation is added to the order's own rows (Ändra operationer would do the same).
    await mfgService.createRoutingOperation(f.parent.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0, setupPrice: 500, unitPrice: 100 });
    const order = await mfgService.createManufacturingOrder({ articleId: f.parent.id, quantity: 5 }, f.user.id);
    const ops = await mfgService.listOperations(order.id);
    const op10 = ops.find((op) => op.sequenceNo === 10)!;
    const legoOp = ops.find((op) => op.sequenceNo === 20)!;
    const report = (moOperationId: string, hours: number, kind?: "setup" | "run") =>
      timeReportService.createTimeReport({ employeeId: f.employee.id, moOperationId, date: "2026-07-07", hours, ...(kind ? { kind } : {}) }, f.user.id);
    await report(op10.id, 1);
    await report(legoOp.id, 0.5, "setup");
    await report(legoOp.id, 2, "run");
    await mfgService.complete(order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const { calculation, analysis } = await costingService.postCalculate(order.id, true);

    // No hours, no lön and no ställ/produktion on the lego row; the 1 h on op 10 is the only time.
    expect(calculation.laborCost).toBe("600.0000");
    const saved = (await costingService.getCostCalculation(calculation.id))!.operationRows;
    expect(saved.find((r) => r.sequenceNo === 20)).toMatchObject({ hours: "0.0000", setupHours: null, runHours: null, laborAmount: "0.0000" });
    const legoRow = analysis!.operationRows.find((r) => r.sequenceNo === 20)!;
    expect(legoRow.kind).toBe("subcontract");
    expect(legoRow.parts).toMatchObject({ rate: 0, setup: 0, run: 0, unclassified: 0 });
    expect(analysis!.operationRows.filter((r) => r.kind === "time")).toHaveLength(1);
    // Op 10 is untyped and on plan (0.5 + 0.5 h): the order has no time deviation.
    expect(analysis!.parts).toMatchObject({ rate: 0, setup: 0, run: 0, unclassified: 0 });
  });

  // Timkostnad per datum (#14 etapp 4, migration 0189): the efterkalkyl
  // prices each work day's hours at that day's hourly rate, the base at the
  // rate as of T₀, and the difference is Timpris. 600 kr/h until 10 May
  // 14:00 (Stockholm), 720 from then; the order created on 1 March.
  async function raiseRateOn10May(f: Fixture) {
    await db.execute(sql`update work_center_rate_history set valid_from = '2026-02-01T09:00:00Z' where work_center_id = ${f.workCenter.id}`);
    await mfgService.updateWorkCenter(f.workCenter.id, { hourlyRate: 720 });
    await db.execute(
      sql`update work_center_rate_history set valid_from = '2026-05-10T12:00:00Z' where work_center_id = ${f.workCenter.id} and hourly_rate = 720`
    );
    await db.execute(sql`update manufacturing_orders set created_at = '2026-03-01T09:00:00Z' where id = ${f.order.id}`);
  }

  it("prices the time per work day around a changed hourly rate, the base at T₀: Timpris", async () => {
    const f = await makeFixture();
    await raiseRateOn10May(f);
    const report = (date: string, hours: number) =>
      timeReportService.createTimeReport({ employeeId: f.employee.id, moOperationId: f.operation.id, date, hours }, f.user.id);
    await report("2026-05-09", 1); // 600
    await report("2026-05-10", 0.5); // the change applies to the whole day: 720
    await mfgService.consumeMaterial(f.order.id, f.materialRow.id, { locationId: f.location.id, quantity: 10 }, f.user.id);
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const preview = await costingService.postCalculate(f.order.id);
    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    // Lön 1 × 600 + 0.5 × 720 = 960; the row shows the average 640 kr/h.
    expect(calculation.laborCost).toBe("960.0000");
    const [savedRow] = (await costingService.getCostCalculation(calculation.id))!.operationRows;
    expect(savedRow).toMatchObject({ hours: "1.5000", hourlyRate: "640.00", laborAmount: "960.0000" });
    // Kalkylerat (0.5 + 0.5) h at R₀ = 600 (T₀ = 1 March); Timpris 960 − 600 × 1.5 = 60;
    // Ej uppdelad (1.5 − 1) × 600 = 300.
    expect(analysis!.operationRows[0]).toMatchObject({ baseHourlyRate: 600, hourlyRate: 640, base: 600, actual: 960, deviation: 360 });
    expect(analysis!.operationRows[0]!.parts).toMatchObject({ rate: 60, unclassified: 300 });
    expect(analysis!.parts).toMatchObject({ price: 0, quantity: 0, rate: 60, unclassified: 300, markups: 0 });
    expect({ ...preview.analysis!, materialRows: withoutIds(preview.analysis!.materialRows), operationRows: withoutIds(preview.analysis!.operationRows) }).toEqual({
      ...analysis!,
      materialRows: withoutIds(analysis!.materialRows),
      operationRows: withoutIds(analysis!.operationRows),
    });

    // A later rate change (today) moves neither the saved efterkalkyl nor a
    // new run: the May days keep their rates. The saved one never changes
    // anyway, so the new runs carry the proof — a preview and a second saved
    // efterkalkyl, read back, equal the first in every figure: the header's
    // costs, each specification row and the whole analysis.
    await mfgService.updateWorkCenter(f.workCenter.id, { hourlyRate: 900 });
    expect((await costingService.getCostCalculation(calculation.id))!.analysis).toEqual(analysis);
    const costs = (c: Record<string, unknown>) => {
      const { id: _id, calculatedAt: _calculatedAt, ...rest } = c;
      return rest;
    };
    const rowFigures = (rows: Record<string, unknown>[]) =>
      rows.map(({ id: _id, costCalculationId: _calculationId, createdAt: _createdAt, ...rest }) => rest);
    const first = (await costingService.getCostCalculation(calculation.id))!;
    const againPreview = await costingService.postCalculate(f.order.id);
    const againSaved = await costingService.postCalculate(f.order.id, true);
    const second = (await costingService.getCostCalculation(againSaved.calculation.id))!;
    expect(againSaved.calculation.id).not.toBe(calculation.id);
    expect(costs(againSaved.calculation as unknown as Record<string, unknown>)).toEqual(costs(calculation as unknown as Record<string, unknown>));
    expect(rowFigures(second.operationRows as unknown as Record<string, unknown>[])).toEqual(
      rowFigures(first.operationRows as unknown as Record<string, unknown>[])
    );
    expect(rowFigures(second.materialRows as unknown as Record<string, unknown>[])).toEqual(
      rowFigures(first.materialRows as unknown as Record<string, unknown>[])
    );
    for (const run of [againPreview.analysis!, second.analysis!]) {
      expect({ ...run, materialRows: withoutIds(run.materialRows), operationRows: withoutIds(run.operationRows) }).toEqual({
        ...analysis!,
        materialRows: withoutIds(analysis!.materialRows),
        operationRows: withoutIds(analysis!.operationRows),
      });
    }
    expect(againPreview.calculation.laborCost).toBe("960.0000");
  });

  it("takes R₀ at T₀: an order created after the change has the new rate on both sides", async () => {
    const f = await makeFixture();
    await raiseRateOn10May(f);
    await db.execute(sql`update manufacturing_orders set created_at = '2026-05-20T09:00:00Z' where id = ${f.order.id}`);
    await timeReportService.createTimeReport({ employeeId: f.employee.id, moOperationId: f.operation.id, date: "2026-06-01", hours: 1 }, f.user.id);
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const { analysis } = await costingService.postCalculate(f.order.id, true);

    expect(analysis!.operationRows[0]).toMatchObject({ baseHourlyRate: 720, hourlyRate: 720, base: 720, actual: 720 });
    expect(analysis!.parts.rate).toBe(0);
  });

  // The Stockholm day, not the UTC day: the change at 22:30 UTC on 10 May is
  // 00:30 on 11 May in Stockholm (CEST). Two stints stamped out on either
  // side of Stockholm's midnight — at 23:50 on 10 May and 00:50 on 11 May,
  // both on 10 May in UTC — are dated by the stamp-out on their Stockholm
  // days (localDateOf), and the rate applies per Stockholm day (hourlyRateAt).
  // UTC days for the change would give 900 (both at 720), for the reports 750.
  it("prices time around Stockholm's midnight by Stockholm days, not UTC days", async () => {
    const f = await makeFixture();
    await db.execute(sql`update work_center_rate_history set valid_from = '2026-02-01T09:00:00Z' where work_center_id = ${f.workCenter.id}`);
    await mfgService.updateWorkCenter(f.workCenter.id, { hourlyRate: 720 });
    await db.execute(
      sql`update work_center_rate_history set valid_from = '2026-05-10T22:30:00Z' where work_center_id = ${f.workCenter.id} and hourly_rate = 720`
    );
    await db.execute(sql`update manufacturing_orders set created_at = '2026-03-01T09:00:00Z' where id = ${f.order.id}`);
    // Gone home and never back: stamped out later, a paused stint stops when
    // the pause began and is dated on that Stockholm day.
    const stint = async (startedAt: string, pausedAt: string) => {
      const attendance = await timeReportService.attendanceIn({ employeeId: f.employee.id }, f.user.id);
      const stamp = await timeReportService.stampIn({ employeeId: f.employee.id, moOperationId: f.operation.id }, f.user.id);
      await timeReportService.attendanceOut(attendance.id, f.user.id);
      await db.execute(
        sql`update stamp_sessions set started_at = ${startedAt}::timestamptz, paused_at = ${pausedAt}::timestamptz, paused_seconds = 0 where id = ${stamp.id}`
      );
      return (await timeReportService.stampOut(stamp.id, stampOutSchema.parse({}), f.user.id)).timeReport;
    };
    const beforeMidnight = await stint("2026-05-10T20:50:00Z", "2026-05-10T21:50:00Z"); // 22:50–23:50, 10 May
    const afterMidnight = await stint("2026-05-10T22:35:00Z", "2026-05-10T22:50:00Z"); // 00:35–00:50, 11 May
    expect(beforeMidnight).toMatchObject({ date: "2026-05-10", hours: "1.00" });
    expect(afterMidnight).toMatchObject({ date: "2026-05-11", hours: "0.25" });
    await mfgService.complete(f.order.id, { quantity: 5, locationId: f.location.id }, f.user.id);

    const { calculation, analysis } = await costingService.postCalculate(f.order.id, true);

    // 1 h × 600 (10 May, before the change) + 0.25 h × 720 (11 May) = 780.
    expect(calculation.laborCost).toBe("780.0000");
    // Timpris 780 − 600 × 1.25 = 30; the row's rate the average 624.
    expect(analysis!.operationRows[0]).toMatchObject({ baseHourlyRate: 600, hourlyRate: 624 });
    expect(analysis!.operationRows[0]!.parts.rate).toBe(30);
  });

  it("refuses a row whose base group is only partly saved, and an operation row with both groups", async () => {
    const f = await makeFixture();
    const { calculation } = await costingService.postCalculate(f.order.id, true);
    const id = calculation.id;

    await expect(db.execute(sql`update cost_calculation_material_rows set base_quantity = null where cost_calculation_id = ${id}`)).rejects.toThrow();
    await expect(db.execute(sql`update cost_calculation_material_rows set scrap_quantity = null where cost_calculation_id = ${id}`)).rejects.toThrow();
    await expect(db.execute(sql`update cost_calculation_operation_rows set base_hourly_rate = null where cost_calculation_id = ${id}`)).rejects.toThrow();
    await expect(
      db.execute(sql`update cost_calculation_operation_rows set base_quantity = 1, subcontract_quantity = 1, base_unit_price = 1 where cost_calculation_id = ${id}`)
    ).rejects.toThrow();
    // Both groups complete on one row: still refused.
    await expect(
      db.execute(
        sql`update cost_calculation_operation_rows set base_quantity = 1, subcontract_quantity = 1, base_unit_price = 1, base_one_off = 1 where cost_calculation_id = ${id}`
      )
    ).rejects.toThrow();
    // Swapping to the lego group alone is allowed: the CHECK is the shape, not the kind.
    await db.execute(
      sql`update cost_calculation_operation_rows set base_setup_hours = null, base_run_hours = null, base_hourly_rate = null, base_quantity = 1, subcontract_quantity = 1, base_unit_price = 1, base_one_off = 1 where cost_calculation_id = ${id}`
    );
  });
});

// Påslag per nivå (#16, etapp 1): the varugrupp's price markups and Pröva
// påslag in the förkalkyl. Only the sales price moves — TVK and SVK (and so
// the standard cost, TB and Kalkylutfall) never do.
describe("costing service — markup levels (#16)", () => {
  let groupSeq = 0;
  async function makeGroup(markups: { generalMarkupPercent?: number | null; materialMarkupPercent?: number | null }) {
    groupSeq += 1;
    return articleService.createArticleGroup({ code: String(9000 + groupSeq), name: `Påslagsgrupp ${groupSeq}`, ...markups });
  }

  // Company: MO 10 %, Affo 10 %, generellt 25 %, material 10 %. The parent: 2
  // × a 10 kr component per unit and one operation, 60 min setup at 60 kr/h
  // with TO 10 %. For 5: dM 100, MO 10, dL 60, TO 6 ⇒ TVK 170, Affo 17, SVK
  // 187; the materialpåslag's base dM + MO = 110.
  async function makePricedParent() {
    Object.assign(costingSettings, {
      costingMoPercent: 10,
      costingAffoPercent: 10,
      costingGeneralMarkupPercent: 25,
      costingMaterialMarkupPercent: 10,
    });
    const { parent, component } = await makeParentWithBom(10, 2);
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 60, overheadPercent: 10, active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 1, workCenterId: workCenter.id, setupTime: 60, runTimePerUnit: 0 });
    return { parent, component };
  }

  const COST_COLUMNS = [
    "materialCost",
    "materialOverhead",
    "laborCost",
    "overhead",
    "subcontractCost",
    "subcontractOverhead",
    "semiFinishedCost",
    "businessOverhead",
  ] as const;
  const costsOf = (c: Record<(typeof COST_COLUMNS)[number], string>) => Object.fromEntries(COST_COLUMNS.map((k) => [k, c[k]]));

  it("prices the förkalkyl with the varugrupp's markups field by field and leaves TVK and SVK alone", async () => {
    const { parent } = await makePricedParent();
    const { calculation: company } = await costingService.preCalculate(parent.id, 5, true);
    // 187 + 25 % × 187 + 10 % × 110 + 6
    expect(company).toMatchObject({
      generalMarkupPercent: "25.00",
      generalMarkupLevel: "company",
      materialMarkupPercent: "10.00",
      materialMarkupLevel: "company",
      materialMarkupBase: "110.0000",
      generalMarkup: "46.7500",
      materialMarkup: "11.0000",
      salesPrice: "250.7500",
    });

    const group = await makeGroup({ generalMarkupPercent: 40, materialMarkupPercent: null });
    await articleService.updateArticle(parent.id, { groupId: group.id });
    const { calculation: grouped } = await costingService.preCalculate(parent.id, 5, true);

    // The group's 40 %, the company's material (the group's field is empty).
    expect(grouped).toMatchObject({
      generalMarkupPercent: "40.00",
      generalMarkupLevel: "group",
      materialMarkupPercent: "10.00",
      materialMarkupLevel: "company",
      materialMarkupBase: "110.0000",
      generalMarkup: "74.8000",
      materialMarkup: "11.0000",
      salesPrice: "278.8000",
      // The cost markups are always the company's.
      moPercent: "10.00",
      affoPercent: "10.00",
    });
    // Every cost bucket, TVK and SVK as without the group.
    expect(costsOf(grouped)).toEqual(costsOf(company));
    expect(manufacturingCost(grouped)).toBe(170);
    expect(selfCost(grouped)).toBe(187);

    // The preview answers the same as the save.
    const { calculation: preview } = await costingService.preCalculate(parent.id, 5);
    expect(preview).toMatchObject({ id: null, generalMarkupLevel: "group", materialMarkupLevel: "company", materialMarkupBase: "110.0000", salesPrice: "278.8000" });
  });

  // The review of etapp 1: markupPercentSchema bounds the range, not the
  // decimals. The amounts must be priced at the percentage the header stores
  // (two decimals), or the Kalkylpris delta against the header is off by öre.
  it("prices a percentage with more than two decimals at the two the header stores — trial and company alike", async () => {
    const { parent } = await makePricedParent();
    const { calculation: tried } = await costingService.preCalculate(parent.id, 5, true, false, {
      generalMarkupPercent: 12.345,
      materialMarkupPercent: 7.125,
    });
    // 187 × 12.35 % = 23.0945 (12.345 % would be 23.0852); 110 × 7.13 % = 7.843.
    expect(tried).toMatchObject({
      generalMarkupPercent: "12.35",
      generalMarkup: "23.0945",
      materialMarkupPercent: "7.13",
      materialMarkup: "7.8430",
      salesPrice: "223.9375", // 187 + 23.0945 + 7.843 + 6
    });
    expect(Number(tried.generalMarkup)).toBe(Math.round(selfCost(tried) * Number(tried.generalMarkupPercent) * 100) / 10000);
    expect(Number(tried.materialMarkup)).toBe(Math.round(Number(tried.materialMarkupBase) * Number(tried.materialMarkupPercent) * 100) / 10000);

    // The company's setting has no decimal bound either.
    Object.assign(costingSettings, { costingGeneralMarkupPercent: 25.125 });
    const { calculation: company } = await costingService.preCalculate(parent.id, 5);
    expect(company).toMatchObject({ generalMarkupPercent: "25.13", generalMarkupLevel: "company", generalMarkup: "46.9931" }); // 187 × 25.13 %
  });

  it("takes the varugrupp's 0 as 0 % and its empty field as the company's", async () => {
    const { parent } = await makePricedParent();
    const group = await makeGroup({ generalMarkupPercent: null, materialMarkupPercent: 0 });
    await articleService.updateArticle(parent.id, { groupId: group.id });

    const { calculation } = await costingService.preCalculate(parent.id, 5, true);

    expect(calculation).toMatchObject({
      generalMarkupPercent: "25.00",
      generalMarkupLevel: "company",
      materialMarkupPercent: "0.00",
      materialMarkupLevel: "group",
      materialMarkup: "0.0000",
      // With 0 % the amount says nothing — the base still does.
      materialMarkupBase: "110.0000",
      salesPrice: "239.7500",
    });
  });

  it("previews Pröva påslag without saving anything — no calculation, no setting, no group, no article price", async () => {
    const { parent } = await makePricedParent();
    const group = await makeGroup({ generalMarkupPercent: 40, materialMarkupPercent: 15 });
    await articleService.updateArticle(parent.id, { groupId: group.id });
    const settingsBefore = await db.select().from(systemSettings).orderBy(asc(systemSettings.key));
    const [groupBefore] = await db.select().from(articleGroups).where(eq(articleGroups.id, group.id));

    // Against the real settings reader too: the costing module has no write
    // path to System → Kalkyler at all, and a trial must not grow one.
    const onRealSettings = createCostingService(createCostingRepository(db), testSystemService);
    await onRealSettings.preCalculate(parent.id, 5, false, false, { generalMarkupPercent: 35 });
    const { calculation } = await costingService.preCalculate(parent.id, 5, false, false, { generalMarkupPercent: 35 });

    // 35 % tried, the material still the group's 15 % — field by field.
    expect(calculation).toMatchObject({
      id: null,
      generalMarkupPercent: "35.00",
      generalMarkupLevel: "trial",
      materialMarkupPercent: "15.00",
      materialMarkupLevel: "group",
      generalMarkup: "65.4500",
      materialMarkup: "16.5000",
      salesPrice: "274.9500",
    });
    expect(await db.select().from(costCalculations)).toHaveLength(0);
    expect(await db.select().from(systemSettings).orderBy(asc(systemSettings.key))).toEqual(settingsBefore);
    expect((await db.select().from(articleGroups).where(eq(articleGroups.id, group.id)))[0]).toEqual(groupBefore);
    const [article] = await db.select({ standardCost: articles.standardCost, salesPrice: articles.salesPrice }).from(articles).where(eq(articles.id, parent.id));
    expect(article).toEqual({ standardCost: null, salesPrice: null });

    // null = the current one, like an absent field.
    const { calculation: inherited } = await costingService.preCalculate(parent.id, 5, false, false, { generalMarkupPercent: null, materialMarkupPercent: null });
    expect(inherited).toMatchObject({ generalMarkupLevel: "group", materialMarkupLevel: "group", salesPrice: "284.3000" }); // 187 + 74.8 + 16.5 + 6
  });

  it("saves a trial as prövat with the TVK and SVK of an ordinary calculation, so TB reads the same self cost", async () => {
    const { parent } = await makePricedParent();
    const { calculation: regular } = await costingService.preCalculate(parent.id, 5, true);
    const { calculation: trial } = await costingService.preCalculate(parent.id, 5, true, false, { generalMarkupPercent: 35, materialMarkupPercent: 0 });

    expect(trial).toMatchObject({
      type: "pre",
      generalMarkupPercent: "35.00",
      generalMarkupLevel: "trial",
      materialMarkupPercent: "0.00",
      materialMarkupLevel: "trial",
      materialMarkup: "0.0000",
      materialMarkupBase: "110.0000",
      // 187 + 65.45 + 0 + 6
      salesPrice: "258.4500",
    });
    expect(costsOf(trial)).toEqual(costsOf(regular));
    expect(selfCost(trial)).toBe(selfCost(regular));

    // The trial is now the latest förkalkyl — and TB's self cost is unchanged.
    const latest = (await costingService.latestPreCalculationSelfCost([parent.id])).get(parent.id);
    expect(latest).toMatchObject({ calculationId: trial.id, selfCostPerUnit: 187 / 5 });
    // The list carries the mark the web shows as prövat.
    const listed = await costingService.listCostCalculations(parent.id);
    expect(listed.map((c) => [c.id, c.generalMarkupLevel, c.materialMarkupLevel])).toEqual([
      [trial.id, "trial", "trial"],
      [regular.id, "company", "company"],
    ]);
    // Saving wrote nothing back onto the article: that is Sätt standardpris /
    // Sätt försäljningspris, below.
    const [article] = await db.select({ standardCost: articles.standardCost, salesPrice: articles.salesPrice }).from(articles).where(eq(articles.id, parent.id));
    expect(article).toEqual({ standardCost: null, salesPrice: null });
  });

  it("feeds back the calculation's own price — the varugrupp's or the tried one — and the same standard cost", async () => {
    const withWriter = createCostingService(createCostingRepository(db), { getSettings: async () => costingSettings }, articleService);
    const { parent } = await makePricedParent();
    const group = await makeGroup({ generalMarkupPercent: 40 });
    await articleService.updateArticle(parent.id, { groupId: group.id });
    const { calculation: grouped } = await withWriter.preCalculate(parent.id, 5, true);
    const { calculation: trial } = await withWriter.preCalculate(parent.id, 5, true, false, { generalMarkupPercent: 35, materialMarkupPercent: 0 });

    // Sätt försäljningspris: the calculation's price per unit, never the company's.
    expect((await withWriter.applySalesPriceFromCalculation(grouped.id))).toMatchObject({ salesPrice: "55.7600" }); // 278.8 / 5
    expect((await withWriter.applySalesPriceFromCalculation(trial.id))).toMatchObject({ salesPrice: "51.6900" }); // 258.45 / 5
    // Sätt standardpris: TVK per unit, the same whichever price markups ran.
    expect((await withWriter.applyStandardCostFromCalculation(trial.id))).toMatchObject({ standardCost: "34.0000" }); // 170 / 5
    expect((await withWriter.applyStandardCostFromCalculation(grouped.id))).toMatchObject({ standardCost: "34.0000" });
  });

  it("refuses to try a cost markup or an out-of-range percentage", () => {
    expect(preCalculateSchema.safeParse({ quantity: 1, markups: { moPercent: 10 } }).success).toBe(false);
    expect(preCalculateSchema.safeParse({ quantity: 1, markups: { generalMarkupPercent: 1001 } }).success).toBe(false);
    expect(preCalculateSchema.safeParse({ quantity: 1, markups: { materialMarkupPercent: -1 } }).success).toBe(false);
    expect(preCalculateSchema.safeParse({ quantity: 1, markups: { generalMarkupPercent: 0, materialMarkupPercent: null } }).success).toBe(true);
    expect(preCalculateSchema.safeParse({ quantity: 1, markups: {} }).success).toBe(true);
  });

  it("prices a multi-level run's sub-levels with the sold article's materialpåslag and sums the base", async () => {
    Object.assign(costingSettings, { costingMoPercent: 10, costingMaterialMarkupPercent: 10 });
    const raw = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `RAW-${crypto.randomUUID()}`, name: "Råmaterial", type: "purchased", standardCost: 50, active: true }));
    const semi = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `SEMI-${crypto.randomUUID()}`, name: "Underrede", type: "manufactured", active: true }));
    const top = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `TOP-${crypto.randomUUID()}`, name: "Diskbänk", type: "manufactured", standardCost: 0, active: true }));
    await articleService.addBomComponent(semi.id, { componentArticleId: raw.id, quantity: 1 });
    await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 2 });
    await articleService.addBomComponent(top.id, { componentArticleId: raw.id, quantity: 1 });
    // The halvfabrikat's own group is NOT read: the markup is a pricing
    // decision for what is sold.
    const semiGroup = await makeGroup({ materialMarkupPercent: 50 });
    const topGroup = await makeGroup({ materialMarkupPercent: 20 });
    await articleService.updateArticle(semi.id, { groupId: semiGroup.id });
    await articleService.updateArticle(top.id, { groupId: topGroup.id });

    const { calculation } = await costingService.preCalculate(top.id, 1, true, true);

    // Sub-level for 2: dM 100 + MO 10 = base 110, markup 20 % = 22. Top: its
    // own raw 50 + MO 5 = 55, plus the lifted 110 ⇒ base 165, markup 33.
    expect(calculation).toMatchObject({
      multiLevel: true,
      materialMarkupPercent: "20.00",
      materialMarkupLevel: "group",
      materialMarkupBase: "165.0000",
      materialMarkup: "33.0000",
      semiFinishedCost: "110.0000",
    });
    const rows = await db.select().from(costCalculationMaterialRows).where(eq(costCalculationMaterialRows.costCalculationId, calculation.id));
    const semiRow = rows.find((r) => r.kind === "semi")!;
    expect([semiRow.materialMarkupBase, semiRow.materialMarkupAmount]).toEqual(["110.0000", "22.0000"]);
    expect(rows.find((r) => r.kind === "material")!.materialMarkupBase).toBe("0.0000");
    // The Kalkylpris's identity: markup = percent × base, every level included.
    expect(Number(calculation.materialMarkup)).toBeCloseTo(Number(calculation.materialMarkupBase) * 0.2, 10);
  });

  it("prices the efterkalkyl with the varugrupp too, its TVK and avvikelseanalys untouched", async () => {
    Object.assign(costingSettings, { costingMoPercent: 10, costingGeneralMarkupPercent: 25, costingMaterialMarkupPercent: 10 });
    const order = await makeOrderWithReportedWork();
    const before = await costingService.postCalculate(order.id);
    const group = await makeGroup({ generalMarkupPercent: 40, materialMarkupPercent: 0 });
    await articleService.updateArticle(order.articleId, { groupId: group.id });

    const after = await costingService.postCalculate(order.id, true);

    expect(after.calculation).toMatchObject({
      type: "post",
      generalMarkupPercent: "40.00",
      generalMarkupLevel: "group",
      materialMarkupPercent: "0.00",
      materialMarkupLevel: "group",
      // dM 80 + MO 8 — an efterkalkyl is single-level.
      materialMarkupBase: "88.0000",
    });
    expect(before.calculation).toMatchObject({ generalMarkupLevel: "company", materialMarkupLevel: "company", materialMarkupBase: "88.0000" });
    expect(costsOf(after.calculation)).toEqual(costsOf(before.calculation));
    expect(Number(after.calculation.salesPrice)).not.toBe(Number(before.calculation.salesPrice));
    expect(after.analysis).toEqual({
      ...before.analysis!,
      materialRows: before.analysis!.materialRows.map((r, i) => ({ ...r, id: after.analysis!.materialRows[i]!.id })),
      operationRows: before.analysis!.operationRows.map((r, i) => ({ ...r, id: after.analysis!.operationRows[i]!.id })),
    });
  });

  it("gives previewStructure the template's varugrupp, which moves only the materialpåslag", async () => {
    Object.assign(costingSettings, { costingMoPercent: 10, costingAffoPercent: 10, costingMaterialMarkupPercent: 10 });
    const template = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `TPL-${crypto.randomUUID()}`, name: "Mall", type: "manufactured", active: true }));
    const part = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `PART-${crypto.randomUUID()}`, name: "Skiva", type: "purchased", standardCost: 10, active: true }));
    const structure = { components: [{ componentArticleId: part.id, quantity: 2, unitId: null, unitFactor: null }], operations: [] };

    const company = await costingService.previewStructure(template.id, 5, structure);
    const group = await makeGroup({ generalMarkupPercent: 90, materialMarkupPercent: 30 });
    await articleService.updateArticle(template.id, { groupId: group.id });
    const grouped = await costingService.previewStructure(template.id, 5, structure);

    // dM 100 + MO 10 = 110: 10 % ⇒ 11, the group's 30 % ⇒ 33.
    expect(company.materialMarkup).toBeCloseTo(11, 10);
    expect(grouped.materialMarkup).toBeCloseTo(33, 10);
    expect(grouped.manufacturingCost).toBe(company.manufacturingCost);
    expect(grouped.selfCost).toBe(company.selfCost);
    expect(grouped.selfCostPerUnit).toBe(company.selfCostPerUnit);
  });

  it("backfills the base on single-level calculations only (0194's own UPDATE)", async () => {
    const { parent } = await makePricedParent();
    const { calculation: single } = await costingService.preCalculate(parent.id, 5, true);
    const { calculation: multi } = await costingService.preCalculate(parent.id, 5, true, true);
    // As saved before 0194: no base, levels by the column default.
    await db.execute(sql`update cost_calculations set material_markup_base = null`);

    const migration = readFileSync(new URL("../../../packages/db/drizzle/0194_paslag_per_varugrupp.sql", import.meta.url), "utf8");
    const update = migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => /^UPDATE "cost_calculations"/m.test(statement));
    expect(update, "0194 must contain the backfill").toBeDefined();
    await db.execute(sql.raw(update!.slice(update!.search(/^UPDATE "cost_calculations"/m))));

    const rows = await db.select({ id: costCalculations.id, base: costCalculations.materialMarkupBase }).from(costCalculations);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.base]))).toEqual({ [single.id]: "110.0000", [multi.id]: null });
  });

  // The review of etapp 1: a multi-level calculation without semi-finished
  // cost lifts no base either, so its base is exactly dM + MO — 0195 fills
  // it. One with semi-finished cost stays null (the sub-levels' base is lost).
  it("backfills the base on multi-level calculations without semi-finished cost too (0195's UPDATE)", async () => {
    const { parent } = await makePricedParent();
    const { calculation: single } = await costingService.preCalculate(parent.id, 5, true);
    const { calculation: multi } = await costingService.preCalculate(parent.id, 5, true, true);
    const { calculation: withSemi } = await costingService.preCalculate(parent.id, 5, true, true);
    expect(multi).toMatchObject({ multiLevel: true, semiFinishedCost: "0.0000" });
    await db.execute(sql`update cost_calculations set material_markup_base = null`);
    // As if a manufactured component had been costed from its own structure.
    await db.execute(sql`update cost_calculations set semi_finished_cost = 5 where id = ${withSemi.id}`);

    const updateOf = (file: string) => {
      const migration = readFileSync(new URL(`../../../packages/db/drizzle/${file}`, import.meta.url), "utf8");
      const update = migration
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .find((statement) => /^UPDATE "cost_calculations"/m.test(statement));
      expect(update, `${file} must contain the backfill`).toBeDefined();
      return sql.raw(update!.slice(update!.search(/^UPDATE "cost_calculations"/m)));
    };
    // In migration order.
    await db.execute(updateOf("0194_paslag_per_varugrupp.sql"));
    await db.execute(updateOf("0195_paslag_per_kund.sql"));

    const rows = await db.select({ id: costCalculations.id, base: costCalculations.materialMarkupBase }).from(costCalculations);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.base]))).toEqual({
      [single.id]: "110.0000",
      [multi.id]: "110.0000",
      [withSemi.id]: null,
    });
  });
});
