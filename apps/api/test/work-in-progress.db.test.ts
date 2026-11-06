import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { pdfText } from "./helpers/pdf.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { costingRoutes } from "../src/modules/costing/routes/costing.routes.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createWorkInProgressService } from "../src/modules/costing/service/work-in-progress.service.js";
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

// Produkter i arbete (#25) against Postgres: every source bounded to D, the
// orders that count, avräknat at the stock price. "Before D" is made by
// moving rows onto fixed days with SQL; everything the services write now
// lies after D.

const D = "2025-06-30";
const BEFORE = "2025-06-15T10:00:00Z";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);
const authRepo = createAuthRepository(db);
// Receiving a lego IO row reports the TO operation through the manufacturing
// service, as app.ts wires it.
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService
);

const costingSettings = {
  costingMaterialSource: "standard" as "standard" | "supplier",
  costingPostMaterialSource: "standard" as "standard" | "supplier" | "actual",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
};
const wipService = createWorkInProgressService({
  db,
  settings: { getSettings: async () => costingSettings },
  rates: {
    getRate: async (currency, date) => {
      throw new ExchangeRateUnavailableError(currency, date);
    },
  },
  pdf: testDocumentPdfService,
});

const TRUNCATE = sql`TRUNCATE purchase_receipts, purchase_order_rows, purchase_orders, suppliers, cost_calculations, time_reports, employees, mo_report_materials, mo_reports, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, article_suppliers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  Object.assign(costingSettings, { costingPostMaterialSource: "standard", costingMoPercent: 0, costingLoPercent: 0 });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

let seq = 0;
async function makeUser() {
  return authRepo.create({
    email: `pia-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Produktionsekonom",
    role: "admin",
  });
}

async function article(name: string, type: "manufactured" | "purchased" | "service", standardCost?: number) {
  return articleService.createArticle({
    articleNumber: `PIA-${(seq += 1)}-${crypto.randomUUID().slice(0, 6)}`,
    name,
    type,
    unit: "st",
    standardCost,
    active: true,
  });
}

