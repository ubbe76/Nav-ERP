import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  db,
  deliveryRows,
  salesOrderRows,
  salesOrders,
  shipmentDeliveries,
  shipments,
  stockLocations,
  stockTransactions,
} from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import {
  createSalesService,
  DeliveryNotFoundError,
  DeliveryOnShipmentError,
  DeliveryRowAlreadyUndoneError,
  DeliveryRowInvoicedError,
  DeliveryRowNotFoundError,
  DeliveryRowNotInDeliveryError,
  DeliveryRowNotUndoableError,
  DeliveryUndoneError,
  InvalidStatusTransitionError,
} from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { ShipmentDeliveryUndoneError } from "../src/modules/shipping/service/shipping.errors.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockService, LocationUnderStockCountError } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";

// Ångra utleverans: one delivery row reversed — stock back where it was
// taken from, the order row's delivered quantity, the order status — and the
// readers that must leave undone rows out (följesedel, pallkort, frakt).

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const stockCountRepo = createStockCountRepository(db);
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  createRegisterService(createRegisterRepository(db)),
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository
);
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  documentPdfService,
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  auditRepository,
  articleService
);
const shippingRepository = createShippingRepository(db);

const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, shipment_deliveries, shipments, audit_log, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  await setupPostingBaseline();
  user = await authRepo.create({
    email: `undo-delivery-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Lagerchef",
    role: "admin",
  });
});

afterAll(async () => {
  await db.execute(TABLES);
});

async function makeArticle() {
  return articleService.createArticle({
    articleNumber: `ART-UNDO-${crypto.randomUUID().slice(0, 8)}`,
    name: "Testartikel",
    type: "purchased",
    unit: "st",
    active: true,
  });
}

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${name}`, active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name, active: true });
}

async function balance(articleId: string, locationId: string) {
  const [row] = await db
    .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(row!.quantity);
}

async function orderStatus(orderId: string) {
  const [order] = await db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, orderId));
  return order!.status;
}

async function delivered(rowId: string) {
  const [row] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, rowId));
  return Number(row!.quantityDelivered);
}

// Two rows (A 10 st, B 5 st), stocked with exactly the ordered quantities at
// one location and pushed to in_production.
async function makeOrder(stockA = 10, stockB = 5) {
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  const articleA = await makeArticle();
  const articleB = await makeArticle();
  const location = await makeLocation();
  await stockService.recordTransaction({ articleId: articleA.id, locationId: location.id, quantityDelta: stockA, transactionType: "inventory_adjustment" });
  await stockService.recordTransaction({ articleId: articleB.id, locationId: location.id, quantityDelta: stockB, transactionType: "inventory_adjustment" });
  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      rows: [
        { articleId: articleA.id, quantity: 10, unitPrice: 10 },
        { articleId: articleB.id, quantity: 5, unitPrice: 20 },
      ],
    },
    user.id
  );
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);
  return {
    customer,
    articleA,
    articleB,
    location,
    order,
    rowA: rows.find((r) => r.articleId === articleA.id)!,
    rowB: rows.find((r) => r.articleId === articleB.id)!,
  };
}

async function deliver(orderId: string, locationId: string, rows: { rowId: string; quantity: number }[]) {
  const result = await salesService.deliverBatch(orderId, { locationId, rows }, user.id);
  const dRows = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
  const byOrderRow = (rowId: string) => dRows.find((r) => r.salesOrderRowId === rowId)!;
  return { ...result, byOrderRow };
}

