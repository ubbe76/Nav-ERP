import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  articleGroups,
  articles,
  customers,
  db,
  purchaseOrderRows,
  purchaseOrders,
  salesOrderRows,
  salesOrders,
  suppliers,
  units,
} from "@navet/db";
import { purchaseOrderRegisterQuerySchema, salesOrderRegisterQuerySchema } from "@navet/shared";
import { createOrderRegisterRepository } from "../src/modules/reports/repository/order-register.repository.js";
import {
  createOrderRegisterService,
  OrderRegisterTooLargeError,
} from "../src/modules/reports/service/order-register.service.js";
import { ORDER_REGISTER_MAX_ROWS } from "../src/modules/reports/repository/order-register.repository.js";
import { testDocumentPdfService } from "./helpers/services.js";
import { pdfText } from "./helpers/pdf.js";

// Orderförteckning — rows are inserted directly so the order dates (created_at)
// and every quantity are exactly what the assertions expect.
const service = createOrderRegisterService(createOrderRegisterRepository(db), testDocumentPdfService);

const TRUNCATE = sql`TRUNCATE sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, articles, article_groups CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const sales = (raw: Record<string, string> = {}) => salesOrderRegisterQuerySchema.parse(raw);
const purchase = (raw: Record<string, string> = {}) => purchaseOrderRegisterQuerySchema.parse(raw);

// units is a shared, never-truncated register table.
async function unitByCode(code: string, name: string) {
  await db.insert(units).values({ code, name }).onConflictDoNothing();
  const [unit] = await db.select().from(units).where(eq(units.code, code));
  return unit!.id;
}

async function fixture() {
  const unitId = await unitByCode("st-or", "Styck (orderförteckning)");
  const boxId = await unitByCode("frp-or", "Förpackning (orderförteckning)");

  const [group] = await db.insert(articleGroups).values({ code: "510", name: "Plåt" }).returning();
  const [sink, legs] = await db
    .insert(articles)
    .values([
      { articleNumber: "A-100", name: "Diskbänk", type: "manufactured", unitId, groupId: group!.id },
      { articleNumber: "B-200", name: "Benställning", type: "purchased", unitId },
    ])
    .returning();
  const [anna, bert] = await db
    .insert(customers)
    .values([
      { customerNumber: "10001", name: "Anna Storkök AB" },
      { customerNumber: "10002", name: "Bert Restaurang AB" },
    ])
    .returning();
  const [steel] = await db.insert(suppliers).values({ supplierNumber: "20001", name: "Stålgrossisten AB" }).returning();

  const [ko1, ko2, ko3] = await db
    .insert(salesOrders)
    .values([
      {
        orderNumber: "KO-1",
        customerId: anna!.id,
        status: "confirmed",
        expectedDeliveryDate: "2026-02-01",
        createdAt: new Date("2026-01-10T09:00:00Z"),
      },
      {
        orderNumber: "KO-2",
        customerId: bert!.id,
        status: "invoiced",
        expectedDeliveryDate: "2026-01-12",
        createdAt: new Date("2026-01-05T09:00:00Z"),
      },
      { orderNumber: "KO-3", customerId: anna!.id, status: "cancelled", createdAt: new Date("2026-03-01T09:00:00Z") },
    ])
    .returning();
  await db.insert(salesOrderRows).values([
    // 10 × 100 − 10 % = 900, 4 delivered ⇒ rest 6 × 90 = 540
    { salesOrderId: ko1!.id, articleId: sink!.id, quantityOrdered: "10", quantityDelivered: "4", unitPrice: "100", discountPercent: "10" },
    // own date, fully delivered: 2 × 50 = 100, no rest
    {
      salesOrderId: ko1!.id,
      articleId: legs!.id,
      quantityOrdered: "2",
      quantityDelivered: "2",
      unitPrice: "50",
      expectedDeliveryDate: "2026-01-20",
      createdAt: new Date(Date.now() + 1000),
    },
    { salesOrderId: ko2!.id, articleId: legs!.id, quantityOrdered: "1", quantityDelivered: "1", unitPrice: "75" },
    { salesOrderId: ko3!.id, articleId: sink!.id, quantityOrdered: "1", unitPrice: "500" },
  ]);

  const [io1] = await db
    .insert(purchaseOrders)
    .values({
      orderNumber: "IO-1",
      supplierId: steel!.id,
      status: "confirmed",
      currency: "EUR",
      exchangeRate: "11.5",
      expectedDeliveryDate: "2026-02-10",
      confirmedDeliveryDate: "2026-02-14",
      createdAt: new Date("2026-01-20T23:30:00Z"), // 2026-01-21 in Stockholm
    })
    .returning();
  await db.insert(purchaseOrderRows).values([
    // 5 × 10 + ställpris 20 = 70, nothing received ⇒ the ställpris is rest too
    { purchaseOrderId: io1!.id, articleId: legs!.id, quantityOrdered: "5", unitPrice: "10", setupPrice: "20" },
    // 12 base units in packs of 4 (factor 0.25 pack per base unit) ⇒ 3 frp à 40
    {
      purchaseOrderId: io1!.id,
      articleId: sink!.id,
      quantityOrdered: "12",
      quantityReceived: "4",
      unitPrice: "10",
      unitId: boxId,
      unitFactor: "0.25",
      createdAt: new Date(Date.now() + 1000),
    },
  ]);

  return { group: group!, sink: sink!, legs: legs!, anna: anna!, steel: steel! };
}

describe("orderförteckning kundorder", () => {
  it("lists every order with values and the next delivery date of the rows with rest", async () => {
    await fixture();
    const result = await service.get("sales", sales({ withRows: "true" }));
    expect(result.orders.map((o) => o.orderNumber)).toEqual(["KO-1", "KO-2", "KO-3"]);
    const ko1 = result.orders[0]!;
    expect(ko1).toMatchObject({
      orderDate: "2026-01-10",
      partnerName: "Anna Storkök AB",
      orderValue: 1000,
      restValue: 540,
      deliveryDate: "2026-02-01",
      rowCount: 2,
    });
    expect(ko1.rows!.map((r) => [r.articleNumber, r.quantity, r.done, r.rest, r.amount, r.restAmount, r.deliveryDate])).toEqual([
      ["A-100", 10, 4, 6, 900, 540, "2026-02-01"],
      ["B-200", 2, 2, 0, 100, 0, "2026-01-20"],
    ]);
    expect(result.totals).toMatchObject({ orderCount: 3, rowCount: 4, orderValueSek: 1575, restValueSek: 1040, converted: false });
  });

  it("rows are only included when asked for", async () => {
    await fixture();
    const result = await service.get("sales", sales());
    expect(result.orders[0]!.rows).toBeUndefined();
  });

  it("filters on status, open rows, customer, article and article group", async () => {
    const f = await fixture();
    expect((await service.get("sales", sales({ status: "open" }))).orders.map((o) => o.orderNumber)).toEqual(["KO-1"]);
    expect((await service.get("sales", sales({ status: "invoiced,cancelled" }))).orders.map((o) => o.orderNumber)).toEqual([
      "KO-2",
      "KO-3",
    ]);

    const openOnly = await service.get("sales", sales({ openOnly: "true" }));
    expect(openOnly.orders.map((o) => [o.orderNumber, o.rowCount, o.orderValue])).toEqual([
      ["KO-1", 1, 900],
      ["KO-3", 1, 500],
    ]);

    expect((await service.get("sales", sales({ partnerId: f.anna.id }))).orders.map((o) => o.orderNumber)).toEqual(["KO-1", "KO-3"]);
    expect((await service.get("sales", sales({ articleId: f.legs.id }))).orders.map((o) => [o.orderNumber, o.orderValue])).toEqual([
      ["KO-1", 100],
      ["KO-2", 75],
    ]);
    expect((await service.get("sales", sales({ articleGroupId: f.group.id }))).orders.map((o) => o.orderNumber)).toEqual([
      "KO-1",
      "KO-3",
    ]);
  });

  it("the date range reads the order date or each row's effective delivery date", async () => {
    await fixture();
    const byOrderDate = await service.get("sales", sales({ from: "2026-01-06", to: "2026-01-31" }));
    expect(byOrderDate.orders.map((o) => o.orderNumber)).toEqual(["KO-1"]);

    // Only KO-1's second row has its own date inside the range; its first
    // row follows the order's 2026-02-01.
    const byDelivery = await service.get("sales", sales({ dateBasis: "delivery", from: "2026-01-15", to: "2026-01-31", withRows: "true" }));
    expect(byDelivery.orders.map((o) => [o.orderNumber, o.rows!.map((r) => r.articleNumber)])).toEqual([["KO-1", ["B-200"]]]);
  });

  it("CSV has one line per row when rows are shown, one per order otherwise", async () => {
    await fixture();
    const perOrder = await service.getCsv("sales", sales());
    expect(perOrder.filename).toMatch(/^orderforteckning-kundorder-\d{4}-\d{2}-\d{2}\.csv$/);
    const orderLines = perOrder.content.trim().split("\r\n");
    expect(orderLines[0]).toContain("Ordervärde");
    expect(orderLines).toHaveLength(4);
    expect(orderLines[1]).toContain("KO-1;2026-01-10;10001;Anna Storkök AB;Bekräftad;SEK;2026-02-01;2;1000,00;540,00");

    const perRow = await service.getCsv("sales", sales({ withRows: "true" }));
    const rowLines = perRow.content.trim().split("\r\n");
    expect(rowLines).toHaveLength(5);
    expect(rowLines[0]).toContain("Rabatt %");
  });

  it("PDF prints the selection, the orders and the totals", async () => {
    await fixture();
    const { filename, content } = await service.getPdf("sales", sales({ status: "open", withRows: "true" }));
    expect(filename).toMatch(/\.pdf$/);
    const text = pdfText(content);
    expect(text).toContain("Orderförteckning kundorder");
    expect(text).toContain("Öppna ordrar");
    expect(text).toContain("KO-1");
    expect(text).toContain("Diskbänk");
    expect(text).not.toContain("KO-2");
    expect(text).toContain("1 ordrar, 2 rader");
  });
});

describe("orderförteckning inköp", () => {
  it("values are in the order's currency with ställpris and row units; totals in SEK", async () => {
    await fixture();
    const result = await service.get("purchase", purchase({ withRows: "true" }));
    const io = result.orders[0]!;
    expect(io).toMatchObject({
      orderNumber: "IO-1",
      orderDate: "2026-01-21",
      currency: "EUR",
      // 70 + 120, rest: 70 (ställpris still open) + 8 × 10
      orderValue: 190,
      restValue: 150,
      // Bekräftat leveransdatum wins over Önskat
      deliveryDate: "2026-02-14",
    });
    expect(io.rows!.map((r) => [r.quantity, r.done, r.rest, r.unit, r.unitPrice, r.amount, r.restAmount])).toEqual([
      [5, 0, 5, "st-or", 10, 70, 70],
      [3, 1, 2, "frp-or", 40, 120, 80],
    ]);
    expect(result.totals).toMatchObject({ orderValueSek: 2185, restValueSek: 1725, converted: true });

    const text = pdfText((await service.getPdf("purchase", purchase())).content);
    expect(text).toContain("Orderförteckning inköp");
    expect(text).toContain("Summa i SEK");
  });

  it("confirmed delivery dates drive the delivery date range", async () => {
    await fixture();
    expect((await service.get("purchase", purchase({ dateBasis: "delivery", to: "2026-02-12" }))).orders).toHaveLength(0);
    expect((await service.get("purchase", purchase({ dateBasis: "delivery", to: "2026-02-14" }))).orders).toHaveLength(1);
  });
});

it("refuses a selection over the row ceiling instead of cutting it", async () => {
  const row = { orderId: "o", orderNumber: "KO-1", status: "confirmed", orderDate: "2026-01-01", partnerNumber: "1", partnerName: "x",
    currency: "SEK", exchangeRate: 1, articleNumber: "A", articleName: "A", unitCode: null, unitFactor: null, quantity: 1, done: 0,
    unitPrice: 1, discountPercent: 0, setupPrice: null, deliveryDate: null };
  const fake = createOrderRegisterService({
    loadSalesRows: async (_q, limit) => Array.from({ length: limit }, () => row),
    loadPurchaseRows: async () => [],
  });
  await expect(fake.get("sales", sales())).rejects.toThrow(OrderRegisterTooLargeError);
  expect(ORDER_REGISTER_MAX_ROWS).toBe(10_000);
});
