import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, deliveries, deliveryRows, stockTransactions } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import {
  createSalesService,
  DeliveryNotFoundError,
  OverDeliveryError,
  SalesOrderRowNotFoundError,
} from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { pdfText } from "./helpers/pdf.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockService, LocationUnderStockCountError } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const stockCountRepo = createStockCountRepository(db);
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const fakeTransportFactory: MailTransportFactory = () => ({ async sendMail() {} });
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);

// number_series is deliberately never truncated — see sales.service.test.ts's
// customer-number tests for why (the FS- counter must survive across tests
// and across suites, same as the KO- and customer counters).
const TABLES = sql`TRUNCATE email_log, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
});

afterAll(async () => {
  await db.execute(TABLES);
});

async function makeUser() {
  return authRepo.create({
    email: `delivery-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Lagerarbetare",
    role: "admin",
  });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

async function makeArticle() {
  return articleService.createArticle({
    articleNumber: `ART-DEL-${crypto.randomUUID()}`,
    name: "Test Article",
    type: "manufactured",
    unit: "st",
    active: true,
  });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({
    articleId,
    locationId,
    quantityDelta: quantity,
    transactionType: "inventory_adjustment",
  });
}

// Two rows on one order (the unique (order, article) index forces two
// distinct articles), stocked and pushed to in_production so deliverBatch's
// status guard passes.
async function makeOrderWithTwoRows(quantityA = 10, quantityB = 5) {
  const user = await makeUser();
  const customer = await makeCustomer();
  const articleA = await makeArticle();
  const articleB = await makeArticle();
  const location = await makeLocation();
  await seedStock(articleA.id, location.id, quantityA);
  await seedStock(articleB.id, location.id, quantityB);

  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      rows: [
        { articleId: articleA.id, quantity: quantityA, unitPrice: 10 },
        { articleId: articleB.id, quantity: quantityB, unitPrice: 20 },
      ],
    },
    user.id
  );
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);

  const rowA = rows.find((r) => r.articleId === articleA.id)!;
  const rowB = rows.find((r) => r.articleId === articleB.id)!;
  return { user, customer, articleA, articleB, location, order, rowA, rowB };
}