describe("Ångra utleverans — one row", () => {
  it("links each delivery row to its location and stock movement", async () => {
    const { order, rowA, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 4 }]);
    const row = d.byOrderRow(rowA.id);
    expect(row.locationId).toBe(location.id);
    const [movement] = await db.select().from(stockTransactions).where(eq(stockTransactions.id, row.stockTransactionId!));
    expect(movement!.quantityDelta).toBe("-4.0000");
    expect(movement!.transactionType).toBe("sales_delivery");
  });

  it("puts the goods back, lowers the delivered quantity, reopens the order and leaves the other row alone", async () => {
    const { order, articleA, articleB, rowA, rowB, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [
      { rowId: rowA.id, quantity: 10 },
      { rowId: rowB.id, quantity: 5 },
    ]);
    expect(d.orderStatus).toBe("delivered");
    expect(await balance(articleA.id, location.id)).toBe(0);

    const result = await salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id);

    expect(result.orderStatus).toBe("in_production");
    expect(result.undoneAt).toBeInstanceOf(Date);
    expect(await orderStatus(order.id)).toBe("in_production");
    expect(await delivered(rowA.id)).toBe(0);
    expect(await delivered(rowB.id)).toBe(5);
    expect(await balance(articleA.id, location.id)).toBe(10);
    expect(await balance(articleB.id, location.id)).toBe(0);

    // The return movement: positive, same type, no unit_cost (D0 — it comes
    // back at the moving average it left with).
    const movements = await db
      .select()
      .from(stockTransactions)
      .where(and(eq(stockTransactions.referenceId, order.id), eq(stockTransactions.articleId, articleA.id)));
    const back = movements.find((m) => Number(m.quantityDelta) > 0)!;
    expect(back.transactionType).toBe("sales_delivery");
    expect(back.unitCost).toBeNull();

    const [undone] = await db.select().from(deliveryRows).where(eq(deliveryRows.id, d.byOrderRow(rowA.id).id));
    expect(undone!.undoneBy).toBe(user.id);
    const [other] = await db.select().from(deliveryRows).where(eq(deliveryRows.id, d.byOrderRow(rowB.id).id));
    expect(other!.undoneAt).toBeNull();

    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "delivery_row_undone"));
    expect(log!.entityId).toBe(d.deliveryNumber);
    expect(log!.detail).toMatchObject({
      orderNumber: order.orderNumber,
      articleNumber: articleA.articleNumber,
      quantity: 10,
      statusBefore: "delivered",
      statusAfter: "in_production",
    });

    // The row can be delivered again — on a new följesedel.
    const again = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 10 }]);
    expect(again.deliveryNumber).not.toBe(d.deliveryNumber);
    expect(again.orderStatus).toBe("delivered");
  });

  it("reactivates the location the delivery emptied", async () => {
    const { order, articleA, rowA } = await makeOrder();
    const shelf = await makeLocation("B7");
    await stockService.recordTransaction({ articleId: articleA.id, locationId: shelf.id, quantityDelta: 3, transactionType: "inventory_adjustment" });
    const d = await deliver(order.id, shelf.id, [{ rowId: rowA.id, quantity: 3 }]);
    const [emptied] = await db.select().from(stockLocations).where(eq(stockLocations.id, shelf.id));
    expect(emptied!.active).toBe(false);

    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id);

    const [back] = await db.select().from(stockLocations).where(eq(stockLocations.id, shelf.id));
    expect(back!.active).toBe(true);
    expect(await balance(articleA.id, shelf.id)).toBe(3);
  });

  it("refuses a row twice, a row of another följesedel and a följesedel of another order", async () => {
    const { order, rowA, rowB, location } = await makeOrder();
    const first = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 2 }]);
    const second = await deliver(order.id, location.id, [{ rowId: rowB.id, quantity: 2 }]);
    const other = await makeOrder();

    await salesService.undoDeliveryRow(order.id, first.deliveryId, first.byOrderRow(rowA.id).id, user.id);
    await expect(
      salesService.undoDeliveryRow(order.id, first.deliveryId, first.byOrderRow(rowA.id).id, user.id)
    ).rejects.toBeInstanceOf(DeliveryRowAlreadyUndoneError);
    await expect(
      salesService.undoDeliveryRow(order.id, first.deliveryId, second.byOrderRow(rowB.id).id, user.id)
    ).rejects.toBeInstanceOf(DeliveryRowNotFoundError);
    await expect(
      salesService.undoDeliveryRow(other.order.id, second.deliveryId, second.byOrderRow(rowB.id).id, user.id)
    ).rejects.toBeInstanceOf(DeliveryNotFoundError);
  });

  it("lets exactly one of two concurrent undos of the same row through", async () => {
    const { order, articleA, rowA, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 6 }]);
    const rowId = d.byOrderRow(rowA.id).id;

    const results = await Promise.allSettled([
      salesService.undoDeliveryRow(order.id, d.deliveryId, rowId, user.id),
      salesService.undoDeliveryRow(order.id, d.deliveryId, rowId, user.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DeliveryRowAlreadyUndoneError);
    expect(await delivered(rowA.id)).toBe(0);
    expect(await balance(articleA.id, location.id)).toBe(10);
  });

  it("refuses a row without a stock link (an old delivery the backfill could not pair)", async () => {
    const { order, rowA, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 2 }]);
    await db
      .update(deliveryRows)
      .set({ stockTransactionId: null, locationId: null })
      .where(eq(deliveryRows.id, d.byOrderRow(rowA.id).id));

    await expect(
      salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id)
    ).rejects.toBeInstanceOf(DeliveryRowNotUndoableError);
  });

  it("refuses unless the order is in production or delivered", async () => {
    const { order, rowA, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 2 }]);
    await db.update(salesOrders).set({ status: "invoiced" }).where(eq(salesOrders.id, order.id));

    await expect(
      salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id)
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("refuses while the location is under a blocking count, and writes nothing", async () => {
    const { order, articleA, rowA, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 4 }]);
    await stockCountRepo.createSession({ locationId: location.id, blocksTransactions: true }, null);

    await expect(
      salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id)
    ).rejects.toBeInstanceOf(LocationUnderStockCountError);
    expect(await delivered(rowA.id)).toBe(4);
    expect(await balance(articleA.id, location.id)).toBe(6);
  });
});

