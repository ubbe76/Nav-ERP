import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createManufacturingOrderSchema } from "@navet/shared";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { pdfText } from "./helpers/pdf.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  LinkedOrderStatusError,
  LinkedRowArticleMismatchError,
  LinkedRowNotFoundError,
  LinkedRowNotManufacturedError,
  NothingLeftToManufactureError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { manufacturingRoutes } from "../src/modules/manufacturing/routes/manufacturing.routes.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({
  async sendMail() {
    /* no-op fake transport — not exercised by these tests */
  },
}));
const documentPdfService = createDocumentPdfService(systemService);
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

const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});

// Task 5: a second sales service instance with the manufacturingCoverage
// dependency wired in (mfgService.coverageForSalesOrderRows), to assert the
// "I tillverkning" enrichment on listRows. The plain `salesService` above
// intentionally omits it, mirroring how most other test files construct
// createSalesService — the fallback path (quantityInProduction: 0, empty
// list) is exercised by every one of those, not just here.
const salesServiceWithCoverage = createSalesService(
  salesRepository,
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  // The audit writer comes BEFORE the coverage reader. G1 inserted it in this
  // position after E3 wrote this file, and mfgService silently slid into the
  // audit slot — leaving manufacturingCoverage undefined, so every row fell
  // back to quantityInProduction 0. A no-op rather than the real writer: this
  // file asserts nothing about the audit trail and does not truncate
  // audit_log, so real rows would leak between tests.
  { log: async () => {} },
  mfgService
);

const TRUNCATE = sql`TRUNCATE mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `mfg-link-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Producer",
    role: "admin",
  });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

async function makeArticle(type: "manufactured" | "purchased" = "manufactured") {
  return articleService.createArticle({
    articleNumber: `ART-LINK-${crypto.randomUUID()}`,
    name: "Länkad artikel",
    type,
    unit: "st",
    active: true,
  });
}

// A confirmed KO with one row for a manufactured article — the normal case
// this feature exists for.
async function makeConfirmedOrderRow(quantity = 10) {
  const user = await makeUser();
  const customer = await makeCustomer();
  const article = await makeArticle("manufactured");
  const { order, rows } = await salesService.createQuote(
    { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity, unitPrice: 100 }] },
    user.id
  );
  return { user, customer, article, order, row: rows[0]! };
}

describe("manufacturing service — creating a TO linked to a KO row", () => {
  it("links the MO, stamps salesOrderRowId, and flips the order to in_production", async () => {
    const { order, article, row } = await makeConfirmedOrderRow(10);

    const mo = await mfgService.createManufacturingOrder({ quantity: 10, salesOrderRowId: row.id }, null);

    expect(mo.salesOrderRowId).toBe(row.id);
    expect(mo.articleId).toBe(article.id); // articleId derived from the row, not supplied
    const flipped = await salesService.getSalesOrder(order.id);
    expect(flipped!.status).toBe("in_production");
  });

  it("does not double-flip an order that is already in_production (idempotent no-op)", async () => {
    const { order, row } = await makeConfirmedOrderRow(10);
    await salesService.startProduction(order.id);
    const before = await salesService.getSalesOrder(order.id);
    expect(before!.status).toBe("in_production");

    const mo = await mfgService.createManufacturingOrder({ quantity: 5, salesOrderRowId: row.id }, null);

    expect(mo.salesOrderRowId).toBe(row.id);
    const after = await salesService.getSalesOrder(order.id);
    expect(after!.status).toBe("in_production");
  });

  it("rejects a link to an unknown sales order row", async () => {
    await expect(
      mfgService.createManufacturingOrder({ quantity: 1, salesOrderRowId: "00000000-0000-0000-0000-000000000000" }, null)
    ).rejects.toBeInstanceOf(LinkedRowNotFoundError);
  });

  it("rejects a link where the supplied articleId doesn't match the row's article", async () => {
    const { row } = await makeConfirmedOrderRow(10);
    const otherArticle = await makeArticle("manufactured");

    await expect(
      mfgService.createManufacturingOrder({ articleId: otherArticle.id, quantity: 1, salesOrderRowId: row.id }, null)
    ).rejects.toBeInstanceOf(LinkedRowArticleMismatchError);
  });

  it("rejects a link to a row for a purchased (non-manufactured) article", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle("purchased");
    const { rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 5, unitPrice: 10 }] },
      user.id
    );

    await expect(
      mfgService.createManufacturingOrder({ quantity: 5, salesOrderRowId: rows[0]!.id }, null)
    ).rejects.toBeInstanceOf(LinkedRowNotManufacturedError);
  });

  it("rejects a link to a row still on a quote (not confirmed/in_production)", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle("manufactured");
    // No confirm flag — order stays "quote".
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 5, unitPrice: 10 }] },
      user.id
    );
    expect(order.status).toBe("quote");

    await expect(
      mfgService.createManufacturingOrder({ quantity: 5, salesOrderRowId: rows[0]!.id }, null)
    ).rejects.toBeInstanceOf(LinkedOrderStatusError);
  });

  it("allows creating a TO without a link, unaffected by the new validation", async () => {
    const article = await makeArticle("manufactured");
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 3 }, null);
    expect(mo.salesOrderRowId).toBeNull();
    expect(mo.articleId).toBe(article.id);
  });
});