// A manufactured article (standard cost `parentCost`, null = none) with one
// unlinked component (2 per unit, standard cost 12) and one operation at a
// 100 kr/h resource with 50 % TO, 100 components in stock at 12.
async function makeProduct(parentCost: number | null) {
  const parent = await article("Diskbänk", "manufactured", parentCost ?? undefined);
  const component = await article("Plåt", "purchased", 12);
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2 });
  const workCenter = await mfgService.createWorkCenter({ code: `${100 + (seq % 800)}`, name: "Svets", hourlyRate: 100, overheadPercent: 50, active: true });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
  const warehouse = await stockService.createWarehouse({ name: `Lager ${seq}`, active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
  await stockService.recordTransaction({ articleId: component.id, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });
  const employee = await timeReportService.createEmployee({ employeeNumber: `E-${seq}`, name: "Kalle", active: true });
  return { parent, component, location, employee, workCenter };
}

async function makeOrder(product: Awaited<ReturnType<typeof makeProduct>>, quantity: number, userId: string) {
  const order = await mfgService.createManufacturingOrder({ articleId: product.parent.id, quantity }, userId);
  const [material] = await mfgService.listMaterialConsumptions(order.id);
  const [operation] = await mfgService.listOperations(order.id);
  return { order, material: material!, operation: operation! };
}

// Everything the order has logged so far moves onto BEFORE (on or before D).
async function moveBeforeD(orderId: string) {
  await db.execute(sql`UPDATE stock_transactions SET created_at = ${BEFORE}::timestamptz WHERE reference_id = ${orderId}`);
  await db.execute(sql`UPDATE mo_reports SET created_at = ${BEFORE}::timestamptz WHERE manufacturing_order_id = ${orderId}`);
}

async function report(asOf?: string, basis: "manufacturing_cost" | "direct" = "manufacturing_cost") {
  return wipService.getWorkInProgress({ asOf, basis });
}

describe("Produkter i arbete per datum — the sources", () => {
  it("counts draws, returns and time by D, and relieves the delinleverans at the stock price", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const { order, material, operation } = await makeOrder(product, 5, user.id);

    await mfgService.consumeMaterial(order.id, material.id, { locationId: product.location.id, quantity: 6 }, user.id);
    const [first] = await mfgService.listReports(order.id);
    await mfgService.consumeMaterial(order.id, material.id, { locationId: product.location.id, quantity: 1 }, user.id);
    const returned = (await mfgService.listReports(order.id)).find((r) => r.id !== first!.id)!;
    // Ångra rapportering: the 1 goes back as a positive mo_consumption.
    await mfgService.undoReport(order.id, returned.id, user.id);
    // Delinleverans: 2 OK on the last operation are finished goods at the
    // article's standard cost (50); the unlinked material already covers it.
    await mfgService.reportOperationQuantities(operation.id, { quantityOk: 2, quantityScrapped: 0, markDone: false, createdBy: user.id });
    await moveBeforeD(order.id);
    // A standard cost set after the draws before D does not reprice them;
    // the draw after D is priced at it.
    await articleService.updateStandardCost(product.component.id, 20);
    // After D: 2 more drawn.
    await mfgService.consumeMaterial(order.id, material.id, { locationId: product.location.id, quantity: 2 }, user.id);
    // Worked on or before D but registered later counts; worked after D does not.
    await timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: operation.id, date: "2025-06-20", hours: 3 }, user.id);
    await timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: operation.id, date: "2025-07-02", hours: 2 }, user.id);
    costingSettings.costingMoPercent = 10;

    const atD = await report(D);
    expect(atD.rows).toHaveLength(1);
    // 6 × 12 + 3 h × 100 (TO excluded) + MO 10 % of 72 = 379,20; 2 × 50 relieved.
    expect(atD.rows[0]).toMatchObject({
      manufacturingOrderId: order.id,
      orderNumber: order.orderNumber,
      quantity: 5,
      receivedQuantity: 2,
      material: 72,
      labor: 300,
      subcontract: 0,
      overhead: 7.2,
      accumulated: 379.2,
      relieved: 100,
      value: 279.2,
      capped: false,
    });
    expect(atD.totalValue).toBe(279.2);

    const direct = await report(D, "direct");
    expect(direct.rows[0]).toMatchObject({ overhead: 0, accumulated: 372, value: 272 });

    // Today: 8 drawn (the latest draw today, at today's 20), 5 h.
    const now = await report(undefined, "direct");
    expect(now.rows[0]).toMatchObject({ material: 160, labor: 500, accumulated: 660, relieved: 100, value: 560 });
  });

  it("leaves out an order completed before D and keeps one completed after D", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const early = await makeOrder(product, 2, user.id);
    await mfgService.consumeMaterial(early.order.id, early.material.id, { locationId: product.location.id, quantity: 4 }, user.id);
    await mfgService.complete(early.order.id, { quantity: 2 }, user.id);
    await moveBeforeD(early.order.id);

    const late = await makeOrder(product, 2, user.id);
    await mfgService.consumeMaterial(late.order.id, late.material.id, { locationId: product.location.id, quantity: 4 }, user.id);
    await moveBeforeD(late.order.id);
    await mfgService.complete(late.order.id, { quantity: 2 }, user.id);

    const atD = await report(D, "direct");
    expect(atD.rows.map((r) => r.manufacturingOrderId)).toEqual([late.order.id]);
    expect(atD.rows[0]).toMatchObject({ material: 48, relieved: 0, value: 48 });
    // Today both are done: the difference is a variance, not an asset.
    expect((await report(undefined, "direct")).rows).toEqual([]);
  });

  it("values a configured TO's receipt at its own TVK/st and leaves a receipt without a price unvalued", async () => {
    const user = await makeUser();
    const configuredProduct = await makeProduct(50);
    const configured = await makeOrder(configuredProduct, 3, user.id);
    await db.execute(
      sql`UPDATE manufacturing_orders SET configuration = ${JSON.stringify({
        templateArticleId: configuredProduct.parent.id,
        key: "BREDD=1200",
        selection: [],
        cost: { manufacturingCostPerUnit: 77, calculatedAt: "2025-06-01T00:00:00Z" },
      })}::jsonb WHERE id = ${configured.order.id}`
    );
    await mfgService.consumeMaterial(configured.order.id, configured.material.id, { locationId: configuredProduct.location.id, quantity: 6 }, user.id);
    await mfgService.reportOperationQuantities(configured.operation.id, { quantityOk: 1, quantityScrapped: 0, markDone: false, createdBy: user.id });
    await timeReportService.createTimeReport(
      { employeeId: configuredProduct.employee.id, moOperationId: configured.operation.id, date: "2025-06-20", hours: 1 },
      user.id
    );
    await moveBeforeD(configured.order.id);

    const unpricedProduct = await makeProduct(null);
    const unpriced = await makeOrder(unpricedProduct, 3, user.id);
    await mfgService.consumeMaterial(unpriced.order.id, unpriced.material.id, { locationId: unpricedProduct.location.id, quantity: 6 }, user.id);
    await mfgService.reportOperationQuantities(unpriced.operation.id, { quantityOk: 1, quantityScrapped: 0, markDone: false, createdBy: user.id });
    await moveBeforeD(unpriced.order.id);

    const atD = await report(D, "direct");
    const byId = new Map(atD.rows.map((row) => [row.manufacturingOrderId, row]));
    // 6 × 12 + 1 h × 100 = 172, less 1 × 77 (not the template's standard cost 50).
    expect(byId.get(configured.order.id)).toMatchObject({ accumulated: 172, relieved: 77, value: 95, capped: false });
    expect(byId.get(unpriced.order.id)).toMatchObject({ material: 72, relieved: null, value: null, capped: false });
    expect(atD).toMatchObject({ totalValue: 95, unvaluedCount: 1, cappedCount: 0 });
  });

  it("counts a lego receipt that was alive on D, also when it was undone after D", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: `Lackering ${crypto.randomUUID().slice(0, 6)}`, active: true });
    const machine = await mfgService.createWorkCenter({ code: "310", name: "Svets", type: "machine", hourlyRate: 100, active: true });
    const lego = await mfgService.createWorkCenter({ code: "910", name: "Lackering AB", type: "subcontract", supplierId: supplier.id, active: true });
    const parent = await article("Legodetalj", "manufactured", 200);
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0, setupPrice: 500, unitPrice: 100 });
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, user.id);
    const legoOp = (await mfgService.listOperations(order.id)).find((op) => op.sequenceNo === 20)!;

    const io = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const row = await purchaseService.addRow(io.id, { articleId: parent.id, quantity: 4, unitPrice: 100, setupPrice: 500, moOperationId: legoOp.id });
    await purchaseService.confirm(io.id);
    // The lego operation is the last one: the received unit is finished goods (1 × 200).
    await purchaseService.receiveGoods(io.id, row.id, { quantity: 1 }, user.id);
    const [receipt] = await purchaseService.listReceipts(io.id);
    await purchaseService.undoReceipt(io.id, receipt!.id, user.id);
    // Received before D, undone after D; the TO receipt before D, its reversal after.
    await db.execute(sql`UPDATE purchase_receipts SET created_at = ${BEFORE}::timestamptz WHERE id = ${receipt!.id}`);
    await db.execute(
      sql`UPDATE stock_transactions SET created_at = ${BEFORE}::timestamptz WHERE reference_id = ${order.id} AND transaction_type = 'mo_receipt' AND quantity_delta > 0`
    );
    costingSettings.costingLoPercent = 10;

    const atD = await report(D);
    // 1 × 100 + ställpris 500 once = 600, LO 10 % = 60; 1 × 200 relieved.
    expect(atD.rows).toHaveLength(1);
    expect(atD.rows[0]).toMatchObject({ subcontract: 600, overhead: 60, accumulated: 660, receivedQuantity: 1, relieved: 200, value: 460 });
    // Today the receipt is undone: nothing accumulated, nothing relieved.
    expect((await report()).rows).toEqual([]);
  });
});

