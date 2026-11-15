// Bakdaterade lagerrörelser (#19): Lagerjustering and inleverans may be
// booked per an earlier day (Bokför per). The row counts at that day's end in
// everything "as of a date", the registration time is kept, and the day must
// be open for bookkeeping with no count or imported balance on the place
// that day or later. The REAL period reader (economy's postingPeriodLockOn)
// is wired in as app.ts does; the last block proves app.ts itself.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createArticleSchema,
  createPurchaseOrderSchema,
  createStockLocationSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  listGoodsReceiptsQuerySchema,
  listPurchaseInvoiceBasisQuerySchema,
} from "@navet/shared";
import { accountingPeriods, articleStandardCostHistory, auditLog, db, fiscalYears, purchaseOrderRows, purchaseReceipts, stockCountSessions, stockTransactions } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { postingPeriodLockOn } from "../src/modules/economy/service/verification-poster.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService, PurchaseReceiptBackdateLegoError } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import {
  backdatedDay,
  backdatedInstant,
  STOCK_IMPORT_NOTE,
  StockBackdateInFutureError,
  StockBackdateRefusedError,
} from "../src/modules/stock/service/backdating.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createValuationService } from "../src/modules/stock/service/valuation.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { addDays, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createCalendarYear, createUser, resetYearEnd } from "./helpers/year-end.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

const periods = { lockOn: postingPeriodLockOn };
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db, periods));
const countRepo = createStockCountRepository(db, periods);
const valuation = createValuationService({ db });
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const purchaseRepo = createPurchaseRepository(db, periods);
const purchaseService = createPurchaseService(
  purchaseRepo,
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  createAuditRepository(db)
);

