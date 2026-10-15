import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, stockTransactions } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

// Repository-level coverage for stock_transactions.unit_cost (D0): the
// column is stamped only on the three inflow writers (purchase receipt,
// MO receipt, positive manual adjustment) and stays null on every outflow
// and on both legs of a stock transfer. Called against the real
// repositories/test database, mirroring economy-reports.test.ts's style.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const purchaseRepo = createPurchaseRepository(db);
const manufacturingRepo = createManufacturingRepository(db);
const salesRepo = createSalesRepository(db);
const stockRepo = createStockRepository(db);
const stockService = createStockService(stockRepo);

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, mo_material_consumptions, manufacturing_orders, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Bypasses authService.register (bootstrap-only) since these tests only
// need a valid user id for createdBy — not auth policy itself.
async function makeUser() {
  return authRepo.create({
    email: `unitcost-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Tester",
    role: "admin",
  });
}

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name, active: true });
}

async function makeArticle(opts: { type?: "purchased" | "manufactured"; standardCost?: number } = {}) {
  return articleService.createArticle({
    articleNumber: `ART-UC-${crypto.randomUUID()}`,
    name: "Test Article",
    type: opts.type ?? "purchased",
    unit: "st",
    active: true,
    ...(opts.standardCost !== undefined ? { standardCost: opts.standardCost } : {}),
  });
}

async function transactionsFor(referenceId: string, transactionType?: string) {
  const conditions = [eq(stockTransactions.referenceId, referenceId)];
  if (transactionType) {
    conditions.push(eq(stockTransactions.transactionType, transactionType as (typeof stockTransactions.$inferSelect)["transactionType"]));
  }
  return db.select().from(stockTransactions).where(and(...conditions));
}

describe("stock_transactions.unit_cost — purchase_receipt", () => {
  // Order + row + confirmed status, ready for receiveGoods. exchangeRate
  // defaults to 1 (SEK) unless overridden, mirroring purchase.service.test.ts.
  async function makeConfirmedOrder(opts: { currency?: string; exchangeRate?: number; unitPrice?: number } = {}) {
    const user = await makeUser();
    const supplier = await purchaseRepo.createSupplier({
      name: "ACME AB",
      active: true,
      currency: opts.currency ?? "SEK",
    });
    const article = await makeArticle();
    const location = await makeLocation();
    const order = await purchaseRepo.createPurchaseOrder(
      { supplierId: supplier.id, exchangeRate: opts.exchangeRate },
      user.id,
      supplier.currency
    );
    const row = await purchaseRepo.addRow(order.id, {
      articleId: article.id,
      quantity: 10,
      unitPrice: opts.unitPrice ?? 42,
      unitId: null,
      unitFactor: null,
    });
    await purchaseRepo.updateStatus(order.id, "confirmed");
    return { user, supplier, article, location, order, row };
  }

  it("stamps unit_cost from the row's unit price when the order is in SEK (exchange rate 1)", async () => {
    const { user, location, order, row } = await makeConfirmedOrder({ unitPrice: 42 });

    const result = await purchaseRepo.receiveGoods(order.id, row.id, {
      locationId: location.id,
      quantity: 4,
      createdBy: user.id,
      overReceiptPercent: 0,
    });
    expect(result.ok).toBe(true);

    const [tx] = await transactionsFor(order.id, "purchase_receipt");
    expect(tx?.unitCost).toBe("42.0000");
  });

  it("converts unit_cost with a non-1 exchange rate (EUR order)", async () => {
    const { user, location, order, row } = await makeConfirmedOrder({
      currency: "EUR",
      exchangeRate: 11.5,
      unitPrice: 42,
    });
    expect(order.exchangeRate).toBe("11.500000");

    await purchaseRepo.receiveGoods(order.id, row.id, {
      locationId: location.id,
      quantity: 2,
      createdBy: user.id,
      overReceiptPercent: 0,
    });

    const [tx] = await transactionsFor(order.id, "purchase_receipt");
    // 42 * 11.5 = 483
    expect(tx?.unitCost).toBe("483.0000");
  });
});

describe("stock_transactions.unit_cost — mo_receipt", () => {
  // Minimal MO: no BOM/routing needed since complete() draws unlinked
  // material only when consumption rows exist (see consumeLinkedMaterial),
  // and the release at creation snapshots nothing when the parent has none.
  async function makeCompletedOrder(standardCost?: number) {
    const user = await makeUser();
    const parent = await makeArticle({ type: "manufactured", standardCost });
    const location = await makeLocation();
    const created = await manufacturingRepo.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    if (!created.ok) throw new Error(`createManufacturingOrder failed: ${created.reason}`);
    const order = created.order;
    await manufacturingRepo.updateStatus(order.id, "in_progress");
    const result = await manufacturingRepo.complete(order.id, { locationId: location.id, quantity: 5, createdBy: user.id });
    expect(result.ok).toBe(true);
    return { user, parent, location, order };
  }

  it("stamps the produced article's standard cost at receipt", async () => {
    const { order } = await makeCompletedOrder(123.4567);

    const [tx] = await transactionsFor(order.id, "mo_receipt");
    expect(tx?.unitCost).toBe("123.4567");
  });

  it("leaves unit_cost null when the article has no standard cost", async () => {
    const { order } = await makeCompletedOrder(undefined);

    const [tx] = await transactionsFor(order.id, "mo_receipt");
    expect(tx?.unitCost).toBeNull();
  });
});

describe("stock_transactions.unit_cost — manual inventory_adjustment", () => {
  it("stamps standard cost on a positive adjustment", async () => {
    const article = await makeArticle({ standardCost: 17.5 });
    const location = await makeLocation();

    const row = await stockRepo.createTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 5,
      transactionType: "inventory_adjustment",
    });

    expect(row?.unitCost).toBe("17.5000");
  });

  it("leaves unit_cost null on a negative adjustment", async () => {
    const article = await makeArticle({ standardCost: 17.5 });
    const location = await makeLocation();
    // Seed enough stock first so the negative leg isn't the article's only movement.
    await stockRepo.createTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 5,
      transactionType: "inventory_adjustment",
    });

    const row = await stockRepo.createTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: -3,
      transactionType: "inventory_adjustment",
    });

    expect(row?.unitCost).toBeNull();
  });
});

describe("stock_transactions.unit_cost — outflows and transfers stay unvalued", () => {
  it("leaves unit_cost null on a sales_delivery", async () => {
    const user = await makeUser();
    const customer = await salesRepo.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle();
    const location = await makeLocation();

    const { order, rows } = await salesRepo.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 10, unitPrice: 99, unitId: null, unitFactor: null }] },
      user.id
    );
    await salesRepo.updateStatus(order.id, "in_production");

    await salesRepo.deliverBatch(order.id, {
      locationId: location.id,
      rows: [{ rowId: rows[0]!.id, quantity: 3 }],
      createdBy: user.id,
      overReceiptPercent: 0,
    });

    const [tx] = await transactionsFor(order.id, "sales_delivery");
    expect(tx?.unitCost).toBeNull();
  });

  it("leaves unit_cost null on both legs of a stock transfer", async () => {
    const user = await makeUser();
    const article = await makeArticle({ standardCost: 25 });
    const from = await makeLocation("A1");
    const to = await makeLocation("B2");
    await stockRepo.createTransaction({
      articleId: article.id,
      locationId: from.id,
      quantityDelta: 10,
      transactionType: "inventory_adjustment",
    });

    const result = await stockRepo.transferStock(
      { fromLocationId: from.id, toLocationId: to.id, rows: [{ articleId: article.id, quantity: 5 }] },
      user.id
    );

    const legs = await transactionsFor(result.transferId, "stock_transfer");
    expect(legs).toHaveLength(2);
    expect(legs.every((leg) => leg.unitCost === null)).toBe(true);
  });
});
