import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { ArticleNotFoundError, createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";
import { createScheduleRepository } from "../src/modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "../src/modules/timereport/service/schedule.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { CustomerNotFoundError, SalesOrderNotOpenError } from "../src/modules/planning/service/planning.service.js";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const documentPdfService = createDocumentPdfService(systemService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  // Lego (Etapp G): SubcontractOperationReporter — never reached in this
  // suite, and loud if it ever is.
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  }
);

const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseService,
  manufacturing: mfgService,
  // Every test changes data between reads — the cache is covered in
  // planning-orders-unit.test.ts.
  requirementsCacheMs: 0,
});

const TRUNCATE = sql`TRUNCATE week_schedule_days, week_schedules, day_schedule_breaks, day_schedules, holidays, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, article_suppliers, suppliers, sales_order_rows, sales_orders, customers, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, articles, article_groups, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `planning-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Planner",
    role: "user",
  });
}

async function makeArticle(overrides: {
  articleNumber: string;
  type?: "manufactured" | "purchased" | "service";
  reorderPoint?: number;
  orderQuantity?: number;
  rounding?: number;
  active?: boolean;
}) {
  return articleService.createArticle({
    name: overrides.articleNumber,
    type: "purchased",
    active: true,
    ...overrides,
  });
}

async function makeSupplierWithCatalog(
  name: string,
  articleIds: string[],
  price = 10,
  leadTimeDays = 7,
  priceBreaks?: { fromQuantity: number; price: number }[]
) {
  const supplier = await purchaseService.createSupplier({ name, active: true });
  for (const articleId of articleIds) {
    await purchaseService.addArticleSupplier(articleId, {
      supplierId: supplier.id,
      price,
      currency: "SEK",
      leadTimeDays,
      isPrimary: true,
      priceBreaks,
    });
  }
  return supplier;
}

async function makeConfirmedSalesOrder(articleId: string, quantity: number, userId: string) {
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  return salesService.createQuote(
    { customerId: customer.id, confirm: true, rows: [{ articleId, quantity, unitPrice: 100 }] },
    userId
  );
}

async function addStock(articleId: string, quantity: number) {
  await stockService.recordTransaction({
    articleId,
    quantityDelta: quantity,
    transactionType: "inventory_adjustment",
  });
}

// Lego (Etapp G): a released MO with one subcontract operation — the
// fixture the behovsberäkning proposes a lego row for, and that an RFQ
// (förfrågan) can be raised against via moOperationId. Mirrors
// inquiry-lego.test.ts's makeLegoRouting/releasedMo.
async function releasedLegoMo(quantity = 4) {
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier({ name: "Lego AB", active: true });
  const lego = await mfgService.createWorkCenter({
    code: "900",
    name: "Ytbehandling AB",
    type: "subcontract",
    supplierId: supplier.id,
    active: true,
  });
  const parent = await articleService.createArticle({
    articleNumber: `LEGO-${crypto.randomUUID()}`,
    name: "Legodetalj",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    description: "Ytbehandling",
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: 500,
    unitPrice: 100,
  });

  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity }, user.id);
  const operations = await mfgService.listOperations(order.id);
  const moLegoOp = operations.find((op) => op.sequenceNo === 20)!;
  return { user, supplier, parent, order, moLegoOp };
}

describe("planning service — listRequirements", () => {
  it("nets demand, stock and supply per article and proposes with the primary supplier attached", async () => {
    const user = await makeUser();
    const a = await makeArticle({ articleNumber: "PLAN-A" });
    await makeSupplierWithCatalog("Alfa AB", [a.id], 12.5, 14);
    await makeConfirmedSalesOrder(a.id, 10, user.id);
    await addStock(a.id, 4);
    const po = await purchaseService.createPurchaseOrder({ supplierId: (await purchaseService.listArticleSuppliers(a.id))[0]!.supplierId, exchangeRate: 1 }, user.id);
    await purchaseService.addRow(po.id, { articleId: a.id, quantity: 2, unitPrice: 12.5 });
    await purchaseService.confirm(po.id);

    const { rows, total } = await planningService.listRequirements({ limit: 50, offset: 0 });

    expect(total).toBe(1);
    const row = rows[0]!;
    expect(row.articleNumber).toBe("PLAN-A");
    expect(row.onHand).toBe(4);
    expect(row.demandSales).toBe(10);
    expect(row.supplyPo).toBe(2);
    expect(row.projected).toBe(-4);
    expect(row.proposalQuantity).toBe(4);
    expect(row.proposalKind).toBe("purchase");
    expect(row.primarySupplier).toMatchObject({
      supplierName: "Alfa AB",
      price: 12.5,
      leadTimeDays: 14,
    });
  });

  it("hides fully covered articles by default and shows them with showAll", async () => {
    const b = await makeArticle({ articleNumber: "PLAN-B" });
    await addStock(b.id, 8);

    const withoutFlag = await planningService.listRequirements({ limit: 50, offset: 0 });
    expect(withoutFlag.total).toBe(0);

    const withFlag = await planningService.listRequirements({ limit: 50, offset: 0, showAll: true });
    expect(withFlag.total).toBe(1);
    expect(withFlag.rows[0]!.articleNumber).toBe("PLAN-B");
    expect(withFlag.rows[0]!.proposalQuantity).toBe(0);
  });

  it("filters on search, type and group", async () => {
    const group = await articleService.createArticleGroup({ code: "310", name: "Plåt" });
    const purchased = await articleService.createArticle({
      articleNumber: "FILT-P",
      name: "Filterartikel",
      type: "purchased",
      active: true,
      reorderPoint: 5,
      groupId: group.id,
    });
    await makeArticle({ articleNumber: "FILT-M", type: "manufactured", reorderPoint: 5 });

    const byType = await planningService.listRequirements({ limit: 50, offset: 0, type: "purchased" });
    expect(byType.rows.map((r) => r.articleNumber)).toEqual(["FILT-P"]);

    const byGroup = await planningService.listRequirements({ limit: 50, offset: 0, groupId: group.id });
    expect(byGroup.rows.map((r) => r.articleNumber)).toEqual(["FILT-P"]);

    const bySearch = await planningService.listRequirements({ limit: 50, offset: 0, search: "filt-m" });
    expect(bySearch.rows.map((r) => r.articleNumber)).toEqual(["FILT-M"]);
    expect(purchased.id).toBeTruthy();
  });
});