describe("Ångra utleverans — invoicing", () => {
  it("refuses a row whose quantity is invoiced, row by row, until the invoice is credited", async () => {
    const { order, customer, articleA, rowA, location } = await makeOrder();
    const first = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 6 }]);
    const second = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 4 }]);
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Del", articleId: articleA.id, salesOrderRowId: rowA.id, quantity: 6, unitPrice: 10 }],
      },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, user.id);

    // 10 delivered, 6 invoiced: undoing the 4 leaves 6 ≥ 6 …
    await salesService.undoDeliveryRow(order.id, second.deliveryId, second.byOrderRow(rowA.id).id, user.id);
    // … but undoing the 6 would leave 0 < 6.
    const refused = salesService.undoDeliveryRow(order.id, first.deliveryId, first.byOrderRow(rowA.id).id, user.id);
    await expect(refused).rejects.toBeInstanceOf(DeliveryRowInvoicedError);
    await expect(refused).rejects.toThrow(/kreditera fakturan eller ta bort fakturautkastet/);

    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    await invoiceService.issue(credit!.id, user.id);
    await salesService.undoDeliveryRow(order.id, first.deliveryId, first.byOrderRow(rowA.id).id, user.id);
    expect(await delivered(rowA.id)).toBe(0);
  });

  it("counts a draft invoice too", async () => {
    const { order, customer, articleA, rowA, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 5 }]);
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Utkast", articleId: articleA.id, salesOrderRowId: rowA.id, quantity: 1, unitPrice: 10 }],
      },
      user.id
    );

    await expect(
      salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id)
    ).rejects.toBeInstanceOf(DeliveryRowInvoicedError);

    await invoiceService.cancel(draft!.id, user.id);
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id);
  });
});

