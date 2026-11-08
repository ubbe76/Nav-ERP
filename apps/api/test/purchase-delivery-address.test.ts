import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companyInfo, db } from "@navet/db";
import {
  updateCompanyInfoSchema,
  updatePurchaseOrderHeaderSchema,
  createArticleSchema,
  createCustomerSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  createWorkCenterSchema,
} from "@navet/shared";
import { pdfText } from "./helpers/pdf.js";
import {
  testArticleService,
  testDocumentPdfService,
  testSystemService,
} from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import {
  createPurchaseService,
  InvalidStatusTransitionError,
} from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { parsed } from "./helpers/parsed.js";

// Leveransadress på inköpsordern (avsändning lego): the snapshot on the
// order, the header PATCH's status guard and revision, the IO PDF's three
// fallbacks (chosen → company godsadress → company address), the linked
// sales orders behind the lego rows and the company's new godsadress fields.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(
  createMailRepository(db),
  testSystemService,
);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  testArticleService,
  testSystemService,
  (query) => resolvePrice(db, query),
);
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
);

const TABLES = sql`TRUNCATE purchase_order_dispatches, purchase_receipts, purchase_order_rows, purchase_orders, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, sales_order_rows, sales_orders, customer_delivery_addresses, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
  await db
    .update(companyInfo)
    .set({
      name: "Testbolaget AB",
      address: "Fabriksgatan 1",
      postalCode: "111 11",
      city: "Fabriksstaden",
      deliveryAddress: null,
      deliveryPostalCode: null,
      deliveryCity: null,
    });
});

afterAll(async () => {
  await db.execute(TABLES);
  await db
    .update(companyInfo)
    .set({
      deliveryAddress: null,
      deliveryPostalCode: null,
      deliveryCity: null,
    });
});

async function makeOrder(language: "sv" | "en" = "sv") {
  const user = await authRepo.create({
    email: `adr-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Inköparen",
    role: "admin",
  });
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, {
    name: "Leverantören AB",
    active: true,
    language,
    address: "Levgatan 2",
    postalCode: "222 22",
    city: "Levstaden",
  }));
  const article = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `ART-${crypto.randomUUID().slice(0, 8)}`,
    name: "Plåt",
    type: "purchased",
    active: true,
  }));
  const order = await purchaseService.createPurchaseOrder(
    parsed(createPurchaseOrderSchema, { supplierId: supplier.id }),
    user.id,
  );
  await purchaseService.addRow(order.id, {
    articleId: article.id,
    quantity: 3,
    unitPrice: 10,
  });
  return { user, supplier, article, order };
}

const customerAddress = {
  name: "Kund AB",
  address: "Byggvägen 5\nPort B",
  postalCode: "444 44",
  city: "Byggstaden",
  country: "NO",
};