describe("delivery occasions — batch delivery", () => {
  it("delivers two rows in one batch: one delivery with an FS-number, two delivery_rows, two stock rows, both rows updated", async () => {
    const { order, rowA, rowB, location, user } = await makeOrderWithTwoRows(10, 5);

    const result = await salesService.deliverBatch(
      order.id,
      {
        locationId: location.id,
        rows: [
          { rowId: rowA.id, quantity: 10 },
          { rowId: rowB.id, quantity: 5 },
        ],
      },
      user.id
    );

    expect(result.deliveryNumber.startsWith("FS-")).toBe(true);
    // Both rows fully delivered — the whole order flips to delivered.
    expect(result.orderStatus).toBe("delivered");

    const dbDeliveries = await db.select().from(deliveries).where(eq(deliveries.id, result.deliveryId));
    expect(dbDeliveries).toHaveLength(1);
    expect(dbDeliveries[0]!.deliveryNumber).toBe(result.deliveryNumber);
    expect(dbDeliveries[0]!.salesOrderId).toBe(order.id);

    const dbDeliveryRows = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
    expect(dbDeliveryRows).toHaveLength(2);
    expect(dbDeliveryRows.map((r) => r.quantity).sort()).toEqual(["10.0000", "5.0000"].sort());

    const stockRows = await db.select().from(stockTransactions).where(eq(stockTransactions.referenceId, order.id));
    expect(stockRows).toHaveLength(2);

    const rowsAfter = await salesService.listRows(order.id);
    expect(rowsAfter.find((r) => r.id === rowA.id)!.quantityDelivered).toBe("10.0000");
    expect(rowsAfter.find((r) => r.id === rowB.id)!.quantityDelivered).toBe("5.0000");
  });

  it("refuses a delivery against a location under a blocking count", async () => {
    const { order, rowA, rowB, location, user } = await makeOrderWithTwoRows(10, 5);
    await stockCountRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    await expect(
      salesService.deliverBatch(
        order.id,
        {
          locationId: location.id,
          rows: [
            { rowId: rowA.id, quantity: 10 },
            { rowId: rowB.id, quantity: 5 },
          ],
        },
        user.id
      )
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);
  });

  it("rolls back the whole batch when a later row over-delivers — no delivery, no stock rows, row 1 unchanged", async () => {
    const { order, rowA, rowB, location, user } = await makeOrderWithTwoRows(10, 5);

    await expect(
      salesService.deliverBatch(
        order.id,
        {
          locationId: location.id,
          rows: [
            { rowId: rowA.id, quantity: 4 },
            { rowId: rowB.id, quantity: 999 }, // exceeds ordered quantity (5)
          ],
        },
        user.id
      )
    ).rejects.toThrow(OverDeliveryError);

    const dbDeliveries = await db.select().from(deliveries).where(eq(deliveries.salesOrderId, order.id));
    expect(dbDeliveries).toHaveLength(0);

    const dbDeliveryRows = await db.select().from(deliveryRows);
    expect(dbDeliveryRows).toHaveLength(0);

    const stockRows = await db.select().from(stockTransactions).where(eq(stockTransactions.referenceId, order.id));
    expect(stockRows).toHaveLength(0);

    const rowsAfter = await salesService.listRows(order.id);
    expect(rowsAfter.find((r) => r.id === rowA.id)!.quantityDelivered).toBe("0.0000");
    expect(rowsAfter.find((r) => r.id === rowB.id)!.quantityDelivered).toBe("0.0000");

    const orderAfter = await salesService.getSalesOrder(order.id);
    expect(orderAfter!.status).toBe("in_production");
  });

  it("rolls back the whole batch when a row id is unknown", async () => {
    const { order, rowA, location, user } = await makeOrderWithTwoRows(10, 5);

    await expect(
      salesService.deliverBatch(
        order.id,
        {
          locationId: location.id,
          rows: [
            { rowId: rowA.id, quantity: 4 },
            { rowId: crypto.randomUUID(), quantity: 1 },
          ],
        },
        user.id
      )
    ).rejects.toThrow(SalesOrderRowNotFoundError);

    const dbDeliveries = await db.select().from(deliveries).where(eq(deliveries.salesOrderId, order.id));
    expect(dbDeliveries).toHaveLength(0);
    const rowsAfter = await salesService.listRows(order.id);
    expect(rowsAfter.find((r) => r.id === rowA.id)!.quantityDelivered).toBe("0.0000");
  });

  it("the old per-row deliver endpoint's service path creates a 1-row delivery occasion", async () => {
    const { order, rowA, location, user } = await makeOrderWithTwoRows(10, 5);

    const result = await salesService.deliverGoods(order.id, rowA.id, { locationId: location.id, quantity: 4 }, user.id);

    // Backward-compatible fields still present...
    expect(result.row.quantityDelivered).toBe("4.0000");
    expect(result.orderStatus).toBe("in_production");
    // ...plus the new delivery-occasion fields.
    expect(result.deliveryNumber.startsWith("FS-")).toBe(true);

    const dbDeliveryRows = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
    expect(dbDeliveryRows).toHaveLength(1);
    expect(dbDeliveryRows[0]!.quantity).toBe("4.0000");
    expect(dbDeliveryRows[0]!.salesOrderRowId).toBe(rowA.id);
  });

  it("two partial batches yield two deliveries with sequential FS-numbers, and full delivery flips the order to delivered", async () => {
    const { order, rowA, rowB, location, user } = await makeOrderWithTwoRows(10, 5);

    const first = await salesService.deliverBatch(
      order.id,
      { locationId: location.id, rows: [{ rowId: rowA.id, quantity: 4 }] },
      user.id
    );
    expect(first.orderStatus).toBe("in_production");

    const second = await salesService.deliverBatch(
      order.id,
      {
        locationId: location.id,
        rows: [
          { rowId: rowA.id, quantity: 6 },
          { rowId: rowB.id, quantity: 5 },
        ],
      },
      user.id
    );

    expect(first.deliveryNumber).not.toBe(second.deliveryNumber);
    const firstSeq = Number(first.deliveryNumber.replace("FS-", ""));
    const secondSeq = Number(second.deliveryNumber.replace("FS-", ""));
    expect(secondSeq).toBe(firstSeq + 1);

    // The second batch completes both rows.
    expect(second.orderStatus).toBe("delivered");
    const orderAfter = await salesService.getSalesOrder(order.id);
    expect(orderAfter!.status).toBe("delivered");
  });
});