describe("planning service — lego operations: open inquiries", () => {
  it("carries an open inquiry's FO number and status on the proposal row, without touching proposalQuantity", async () => {
    const f = await releasedLegoMo(4);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 4, moOperationId: f.moLegoOp.id }] },
      f.user.id
    );

    const { rows } = await planningService.listRequirements({ limit: 50, offset: 0 });
    const legoRow = rows.find((r) => r.moOperationId === f.moLegoOp.id)!;
    expect(legoRow).toBeDefined();
    expect(legoRow.proposalQuantity).toBe(4);
    expect(legoRow.openInquiries).toEqual([
      { id: inquiry.id, inquiryNumber: inquiry.inquiryNumber, status: "draft" },
    ]);
  });

  it("excludes a cancelled inquiry and an inquiry converted to a purchase order", async () => {
    const f = await releasedLegoMo(10);
    const cancelled = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 2, moOperationId: f.moLegoOp.id }] },
      f.user.id
    );
    await purchaseService.cancelInquiry(cancelled.inquiry.id);

    const ordered = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 3, moOperationId: f.moLegoOp.id }] },
      f.user.id
    );
    await purchaseService.sendInquiry(ordered.inquiry.id, f.user.id);
    await purchaseService.convertInquiryToOrder(ordered.inquiry.id, f.user.id);

    const { rows } = await planningService.listRequirements({ limit: 50, offset: 0 });
    const legoRow = rows.find((r) => r.moOperationId === f.moLegoOp.id)!;
    expect(legoRow).toBeDefined();
    // The ordered inquiry's PO row books 3 already-ordered, so the
    // operation's proposal shrinks — but that is orderedQuantity's doing,
    // never the inquiries list itself.
    expect(legoRow.proposalQuantity).toBe(7);
    expect(legoRow.openInquiries).toEqual([]);
  });

  it("is an empty array for an operation with no inquiries", async () => {
    const f = await releasedLegoMo(4);
    const { rows } = await planningService.listRequirements({ limit: 50, offset: 0 });
    const legoRow = rows.find((r) => r.moOperationId === f.moLegoOp.id)!;
    expect(legoRow).toBeDefined();
    expect(legoRow.openInquiries).toEqual([]);
  });
});