describe("Leveransadress on the purchase order", () => {
  it("is null by default, set as a snapshot by the header PATCH, cleared with null, and bumps the revision like other header changes", async () => {
    const { order } = await makeOrder();
    const before = (await purchaseService.getPurchaseOrder(order.id))!;
    expect(before.deliveryAddress).toBeNull();
    expect(before.linkedSalesOrders).toEqual([]);
    expect(before.revision).toBe(2);

    await purchaseService.updatePurchaseOrderHeader(order.id, {
      deliveryAddress: customerAddress,
    });
    const withAddress = (await purchaseService.getPurchaseOrder(order.id))!;
    expect(withAddress.deliveryAddress).toEqual(customerAddress);
    expect(withAddress.revision).toBe(3);

    // A later country-less address defaults to SE (the schema), and
    // bumpRevision: false leaves the revision alone.
    const parsed = updatePurchaseOrderHeaderSchema.parse({
      deliveryAddress: { name: " Eget lager ", address: "Lagervägen 1" },
      bumpRevision: false,
    });
    await purchaseService.updatePurchaseOrderHeader(order.id, parsed);
    const second = (await purchaseService.getPurchaseOrder(order.id))!;
    expect(second.deliveryAddress).toEqual({
      name: "Eget lager",
      address: "Lagervägen 1",
      postalCode: null,
      city: null,
      country: "SE",
    });
    expect(second.revision).toBe(3);

    await purchaseService.updatePurchaseOrderHeader(order.id, {
      deliveryAddress: null,
    });
    const cleared = (await purchaseService.getPurchaseOrder(order.id))!;
    expect(cleared.deliveryAddress).toBeNull();
    expect(cleared.deliveryName).toBeNull();
    expect(cleared.revision).toBe(4);

    // Omitted = untouched.
    await purchaseService.updatePurchaseOrderHeader(order.id, {
      deliveryAddress: customerAddress,
    });
    await purchaseService.updatePurchaseOrderHeader(order.id, { note: "hej" });
    expect(
      (await purchaseService.getPurchaseOrder(order.id))!.deliveryAddress,
    ).toEqual(customerAddress);

    expect(
      updatePurchaseOrderHeaderSchema.safeParse({
        deliveryAddress: { name: "", address: "x" },
      }).success,
    ).toBe(false);
    expect(
      updatePurchaseOrderHeaderSchema.safeParse({
        deliveryAddress: { name: "x", address: "" },
      }).success,
    ).toBe(false);
  });

  it("follows the header's status guard: refused once the order is received", async () => {
    const { user, order } = await makeOrder();
    await purchaseService.confirm(order.id);
    await purchaseService.updatePurchaseOrderHeader(order.id, {
      deliveryAddress: customerAddress,
    });
    const [row] = await purchaseService.listRows(order.id);
    await purchaseService.receiveGoods(
      order.id,
      row!.id,
      { quantity: 3 },
      user.id,
    );
    await expect(
      purchaseService.updatePurchaseOrderHeader(order.id, {
        deliveryAddress: null,
      }),
    ).rejects.toThrow(InvalidStatusTransitionError);
    expect(
      (await purchaseService.getPurchaseOrder(order.id))!.deliveryAddress,
    ).toEqual(customerAddress);
  });

  it("the IO PDF always prints Leveransadress: the chosen address, else the company godsadress, else the company address", async () => {
    const { order } = await makeOrder();
    let text = pdfText(
      (await purchaseService.getPurchaseOrderPdf(order.id)).content,
    );
    expect(text).toContain("LEVERANSADRESS");
    expect(text).toContain("Testbolaget AB");
    expect(text).toContain("Fabriksgatan 1");
    expect(text).toContain("111 11 Fabriksstaden");

    await db
      .update(companyInfo)
      .set({
        deliveryAddress: "Godsmottagningen 2",
        deliveryPostalCode: "555 55",
        deliveryCity: "Godsorten",
      });
    text = pdfText(
      (await purchaseService.getPurchaseOrderPdf(order.id)).content,
    );
    expect(text).toContain("Godsmottagningen 2");
    expect(text).toContain("555 55 Godsorten");
    // The company header keeps the company address; the delivery block shows the godsadress.
    expect(text).toContain("Fabriksgatan 1");

    await purchaseService.updatePurchaseOrderHeader(order.id, {
      deliveryAddress: customerAddress,
    });
    text = pdfText(
      (await purchaseService.getPurchaseOrderPdf(order.id)).content,
    );
    expect(text).toContain("Kund AB");
    expect(text).toContain("Byggvägen 5");
    expect(text).toContain("Port B");
    expect(text).toContain("444 44 Byggstaden");
    expect(text).toContain("Norge");
    expect(text).not.toContain("Godsmottagningen 2");

    // The inquiry deliberately has no delivery address.
    const supplierId = (await purchaseService.getPurchaseOrder(order.id))!
      .supplierId;
    const [article] = await purchaseService.listRows(order.id);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId, rows: [{ articleId: article!.articleId, quantity: 1 }] },
      (
        await authRepo.create({
          email: `q-${crypto.randomUUID()}@example.com`,
          passwordHash: "x",
          name: "Q",
          role: "admin",
        })
      ).id,
    );
    expect(
      pdfText((await purchaseService.getInquiryPdf(inquiry.id)).content),
    ).not.toContain("LEVERANSADRESS");
  });

  it("writes the block in English for an English supplier", async () => {
    const { order } = await makeOrder("en");
    await purchaseService.updatePurchaseOrderHeader(order.id, {
      deliveryAddress: customerAddress,
    });
    const text = pdfText(
      (await purchaseService.getPurchaseOrderPdf(order.id)).content,
    );
    expect(text).toContain("DELIVERY ADDRESS");
    expect(text).toContain("Norway");
    expect(text).not.toContain("LEVERANSADRESS");
    expect(text).not.toContain("Norge");
  });

  it("linkedSalesOrders lists the sales orders behind the lego rows, once each, with the order's delivery address", async () => {
    const { user, supplier } = await makeOrder();
    const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, {
      code: "100",
      name: "Svets",
      type: "machine",
      active: true,
    }));
    const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, {
      code: "900",
      name: "Lack",
      type: "subcontract",
      supplierId: supplier.id,
      active: true,
    }));
    const parent = await articleService.createArticle(parsed(createArticleSchema, {
      articleNumber: `LEGO-${crypto.randomUUID().slice(0, 8)}`,
      name: "Legodetalj",
      type: "manufactured",
      active: true,
    }));
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: machine.id,
      setupTime: 0,
      runTimePerUnit: 1,
    });
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 20,
      workCenterId: lego.id,
      setupTime: 0,
      runTimePerUnit: 0,
      unitPrice: 100,
    });
    const customer = await salesService.createCustomer(parsed(createCustomerSchema, {
      name: "Kund AB",
      active: true,
    }));
    const address = await salesService.createDeliveryAddress(customer.id, {
      label: "Byggplatsen",
      address: "Byggvägen 5",
      postalCode: "444 44",
      city: "Byggstaden",
      country: "NO",
      isDefault: true,
    });
    const withAddress = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        deliveryAddressId: address.id,
        rows: [
          { articleId: parent.id, quantity: 4, unitPrice: 500 },
          { articleId: parent.id, quantity: 2, unitPrice: 500 },
        ],
      },
      user.id,
    );
    const without = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        rows: [{ articleId: parent.id, quantity: 1, unitPrice: 500 }],
      },
      user.id,
    );
    const moA = await mfgService.createManufacturingOrder(
      { quantity: 4, salesOrderRowId: withAddress.rows[0]!.id },
      user.id,
    );
    const moB = await mfgService.createManufacturingOrder(
      { quantity: 2, salesOrderRowId: withAddress.rows[1]!.id },
      user.id,
    );
    const moC = await mfgService.createManufacturingOrder(
      { quantity: 1, salesOrderRowId: without.rows[0]!.id },
      user.id,
    );
    const free = await mfgService.createManufacturingOrder(
      { articleId: parent.id, quantity: 1 },
      user.id,
    );
    const opOf = async (moId: string) =>
      (await mfgService.listOperations(moId)).find(
        (op) => op.sequenceNo === 20,
      )!.id;

    const order = await purchaseService.createPurchaseOrder(
      parsed(createPurchaseOrderSchema, { supplierId: supplier.id }),
      user.id,
    );
    for (const mo of [moA, moB, moC, free]) {
      await purchaseService.addRow(order.id, {
        articleId: parent.id,
        quantity: 1,
        unitPrice: 100,
        moOperationId: await opOf(mo.id),
      });
    }
    const linked = (await purchaseService.getPurchaseOrder(order.id))!
      .linkedSalesOrders;
    expect(linked).toEqual([
      {
        salesOrderId: withAddress.order.id,
        orderNumber: withAddress.order.orderNumber,
        customerId: customer.id,
        customerName: "Kund AB",
        deliveryAddress: {
          label: "Byggplatsen",
          address: "Byggvägen 5",
          postalCode: "444 44",
          city: "Byggstaden",
          country: "NO",
        },
      },
      {
        salesOrderId: without.order.id,
        orderNumber: without.order.orderNumber,
        customerId: customer.id,
        customerName: "Kund AB",
        deliveryAddress: null,
      },
    ]);
  });
});

