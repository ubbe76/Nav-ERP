import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, freightProducts, salesOrders, shipments } from "@navet/db";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { InvalidFreightProductError } from "../src/modules/sales/service/sales.errors.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import { createFakeFreightProvider, SANDBOX_PRICES } from "./helpers/fake-freight-provider.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery, resetShipping } from "./helpers/shipping-fixtures.js";

const repo = createShippingRepository(db);
const audit = { async log() {} };
const fake = createFakeFreightProvider();
const settings = createFreightSettingsService({ repo, audit, providerFactory: fake.factory });
const service = createShippingService({ repo, settings, audit });

const fakeTransport: MailTransportFactory = () => ({ async sendMail() {} });
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService, fakeTransport),
  testDocumentPdfService,
  createStockService(createStockRepository(db)),
  testArticleService,
  testSystemService,
  (query) => resolvePrice(db, query)
);

beforeEach(async () => {
  await resetShipping();
  await enableFreight();
  Object.assign(fake.state, {
    prices: SANDBOX_PRICES.map((p) => ({ ...p })),
    createDelayMs: 0,
    ratesDelayMs: 0,
    bookError: null,
    bookDelayMs: 0,
    round: 0,
    created: [],
  });
});
afterAll(resetShipping);

async function product(carrierCode = "dhl", productName = "DHL Paket") {
  const [p] = await db
    .insert(freightProducts)
    .values({ provider: "sendify", carrierCode, carrierName: carrierCode.toUpperCase(), productName })
    .returning();
  return p!;
}

describe("kundens förvalda fraktprodukt", () => {
  it("a new shipment inherits the customer's product without a carrier price", async () => {
    const p = await product();
    const customer = await makeCustomer({ defaultFreightProductId: p.id });
    const article = await makeArticle({ weight: 5 });
    const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }]);
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row).toMatchObject({ freightProductId: p.id, carrierPrice: null });
  });

  it("the order's quoted product wins over the customer's", async () => {
    const mine = await product("ups", "UPS Express");
    const theirs = await product();
    const customer = await makeCustomer({ defaultFreightProductId: theirs.id });
    const article = await makeArticle({ weight: 5 });
    const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }]);
    await db
      .update(salesOrders)
      .set({ freightProductId: mine.id, freightCarrierPrice: "520.00" })
      .where(eq(salesOrders.id, delivery.orderId));
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row).toMatchObject({ freightProductId: mine.id, carrierPrice: "520.00" });
  });

  it("Boka vald produkt books the inherited product right away", async () => {
    const p = await product();
    const customer = await makeCustomer({ defaultFreightProductId: p.id });
    const article = await makeArticle({ weight: 5 });
    const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }]);
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    const booked = await service.book(shipment.id, { useSelection: true }, null);
    expect(booked.shipment.status).toBe("booked");
    expect(booked.shipment.carrierPrice).toBe(412.4);
  });

  it("updateCustomer validates the product and the GET joins its names", async () => {
    const customer = await makeCustomer();
    await expect(
      salesService.updateCustomer(customer.id, { defaultFreightProductId: "6f1c7a8e-2b3d-4c5e-8f90-123456789abc" })
    ).rejects.toBeInstanceOf(InvalidFreightProductError);
    const p = await product();
    await salesService.updateCustomer(customer.id, { defaultFreightProductId: p.id });
    expect(await salesService.getCustomer(customer.id)).toMatchObject({
      defaultFreightProductId: p.id,
      defaultFreightCarrierName: "DHL",
      defaultFreightProductName: "DHL Paket",
    });
    await salesService.updateCustomer(customer.id, { defaultFreightProductId: null });
    expect((await salesService.getCustomer(customer.id))!.defaultFreightProductId).toBeNull();
  });
});