// Timkostnad per datum (#14 etapp 4): lön per work day at that day's hourly
// rate, the efterkalkyl's rule — PIA no longer uses today's rate.
describe("Produkter i arbete per datum — lön per arbetsdag", () => {
  it("prices each work day at its rate, and a rate changed after D never moves PIA per D", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const { operation } = await makeOrder(product, 5, user.id);
    // 100 kr/h from the start of the year, 150 from 20 June (Stockholm).
    await db.execute(sql`UPDATE work_center_rate_history SET valid_from = '2025-01-01T08:00:00Z' WHERE work_center_id = ${product.workCenter.id}`);
    await mfgService.updateWorkCenter(product.workCenter.id, { hourlyRate: 150 });
    await db.execute(
      sql`UPDATE work_center_rate_history SET valid_from = '2025-06-20T08:00:00Z' WHERE work_center_id = ${product.workCenter.id} AND hourly_rate = 150`
    );
    const hours = (date: string, h: number) =>
      timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: operation.id, date, hours: h }, user.id);
    await hours("2025-06-10", 3);
    await hours("2025-06-25", 2);

    expect((await report("2025-06-15", "direct")).rows[0]).toMatchObject({ labor: 300 });
    // 3 × 100 + 2 × 150 — not 5 × today's rate.
    expect((await report(D, "direct")).rows[0]).toMatchObject({ labor: 600, accumulated: 600, value: 600 });

    // Raised again today: PIA per D (a booked year-end step) stays as it was.
    await mfgService.updateWorkCenter(product.workCenter.id, { hourlyRate: 300 });
    expect((await report(D, "direct")).rows[0]).toMatchObject({ labor: 600 });
    // Time reported afterwards for a day before D changes it (Inaktuell in the bokslut).
    await hours("2025-06-28", 1);
    expect((await report(D, "direct")).rows[0]).toMatchObject({ labor: 750 });
    // Today's PIA has the same days at the same rates.
    expect((await report(undefined, "direct")).rows[0]).toMatchObject({ labor: 750 });
  });
});

