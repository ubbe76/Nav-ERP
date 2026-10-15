import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, salesOrderRows, salesOrders } from "@navet/db";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { FreightRowDeliveredError } from "../src/modules/sales/service/sales.errors.js";
import { createSalesService, InvalidStatusTransitionError } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { makeArticle, makeCustomer, makeDelivery, resetShipping } from "./helpers/shipping-fixtures.js";

const fakeTransport: MailTransportFactory = () => ({ async sendMail() {} });
const sales = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService, fakeTransport),
  testDocumentPdfService,
  createStockService(createStockRepository(db)),
  testArticleService,
  testSystemService,
  (query) => resolvePrice(db, query)
);

beforeEach(resetShipping);
afterAll(resetShipping);

// makeDelivery inserts the order with an already-delivered goods row; the
// freight row under test is added separately by setFreightRow.
async function orderWithFreightArticle(status: "quote" | "confirmed" | "in_production" | "delivered" = "quote") {
  const customer = await makeCustomer();
  const goods = await makeArticle();
  const freight = await makeArticle({ name: "Frakt", type: "service", length: undefined, width: undefined, height: undefined, weight: undefined });
  const { orderId } = await makeDelivery(customer.id, [{ articleId: goods.id, quantity: 1 }], { status });
  return { orderId, freight };
}

async function freightRows(articleId: string) {
  return db.select().from(salesOrderRows).where(eq(salesOrderRows.articleId, articleId));
}

describe("setFreightRow", () => {
  it("adds one freight row with quantity 1, the given price and no discount", async () => {
    const { orderId, freight } = await orderWithFreightArticle();
    const row = await sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 454 }, null);
    expect(row.articleId).toBe(freight.id);
    expect(Number(row.quantityOrdered)).toBe(1);
    expect(Number(row.unitPrice)).toBe(454);
    expect(Number(row.discountPercent)).toBe(0);
    expect(await freightRows(freight.id)).toHaveLength(1);
  });

  it("replaces the price on the existing freight row instead of adding another", async () => {
    const { orderId, freight } = await orderWithFreightArticle("confirmed");
    const first = await sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 454 }, null);
    const second = await sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 520 }, null);
    expect(second.id).toBe(first.id);
    const rows = await freightRows(freight.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.unitPrice)).toBe(520);
    expect(Number(rows[0]!.quantityOrdered)).toBe(1);
  });

  it("refuses to reprice a freight row that is already delivered", async () => {
    const { orderId, freight } = await orderWithFreightArticle("in_production");
    await sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 454 }, null);
    await db.update(salesOrderRows).set({ quantityDelivered: "1" }).where(eq(salesOrderRows.articleId, freight.id));
    await expect(sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 500 }, null)).rejects.toBeInstanceOf(
      FreightRowDeliveredError
    );
    const rows = await freightRows(freight.id);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.unitPrice)).toBe(454);
  });

  it("refuses an order whose rows are no longer editable", async () => {
    const { orderId, freight } = await orderWithFreightArticle("delivered");
    await expect(sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 454 }, null)).rejects.toBeInstanceOf(
      InvalidStatusTransitionError
    );
    expect(await freightRows(freight.id)).toHaveLength(0);
  });

  it("bumps the order revision like any row change", async () => {
    const { orderId, freight } = await orderWithFreightArticle();
    const [before] = await db.select().from(salesOrders).where(eq(salesOrders.id, orderId));
    await sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 454 }, null);
    const [afterAdd] = await db.select().from(salesOrders).where(eq(salesOrders.id, orderId));
    expect(afterAdd!.revision).toBe(before!.revision + 1);
    await sales.setFreightRow(orderId, { articleId: freight.id, unitPrice: 520 }, null);
    const [afterReprice] = await db.select().from(salesOrders).where(eq(salesOrders.id, orderId));
    expect(afterReprice!.revision).toBe(before!.revision + 2);
  });
});