describe("planning service — createOrdersFromProposals", () => {
  it("groups purchase proposals into one draft IO per primary supplier with catalog prices", async () => {
    const user = await makeUser();
    const c1 = await makeArticle({ articleNumber: "GRP-C1" });
    const c2 = await makeArticle({ articleNumber: "GRP-C2" });
    const c3 = await makeArticle({ articleNumber: "GRP-C3" });
    await makeSupplierWithCatalog("Stål AB", [c1.id, c2.id], 25);
    await makeSupplierWithCatalog("Skruv AB", [c3.id], 0.5);

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: c1.id, quantity: 10, kind: "purchase" },
          { articleId: c2.id, quantity: 20, kind: "purchase" },
          { articleId: c3.id, quantity: 100, kind: "purchase" },
        ],
      },
      user.id
    );

    expect(result.errors).toEqual([]);
    expect(result.manufacturingOrders).toEqual([]);
    expect(result.purchaseOrders).toHaveLength(2);

    const stal = result.purchaseOrders.find((o) => o.supplierName === "Stål AB")!;
    expect(stal.rowCount).toBe(2);
    const stalOrder = await purchaseService.getPurchaseOrder(stal.id);
    expect(stalOrder!.status).toBe("draft");
    const stalRows = await purchaseService.listRows(stal.id);
    expect(stalRows).toHaveLength(2);
    expect(stalRows.map((r) => Number(r.unitPrice))).toEqual([25, 25]);
    expect(stalRows.map((r) => Number(r.quantityOrdered)).sort((x, y) => x - y)).toEqual([10, 20]);

    const skruv = result.purchaseOrders.find((o) => o.supplierName === "Skruv AB")!;
    expect(skruv.rowCount).toBe(1);
  });

  it("uses the staffel price matching the proposal quantity", async () => {
    const user = await makeUser();
    const c1 = await makeArticle({ articleNumber: "STF-C1" });
    const c2 = await makeArticle({ articleNumber: "STF-C2" });
    await makeSupplierWithCatalog("Stål AB", [c1.id, c2.id], 25, 7, [{ fromQuantity: 10, price: 20 }]);

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: c1.id, quantity: 10, kind: "purchase" },
          { articleId: c2.id, quantity: 5, kind: "purchase" },
        ],
      },
      user.id
    );

    expect(result.errors).toEqual([]);
    const rows = await purchaseService.listRows(result.purchaseOrders[0]!.id);
    const priceFor = (articleId: string) => Number(rows.find((r) => r.articleId === articleId)!.unitPrice);
    expect(priceFor(c1.id)).toBe(20); // at the break
    expect(priceFor(c2.id)).toBe(25); // below it: grundpriset
  });

  it("creates released manufacturing orders for manufacture proposals", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "MFG-1", type: "manufactured" });

    const result = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: m.id, quantity: 5, kind: "manufacture" }] },
      user.id
    );

    expect(result.errors).toEqual([]);
    expect(result.manufacturingOrders).toHaveLength(1);
    expect(result.manufacturingOrders[0]!.articleNumber).toBe("MFG-1");
    const mo = await mfgService.getManufacturingOrder(result.manufacturingOrders[0]!.id);
    expect(mo!.status).toBe("released");
    expect(Number(mo!.quantity)).toBe(5);
  });

  // Avrundning: an edited proposal quantity is rounded again by the order
  // services, so Skapa ordrar can never produce an un-rounded IO/TO.
  it("rounds edited proposal quantities up to the article's Avrundning on the created orders", async () => {
    const user = await makeUser();
    const c1 = await makeArticle({ articleNumber: "RND-C1", rounding: 5 });
    const m1 = await makeArticle({ articleNumber: "RND-M1", type: "manufactured", rounding: 10 });
    await makeSupplierWithCatalog("Stål AB", [c1.id], 25);

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: c1.id, quantity: 12, kind: "purchase" },
          { articleId: m1.id, quantity: 12, kind: "manufacture" },
        ],
      },
      user.id
    );

    expect(result.errors).toEqual([]);
    const rows = await purchaseService.listRows(result.purchaseOrders[0]!.id);
    expect(rows[0]!.quantityOrdered).toBe("15.0000");
    const mo = await mfgService.getManufacturingOrder(result.manufacturingOrders[0]!.id);
    expect(mo!.quantity).toBe("20.0000");
  });

  it("carries rounding on the requirement rows and rounds the proposal", async () => {
    const user = await makeUser();
    const a = await makeArticle({ articleNumber: "RND-REQ", rounding: 5 });
    await makeConfirmedSalesOrder(a.id, 12, user.id);

    const { rows } = await planningService.listRequirements({ limit: 50, offset: 0 });
    const row = rows.find((r) => r.articleId === a.id)!;
    expect(row.rounding).toBe(5);
    expect(row.proposalQuantity).toBe(15);
  });

  it("reports articles without a primary supplier as errors but creates the rest", async () => {
    const user = await makeUser();
    const withSupplier = await makeArticle({ articleNumber: "ERR-OK" });
    const withoutSupplier = await makeArticle({ articleNumber: "ERR-MISSING" });
    await makeSupplierWithCatalog("Alfa AB", [withSupplier.id]);

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: withSupplier.id, quantity: 3, kind: "purchase" },
          { articleId: withoutSupplier.id, quantity: 7, kind: "purchase" },
        ],
      },
      user.id
    );

    expect(result.purchaseOrders).toHaveLength(1);
    expect(result.errors).toEqual([
      { articleId: withoutSupplier.id, articleNumber: "ERR-MISSING", message: "Artikeln saknar huvudleverantör" },
    ]);
  });

  it("converges: after creating the proposed orders a re-run proposes nothing", async () => {
    const user = await makeUser();
    const fg = await makeArticle({ articleNumber: "CONV-FG", type: "manufactured" });
    const c = await makeArticle({ articleNumber: "CONV-C" });
    await makeSupplierWithCatalog("Alfa AB", [c.id]);
    await articleService.addBomComponent(fg.id, { componentArticleId: c.id, quantity: 2 });
    await makeConfirmedSalesOrder(fg.id, 5, user.id);

    const first = await planningService.listRequirements({ limit: 50, offset: 0 });
    const fgRow = first.rows.find((r) => r.articleNumber === "CONV-FG")!;
    const cRow = first.rows.find((r) => r.articleNumber === "CONV-C")!;
    expect(fgRow.proposalQuantity).toBe(5);
    expect(cRow.proposalQuantity).toBe(10); // derived: 5 x 2

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: fg.id, quantity: fgRow.proposalQuantity, kind: "manufacture" },
          { articleId: c.id, quantity: cRow.proposalQuantity, kind: "purchase" },
        ],
      },
      user.id
    );
    expect(result.errors).toEqual([]);

    // The planned TO now supplies fg AND (via one-level explosion) demands c;
    // the draft IO supplies c. Nothing left to propose.
    const second = await planningService.listRequirements({ limit: 50, offset: 0, showAll: true });
    for (const row of second.rows) {
      expect(row.proposalQuantity).toBe(0);
    }
    const cAfter = second.rows.find((r) => r.articleNumber === "CONV-C")!;
    expect(cAfter.demandMo).toBe(10);
    expect(cAfter.supplyPoDraft).toBe(10);
  });
});