describe("Produkter i arbete per datum — material sources", () => {
  async function drawnBeforeD() {
    const user = await makeUser();
    const product = await makeProduct(50);
    const { order, material } = await makeOrder(product, 5, user.id);
    // The opening stock arrived before the draw, at 15 (not the standard cost 12).
    await db.execute(
      sql`UPDATE stock_transactions SET unit_cost = 15, created_at = '2025-06-01T10:00:00Z' WHERE article_id = ${product.component.id} AND transaction_type = 'inventory_adjustment'`
    );
    await mfgService.consumeMaterial(order.id, material.id, { locationId: product.location.id, quantity: 6 }, user.id);
    await moveBeforeD(order.id);
    await articleService.updateStandardCost(product.component.id, 20);
    return order;
  }

  it("standard: the standard cost at the latest draw on or before D", async () => {
    await drawnBeforeD();
    costingSettings.costingPostMaterialSource = "standard";
    expect((await report(D, "direct")).rows[0]).toMatchObject({ material: 72 });
  });

  it("actual: the moving average over the draws on or before D", async () => {
    await drawnBeforeD();
    costingSettings.costingPostMaterialSource = "actual";
    const atD = await report(D, "direct");
    expect(atD.rows[0]).toMatchObject({ material: 90 });
    expect(atD.warnings).toEqual([]);
  });
});