describe("delivery occasions — list endpoint", () => {
  it("lists an order's deliveries newest first with the right row counts", async () => {
    const { order, rowA, rowB, location, user } = await makeOrderWithTwoRows(10, 5);

    const first = await salesService.deliverBatch(
      order.id,
      { locationId: location.id, rows: [{ rowId: rowA.id, quantity: 4 }] },
      user.id
    );
    const second = await salesService.deliverBatch(
      order.id,
      {
        locationId: location.id,
        rows: [
          { rowId: rowA.id, quantity: 6 },
          { rowId: rowB.id, quantity: 5 },
        ],
      },
      user.id
    );

    const list = await salesService.listDeliveries(order.id);
    expect(list).toHaveLength(2);
    // Newest first.
    expect(list[0]!.id).toBe(second.deliveryId);
    expect(list[1]!.id).toBe(first.deliveryId);
    expect(list[0]!.deliveryNumber).toBe(second.deliveryNumber);
    expect(list[0]!.rowCount).toBe(2);
    expect(list[1]!.rowCount).toBe(1);
  });

  it("returns an empty list for an order with no deliveries yet", async () => {
    const { order } = await makeOrderWithTwoRows(10, 5);
    expect(await salesService.listDeliveries(order.id)).toEqual([]);
  });
});

describe("delivery note (följesedel) PDF", () => {
  it("the SECOND of two partial occasions prints this-occasion quantities and 'Tidigare levererat' derived by subtraction", async () => {
    const { order, articleA, articleB, rowA, rowB, location, user } = await makeOrderWithTwoRows(10, 5);

    // First occasion: only rowA, partially (4 of 10).
    await salesService.deliverBatch(
      order.id,
      { locationId: location.id, rows: [{ rowId: rowA.id, quantity: 4 }] },
      user.id
    );
    // Second occasion: rowA's remainder (6) plus rowB's whole quantity (5) —
    // completes the order.
    const second = await salesService.deliverBatch(
      order.id,
      {
        locationId: location.id,
        rows: [
          { rowId: rowA.id, quantity: 6 },
          { rowId: rowB.id, quantity: 5 },
        ],
      },
      user.id
    );

    const { pdf, filename, deliveryNumber } = await salesService.deliveryNotePdf(second.deliveryId);
    expect(deliveryNumber).toBe(second.deliveryNumber);
    expect(filename).toBe(`foljesedel-${second.deliveryNumber}.pdf`);

    const text = pdfText(pdf);
    expect(text).toContain(`Följesedel ${second.deliveryNumber}`);
    expect(text).toContain(`Ordernummer: ${order.orderNumber}`);
    // rowA: 6 delivered THIS occasion, 4 delivered before it (the first
    // occasion's booking) — adjacent doc.text() calls concatenate with no
    // separator, same convention document-pdf-amounts.test.ts relies on.
    expect(text).toContain(`${articleA.articleNumber}Test Article6st4`);
    // rowB: 5 delivered THIS occasion, 0 before it — its first delivery ever.
    expect(text).toContain(`${articleB.articleNumber}Test Article5st0`);
  });

  it("404s for an unknown delivery id", async () => {
    await expect(salesService.deliveryNotePdf(crypto.randomUUID())).rejects.toThrow(DeliveryNotFoundError);
  });
});