// Färdigdatumsförslag — dates far in the future so "today" never clamps them.
// 2030-03-04 is a Monday: the working day before is Friday 2030-03-01.
describe("planning service — färdigdatumsförslag", () => {
  async function koFor(articleId: string, quantity: number, userId: string, date = "2030-03-04") {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    return salesService.createQuote(
      { customerId: customer.id, confirm: true, expectedDeliveryDate: date, rows: [{ articleId, quantity, unitPrice: 100 }] },
      userId
    );
  }

  it("suggests the working day before the first uncovered demand", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DD-1", type: "manufactured" });
    const ko = await koFor(m.id, 5, user.id);

    expect(await planningService.suggestManufacturingDueDate(m.id)).toMatchObject({
      dueDate: "2030-03-01",
      demandDate: "2030-03-04",
      source: "shortage",
      documentNumber: ko.order.orderNumber,
      clampedToToday: false,
    });
  });

  it("skips a full-day holiday from the register, but not a shortened day", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DD-2", type: "manufactured" });
    await koFor(m.id, 5, user.id);
    await db.execute(sql`INSERT INTO holidays (date, name) VALUES ('2030-03-01', 'Ledig fredag')`);
    expect((await planningService.suggestManufacturingDueDate(m.id))?.dueDate).toBe("2030-02-28");

    // A holiday WITH a day schedule is a shortened working day — not skipped.
    const code = `DD-${crypto.randomUUID().slice(0, 8)}`;
    await db.execute(sql`DELETE FROM holidays WHERE date = '2030-03-01'`);
    await db.execute(
      sql`INSERT INTO day_schedules (code, name, start_time, end_time) VALUES (${code}, 'Kortdag', '07:00', '12:00')`
    );
    await db.execute(
      sql`INSERT INTO holidays (date, name, day_schedule_id) SELECT '2030-03-01', 'Kortdag', id FROM day_schedules WHERE code = ${code}`
    );
    try {
      expect((await planningService.suggestManufacturingDueDate(m.id))?.dueDate).toBe("2030-03-01");
    } finally {
      await db.execute(sql`DELETE FROM holidays WHERE date = '2030-03-01'`);
      await db.execute(sql`DELETE FROM day_schedules WHERE code = ${code}`);
    }
  });

  it("gives no suggestion when stock covers every demand", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DD-3", type: "manufactured" });
    await koFor(m.id, 5, user.id);
    await addStock(m.id, 5);

    expect(await planningService.suggestManufacturingDueDate(m.id)).toBeNull();
  });

  it("uses the linked KO row's own date when that row is uncovered", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DD-4", type: "manufactured" });
    await koFor(m.id, 5, user.id); // earlier, also uncovered
    const later = await koFor(m.id, 5, user.id, "2030-03-11"); // Monday

    expect(
      await planningService.suggestManufacturingDueDate(m.id, { salesOrderRowId: later.rows[0]!.id })
    ).toMatchObject({ dueDate: "2030-03-08", source: "sales_order_row", documentNumber: later.order.orderNumber });
  });

  it("does not count a demand an existing TO already covers — even an undated one", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DD-7", type: "manufactured" });
    const ko = await koFor(m.id, 5, user.id);
    await mfgService.createManufacturingOrder({ articleId: m.id, quantity: 5 }, user.id); // no dueDate

    expect(await planningService.suggestManufacturingDueDate(m.id)).toBeNull();
    expect(await planningService.suggestManufacturingDueDate(m.id, { salesOrderRowId: ko.rows[0]!.id })).toBeNull();
  });

  it("throws ArticleNotFoundError for an unknown article", async () => {
    await expect(planningService.suggestManufacturingDueDate(crypto.randomUUID())).rejects.toBeInstanceOf(
      ArticleNotFoundError
    );
  });

  it("Skapa ordrar dates each TO, parents first so a component lands before its parent", async () => {
    const user = await makeUser();
    const parent = await makeArticle({ articleNumber: "DD-P", type: "manufactured" });
    const component = await makeArticle({ articleNumber: "DD-C", type: "manufactured" });
    await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2 });
    await koFor(parent.id, 3, user.id);

    // Component listed FIRST — the service must still create the parent first.
    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: component.id, quantity: 6, kind: "manufacture" },
          { articleId: parent.id, quantity: 3, kind: "manufacture" },
        ],
      },
      user.id
    );

    expect(result.errors).toEqual([]);
    const dueOf = async (articleNumber: string) => {
      const created = result.manufacturingOrders.find((o) => o.articleNumber === articleNumber)!;
      return (await mfgService.getManufacturingOrder(created.id))!.dueDate;
    };
    expect(await dueOf("DD-P")).toBe("2030-03-01"); // working day before the KO
    expect(await dueOf("DD-C")).toBe("2030-02-28"); // working day before the parent TO
  });

  it("Skapa ordrar leaves the date empty when there is no dated shortage", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DD-5", type: "manufactured" });

    const result = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: m.id, quantity: 2, kind: "manufacture" }] },
      user.id
    );
    expect((await mfgService.getManufacturingOrder(result.manufacturingOrders[0]!.id))!.dueDate).toBeNull();
  });

  it("Skapa ordrar dates the IO: the earliest need on the order, a later one on its own row", async () => {
    const user = await makeUser();
    const early = await makeArticle({ articleNumber: "DD-IO-A" });
    const late = await makeArticle({ articleNumber: "DD-IO-B" });
    await makeSupplierWithCatalog("Stål AB", [early.id, late.id]);
    await koFor(early.id, 4, user.id); // Mon 2030-03-04 → Fri 03-01
    await koFor(late.id, 4, user.id, "2030-03-11"); // Mon → Fri 03-08

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: early.id, quantity: 4, kind: "purchase" },
          { articleId: late.id, quantity: 4, kind: "purchase" },
        ],
      },
      user.id
    );

    expect(result.errors).toEqual([]);
    const io = result.purchaseOrders[0]!;
    expect((await purchaseService.getPurchaseOrder(io.id))!.expectedDeliveryDate).toBe("2030-03-01");
    const rows = await purchaseService.listRows(io.id);
    expect(rows.find((r) => r.articleId === early.id)!.expectedDeliveryDate).toBeNull(); // follows the order
    expect(rows.find((r) => r.articleId === late.id)!.expectedDeliveryDate).toBe("2030-03-08");
  });

  it("Skapa ordrar creates TOs before IOs, so a purchased component lands before its new parent TO", async () => {
    const user = await makeUser();
    const parent = await makeArticle({ articleNumber: "DD-IO-P", type: "manufactured" });
    const part = await makeArticle({ articleNumber: "DD-IO-C" });
    await articleService.addBomComponent(parent.id, { componentArticleId: part.id, quantity: 2 });
    await makeSupplierWithCatalog("Stål AB", [part.id]);
    await koFor(parent.id, 3, user.id);

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: [
          { articleId: part.id, quantity: 6, kind: "purchase" },
          { articleId: parent.id, quantity: 3, kind: "manufacture" },
        ],
      },
      user.id
    );

    expect(result.errors).toEqual([]);
    const mo = await mfgService.getManufacturingOrder(result.manufacturingOrders[0]!.id);
    expect(mo!.dueDate).toBe("2030-03-01");
    expect((await purchaseService.getPurchaseOrder(result.purchaseOrders[0]!.id))!.expectedDeliveryDate).toBe(
      "2030-02-28"
    );
  });

  it("the artikelöversikt dates an IO row by its own date, else the order's", async () => {
    const user = await makeUser();
    const a = await makeArticle({ articleNumber: "DD-OV-A" });
    const b = await makeArticle({ articleNumber: "DD-OV-B" });
    const supplier = await makeSupplierWithCatalog("Stål AB", [a.id, b.id]);
    const io = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, exchangeRate: 1, expectedDeliveryDate: "2030-03-04" },
      user.id
    );
    await purchaseService.addRow(io.id, { articleId: a.id, quantity: 1, unitPrice: 1, expectedDeliveryDate: "2030-05-01" });
    await purchaseService.addRow(io.id, { articleId: b.id, quantity: 1, unitPrice: 1 });

    const dateOf = async (articleId: string) =>
      (await planningService.getArticleOverview(articleId)).rows.find((r) => r.kind === "purchase_order")!.date;
    expect(await dateOf(a.id)).toBe("2030-05-01");
    expect(await dateOf(b.id)).toBe("2030-03-04");
  });

  it("KO → TO carries the dialog's färdigdatum onto the order", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DD-6", type: "manufactured" });
    const ko = await koFor(m.id, 4, user.id);

    const mo = await mfgService.createFromSalesOrderRow(ko.rows[0]!.id, { dueDate: "2030-03-01" }, user.id);
    expect(mo.dueDate).toBe("2030-03-01");
  });
});

