import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createRoutingOperationSchema, createWorkCenterSchema } from "@navet/shared";
import { pdfPageCount, pdfText } from "./helpers/pdf.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  InvalidStatusTransitionError,
  MOOperationNotFoundError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { testArticleService } from "./helpers/services.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";

// Pallkort (Etapp F): the card placed on the pallet when an operation is
// reported (manufacturing) or a delivery leaves (sales). Same service
// construction as manufacturing-sales-link.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const fakeTransportFactory: MailTransportFactory = () => ({ async sendMail() {} });
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
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

const mfgService = createManufacturingService(createManufacturingRepository(db), documentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});

const TRUNCATE = sql`TRUNCATE email_log, delivery_rows, deliveries, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `pallkort-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Operator",
    role: "admin",
  });
}

// Short article numbers on purpose — the card prints them in 30 pt with
// ellipsis, so a UUID-length number would be truncated in the assertions.
async function makeRoutedArticle(articleNumber: string) {
  const workCenter = await mfgService.createWorkCenter(createWorkCenterSchema.parse({ code: "100", name: "Svets" }));
  const article = await articleService.createArticle({
    articleNumber,
    name: "Diskbänk 1200",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  await mfgService.createRoutingOperation(
    article.id,
    createRoutingOperationSchema.parse({
      sequenceNo: 10,
      description: "Kapning",
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 2,
    })
  );
  await mfgService.createRoutingOperation(
    article.id,
    createRoutingOperationSchema.parse({
      sequenceNo: 20,
      description: "Montering",
      workCenterId: workCenter.id,
      setupTime: 5,
      runTimePerUnit: 1,
    })
  );
  return article;
}

// A released KO-linked TO on a two-operation routing — the "final card on
// the last operation" case this feature exists for.
async function makeLinkedReleasedMo(customerOrderNumber?: string) {
  const user = await makeUser();
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  const article = await makeRoutedArticle("PALL-FIN");
  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      confirm: true,
      customerOrderNumber,
      rows: [{ articleId: article.id, quantity: 10, unitPrice: 100 }],
    },
    user.id
  );
  const mo = await mfgService.createManufacturingOrder({ quantity: 10, salesOrderRowId: rows[0]!.id }, null);
  const operations = (await mfgService.listOperations(mo.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { user, customer, article, order, mo, op10: operations[0]!, op20: operations[1]! };
}

async function makeUnlinkedReleasedMo() {
  const article = await makeRoutedArticle("PALL-INT");
  const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, null);
  const operations = (await mfgService.listOperations(mo.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { article, mo, op10: operations[0]!, op20: operations[1]! };
}

describe("pallkort — TO operation (GET .../operations/:opId/pallet-card)", () => {
  it("prints the final card on the last operation of a KO-linked TO: customer, both order numbers, explicit quantity", async () => {
    const { order, mo, op20 } = await makeLinkedReleasedMo("KUND-PO-77");

    const { filename, content } = await mfgService.getOperationPalletCardPdf(mo.id, op20.id, 7);
    const text = pdfText(content);

    expect(filename).toBe(`pallkort-${mo.orderNumber}-op20.pdf`);
    expect(text).toContain("PALLKORT");
    expect(text).toContain("PALL-FIN");
    expect(text).toContain("BENÄMNING");
    expect(text).toContain("Diskbänk 1200");
    expect(text).toContain("Kund AB");
    expect(text).toContain("KUND-PO-77");
    expect(text).toContain(order.orderNumber);
    expect(text).toContain("7 st");
    // The final card names no next operation.
    expect(text).not.toContain("NÄSTA OPERATION");
  });

  it("prints '—' when the linked order has no customer order number", async () => {
    const { mo, op20 } = await makeLinkedReleasedMo();

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op20.id)).content);

    expect(text).toContain("KUNDENS ORDERNUMMER");
    expect(text).toContain("—");
  });

  it("prints the internal card on a non-last operation: TO number and next operation, no customer", async () => {
    const { mo, op10 } = await makeLinkedReleasedMo("KUND-PO-77");

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op10.id, 3)).content);

    expect(text).toContain("BENÄMNING");
    expect(text).toContain("Diskbänk 1200");
    expect(text).toContain("TILLVERKNINGSORDER");
    expect(text).toContain(mo.orderNumber);
    // Next operation = lowest sequence number after this one, description first,
    // rendered side by side with TILLVERKNINGSORDER under its own label.
    expect(text).toContain("NÄSTA OPERATION");
    expect(text).toContain("20 · Montering");
    expect(text).toContain("3 st");
    // A pallet moving to the next operation names no customer.
    expect(text).not.toContain("Kund AB");
    expect(text).not.toContain("KUND-PO-77");
  });

  it("prints the internal card without a next-operation row on the last op of an UNLINKED TO", async () => {
    const { mo, op20 } = await makeUnlinkedReleasedMo();

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op20.id)).content);

    expect(text).toContain("TILLVERKNINGSORDER");
    expect(text).toContain(mo.orderNumber);
    expect(text).not.toContain("NÄSTA OPERATION");
    // No ?quantity and nothing reported — falls back to the order quantity.
    expect(text).toContain("5 st");
  });

  it("defaults the quantity to the operation's accumulated OK quantity when reported", async () => {
    const { mo, op10 } = await makeUnlinkedReleasedMo();
    await mfgService.reportOperationQuantities(op10.id, {
      quantityOk: 4,
      quantityScrapped: 0,
      markDone: false,
      createdBy: null,
    });

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op10.id)).content);

    expect(text).toContain("4 st");
  });

  it("rejects a planned order (no operations snapshotted yet) with InvalidStatusTransitionError", async () => {
    const article = await makeRoutedArticle("PALL-PLAN");
    const mo = await insertPlannedManufacturingOrder({ articleId: article.id, quantity: 5 });

    await expect(
      mfgService.getOperationPalletCardPdf(mo.id, "00000000-0000-0000-0000-000000000000")
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("404s an operation id that does not belong to the order", async () => {
    const { mo } = await makeUnlinkedReleasedMo();

    await expect(
      mfgService.getOperationPalletCardPdf(mo.id, "00000000-0000-0000-0000-000000000000")
    ).rejects.toBeInstanceOf(MOOperationNotFoundError);
  });
});

describe("pallkort — delivery (GET /deliveries/:id/pallet-card)", () => {
  it("renders one card page per delivered row, all in the final variant", async () => {
    const user = await makeUser();
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const articleA = await articleService.createArticle({
      articleNumber: "PALL-A",
      name: "Modul A",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const articleB = await articleService.createArticle({
      articleNumber: "PALL-B",
      name: "Modul B",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    for (const article of [articleA, articleB]) {
      await stockService.recordTransaction({
        articleId: article.id,
        locationId: location.id,
        quantityDelta: 10,
        transactionType: "inventory_adjustment",
      });
    }

    const { order, rows } = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        customerOrderNumber: "KUND-PO-88",
        rows: [
          { articleId: articleA.id, quantity: 10, unitPrice: 10 },
          { articleId: articleB.id, quantity: 5, unitPrice: 20 },
        ],
      },
      user.id
    );
    await salesService.startProduction(order.id);
    const rowA = rows.find((r) => r.articleId === articleA.id)!;
    const rowB = rows.find((r) => r.articleId === articleB.id)!;

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

    const { pdf, filename } = await salesService.deliveryPalletCardPdf(result.deliveryId);
    const text = pdfText(pdf);

    expect(filename).toBe(`pallkort-${result.deliveryNumber}.pdf`);
    expect(pdfPageCount(pdf)).toBe(2);
    expect(text).toContain("PALL-A");
    expect(text).toContain("PALL-B");
    expect(text).toContain("Kund AB");
    expect(text).toContain("KUND-PO-88");
    expect(text).toContain(order.orderNumber);
    expect(text).toContain("10 st");
    expect(text).toContain("5 st");
  });
});