describe("Ångra utleverans — frakt", () => {
  async function makeShipment(customerId: string, deliveryId: string, active = true) {
    const [shipment] = await db
      .insert(shipments)
      .values({
        shipmentNumber: `FR-${crypto.randomUUID().slice(0, 8)}`,
        customerId,
        recipientName: "Kund AB",
        pickupDate: "2030-01-07",
        pickupFrom: "08:00",
        pickupTo: "16:00",
        status: active ? "draft" : "cancelled",
      })
      .returning();
    await db.insert(shipmentDeliveries).values({ shipmentId: shipment!.id, deliveryId, active });
    return shipment!;
  }

  it("refuses while the följesedel is on a live shipment, not once the shipment is cancelled", async () => {
    const { order, customer, rowA, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 2 }]);
    const shipment = await makeShipment(customer.id, d.deliveryId);

    const refused = salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id);
    await expect(refused).rejects.toBeInstanceOf(DeliveryOnShipmentError);
    await expect(refused).rejects.toThrow(shipment.shipmentNumber);

    await db.update(shipmentDeliveries).set({ active: false }).where(eq(shipmentDeliveries.shipmentId, shipment.id));
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id);
  });

  it("keeps undone rows out of the parcel quantities and a fully undone följesedel out of shipments", async () => {
    const { order, customer, articleB, rowA, rowB, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [
      { rowId: rowA.id, quantity: 4 },
      { rowId: rowB.id, quantity: 2 },
    ]);
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowA.id).id, user.id);

    expect(await shippingRepository.deliveredQuantities([d.deliveryId])).toEqual([{ articleId: articleB.id, quantity: 2 }]);
    expect((await shippingRepository.findDeliveries([d.deliveryId]))[0]!.live).toBe(true);
    expect((await shippingRepository.listOpenDeliveries(customer.id)).map((o) => o.id)).toEqual([d.deliveryId]);

    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowB.id).id, user.id);
    expect((await shippingRepository.findDeliveries([d.deliveryId]))[0]!.live).toBe(false);
    expect(await shippingRepository.listOpenDeliveries(customer.id)).toEqual([]);
    await expect(
      shippingRepository.insertShipment(
        {
          shipmentNumber: "FR-UNDONE",
          customerId: customer.id,
          recipientName: "Kund AB",
          pickupDate: "2030-01-07",
          pickupFrom: "08:00",
          pickupTo: "16:00",
        },
        [d.deliveryId],
        []
      )
    ).rejects.toBeInstanceOf(ShipmentDeliveryUndoneError);
  });
});

describe("Ångra utleverans — följesedel, pallkort and listings", () => {
  it("marks undone rows and the fully undone följesedel, and keeps 'Tidigare levererat' right", async () => {
    const { order, articleA, articleB, rowA, rowB, location } = await makeOrder();
    const first = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 4 }]);
    const second = await deliver(order.id, location.id, [
      { rowId: rowA.id, quantity: 3 },
      { rowId: rowB.id, quantity: 5 },
    ]);
    const third = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 2 }]);

    // The middle occasion's row A is undone: the third occasion's "Tidigare
    // levererat" is now 4 (the first), not 7.
    await salesService.undoDeliveryRow(order.id, second.deliveryId, second.byOrderRow(rowA.id).id, user.id);
    const thirdText = pdfText((await salesService.deliveryNotePdf(third.deliveryId)).pdf);
    expect(thirdText).toContain(`${articleA.articleNumber}Testartikel2st4`);

    const secondText = pdfText((await salesService.deliveryNotePdf(second.deliveryId)).pdf);
    expect(secondText).toMatch(/Ångrad \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(secondText).toContain(`${articleB.articleNumber}Testartikel5st0`);
    // Only a row is undone — the header carries no Ångrad line.
    expect(secondText).not.toMatch(/Leveransdatum: \d{4}-\d{2}-\d{2}Ångrad/);

    await salesService.undoDeliveryRow(order.id, first.deliveryId, first.byOrderRow(rowA.id).id, user.id);
    const firstText = pdfText((await salesService.deliveryNotePdf(first.deliveryId)).pdf);
    expect(firstText).toMatch(/Leveransdatum: \d{4}-\d{2}-\d{2}Ångrad \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);

    const list = await salesService.listDeliveries(order.id);
    expect(list.find((x) => x.id === first.deliveryId)).toMatchObject({ rowCount: 1, undoneRowCount: 1 });
    expect(list.find((x) => x.id === second.deliveryId)).toMatchObject({ rowCount: 2, undoneRowCount: 1 });
    expect(list.find((x) => x.id === third.deliveryId)).toMatchObject({ rowCount: 1, undoneRowCount: 0 });

    const rows = await salesService.deliveryRows(second.deliveryId);
    expect(rows.rows.find((r) => r.articleNumber === articleA.articleNumber)).toMatchObject({
      undoable: false,
      undoneByName: "Lagerchef",
    });
    expect(rows.rows.find((r) => r.articleNumber === articleB.articleNumber)).toMatchObject({
      undoable: true,
      undoneAt: null,
      undoneByName: null,
    });
  });

  it("leaves undone rows off the pallet card and refuses a fully undone följesedel", async () => {
    const { order, rowA, rowB, location } = await makeOrder();
    const d = await deliver(order.id, location.id, [
      { rowId: rowA.id, quantity: 4 },
      { rowId: rowB.id, quantity: 2 },
    ]);
    const undoneRowId = d.byOrderRow(rowA.id).id;
    await salesService.undoDeliveryRow(order.id, d.deliveryId, undoneRowId, user.id);

    // One card, B's (the card shortens the article number — check the antal).
    const text = pdfText((await salesService.deliveryPalletCardPdf(d.deliveryId)).pdf);
    expect(text).toContain("ANTAL2 st");
    expect(text).not.toContain("ANTAL4 st");
    expect(text).toContain("Kolli 1 av 1");
    await expect(
      salesService.deliveryPalletCardPdf(d.deliveryId, [{ deliveryRowId: undoneRowId, quantities: [4] }])
    ).rejects.toBeInstanceOf(DeliveryRowNotInDeliveryError);

    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.byOrderRow(rowB.id).id, user.id);
    await expect(salesService.deliveryPalletCardPdf(d.deliveryId)).rejects.toBeInstanceOf(DeliveryUndoneError);
  });
});