const TABLES = sql`TRUNCATE audit_log, purchase_receipts, mo_reports, purchase_order_rows, purchase_orders, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_count_rows, stock_count_sessions, stock_transactions, stock_locations, warehouses, bom_components, article_standard_cost_history, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
  await resetYearEnd();
});
afterAll(async () => {
  await db.execute(TABLES);
  await resetYearEnd();
});

const DAY = "2025-12-31";
// The end of 2025-12-31 in Stockholm (UTC+1 in winter).
const END_OF_DAY = "2025-12-31T22:59:59.999Z";

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  return stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true }));
}

async function makeArticle(type: "purchased" | "service" = "purchased", standardCost?: number) {
  return articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `BAK-${crypto.randomUUID()}`,
    name: "Plåt",
    type,
    active: true,
    ...(standardCost !== undefined ? { standardCost } : {}),
  }));
}

async function rowsOf(articleId: string) {
  return db.select().from(stockTransactions).where(eq(stockTransactions.articleId, articleId));
}

async function quantityAsOf(asOf: string, articleId: string) {
  const report = await valuation.getValuation({ asOf, method: "standard" });
  const row = report.groups.flatMap((g) => g.rows).find((r) => r.articleId === articleId);
  return row?.quantity ?? 0;
}

async function lockDecember2025() {
  const year = await createCalendarYear(2025);
  await db
    .update(accountingPeriods)
    .set({ status: "locked" })
    .where(and(eq(accountingPeriods.fiscalYearId, year.id), eq(accountingPeriods.startDate, "2025-12-01")));
  return year;
}

describe("the day and the moment (pure)", () => {
  it("books nothing earlier for no day or today, and refuses a later day", () => {
    expect(backdatedDay(undefined, "2026-11-15")).toBeNull();
    expect(backdatedDay("2026-11-15", "2026-11-15")).toBeNull();
    expect(backdatedDay("2026-11-14", "2026-11-15")).toBe("2026-11-14");
    expect(() => backdatedDay("2026-11-16", "2026-11-15")).toThrow(StockBackdateInFutureError);
  });

  it("is the last millisecond of the Stockholm day, also on the switch days", () => {
    expect(backdatedInstant("2025-12-31").toISOString()).toBe(END_OF_DAY);
    expect(backdatedInstant("2026-06-30").toISOString()).toBe("2026-06-30T21:59:59.999Z");
    // Spring forward (29 March) and fall back (25 October) 2026.
    expect(backdatedInstant("2026-03-29").toISOString()).toBe("2026-03-29T21:59:59.999Z");
    expect(backdatedInstant("2026-10-25").toISOString()).toBe("2026-10-25T22:59:59.999Z");
  });
});

describe("Lagerjustering per an earlier day", () => {
  it("counts at the day's end, keeps the registration time and takes the standard cost of then", async () => {
    const location = await makeLocation();
    const article = await makeArticle("purchased", 10);
    // 10 kr was valid from before the day; 12 came after it.
    await db
      .update(articleStandardCostHistory)
      .set({ validFrom: new Date("2025-12-01T00:00:00Z") })
      .where(eq(articleStandardCostHistory.articleId, article.id));
    await articleService.updateStandardCost(article.id, 12);

    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 5, transactionType: "inventory_adjustment", valuedOn: DAY });
    const [row] = await rowsOf(article.id);
    expect(row!.valuedAt!.toISOString()).toBe(END_OF_DAY);
    expect(row!.createdAt.getTime()).toBeGreaterThan(new Date(END_OF_DAY).getTime());
    expect(row!.unitCost).toBe("10.0000");

    expect(await quantityAsOf(DAY, article.id)).toBe(5);
    expect(await quantityAsOf("2025-12-30", article.id)).toBe(0);

    // A decrease per an earlier day is valued then too (no cost on an outflow).
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: -2, transactionType: "inventory_adjustment", valuedOn: "2026-01-10" });
    expect(await quantityAsOf("2026-01-09", article.id)).toBe(5);
    expect(await quantityAsOf("2026-01-10", article.id)).toBe(3);
  });

  it("registers today's day as now and refuses a later day before booking anything", async () => {
    const location = await makeLocation();
    const article = await makeArticle("purchased", 10);
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment", valuedOn: stockholmToday() });
    const [today] = await rowsOf(article.id);
    expect(today!.valuedAt).toBeNull();
    // Today's standard cost as before.
    expect(today!.unitCost).toBe("10.0000");

    await expect(
      stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment", valuedOn: addDays(stockholmToday(), 1) })
    ).rejects.toThrow(StockBackdateInFutureError);
    expect(await rowsOf(article.id)).toHaveLength(1);
  });

  it("is refused in a locked period and a closed year, allowed in an open period", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    const year = await lockDecember2025();

    const locked = await stockService
      .recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment", valuedOn: "2025-12-15" })
      .catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(StockBackdateRefusedError);
    expect(locked).toMatchObject({ reason: "period_locked" });
    expect((locked as Error).message).toBe("Lagerrörelsen kan inte bokföras per 2025-12-15: Bokföringsperioden för 2025-12-15 är låst. Registrera den per i dag i stället.");

    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment", valuedOn: "2025-11-30" });
    expect(await rowsOf(article.id)).toHaveLength(1);

    const user = await createUser();
    await db.update(fiscalYears).set({ status: "closed", closedAt: new Date(), closedBy: user.id }).where(eq(fiscalYears.id, year.id));
    await expect(
      stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment", valuedOn: "2025-11-30" })
    ).rejects.toMatchObject({ reason: "year_closed" });
    expect(await rowsOf(article.id)).toHaveLength(1);
  });

  it("is refused when the place was counted that day or later — open or posted, and only for a counted row", async () => {
    const location = await makeLocation();
    const other = await makeLocation("B1");
    const article = await makeArticle();
    const untouched = await makeArticle();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    await stockService.recordTransaction({ articleId: untouched.id, locationId: location.id, quantityDelta: 4, transactionType: "inventory_adjustment" });

    // An open count frozen on 2026-01-15 (it seeded both articles' rows).
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    await db.update(stockCountSessions).set({ createdAt: new Date("2026-01-15T09:00:00Z") }).where(eq(stockCountSessions.id, session.id));
    const backdate = (articleId: string, valuedOn: string, locationId = location.id) =>
      stockService.recordTransaction({ articleId, locationId, quantityDelta: 1, transactionType: "inventory_adjustment", valuedOn });

    const refused = await backdate(article.id, "2026-01-15").catch((e: unknown) => e);
    expect(refused).toMatchObject({ reason: "counted" });
    expect((refused as Error).message).toContain(`inventerats på lagerplatsen 2026-01-15 (${session.countNumber})`);
    await expect(backdate(article.id, "2026-01-10")).rejects.toMatchObject({ reason: "counted" });
    // After the freeze, and on another place, the count is not in the way.
    await backdate(article.id, "2026-01-16");
    await backdate(article.id, "2026-01-10", other.id);

    // Posted: only the counted row stands in the way.
    const detail = await countRepo.getSession(session.id);
    const row = detail!.rows.find((r) => r.articleId === article.id)!;
    await countRepo.updateRow(session.id, row.id, { countedQuantity: 10 });
    await countRepo.postSession(session.id, null, "today");
    await expect(backdate(article.id, "2026-01-10")).rejects.toMatchObject({ reason: "counted" });
    await backdate(untouched.id, "2026-01-10");

    // A cancelled count is no count.
    await stockService.recordTransaction({ articleId: untouched.id, locationId: other.id, quantityDelta: 2, transactionType: "inventory_adjustment" });
    const cancelled = await countRepo.createSession({ locationId: other.id, blocksTransactions: false }, null);
    await countRepo.cancelSession(cancelled.id);
    await backdate(untouched.id, "2026-01-10", other.id);
  });

  it("is refused before an imported balance on the place", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 7, transactionType: "inventory_adjustment", note: STOCK_IMPORT_NOTE });
    const refused = await stockService
      .recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 1, transactionType: "inventory_adjustment", valuedOn: addDays(stockholmToday(), -1) })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ reason: "imported" });
    expect((refused as Error).message).toContain(`fick ett importerat lagersaldo på lagerplatsen ${stockholmToday()}`);
  });
});

// A confirmed IO with one row of the given article.
async function makeOrder(type: "purchased" | "service" = "purchased", quantity = 10) {
  const user = await createUser();
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "ACME AB", active: true }));
  const article = await makeArticle(type);
  const location = await makeLocation();
  const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id, expectedDeliveryDate: "2025-12-20" }), user.id);
  const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity, unitPrice: 42 });
  await purchaseService.confirm(order.id);
  return { user, supplier, article, location, order, row };
}

describe("Inleverans per an earlier day", () => {
  it("values the goods then and counts them as received then — every receipt reader follows", async () => {
    const { user, article, location, order, row } = await makeOrder();
    const received = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 10, receivedOn: DAY }, user.id);

    const [stockRow] = await rowsOf(article.id);
    expect(stockRow!.valuedAt!.toISOString()).toBe(END_OF_DAY);
    expect(stockRow!.unitCost).toBe("42.0000");
    const [receipt] = await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.id, received.receiptId));
    expect(receipt!.receivedAt!.toISOString()).toBe(END_OF_DAY);
    expect(receipt!.createdAt.getTime()).toBeGreaterThan(new Date(END_OF_DAY).getTime());

    expect(await quantityAsOf(DAY, article.id)).toBe(10);
    expect(await quantityAsOf("2025-12-30", article.id)).toBe(0);

    // The IO card's Inleveranser, the article's inleveranslogg, the
    // fakturaunderlag's Inlevererad and the leveransprecision.
    const [listed] = await purchaseService.listReceipts(order.id);
    expect(listed!.receivedAt.toISOString()).toBe(END_OF_DAY);
    expect(listed!.createdAt.toISOString()).toBe(receipt!.createdAt.toISOString());
    const log = await purchaseService.listArticleGoodsReceipts(article.id, parsed(listGoodsReceiptsQuerySchema, { articleId: article.id }));
    expect(log.rows[0]!.date.toISOString()).toBe(END_OF_DAY);
    const basis = await purchaseService.listInvoiceBasis(parsed(listPurchaseInvoiceBasisQuerySchema, {}));
    expect(new Date(basis.rows.find((o) => o.id === order.id)!.receivedAt!).toISOString()).toBe(END_OF_DAY);
    const precision = await createReportsRepository(db).loadPurchasePrecisionOrders();
    expect(precision.find((p) => p.orderId === order.id)!.completedAt).toBe(END_OF_DAY);

    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "goods_received"));
    expect(audit!.detail).toMatchObject({ receivedOn: DAY });
  });

  it("orders the IO card's receipts by the day the goods arrived", async () => {
    const { user, location, order, row } = await makeOrder();
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 3, receivedOn: "2026-01-20" }, user.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 2, receivedOn: "2026-01-05" }, user.id);
    const listed = await purchaseService.listReceipts(order.id);
    expect(listed.map((r) => Number(r.quantity))).toEqual([3, 2]);
  });

  it("dates a service row's receipt without a stock row, and refuses a locked day for it too", async () => {
    const { user, article, order, row } = await makeOrder("service");
    await purchaseService.receiveGoods(order.id, row.id, { quantity: 4, receivedOn: "2026-01-05" }, user.id);
    const [receipt] = await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.purchaseOrderId, order.id));
    expect(receipt!.receivedAt!.toISOString()).toBe(backdatedInstant("2026-01-05").toISOString());
    expect(receipt!.stockTransactionId).toBeNull();
    expect(await rowsOf(article.id)).toHaveLength(0);

    await lockDecember2025();
    await expect(purchaseService.receiveGoods(order.id, row.id, { quantity: 1, receivedOn: "2025-12-20" }, user.id)).rejects.toMatchObject({ reason: "period_locked" });
    const [after] = await db.select({ received: purchaseOrderRows.quantityReceived }).from(purchaseOrderRows).where(eq(purchaseOrderRows.id, row.id));
    expect(after!.received).toBe("4.0000");
  });

  it("refuses a later day, a locked day and a counted place before anything is booked", async () => {
    const { user, article, location, order, row } = await makeOrder();
    await expect(
      purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 1, receivedOn: addDays(stockholmToday(), 1) }, user.id)
    ).rejects.toThrow(StockBackdateInFutureError);

    await lockDecember2025();
    await expect(
      purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 1, receivedOn: "2025-12-20" }, user.id)
    ).rejects.toMatchObject({ reason: "period_locked" });

    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 2, transactionType: "inventory_adjustment" });
    const session = await countRepo.createSession({ locationId: location.id, blocksTransactions: false }, null);
    await db.update(stockCountSessions).set({ createdAt: new Date("2026-01-15T09:00:00Z") }).where(eq(stockCountSessions.id, session.id));
    await expect(
      purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 1, receivedOn: "2026-01-10" }, user.id)
    ).rejects.toMatchObject({ reason: "counted" });

    expect(await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.purchaseOrderId, order.id))).toHaveLength(0);
    const [after] = await db.select({ received: purchaseOrderRows.quantityReceived }).from(purchaseOrderRows).where(eq(purchaseOrderRows.id, row.id));
    expect(after!.received).toBe("0.0000");
  });

  it("undoes a backdated receipt today, like any other undo", async () => {
    const { user, article, location, order, row } = await makeOrder();
    const received = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 10, receivedOn: DAY }, user.id);
    await purchaseService.undoReceipt(order.id, received.receiptId, user.id);
    const reversal = (await rowsOf(article.id)).find((r) => Number(r.quantityDelta) < 0)!;
    expect(reversal.valuedAt).toBeNull();
    expect(await quantityAsOf(DAY, article.id)).toBe(10);
    expect(await quantityAsOf(stockholmToday(), article.id)).toBe(0);
  });
});

// Manufactured article whose last operation is a lego operation, with an IO
// row buying that operation.
async function makeLegoOrder() {
  const user = await createUser();
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "Lego AB", active: true }));
  const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", type: "machine", active: true }));
  const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling AB", type: "subcontract", supplierId: supplier.id, active: true }));
  const parent = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `LEGO-${crypto.randomUUID()}`, name: "Legodetalj", type: "manufactured", active: true }));
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0, unitPrice: 100 });
  const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, user.id);
  const legoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;
  const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), user.id);
  const row = await purchaseService.addRow(order.id, { articleId: parent.id, quantity: 4, unitPrice: 100, moOperationId: legoOp.id });
  await purchaseService.confirm(order.id);
  return { user, order, row };
}

describe("Inleverans per an earlier day — lego row", () => {
  it("is refused before anything is booked, in the service and again under the row lock", async () => {
    const { user, order, row } = await makeLegoOrder();
    await expect(purchaseService.receiveGoods(order.id, row.id, { quantity: 4, receivedOn: "2026-01-05" }, user.id)).rejects.toThrow(
      PurchaseReceiptBackdateLegoError
    );
    expect(await purchaseRepo.receiveGoods(order.id, row.id, { quantity: 4, createdBy: user.id, overReceiptPercent: null, receivedOn: "2026-01-05" })).toEqual({
      ok: false,
      reason: "backdate_lego",
    });
    expect(await db.select().from(purchaseReceipts).where(eq(purchaseReceipts.purchaseOrderId, order.id))).toHaveLength(0);
    // Today is fine — the receipt reports the operation as before.
    const today = await purchaseService.receiveGoods(order.id, row.id, { quantity: 4, receivedOn: stockholmToday() }, user.id);
    expect(today.operationReport).toEqual({ ok: true });
  });
});

describe("the routes (app.ts wiring)", () => {
  const PASSWORD = "ett-tillräckligt-långt-lösenord";
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  it("answer 400 for a later day and 409 for a locked one, on both writers", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
    });
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
    const post = (url: string, payload: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });

    const { article, location, order, row } = await makeOrder();
    await lockDecember2025();

    const future = await post("/stock/transactions", { articleId: article.id, locationId: location.id, quantityDelta: 1, valuedOn: addDays(stockholmToday(), 1) });
    expect(future.statusCode).toBe(400);
    expect(future.json().code).toBe("stock-backdate-in-future");
    const locked = await post("/stock/transactions", { articleId: article.id, locationId: location.id, quantityDelta: 1, valuedOn: "2025-12-15" });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().code).toBe("stock-backdate-refused");
    const receipt = await post(`/purchase-orders/${order.id}/rows/${row.id}/receive`, { locationId: location.id, quantity: 1, receivedOn: "2025-12-15" });
    expect(receipt.statusCode).toBe(409);
    expect(receipt.json().code).toBe("stock-backdate-refused");
    const ok = await post(`/purchase-orders/${order.id}/rows/${row.id}/receive`, { locationId: location.id, quantity: 1, receivedOn: "2025-11-28" });
    expect(ok.statusCode).toBe(201);
    await app.close();
  });

  it("answers 400 purchase-receipt-backdate-lego for a backdated lego row", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
    });
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
    const { order, row } = await makeLegoOrder();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/purchase-orders/${order.id}/rows/${row.id}/receive`,
      headers: { cookie },
      payload: { quantity: 4, receivedOn: "2026-01-05" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("purchase-receipt-backdate-lego");
    await app.close();
  });
});