describe("Produkter i arbete per datum — the orders", () => {
  // undoReportInTx's own rule: done while a Slutför stands or the receipts
  // cover the order — not "a report once set completed_order".
  it("reopens an order per D when an earlier receipt is undone after the one that completed it", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const { order, operation } = await makeOrder(product, 10, user.id);
    await mfgService.reportOperationQuantities(operation.id, { quantityOk: 6, quantityScrapped: 0, markDone: false, createdBy: user.id });
    const [first] = await mfgService.listReports(order.id);
    // 4 more on the last operation: received 10, the order is done (completed_order).
    await mfgService.reportOperationQuantities(operation.id, { quantityOk: 4, quantityScrapped: 0, markDone: false, createdBy: user.id });
    expect((await mfgService.getManufacturingOrder(order.id)).status).toBe("done");
    await timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: operation.id, date: "2025-06-20", hours: 3 }, user.id);
    await moveBeforeD(order.id);
    // After D the first receipt (6) is undone: received 4, the order is open again.
    await mfgService.undoReport(order.id, first!.id, user.id);
    expect((await mfgService.getManufacturingOrder(order.id)).status).not.toBe("done");

    // Per D the receipts covered the order: done, not PIA.
    expect((await report(D, "direct")).rows).toEqual([]);
    // Today: 8 of 20 drawn × 12 + 3 h × 100, less the 4 still received × 50.
    const now = await report(undefined, "direct");
    expect(now.rows).toHaveLength(1);
    expect(now.rows[0]).toMatchObject({ manufacturingOrderId: order.id, receivedQuantity: 4, material: 96, labor: 300, relieved: 200, value: 196 });
  });

  // 0117 backfilled Slutför rows only for orders then done; a short-closed
  // Stängd order from before it has none.
  it("leaves out a short-closed order from before the report log", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const legacy = await makeOrder(product, 5, user.id);
    const open = await makeOrder(product, 5, user.id);
    for (const made of [legacy, open]) {
      await mfgService.reportOperationQuantities(made.operation.id, { quantityOk: 2, quantityScrapped: 0, markDone: false, createdBy: user.id });
      await timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: made.operation.id, date: "2025-06-20", hours: 2 }, user.id);
      await moveBeforeD(made.order.id);
    }
    await db.execute(sql`UPDATE manufacturing_orders SET status = 'closed' WHERE id = ${legacy.order.id}`);

    const atD = await report(D, "direct");
    expect(atD.rows.map((row) => row.manufacturingOrderId)).toEqual([open.order.id]);
  });

  // A cancel needs every draw and receipt undone, so the nets are 0 after
  // the undo; time reports survive it. Before the day it was cancelled the
  // order counts like any other.
  it("counts a cancelled TO up to the day it was cancelled", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const drawn = await makeOrder(product, 5, user.id);
    await mfgService.consumeMaterial(drawn.order.id, drawn.material.id, { locationId: product.location.id, quantity: 4 }, user.id);
    const [draw] = await mfgService.listReports(drawn.order.id);
    await moveBeforeD(drawn.order.id);
    await mfgService.undoReport(drawn.order.id, draw!.id, user.id);
    await mfgService.cancel(drawn.order.id, user.id);

    const timed = await makeOrder(product, 5, user.id);
    await timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: timed.operation.id, date: "2025-06-20", hours: 1 }, user.id);
    await mfgService.cancel(timed.order.id, user.id);

    const atD = await report(D, "direct");
    const byId = new Map(atD.rows.map((row) => [row.manufacturingOrderId, row]));
    expect(byId.get(drawn.order.id)).toMatchObject({ material: 48, value: 48 });
    expect(byId.get(timed.order.id)).toMatchObject({ labor: 100, value: 100 });
    // Today both are cancelled: the time is a cost of the period, not an asset.
    expect((await report(undefined, "direct")).rows).toEqual([]);
  });

  it("sorts on the TO number", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const orders = [];
    for (const number of ["TO-1000", "TO-999", "TO-2"]) {
      const made = await makeOrder(product, 5, user.id);
      await db.execute(sql`UPDATE manufacturing_orders SET order_number = ${number} WHERE id = ${made.order.id}`);
      await timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: made.operation.id, date: "2025-06-20", hours: 1 }, user.id);
      orders.push(made);
    }

    const atD = await report(D, "direct");
    expect(atD.rows.map((row) => row.orderNumber)).toEqual(["TO-2", "TO-999", "TO-1000"]);
    expect(atD.totals).toMatchObject({ labor: 300, accumulated: 300, relieved: 0 });
  });

  it("prints the report as Produkter i arbete", async () => {
    const user = await makeUser();
    const product = await makeProduct(50);
    const { order, operation } = await makeOrder(product, 5, user.id);
    await timeReportService.createTimeReport({ employeeId: product.employee.id, moOperationId: operation.id, date: "2025-06-20", hours: 2 }, user.id);

    const { filename, content } = await wipService.getWorkInProgressPdf({ asOf: D, basis: "direct" });
    expect(filename).toBe(`produkter-i-arbete-${D}.pdf`);
    const text = pdfText(content);
    expect(text).toContain("Produkter i arbete");
    expect(text).toContain("Direkta kostnader");
    expect(text).toContain(order.orderNumber);
    expect(text).toContain("SUMMA PRODUKTER I ARBETE");
  });
});

describe("Produkter i arbete — the routes", () => {
  function buildApp(role: string) {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed" });
      throw err;
    });
    app.addHook("preHandler", async (req) => {
      req.user = { id: "00000000-0000-4000-8000-000000000001", email: "pia@example.com", name: "Test", role } as never;
    });
    app.register(costingRoutes, {
      service: createCostingService(createCostingRepository(db), { getSettings: async () => costingSettings }),
      workInProgress: wipService,
    });
    return app;
  }

  it("answers admin only, serves the PDF and refuses an unknown underlag", async () => {
    const admin = buildApp("admin");
    const office = buildApp("office");
    try {
      expect((await office.inject({ url: `/costing/work-in-progress?asOf=${D}` })).statusCode).toBe(403);
      expect((await office.inject({ url: `/costing/work-in-progress/pdf?asOf=${D}` })).statusCode).toBe(403);

      const json = await admin.inject({ url: `/costing/work-in-progress?asOf=${D}&basis=direct` });
      expect(json.statusCode).toBe(200);
      expect(json.json()).toMatchObject({ asOf: D, basis: "direct", rows: [], totalValue: 0, unvaluedCount: 0, cappedCount: 0, warnings: [] });

      const pdf = await admin.inject({ url: `/costing/work-in-progress/pdf?asOf=${D}` });
      expect(pdf.statusCode).toBe(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      expect(pdf.headers["content-disposition"]).toContain(`produkter-i-arbete-${D}.pdf`);

      expect((await admin.inject({ url: `/costing/work-in-progress?basis=full` })).statusCode).toBe(400);
      expect((await admin.inject({ url: `/costing/work-in-progress?asOf=2025-13-01` })).statusCode).toBe(400);
    } finally {
      await admin.close();
      await office.close();
    }
  });
});