describe("Ångra utleverans — migration 0132's backfill", () => {
  // The test database migrates from empty, so the backfill ran against no
  // deliveries. Re-run that exact statement — read from the migration file —
  // against deliveries whose links are cleared, as it ran in production.
  function backfillSql() {
    const migration = readFileSync(
      new URL("../../../packages/db/drizzle/0132_delivery_row_undo.sql", import.meta.url),
      "utf8"
    );
    const statement = migration
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => /^WITH dr AS/m.test(s));
    expect(statement, "0132 must contain the backfill").toBeDefined();
    return statement!.slice(statement!.search(/^WITH dr AS/m));
  }

  it("pairs each delivery row with its own movement, also two rows of one article on one följesedel", async () => {
    const { order, articleA, rowA, rowB, location } = await makeOrder(20, 5);
    // A second row of article A — what two configured rows of one template
    // look like (the unique (order, article) index skips configured rows).
    const [rowA2] = await db
      .insert(salesOrderRows)
      .values({
        salesOrderId: order.id,
        articleId: articleA.id,
        quantityOrdered: "4",
        unitPrice: "10",
        configuration: { templateArticleId: articleA.id, key: "x", selection: [] },
      })
      .returning();
    const first = await deliver(order.id, location.id, [
      { rowId: rowA.id, quantity: 4 },
      { rowId: rowA2!.id, quantity: 4 },
      { rowId: rowB.id, quantity: 5 },
    ]);
    const second = await deliver(order.id, location.id, [{ rowId: rowA.id, quantity: 4 }]);
    const before = await db.select().from(deliveryRows).orderBy(deliveryRows.id);
    // An undone row's link stays as it is; clear the others like a pre-0132
    // database.
    await db.update(deliveryRows).set({ locationId: null, stockTransactionId: null });

    await db.execute(sql.raw(backfillSql()));

    const after = await db.select().from(deliveryRows).orderBy(deliveryRows.id);
    expect(after.map((r) => [r.id, r.locationId])).toEqual(before.map((r) => [r.id, location.id]));
    const ids = after.map((r) => r.stockTransactionId);
    expect(ids.every((id) => id !== null)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    // Same-article rows may swap movements between them — equivalent — but
    // never across occasions.
    const firstIds = new Set(before.filter((r) => r.deliveryId === first.deliveryId).map((r) => r.stockTransactionId));
    for (const r of after.filter((r) => r.deliveryId === first.deliveryId)) expect(firstIds.has(r.stockTransactionId)).toBe(true);
    const [secondRow] = after.filter((r) => r.deliveryId === second.deliveryId);
    expect(secondRow!.stockTransactionId).toBe(before.find((r) => r.deliveryId === second.deliveryId)!.stockTransactionId);
  });
});