describe("planning service — getArticleOverview", () => {
  // Component OV-C used ×2 by OV-P: stock, a confirmed KO, a confirmed and a
  // draft IO, a planned TO (exploded) and a released TO (snapshot row).
  async function overviewFixture() {
    const user = await makeUser();
    const c = await makeArticle({ articleNumber: "OV-C" });
    const p = await makeArticle({ articleNumber: "OV-P", type: "manufactured" });
    await articleService.addBomComponent(p.id, { componentArticleId: c.id, quantity: 2 });
    const supplier = await makeSupplierWithCatalog("Stål AB", [c.id], 10, 14);
    await addStock(c.id, 10);

    const customer = await salesService.createCustomer({ name: "Bygg AB", active: true });
    const ko = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        expectedDeliveryDate: "2026-10-01",
        rows: [{ articleId: c.id, quantity: 4, unitPrice: 100 }],
      },
      user.id
    );

    const io = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, exchangeRate: 1, expectedDeliveryDate: "2026-09-20" },
      user.id
    );
    await purchaseService.addRow(io.id, { articleId: c.id, quantity: 5, unitPrice: 10 });
    await purchaseService.confirm(io.id);

    const draft = await purchaseService.createPurchaseOrder({ supplierId: supplier.id, exchangeRate: 1 }, user.id);
    await purchaseService.addRow(draft.id, { articleId: c.id, quantity: 3, unitPrice: 10 });

    // An older TO still in planned (new ones are released at creation).
    const planned = await insertPlannedManufacturingOrder({ articleId: p.id, quantity: 3, dueDate: "2026-09-25", createdBy: user.id });
    const released = await mfgService.createManufacturingOrder(
      { articleId: p.id, quantity: 2, dueDate: "2026-09-15" },
      user.id
    );

    return { user, c, p, ko, io, draft, planned, released };
  }

  it("lists every open row for the article in date order with a running balance", async () => {
    const f = await overviewFixture();

    const overview = await planningService.getArticleOverview(f.c.id);

    expect(overview.article).toMatchObject({ articleId: f.c.id, articleNumber: "OV-C", type: "purchased" });
    expect(overview.primarySupplier).toMatchObject({ supplierName: "Stål AB", leadTimeDays: 14 });
    expect(overview.onHand).toBe(10);
    expect(overview.rows.map((r) => [r.kind, r.date, r.quantity, r.balance])).toEqual([
      ["mo_material", "2026-09-15", -4, 6],
      ["purchase_order", "2026-09-20", 5, 11],
      ["mo_planned_material", "2026-09-25", -6, 5],
      ["sales_order", "2026-10-01", -4, 1],
      ["purchase_order", null, 3, 4],
    ]);
    expect(overview.closingBalance).toBe(4);

    const [material, confirmedIo, plannedMaterial, sales, draftIo] = overview.rows;
    expect(material).toMatchObject({
      documentType: "manufacturing_order",
      documentId: f.released.id,
      documentNumber: f.released.orderNumber,
      partner: "OV-P — OV-P",
      isDraft: false,
    });
    expect(confirmedIo).toMatchObject({
      documentType: "purchase_order",
      documentId: f.io.id,
      documentNumber: f.io.orderNumber,
      partner: "Stål AB",
      status: "confirmed",
      isDraft: false,
    });
    expect(plannedMaterial).toMatchObject({
      documentType: "manufacturing_order",
      documentId: f.planned.id,
      documentNumber: f.planned.orderNumber,
      partner: "OV-P — OV-P",
      status: "planned",
    });
    expect(sales).toMatchObject({
      documentType: "sales_order",
      documentId: f.ko.order.id,
      documentNumber: f.ko.order.orderNumber,
      partner: "Bygg AB",
      status: "confirmed",
    });
    expect(draftIo).toMatchObject({ documentId: f.draft.id, status: "draft", isDraft: true });
  });

  it("closes on the behovsberäkning's projected balance for the same article", async () => {
    const f = await overviewFixture();

    const overview = await planningService.getArticleOverview(f.c.id);
    const { rows } = await planningService.listRequirements({ limit: 50, offset: 0, showAll: true, search: "OV-C" });
    const mrpRow = rows.find((r) => r.articleId === f.c.id)!;

    expect(mrpRow).toBeDefined();
    expect(overview.closingBalance).toBe(mrpRow.projected - mrpRow.demandDerived);
  });

  // Delinleverans: the received part of an open TO is already stock — only
  // the remainder is still supply, or those units would count twice.
  it("counts only an open TO's unreceived remainder as supply, in the overview and the behovsberäkning alike", async () => {
    const user = await makeUser();
    const p = await makeArticle({ articleNumber: "DEL-P", type: "manufactured" });
    const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
    await mfgService.createRoutingOperation(p.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 1, runTimePerUnit: 1 });
    await makeConfirmedSalesOrder(p.id, 12, user.id);
    const mo = await mfgService.createManufacturingOrder({ articleId: p.id, quantity: 10, dueDate: "2026-09-15" }, user.id);
    const [op] = await mfgService.listOperations(mo.id);
    await mfgService.reportOperationQuantities(op!.id, { quantityOk: 4, quantityScrapped: 0, markDone: false, createdBy: user.id });

    const overview = await planningService.getArticleOverview(p.id);
    expect(overview.onHand).toBe(4);
    expect(overview.rows.filter((r) => r.kind === "manufacturing_order").map((r) => r.quantity)).toEqual([6]);
    expect(overview.closingBalance).toBe(-2); // 4 on hand + 6 to come − 12 ordered

    const { rows } = await planningService.listRequirements({ limit: 50, offset: 0, showAll: true, search: "DEL-P", refresh: true });
    const row = rows.find((r) => r.articleId === p.id)!;
    expect([row.supplyMo, row.projected, row.proposalQuantity]).toEqual([6, -2, 2]);
  });

  it("shows the parent's own open TOs as supply and ignores lego IO rows", async () => {
    const f = await releasedLegoMo(4);
    const legoIo = await purchaseService.createPurchaseOrder({ supplierId: f.supplier.id, exchangeRate: 1 }, f.user.id);
    await purchaseService.addRow(legoIo.id, {
      articleId: f.parent.id,
      quantity: 4,
      unitPrice: 100,
      moOperationId: f.moLegoOp.id,
    });

    const overview = await planningService.getArticleOverview(f.parent.id);

    expect(overview.rows.map((r) => [r.kind, r.quantity])).toEqual([["manufacturing_order", 4]]);
    expect(overview.closingBalance).toBe(4);
  });

  it("throws ArticleNotFoundError for an unknown article", async () => {
    await expect(planningService.getArticleOverview(crypto.randomUUID())).rejects.toBeInstanceOf(
      ArticleNotFoundError
    );
  });
});

