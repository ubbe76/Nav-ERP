import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, stockTransactions } from "@navet/db";
import { pdfText } from "./helpers/pdf.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  NotSubcontractOperationError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { computeRequirements } from "../src/modules/planning/service/requirements-calc.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";

// Etapp G — legoresurser: subcontract work centers, lego operations in the
// routing, the release snapshot, the lego IO with auto-reporting at goods
// receipt, the pre-/post-calculation and the IO PDF.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
// The REAL cross-module wiring under test: receiving a lego IO row reports
// the MO operation through the manufacturing service (app.ts does the same).
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService
);

const planningRepo = createPlanningRepository(db);

const costingSettings = {
  costingMaterialSource: "standard" as "standard" | "supplier",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
};
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => costingSettings,
});

const TABLES = sql`TRUNCATE cost_calculation_material_rows, cost_calculation_operation_rows, cost_calculations, purchase_order_rows, purchase_orders, routing_operation_files, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
  Object.assign(costingSettings, {
    costingMaterialSource: "standard",
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 0,
  });
});

afterAll(async () => {
  await db.execute(TABLES);
});

async function makeUser() {
  return authRepo.create({
    email: `lego-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Beredare",
    role: "admin",
  });
}

async function makeSupplier(name = "Lego AB") {
  return purchaseService.createSupplier({ name, active: true });
}

async function makeLegoCenter(supplierId: string | null, code = "900") {
  return mfgService.createWorkCenter({ code, name: "Ytbehandling AB", type: "subcontract", supplierId, active: true });
}

// Manufactured article with weight, one ordinary and one lego operation, and
// a BOM component linked to the lego operation (drawn when it reports).
async function makeLegoRouting(opts?: {
  setupPrice?: number;
  unitPrice?: number;
  transportPrice?: number;
  showNetWeight?: boolean;
}) {
  const user = await makeUser();
  const supplier = await makeSupplier();
  const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
  const lego = await makeLegoCenter(supplier.id);

  const parent = await articleService.createArticle({
    articleNumber: `LEGO-${crypto.randomUUID()}`,
    name: "Legodetalj",
    type: "manufactured",
    unit: "st",
    weight: 2.5,
    active: true,
  });
  const component = await articleService.createArticle({
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Component",
    type: "purchased",
    unit: "st",
    active: true,
  });

  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: machine.id,
    setupTime: 10,
    runTimePerUnit: 2,
  });
  const legoOp = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    description: "Ytbehandling",
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: opts?.setupPrice ?? 500,
    unitPrice: opts?.unitPrice ?? 100,
    ...(opts?.transportPrice !== undefined ? { transportPrice: opts.transportPrice } : {}),
    showNetWeight: opts?.showNetWeight ?? true,
  });
  await articleService.addBomComponent(parent.id, {
    componentArticleId: component.id,
    quantity: 2,
    routingOperationId: legoOp.id,
  });

  return { user, supplier, machine, lego, parent, component, legoOp };
}

async function releasedMo(quantity = 4) {
  const fixture = await makeLegoRouting();
  const order = await mfgService.createManufacturingOrder(
    { articleId: fixture.parent.id, quantity },
    fixture.user.id
  );
  const operations = await mfgService.listOperations(order.id);
  const legoOp = operations.find((op) => op.sequenceNo === 20)!;
  return { ...fixture, order, legoOp };
}

// Draft IO on the fixture's supplier with one lego row against the MO
// operation, confirmed so it can be received.
async function makeLegoOrder(fixture: Awaited<ReturnType<typeof releasedMo>>, quantity = 4) {
  const ioOrder = await purchaseService.createPurchaseOrder({ supplierId: fixture.supplier.id }, fixture.user.id);
  const row = await purchaseService.addRow(ioOrder.id, {
    articleId: fixture.parent.id,
    quantity,
    unitPrice: 100,
    setupPrice: 500,
    moOperationId: fixture.legoOp.id,
  });
  await purchaseService.confirm(ioOrder.id);
  return { ioOrder, row };
}