describe("Företagsinformation — Leveransadress (godsmottagning)", () => {
  it("round-trips the three fields through the service and accepts null to clear them", async () => {
    const parsed = updateCompanyInfoSchema.parse({
      deliveryAddress: "Godsmottagningen 2",
      deliveryPostalCode: "555 55",
      deliveryCity: "Godsorten",
    });
    const updated = (await testSystemService.updateCompanyInfo(parsed))!;
    expect(updated).toMatchObject({
      deliveryAddress: "Godsmottagningen 2",
      deliveryPostalCode: "555 55",
      deliveryCity: "Godsorten",
    });
    expect((await testSystemService.getCompanyInfo())!).toMatchObject({
      deliveryAddress: "Godsmottagningen 2",
      deliveryPostalCode: "555 55",
      deliveryCity: "Godsorten",
      address: "Fabriksgatan 1",
    });

    await testSystemService.updateCompanyInfo(
      updateCompanyInfoSchema.parse({
        deliveryAddress: null,
        deliveryPostalCode: null,
        deliveryCity: null,
      }),
    );
    expect((await testSystemService.getCompanyInfo())!).toMatchObject({
      deliveryAddress: null,
      deliveryPostalCode: null,
      deliveryCity: null,
    });
    expect(
      updateCompanyInfoSchema.safeParse({ deliveryAddress: "x".repeat(256) })
        .success,
    ).toBe(false);
  });
});