// Leveranstidskontroll loads the overviews of a whole BOM tree in ONE batch
// (getArticleOverviews, a fixed number of queries + one delivery context).
// It must be indistinguishable from getArticleOverview per article —
// including the KO rows' shift to the ship date.
describe("planning service — getArticleOverviews (batch)", () => {
  it("matches getArticleOverview per article: stock, IO, TO material, planned TO, KO at a customer with transit days", async () => {
    const user = await makeUser();
    const c = await makeArticle({ articleNumber: "BAT-C" });
    const d = await makeArticle({ articleNumber: "BAT-D" });
    const p = await makeArticle({ articleNumber: "BAT-P", type: "manufactured" });
    const empty = await makeArticle({ articleNumber: "BAT-E" });
    await articleService.addBomComponent(p.id, { componentArticleId: c.id, quantity: 2 });
    await articleService.addBomComponent(p.id, { componentArticleId: d.id, quantity: 1 });
    const supplier = await makeSupplierWithCatalog("Stål AB", [c.id, d.id], 10, 14);
    await addStock(c.id, 10);
    await addStock(d.id, 3);

    // KO at a customer with 2 transit days: Thursday 2026-10-01 ⇒ ships
    // Tuesday 2026-09-29. Two rows (component and parent) on one order.
    const customer = await salesService.createCustomer({
      name: "Bygg AB",
      active: true,
      deliveryDayMode: "dispatch",
      transitDays: 2,
    });
    await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        expectedDeliveryDate: "2026-10-01",
        rows: [
          { articleId: c.id, quantity: 4, unitPrice: 100 },
          { articleId: p.id, quantity: 1, unitPrice: 500 },
        ],
      },
      user.id
    );
    const io = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, exchangeRate: 1, expectedDeliveryDate: "2026-09-20" },
      user.id
    );
    await purchaseService.addRow(io.id, { articleId: c.id, quantity: 5, unitPrice: 10 });
    await purchaseService.addRow(io.id, { articleId: d.id, quantity: 1, unitPrice: 10 });
    await purchaseService.confirm(io.id);
    // A planned TO (exploded through the BOM) and a released one (snapshot rows).
    await insertPlannedManufacturingOrder({ articleId: p.id, quantity: 3, dueDate: "2026-09-25", createdBy: user.id });
    await mfgService.createManufacturingOrder({ articleId: p.id, quantity: 2, dueDate: "2026-09-15" }, user.id);

    const ids = [c.id, d.id, p.id, empty.id];
    const batch = await planningService.getArticleOverviews([...ids, crypto.randomUUID()]);

    // An unknown id is left out; every known one equals the single read.
    expect([...batch.keys()].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(batch.get(id)).toEqual(await planningService.getArticleOverview(id));

    // Not vacuous: the batch carries the real rows, partitioned per
    // article, with the KO rows on the ship date.
    expect(batch.get(c.id)!.rows.map((r) => [r.kind, r.date, r.quantity, r.balance])).toEqual([
      ["mo_material", "2026-09-15", -4, 6],
      ["purchase_order", "2026-09-20", 5, 11],
      ["mo_planned_material", "2026-09-25", -6, 5],
      ["sales_order", "2026-09-29", -4, 1],
    ]);
    expect(batch.get(c.id)!.primarySupplier).toMatchObject({ supplierName: "Stål AB", leadTimeDays: 14 });
    expect(batch.get(d.id)!.rows.map((r) => [r.kind, r.date, r.quantity, r.balance])).toEqual([
      ["mo_material", "2026-09-15", -2, 1],
      ["purchase_order", "2026-09-20", 1, 2],
      ["mo_planned_material", "2026-09-25", -3, -1],
    ]);
    expect(batch.get(p.id)!.rows.map((r) => [r.kind, r.date, r.quantity])).toEqual([
      ["manufacturing_order", "2026-09-15", 2],
      ["manufacturing_order", "2026-09-25", 3],
      ["sales_order", "2026-09-29", -1],
    ]);
    expect(batch.get(p.id)!.primarySupplier).toBeNull();
    expect(batch.get(empty.id)).toMatchObject({ onHand: 0, rows: [], closingBalance: 0 });
    expect(await planningService.getArticleOverviews([])).toEqual(new Map());
  });
});