describe("lego work centers and routing", () => {
  it("defaults the operation's supplier from the legoresurs", async () => {
    const supplier = await makeSupplier();
    const lego = await makeLegoCenter(supplier.id);
    const article = await articleService.createArticle({
      articleNumber: `A-${crypto.randomUUID()}`,
      name: "A",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const op = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 10,
      workCenterId: lego.id,
      setupTime: 0,
      runTimePerUnit: 0,
    });
    expect(op.subcontractSupplierId).toBe(supplier.id);
  });

  it("refuses lego fields on a non-subcontract resource and clears them on a resource switch", async () => {
    const supplier = await makeSupplier();
    const machine = await mfgService.createWorkCenter({ code: "101", name: "Fräs", type: "machine", active: true });
    const lego = await makeLegoCenter(supplier.id);
    const article = await articleService.createArticle({
      articleNumber: `A-${crypto.randomUUID()}`,
      name: "A",
      type: "manufactured",
      unit: "st",
      active: true,
    });

    await expect(
      mfgService.createRoutingOperation(article.id, {
        sequenceNo: 10,
        workCenterId: machine.id,
        setupTime: 0,
        runTimePerUnit: 0,
        unitPrice: 50,
      })
    ).rejects.toBeInstanceOf(NotSubcontractOperationError);

    const op = await mfgService.createRoutingOperation(article.id, {
      sequenceNo: 10,
      workCenterId: lego.id,
      setupTime: 0,
      runTimePerUnit: 0,
      setupPrice: 500,
      unitPrice: 100,
      showNetWeight: true,
    });
    // Switching back to an ordinary resource clears the lego fields.
    const switched = await mfgService.updateRoutingOperation(article.id, op.id, { workCenterId: machine.id });
    expect(switched.subcontractSupplierId).toBeNull();
    expect(switched.setupPrice).toBeNull();
    expect(switched.unitPrice).toBeNull();
    expect(switched.showNetWeight).toBe(false);
    expect(switched.useArticleDrawing).toBe(true);
  });

  it("filters the work center list by type", async () => {
    await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
    await makeLegoCenter(null, "900");
    const legoOnly = await mfgService.listWorkCenters({ type: ["subcontract"] });
    expect(legoOnly).toHaveLength(1);
    expect(legoOnly[0]?.code).toBe("900");
    const standard = await mfgService.listWorkCenters({ type: ["machine", "personnel"] });
    expect(standard).toHaveLength(1);
    expect(standard[0]?.code).toBe("100");
    expect(await mfgService.listWorkCenters({ type: undefined })).toHaveLength(2);
  });
});

describe("release snapshots the lego fields", () => {
  it("copies supplier, prices and showNetWeight to mo_operations and exposes the work center type", async () => {
    const { order, supplier, legoOp } = await releasedMo(4);
    void order;

    expect(legoOp.workCenterType).toBe("subcontract");
    expect(legoOp.subcontractSupplierId).toBe(supplier.id);
    expect(legoOp.subcontractSupplierName).toBe(supplier.name);
    expect(legoOp.setupPrice).toBe("500.00");
    expect(legoOp.unitPrice).toBe("100.0000");
    expect(legoOp.showNetWeight).toBe(true);
    // Ordinary operations stay untouched.
    const operations = await mfgService.listOperations(legoOp.manufacturingOrderId);
    const machineOp = operations.find((op) => op.sequenceNo === 10)!;
    expect(machineOp.workCenterType).toBe("machine");
    expect(machineOp.subcontractSupplierId).toBeNull();
    expect(machineOp.setupPrice).toBeNull();
  });
});

