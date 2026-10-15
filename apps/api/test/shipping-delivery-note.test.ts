import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@navet/db";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createFakeFreightProvider } from "./helpers/fake-freight-provider.js";
import { pdfText } from "./helpers/pdf.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery, resetShipping } from "./helpers/shipping-fixtures.js";

const repo = createShippingRepository(db);
const audit = { async log() {} };
const fake = createFakeFreightProvider();
const settings = createFreightSettingsService({ repo, audit, providerFactory: fake.factory });
const shipping = createShippingService({ repo, settings, audit });
const fakeTransport: MailTransportFactory = () => ({ async sendMail() {} });
const sales = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService, fakeTransport),
  testDocumentPdfService,
  createStockService(createStockRepository(db)),
  testArticleService,
  testSystemService,
  (query) => resolvePrice(db, query),
  audit,
  undefined,
  undefined,
  shipping
);

beforeEach(async () => {
  await resetShipping();
  await enableFreight();
});
afterAll(resetShipping);

async function setup() {
  const customer = await makeCustomer();
  const article = await makeArticle();
  const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }]);
  const { shipment } = await shipping.create({ deliveryIds: [delivery.deliveryId] }, null);
  return { delivery, shipment };
}

describe("följesedeln och försändelsen", () => {
  it("shows the live shipment on the order's delivery list", async () => {
    const { delivery, shipment } = await setup();
    const [row] = await sales.listDeliveries(delivery.orderId);
    expect(row).toMatchObject({ id: delivery.deliveryId, shipment: { shipmentId: shipment.id, shipmentNumber: shipment.shipmentNumber, status: "draft" } });
  });

  it("prints carrier and fraktsedelsnummer on the följesedel once booked", async () => {
    const { delivery, shipment } = await setup();
    expect(pdfText((await sales.deliveryNotePdf(delivery.deliveryId)).pdf)).not.toContain("Fraktsedelsnr");
    const rates = await shipping.fetchRates(shipment.id);
    const { shipment: booked } = await shipping.book(shipment.id, { rateId: rates.rates[0]!.id }, null);
    const text = pdfText((await sales.deliveryNotePdf(delivery.deliveryId)).pdf);
    expect(text).toContain("Transportör: DHL Freight");
    expect(text).toContain(`Fraktsedelsnr: ${booked.trackingNumber}`);
  });

  it("forgets a cancelled shipment on the delivery list", async () => {
    const { delivery, shipment } = await setup();
    await shipping.cancel(shipment.id, null);
    const [row] = await sales.listDeliveries(delivery.orderId);
    expect(row!.shipment).toBeNull();
  });
});
