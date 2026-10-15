import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, costCalculations } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createReportsService, resolveReportRange } from "../src/modules/reports/service/reports.service.js";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const documentPdfService = createDocumentPdfService(systemService);
const stockService = createStockService(createStockRepository(db));
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
const reportsService = createReportsService(createReportsRepository(db));

const TRUNCATE = sql`TRUNCATE cost_calculations, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, mo_material_consumptions, mo_operations, manufacturing_orders, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const isoDate = (offsetDays: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function makeUser() {
  return authRepo.create({
    email: `reports-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reporter",
    role: "admin",
  });
}

async function makeArticle(type: "purchased" | "manufactured" = "purchased") {
  return articleService.createArticle({
    articleNumber: `REP-${crypto.randomUUID().slice(0, 8)}`,
    name: "Rapportartikel",
    type,
    active: true,
  });
}

async function makeDeliveredSalesOrder(expectedDeliveryDate: string | null, userId: string) {
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  const article = await makeArticle();
  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      confirm: true,
      ...(expectedDeliveryDate ? { expectedDeliveryDate } : {}),
      rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }],
    },
    userId
  );
  await salesService.startProduction(order.id);
  await salesService.deliverBatch(order.id, { rows: [{ rowId: rows[0]!.id, quantity: 2 }] }, userId);
  return order;
}

describe("reports service — delivery precision", () => {
  it("measures both sides and reports unmeasurable orders", async () => {
    const user = await makeUser();

    // Sales: promised yesterday, delivered today → late 1 day.
    await makeDeliveredSalesOrder(isoDate(-1), user.id);
    // Sales: promised tomorrow, delivered today → on time.
    await makeDeliveredSalesOrder(isoDate(1), user.id);
    // Sales: no promise → missingExpectedDate.
    await makeDeliveredSalesOrder(null, user.id);
    // Sales: delivered before C2 — wipe its delivery occasions.
    const preC2 = await makeDeliveredSalesOrder(isoDate(-1), user.id);
    await db.execute(sql`DELETE FROM deliveries WHERE sales_order_id = ${preC2.id}`);

    // Purchase: promised yesterday, received today → late 1 day.
    const supplier = await purchaseService.createSupplier({ name: "Leverantör AB", active: true });
    const poArticle = await makeArticle();
    const po = await purchaseService.createPurchaseOrder(
      { supplierId: supplier.id, exchangeRate: 1, expectedDeliveryDate: isoDate(-1) },
      user.id
    );
    const poRow = await purchaseService.addRow(po.id, { articleId: poArticle.id, quantity: 5, unitPrice: 10 });
    await purchaseService.confirm(po.id);
    await purchaseService.receiveGoods(po.id, poRow.id, { quantity: 5 }, user.id);

    const result = await reportsService.getDeliveryPrecision({});


    expect(result.sales.totals.total).toBe(2);
    expect(result.sales.totals.onTime).toBe(1);
    expect(result.sales.totals.late).toBe(1);
    expect(result.sales.totals.avgDaysLate).toBe(1);
    expect(result.sales.notMeasurable.missingExpectedDate).toBe(1);
    expect(result.sales.notMeasurable.noDeliveryRecords).toBe(1);

    expect(result.purchase.totals.total).toBe(1);
    expect(result.purchase.totals.late).toBe(1);
  });

  it("excludes unfinished orders from the measurement", async () => {
    const user = await makeUser();
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle();
    await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        expectedDeliveryDate: isoDate(-5),
        rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }],
      },
      user.id
    );

    const result = await reportsService.getDeliveryPrecision({});
    expect(result.sales.totals.total).toBe(0);
    expect(result.sales.notMeasurable.noDeliveryRecords).toBe(0); // not completed — not in scope at all
  });
});

describe("reports service — calculation outcome", () => {
  it("pairs seeded pre/post calculations per manufacturing order", async () => {
    const user = await makeUser();
    const article = await makeArticle("manufactured");
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 10 }, user.id);

    const base = {
      articleId: article.id,
      manufacturingOrderId: mo.id,
      quantity: "10",
      materialCost: "100",
      materialOverhead: "0",
      laborCost: "80",
      overhead: "0",
      subcontractCost: "0",
      subcontractOverhead: "0",
      businessOverhead: "0",
      generalMarkup: "0",
      salesPrice: "0",
    };
    await db.insert(costCalculations).values([
      { ...base, type: "pre" },
      { ...base, type: "post", materialCost: "150" },
    ]);

    const result = await reportsService.getCalculationOutcome({});
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.orderNumber).toBe(mo.orderNumber);
    expect(row.preTvkPerUnit).toBe(18);
    expect(row.postTvkPerUnit).toBe(23);
    expect(row.deltaPct).toBeCloseTo(27.8, 1);
    expect(result.summary.count).toBe(1);
  });
});

describe("resolveReportRange", () => {
  it("defaults to the last 12 months including the current one", () => {
    expect(resolveReportRange({}, "2026-08-22")).toEqual({ from: "2025-09", to: "2026-08" });
  });

  it("fills only the missing end", () => {
    expect(resolveReportRange({ from: "2026-01" }, "2026-08-22")).toEqual({ from: "2026-01", to: "2026-08" });
    expect(resolveReportRange({ to: "2026-03" }, "2026-08-22")).toEqual({ from: "2025-04", to: "2026-03" });
  });

  it("never returns an inverted range when a lone future from passes the schema", () => {
    // The zod refine only fires when BOTH ends are given; a future from with a
    // defaulted to would otherwise run the month axis into its safety cap.
    expect(resolveReportRange({ from: "2030-01" }, "2026-08-22")).toEqual({ from: "2030-01", to: "2030-01" });
  });
});