describe("goods receipt auto-reports the lego operation", () => {
  it("partial receipt reports the received quantity without marking done, final receipt marks done", async () => {
    const fixture = await releasedMo(4);
    const { ioOrder, row } = await makeLegoOrder(fixture, 4);

    const partial = await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 1 }, fixture.user.id);
    expect(partial.operationReport).toEqual({ ok: true });
    let operation = await mfgService.getOperation(fixture.legoOp.id);
    expect(operation?.status).toBe("pending");
    expect(operation?.quantityCompleted).toBe("1.0000");

    // The linked material topped up for the reported quantity (2 per unit).
    const materials = await mfgService.listMaterialConsumptions(fixture.order.id);
    expect(materials[0]?.quantityConsumed).toBe("2.0000");

    const final = await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 3 }, fixture.user.id);
    expect(final.operationReport).toEqual({ ok: true });
    expect(final.orderStatus).toBe("received");
    operation = await mfgService.getOperation(fixture.legoOp.id);
    expect(operation?.status).toBe("done");
    expect(operation?.quantityCompleted).toBe("4.0000");
    expect((await mfgService.listMaterialConsumptions(fixture.order.id))[0]?.quantityConsumed).toBe("8.0000");
  });

  it("reports a receipt on a done TO as an efterrapport — the operation, no finished goods", async () => {
    const fixture = await releasedMo(4);
    const { ioOrder, row } = await makeLegoOrder(fixture, 4);
    await mfgService.complete(fixture.order.id, { quantity: 4 }, fixture.user.id);

    const result = await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 4 }, fixture.user.id);
    expect(result.operationReport).toEqual({ ok: true });
    const operation = await mfgService.getOperation(fixture.legoOp.id);
    expect([operation?.status, operation?.quantityCompleted]).toEqual(["done", "4.0000"]);
    // The lego operation is the last one, but Slutför already received the goods.
    const order = (await mfgService.getManufacturingOrder(fixture.order.id))!;
    expect([order.status, order.quantityReceived]).toEqual(["done", "4.0000"]);
  });

  it("keeps the receipt when the TO is in a status that cannot be reported", async () => {
    const fixture = await releasedMo(4);
    const { ioOrder, row } = await makeLegoOrder(fixture, 4);

    // Drive the TO to closed: a done one still takes efterrapporter.
    await mfgService.start(fixture.order.id);
    await mfgService.complete(fixture.order.id, { quantity: 4 }, fixture.user.id);
    await mfgService.close(fixture.order.id, fixture.user.id);

    const result = await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 4 }, fixture.user.id);
    expect(result.operationReport?.ok).toBe(false);
    expect(result.operationReport?.message).toBeTruthy();
    // The receipt itself stands.
    expect(result.row?.quantityReceived).toBe("4.0000");
    expect(result.orderStatus).toBe("received");
    // The operation was never touched.
    const operation = await mfgService.getOperation(fixture.legoOp.id);
    expect(operation?.quantityCompleted).toBeNull();
  });

  it("does not report anything for an ordinary row", async () => {
    const fixture = await releasedMo(4);
    const ioOrder = await purchaseService.createPurchaseOrder({ supplierId: fixture.supplier.id }, fixture.user.id);
    const row = await purchaseService.addRow(ioOrder.id, {
      articleId: fixture.component.id,
      quantity: 5,
      unitPrice: 10,
    });
    await purchaseService.confirm(ioOrder.id);
    const result = await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 5 }, fixture.user.id);
    expect(result.operationReport).toBeUndefined();
  });

  it("a fully received but shorted lego row leaves the operation pending, with the remainder back in requirements", async () => {
    // MO for 100, but the first lego IO is only ordered for 50 — a manually
    // shorted row/order. Fully receiving it must NOT mark the operation
    // done: it only covers 50 of the 100 the MO needs.
    const fixture = await releasedMo(100);
    const { ioOrder, row } = await makeLegoOrder(fixture, 50);

    const receipt = await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 50 }, fixture.user.id);
    expect(receipt.operationReport).toEqual({ ok: true });
    expect(receipt.orderStatus).toBe("received"); // the IO row itself is fully received…
    const operation = await mfgService.getOperation(fixture.legoOp.id);
    expect(operation?.status).toBe("pending"); // …but the operation is not covered.
    expect(operation?.quantityCompleted).toBe("50.0000");

    // The planning repo only proposes pending operations — since it's still
    // pending, the remaining 50 reappears in the requirements calc.
    const input = await planningRepo.loadRequirementsInput();
    const legoRow = input.legoOperationRows.find((r) => r.moOperationId === fixture.legoOp.id);
    expect(legoRow?.orderQuantity).toBe(100);
    expect(legoRow?.orderedQuantity).toBe(50);
    const rows = computeRequirements(input);
    const proposal = rows.find((r) => r.moOperationId === fixture.legoOp.id);
    expect(proposal?.proposalQuantity).toBe(50);

    // A second IO against the same operation covers the remainder — once
    // accumulated quantity_completed reaches the MO's order quantity, the
    // operation closes and the proposal disappears.
    const { ioOrder: ioOrder2, row: row2 } = await makeLegoOrder(fixture, 50);
    const finalReceipt = await purchaseService.receiveGoods(ioOrder2.id, row2.id, { quantity: 50 }, fixture.user.id);
    expect(finalReceipt.operationReport).toEqual({ ok: true });
    const covered = await mfgService.getOperation(fixture.legoOp.id);
    expect(covered?.status).toBe("done");
    expect(covered?.quantityCompleted).toBe("100.0000");

    const inputAfter = await planningRepo.loadRequirementsInput();
    expect(inputAfter.legoOperationRows.some((r) => r.moOperationId === fixture.legoOp.id)).toBe(false);
  });
});