describe("createManufacturingOrderSchema", () => {
  it("rejects a body with neither articleId nor salesOrderRowId", () => {
    const result = createManufacturingOrderSchema.safeParse({ quantity: 5 });
    expect(result.success).toBe(false);
  });
});

describe("manufacturing service — createFromSalesOrderRow (Skapa TO from a KO row)", () => {
  it("defaults the quantity to the row's remaining balance", async () => {
    const { row } = await makeConfirmedOrderRow(10);
    await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: row.id }, null);

    const mo = await mfgService.createFromSalesOrderRow(row.id, {}, null);

    expect(mo.salesOrderRowId).toBe(row.id);
    expect(Number(mo.quantity)).toBe(6);
  });

  it("uses an explicit quantity instead of the derived default", async () => {
    const { row } = await makeConfirmedOrderRow(10);
    await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: row.id }, null);

    const mo = await mfgService.createFromSalesOrderRow(row.id, { quantity: 3 }, null);

    expect(Number(mo.quantity)).toBe(3);
  });

  it("rejects the default when nothing is left to manufacture", async () => {
    const { row } = await makeConfirmedOrderRow(10);
    await mfgService.createManufacturingOrder({ quantity: 10, salesOrderRowId: row.id }, null);

    await expect(mfgService.createFromSalesOrderRow(row.id, {}, null)).rejects.toBeInstanceOf(
      NothingLeftToManufactureError
    );
  });

  it("does not count a cancelled MO towards coverage", async () => {
    const { row } = await makeConfirmedOrderRow(10);
    const mo = await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: row.id }, null);
    await mfgService.cancel(mo.id);

    const next = await mfgService.createFromSalesOrderRow(row.id, {}, null);

    expect(Number(next.quantity)).toBe(10);
  });

  // Float-edge regression: 0.0004 ordered, covered by two MOs (0.0001 +
  // 0.0003) that sum to exactly the order in decimal but not in IEEE 754
  // double — `0.0004 - (0.0001 + 0.0003)` is 5.4e-20, not 0. Unrounded, that
  // tiny positive slips past the `quantity <= 0` guard and would create a
  // TO for a quantity numeric(14,4) rounds back down to 0.0000. round4-ing
  // the remainder before the guard must treat this as "nothing left".
  it("treats a floating-point remainder that rounds to exactly 0 as nothing left to manufacture", async () => {
    const { row } = await makeConfirmedOrderRow(0.0004);
    await mfgService.createManufacturingOrder({ quantity: 0.0001, salesOrderRowId: row.id }, null);
    await mfgService.createManufacturingOrder({ quantity: 0.0003, salesOrderRowId: row.id }, null);

    await expect(mfgService.createFromSalesOrderRow(row.id, {}, null)).rejects.toBeInstanceOf(
      NothingLeftToManufactureError
    );
  });
});