// Fasta leveransdagar: a sales order's date is the day the customer gets the
// goods — the overview and the färdigdatumsförslag plan by the SHIP date.
// 2030-03-04 is a Monday, 2030-03-06 a Wednesday.
describe("planning service — kundorderns behov på avsändningsdagen", () => {
  async function koWith(articleId: string, userId: string, date: string, customerFields: Record<string, unknown> = {}) {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true, ...customerFields });
    return salesService.createQuote(
      { customerId: customer.id, confirm: true, expectedDeliveryDate: date, rows: [{ articleId, quantity: 5, unitPrice: 100 }] },
      userId
    );
  }
  const koRowDate = async (articleId: string) =>
    (await planningService.getArticleOverview(articleId)).rows.find((r) => r.documentType === "sales_order")?.date;

  it("a customer without settings keeps the delivery date", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "SHIP-1", type: "manufactured" });
    await koWith(m.id, user.id, "2030-03-06");
    expect(await koRowDate(m.id)).toBe("2030-03-06");
    expect((await planningService.suggestManufacturingDueDate(m.id))?.dueDate).toBe("2030-03-05");
  });

  it("transit days move the KO row to the ship date", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "SHIP-2", type: "manufactured" });
    await koWith(m.id, user.id, "2030-03-06", { deliveryDayMode: "dispatch", transitDays: 2 });
    expect(await koRowDate(m.id)).toBe("2030-03-04");
    expect(await planningService.suggestManufacturingDueDate(m.id)).toMatchObject({
      demandDate: "2030-03-04",
      dueDate: "2030-03-01",
    });
  });

  it("the customer's dispatch days pick the last dispatch that arrives in time", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "SHIP-3", type: "manufactured" });
    // Ships Tuesdays, 1 transit day: Tuesday 5 + 1 = Wednesday 6.
    await koWith(m.id, user.id, "2030-03-08", { deliveryWeekdays: [2], deliveryDayMode: "dispatch", transitDays: 1 });
    expect(await koRowDate(m.id)).toBe("2030-03-05");
  });

  // Stored dates predate the 1900–2999 bound: the holiday window is clamped
  // so the overview never asks Postgres for a "+010000-…" date (a 500).
  it("a stored delivery date at the end of the calendar does not break the overview", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "SHIP-9999", type: "manufactured" });
    // Friday 9999-12-31, two transit days ⇒ Wednesday.
    await koWith(m.id, user.id, "9999-12-31", { deliveryDayMode: "dispatch", transitDays: 2 });
    expect(await koRowDate(m.id)).toBe("9999-12-29");
  });

  it("the default transit shifts a customer without own settings, across the weekend", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "SHIP-4", type: "manufactured" });
    await koWith(m.id, user.id, "2030-03-04");
    await db.execute(
      sql`INSERT INTO system_settings (key, value) VALUES ('customer_transit_days', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    try {
      expect(await koRowDate(m.id)).toBe("2030-03-01");
    } finally {
      await db.execute(sql`DELETE FROM system_settings WHERE key = 'customer_transit_days'`);
    }
  });
});

// Leveranstidskontroll against the database. Today is pinned to Monday
// 2030-03-04 so the weeks are deterministic: week 10 = 4–10 March, week 11
// = 11–17, week 12 = 18–24.
describe("planning service — leveranstidskontroll", () => {
  const scheduleService = createScheduleService(createScheduleRepository(db), createTimeReportRepository(db), {
    isDateLocked: async () => false,
  });
  const pinned = createPlanningService(createPlanningRepository(db), {
    purchase: purchaseService,
    manufacturing: mfgService,
    requirementsCacheMs: 0,
    today: () => "2030-03-04",
  });

  async function world() {
    const user = await makeUser();
    const day = await scheduleService.createDaySchedule({
      code: "D8",
      name: "Dagtid 8h",
      startTime: "07:00",
      endTime: "15:00",
      breaks: [],
      active: true,
    });
    const week = await scheduleService.createWeekSchedule({
      code: "VS40",
      name: "Veckoschema 40h",
      days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, dayScheduleId: day.id })),
      active: true,
    });
    const press = await mfgService.createWorkCenter({ code: "110", name: "Kantpress", weekScheduleId: week.id, active: true });
    const p = await makeArticle({ articleNumber: "DTC-P" });
    await makeSupplierWithCatalog("Stål AB", [p.id], 10, 5);
    const m = await makeArticle({ articleNumber: "DTC-M", type: "manufactured" });
    await articleService.addBomComponent(m.id, { componentArticleId: p.id, quantity: 2 });
    await mfgService.createRoutingOperation(m.id, { sequenceNo: 10, workCenterId: press.id, setupTime: 0, runTimePerUnit: 60 });
    // Someone else's TO: 38 h on the press in week 11.
    const x = await makeArticle({ articleNumber: "DTC-X", type: "manufactured" });
    await mfgService.createRoutingOperation(x.id, { sequenceNo: 10, workCenterId: press.id, setupTime: 38 * 60, runTimePerUnit: 0 });
    await mfgService.createManufacturingOrder({ articleId: x.id, quantity: 1, dueDate: "2030-03-13" }, user.id);
    // Three in stock, already promised to a KO.
    await addStock(m.id, 3);
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const ko = await salesService.createQuote(
      { customerId: customer.id, confirm: true, expectedDeliveryDate: "2030-03-20", rows: [{ articleId: m.id, quantity: 3, unitPrice: 100 }] },
      user.id
    );
    return { m, ko, customer };
  }

  it("material lead time and a busy press decide the date; the KO already owns the stock", async () => {
    const { m } = await world();
    const result = await pinned.checkDeliveryTime({ rows: [{ articleId: m.id, quantity: 3 }] });
    // P: Monday 4 + 5 working days = Monday 11. The press has 2 h left in
    // week 11 and the last hour goes in week 12 (ready Friday 22).
    expect(result.rows[0]!.chain.map((s) => s.kind)).toEqual(["purchase", "operation"]);
    expect(result.rows[0]!.chain[1]).toMatchObject({ fromWeek: "2030-03-11", toWeek: "2030-03-18", date: "2030-03-22" });
    expect(result).toMatchObject({ shipDate: "2030-03-25", deliveryDate: "2030-03-25" });
  });

  it("checking the order itself: its own rows are not existing demand", async () => {
    const { ko } = await world();
    const result = await pinned.checkDeliveryTime({ salesOrderId: ko.order.id });
    expect(result.rows[0]!.chain).toEqual([{ kind: "stock", articleNumber: "DTC-M", quantity: 3, date: "2030-03-04" }]);
    expect(result.shipDate).toBe("2030-03-04");
  });

  it("the customer's transit days follow the ship date", async () => {
    const { m } = await world();
    const customer = await salesService.createCustomer({ name: "Långt bort AB", active: true, deliveryDayMode: "dispatch", transitDays: 2 });
    const result = await pinned.checkDeliveryTime({ customerId: customer.id, rows: [{ articleId: m.id, quantity: 3 }] });
    expect(result).toMatchObject({ shipDate: "2030-03-25", deliveryDate: "2030-03-27" });
  });

  it("a quote is checked, a cancelled order is refused", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "DTC-Q", type: "manufactured" });
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const quote = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: m.id, quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect((await pinned.checkDeliveryTime({ salesOrderId: quote.order.id })).rows).toHaveLength(1);
    await salesService.cancel(quote.order.id, user.id);
    await expect(pinned.checkDeliveryTime({ salesOrderId: quote.order.id })).rejects.toBeInstanceOf(SalesOrderNotOpenError);
  });

  it("unknown article and customer are refused", async () => {
    await expect(pinned.checkDeliveryTime({ rows: [{ articleId: crypto.randomUUID(), quantity: 1 }] })).rejects.toBeInstanceOf(
      ArticleNotFoundError
    );
    const { m } = await world();
    await expect(
      pinned.checkDeliveryTime({ customerId: crypto.randomUUID(), rows: [{ articleId: m.id, quantity: 1 }] })
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
  });
});