describe("lego receipts never touch stock or article supply", () => {
  it("books no purchase_receipt — as the last operation the lego receipt brings the goods home as the MO's mo_receipt", async () => {
    const fixture = await releasedMo(4);
    const { ioOrder, row } = await makeLegoOrder(fixture, 4);
    await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 1 }, fixture.user.id);

    // The lego operation is the order's last: the received unit is finished
    // goods, booked once as the MO's mo_receipt (delinleverans) — never as a
    // purchase_receipt, which would stamp the lego price into the average.
    const afterFirst = await db
      .select()
      .from(stockTransactions)
      .where(eq(stockTransactions.articleId, fixture.parent.id));
    expect(afterFirst.map((t) => [t.transactionType, t.quantityDelta])).toEqual([["mo_receipt", "1.0000"]]);
    expect((await mfgService.getManufacturingOrder(fixture.order.id))!.status).toBe("in_progress");

    await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 3 }, fixture.user.id);
    // The PO-row bookkeeping itself is untouched by the skip.
    const receivedRow = (await purchaseService.listRows(ioOrder.id)).find((r) => r.id === row.id);
    expect(receivedRow?.quantityReceived).toBe("4.0000");

    const all = await db
      .select()
      .from(stockTransactions)
      .where(eq(stockTransactions.articleId, fixture.parent.id));
    expect(all.map((t) => [t.transactionType, t.quantityDelta])).toEqual([
      ["mo_receipt", "1.0000"],
      ["mo_receipt", "3.0000"],
    ]);
    // The whole order quantity came home: the TO completed itself.
    const done = (await mfgService.getManufacturingOrder(fixture.order.id))!;
    expect([done.status, done.quantityReceived]).toEqual(["done", "4.0000"]);
  });

  it("keeps the lego IO out of the requirements' article purchase supply while still deducting it per operation", async () => {
    const fixture = await releasedMo(4);
    const { ioOrder, row } = await makeLegoOrder(fixture, 4);
    // Partial receipt keeps the operation pending and the order
    // partially_received — both supply branches (confirmed + draft) must
    // exclude lego rows either way.
    await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 1 }, fixture.user.id);

    const input = await planningRepo.loadRequirementsInput();
    // Not article supply: the units come home via the MO (supplyMo), never
    // via the lego IO.
    expect(input.purchaseRows.filter((r) => r.articleId === fixture.parent.id)).toHaveLength(0);
    // But the per-operation deduction sees the full ordered quantity.
    const legoRow = input.legoOperationRows.find((r) => r.moOperationId === fixture.legoOp.id);
    expect(legoRow?.orderedQuantity).toBe(4);

    const rows = computeRequirements(input);
    const articleRow = rows.find(
      (r) => r.articleId === fixture.parent.id && r.moOperationId === undefined
    );
    expect(articleRow?.supplyPo ?? 0).toBe(0);
    expect(articleRow?.supplyPoDraft ?? 0).toBe(0);
    // Fully ordered → no lego proposal either.
    expect(rows.some((r) => r.moOperationId === fixture.legoOp.id)).toBe(false);
  });
});