describe("POST /sales-orders/:id/rows/:rowId/manufacturing-order", () => {
  async function buildApp() {
    const routeUser = await makeUser();
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      req.user = routeUser as any;
    });
    await app.register(manufacturingRoutes, { service: mfgService });
    return app;
  }

  it("404s when the row does not belong to the order in the URL", async () => {
    const { order, row } = await makeConfirmedOrderRow(10);
    const otherOrderRow = await makeConfirmedOrderRow(5);
    expect(otherOrderRow.order.id).not.toBe(order.id);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/sales-orders/${otherOrderRow.order.id}/rows/${row.id}/manufacturing-order`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("creates a TO defaulting to the row's remaining balance", async () => {
    const { order, row, article } = await makeConfirmedOrderRow(10);

    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/sales-orders/${order.id}/rows/${row.id}/manufacturing-order`,
      payload: {},
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.salesOrderRowId).toBe(row.id);
    expect(body.articleId).toBe(article.id);
    expect(Number(body.quantity)).toBe(10);
    await app.close();
  });
});

describe("Task 6: TO detail GET + printout carry the linked KO's customer", () => {
  it("detail GET bears salesOrder { id, orderNumber, customerName } for a linked TO", async () => {
    const { order, row, customer } = await makeConfirmedOrderRow(10);
    const mo = await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: row.id }, null);

    const detail = await mfgService.getManufacturingOrder(mo.id);

    expect(detail!.salesOrder).toEqual({ id: order.id, orderNumber: order.orderNumber, customerName: customer.name });
  });

  it("detail GET carries salesOrder: null for an unlinked TO", async () => {
    const article = await makeArticle("manufactured");
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 3 }, null);

    const detail = await mfgService.getManufacturingOrder(mo.id);

    expect(detail!.salesOrder).toBeNull();
  });

  it("prints 'Kundorder: <nummer> — <kund>' on a linked TO's printout", async () => {
    const { order, row, customer } = await makeConfirmedOrderRow(10);
    const mo = await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: row.id }, null);

    const { content } = await mfgService.getManufacturingOrderPdf(mo.id);

    expect(pdfText(content)).toContain(`Kundorder: ${order.orderNumber} — ${customer.name}`);
  });

  it("omits the Kundorder line on an unlinked TO's printout", async () => {
    const article = await makeArticle("manufactured");
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 3 }, null);

    const { content } = await mfgService.getManufacturingOrderPdf(mo.id);

    expect(pdfText(content)).not.toContain("Kundorder:");
  });
});

describe("Task 5: sales listRows — quantityInProduction and manufacturingOrders", () => {
  it("sums only non-cancelled linked MOs and lists only the non-cancelled ones", async () => {
    const user = await makeUser();
    const customer = await salesServiceWithCoverage.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle("manufactured");
    const { order, rows } = await salesServiceWithCoverage.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 10, unitPrice: 100 }] },
      user.id
    );
    const row = rows[0]!;

    const kept = await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: row.id }, null);
    const cancelled = await mfgService.createManufacturingOrder({ quantity: 3, salesOrderRowId: row.id }, null);
    await mfgService.cancel(cancelled.id);

    const listed = await salesServiceWithCoverage.listRows(order.id);

    expect(listed).toHaveLength(1);
    expect(listed[0]!.quantityInProduction).toBe(4);
    expect(listed[0]!.manufacturingOrders).toHaveLength(1);
    expect(listed[0]!.manufacturingOrders[0]!.id).toBe(kept.id);
    expect(listed[0]!.manufacturingOrders[0]!.status).not.toBe("cancelled");
    expect(listed[0]!.manufacturingOrders.some((mo: { id: string }) => mo.id === cancelled.id)).toBe(false);
  });

  it("reports 0 / empty list for a row with no linked MOs", async () => {
    const user = await makeUser();
    const customer = await salesServiceWithCoverage.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle("manufactured");
    const { order } = await salesServiceWithCoverage.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 5, unitPrice: 50 }] },
      user.id
    );

    const listed = await salesServiceWithCoverage.listRows(order.id);

    expect(listed).toHaveLength(1);
    expect(listed[0]!.quantityInProduction).toBe(0);
    expect(listed[0]!.manufacturingOrders).toEqual([]);
  });

  it("falls back to 0 / empty list when manufacturingCoverage is omitted (most test-built services)", async () => {
    const user = await makeUser();
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle("manufactured");
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 10, unitPrice: 100 }] },
      user.id
    );
    await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: rows[0]!.id }, null);

    const listed = await salesService.listRows(order.id);

    expect(listed).toHaveLength(1);
    expect(listed[0]!.quantityInProduction).toBe(0);
    expect(listed[0]!.manufacturingOrders).toEqual([]);
  });
});