describe("pre- and post-calculation with a lego operation", () => {
  it("prices the lego operation as setupPrice + unitPrice × quantity into subcontractCost with LO markup", async () => {
    const { parent } = await makeLegoRouting({ setupPrice: 500, unitPrice: 100 });
    costingSettings.costingLoPercent = 10;

    const { calculation } = await costingService.preCalculate(parent.id, 4);
    // 500 + 100 × 4 = 900 lego; the machine op has no hourly rate → 0 labor.
    expect(calculation.subcontractCost).toBe("900.0000");
    expect(calculation.subcontractOverhead).toBe("90.0000");
    expect(calculation.laborCost).toBe("0.0000");
  });

  it("post-calculation takes the actual received IO cost when one exists, else the snapshot standard", async () => {
    const fixture = await releasedMo(4);

    // No IO yet: falls back to snapshot prices × reported OK quantity.
    await mfgService.reportOperationQuantities(fixture.legoOp.id, {
      quantityOk: 2,
      quantityScrapped: 0,
      markDone: false,
      createdBy: fixture.user.id,
    });
    let result = await costingService.postCalculate(fixture.order.id);
    // 500 + 100 × 2 = 700.
    expect(result.calculation.subcontractCost).toBe("700.0000");

    // With a received lego IO (90/unit, 450 ställpris) the actual cost wins:
    // 450 + 90 × 4 = 810.
    const ioOrder = await purchaseService.createPurchaseOrder({ supplierId: fixture.supplier.id }, fixture.user.id);
    const row = await purchaseService.addRow(ioOrder.id, {
      articleId: fixture.parent.id,
      quantity: 4,
      unitPrice: 90,
      setupPrice: 450,
      moOperationId: fixture.legoOp.id,
    });
    await purchaseService.confirm(ioOrder.id);
    await purchaseService.receiveGoods(ioOrder.id, row.id, { quantity: 4 }, fixture.user.id);
    result = await costingService.postCalculate(fixture.order.id);
    expect(result.calculation.subcontractCost).toBe("810.0000");
  });
});

describe("lego IO PDF", () => {
  it("prints the TO reference, the ställpris and the net weight, and adds the ställpris once to the total", async () => {
    const fixture = await releasedMo(4);
    const { ioOrder } = await makeLegoOrder(fixture, 4);

    const { content } = await purchaseService.getPurchaseOrderPdf(ioOrder.id);
    const text = pdfText(content);
    expect(text).toContain(`Lego för ${fixture.order.orderNumber} · Op 20 · Ytbehandling`);
    expect(text).toContain("Ställpris: 500,00 SEK");
    // 2.5 kg × 4 st.
    expect(text).toContain("Nettovikt: 10,0 kg");
    // Row amount and total: 4 × 100 + 500 = 900.
    expect(text).toContain("900,00");
  });

  it("prints no net weight when the article has no weight", async () => {
    const fixture = await releasedMo(4);
    await articleService.updateArticle(fixture.parent.id, { weight: null });
    const { ioOrder } = await makeLegoOrder(fixture, 4);

    const text = pdfText((await purchaseService.getPurchaseOrderPdf(ioOrder.id)).content);
    expect(text).not.toContain("Nettovikt");
    expect(text).toContain("Ställpris: 500,00 SEK");
  });
});

// Transportkostnad (0164): a third lego price, added to the ställpris
// wherever the lego one-off is used (legoOneOffSql).
describe("lego Transportkostnad", () => {
  it("is snapshotted at release, priced into the pre-calculation and added to the IO row's ställpris", async () => {
    const { parent, user, supplier } = await makeLegoRouting({ setupPrice: 500, unitPrice: 100, transportPrice: 300 });

    const { calculation } = await costingService.preCalculate(parent.id, 4);
    // 500 + 300 + 100 × 4 = 1200.
    expect(calculation.subcontractCost).toBe("1200.0000");

    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, user.id);
    const legoOp = (await mfgService.listOperations(order.id)).find((op) => op.sequenceNo === 20)!;
    expect(legoOp.transportPrice).toBe("300.00");

    // The förfrågan defaults its ställpris from the operation's one-off.
    const { rows } = await purchaseService.createInquiry(
      { supplierId: supplier.id, rows: [{ articleId: parent.id, quantity: 4, moOperationId: legoOp.id }] },
      user.id
    );
    expect(rows[0]!.setupPrice).toBe("800.00");
  });

  it("is a lego field: refused on an ordinary resource", async () => {
    const { parent, machine } = await makeLegoRouting();
    await expect(
      mfgService.createRoutingOperation(parent.id, {
        sequenceNo: 30,
        workCenterId: machine.id,
        setupTime: 1,
        runTimePerUnit: 1,
        transportPrice: 100,
      })
    ).rejects.toThrow();
  });
});

