import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, salesOrderRows, salesOrders } from "@navet/db";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightQuoteService } from "../src/modules/shipping/service/freight-quote.service.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import type { ProviderShipment } from "../src/modules/shipping/service/freight-provider.js";
import {
  FreightNotConfiguredError,
  FreightOrderStatusError,
  FreightRateNotFoundError,
  FreightValidationError,
} from "../src/modules/shipping/service/shipping.errors.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import type { AuditEntry, AuditWriter } from "../src/modules/system/repository/audit.repository.js";
import { createFakeFreightProvider, SANDBOX_PRICES } from "./helpers/fake-freight-provider.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { enableFreight, makeArticle, makeCustomer, resetShipping } from "./helpers/shipping-fixtures.js";

// Frakt på offert: the price probe and the freight row on a kundorder. A
// real sales service is the row writer (Task 2's setFreightRow); Sendify is
// the in-memory fake. The clock is a Wednesday morning so the next pickup
// slot is deterministic (enableFreight: weekdays 08–16).
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
const repo = createShippingRepository(db);
// Recording audit stub shared by settings and quotes — tests filter on action.
const auditEntries: AuditEntry[] = [];
const audit: AuditWriter = {
  async log(entry) {
    auditEntries.push(entry);
  },
};
const fake = createFakeFreightProvider();
const now = () => new Date("2026-10-07T10:00:00+02:00");
const settings = createFreightSettingsService({ repo, audit, providerFactory: fake.factory, now });
const quotes = createFreightQuoteService({ repo, settings, sales, audit, now });

type OrderStatus = typeof salesOrders.$inferInsert.status;

let freightArticleId: string;
let seq = 0;

beforeEach(async () => {
  await resetShipping();
  // 10 % påslag: 412.4 → 454, 520 → 572.
  await enableFreight({ freight_markup_percent: "10", freight_markup_amount: "0" });
  const freight = await makeArticle({ name: "Frakt", type: "service", length: undefined, width: undefined, height: undefined, weight: undefined });
  freightArticleId = freight.id;
  await settings.update({ freightArticleId }, null);
  auditEntries.length = 0;
  fake.calls.length = 0;
  Object.assign(fake.state, {
    prices: SANDBOX_PRICES.map((p) => ({ ...p })),
    ratesError: null,
    round: 0,
    created: [],
    tracking: {},
    trackingError: null,
  });
});
afterAll(resetShipping);

// An order with rows that are still (partly) to be shipped — unlike
// makeDelivery, nothing is delivered unless the row says so.
async function makeOrder(
  customerId: string,
  rows: { articleId: string; quantity: number; delivered?: number }[],
  status: OrderStatus = "quote"
) {
  seq++;
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-FQ-${Date.now() % 1_000_000}-${seq}`, customerId, status })
    .returning();
  for (const row of rows) {
    await db.insert(salesOrderRows).values({
      salesOrderId: order!.id,
      articleId: row.articleId,
      quantityOrdered: String(row.quantity),
      quantityDelivered: String(row.delivered ?? 0),
      unitPrice: "100",
    });
  }
  return order!;
}

async function goodsOrder(status: OrderStatus = "quote", customerOver = {}) {
  const customer = await makeCustomer(customerOver);
  const goods = await makeArticle({ weight: 5 });
  const order = await makeOrder(customer.id, [{ articleId: goods.id, quantity: 3 }], status);
  return { order, goods, customer };
}

const PARCEL = { parcelKind: "package" as const, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 15, quantity: 1, stackable: true, loadingMeters: null, description: "Kolli" };

const calls = (method: string) => fake.calls.filter((c) => c.method === method);
const readOrder = async (id: string) => (await db.select().from(salesOrders).where(eq(salesOrders.id, id)))[0]!;

describe("suggestParcels", () => {
  it("packs what is still to be shipped — not service rows, not delivered rows", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle({ weight: 5 });
    const shipped = await makeArticle({ weight: 7 });
    const order = await makeOrder(customer.id, [
      { articleId: goods.id, quantity: 3 },
      { articleId: freightArticleId, quantity: 1 },
      { articleId: shipped.id, quantity: 2, delivered: 2 },
    ]);
    const { parcels, warnings } = await quotes.suggestParcels(order.id);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ quantity: 3, lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, description: goods.name });
    expect(warnings).toEqual([]);
  });

  // The freight article is excluded by being the configured freight
  // article, not by its type: a "purchased" one with full dimensions must
  // not turn into a parcel either.
  it("never packs the configured freight article, whatever its type", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle({ weight: 5 });
    const purchasedFreight = await makeArticle({ name: "Frakt (inköpt)", type: "purchased", weight: 2 });
    await settings.update({ freightArticleId: purchasedFreight.id }, null);
    const order = await makeOrder(customer.id, [
      { articleId: goods.id, quantity: 3 },
      { articleId: purchasedFreight.id, quantity: 1 },
    ]);
    const { parcels, warnings } = await quotes.suggestParcels(order.id);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({ quantity: 3, weightKg: 5, description: goods.name });
    expect(warnings).toEqual([]);
  });
});

describe("fetchRates", () => {
  it("prices a probe shipment referenced by the order number, stores the answer and deletes the probe", async () => {
    const { order } = await goodsOrder();
    const view = await quotes.fetchRates(order.id, [PARCEL]);
    expect(view.rates.map((r) => [r.carrierCode, r.price, r.customerPrice])).toEqual([
      ["dhl", 412.4, 454],
      ["ups", 520, 572],
    ]);
    expect(view.warnings).toEqual(["Schenker: för tungt"]);
    expect(view.rates.every((r) => !("bookingToken" in r))).toBe(true);

    const stored = (await readOrder(order.id)).freightQuote;
    expect(stored?.rates.map((r) => r.id).sort()).toEqual(view.rates.map((r) => r.id).sort());
    expect(stored?.fetchedAt).toBe(now().toISOString());
    // The sales module returns freight_quote raw on every order read, so the
    // tokens must not be in the column at all (fake tokens are "tok-…").
    expect(stored?.rates.every((r) => !("bookingToken" in r))).toBe(true);
    expect(JSON.stringify(await sales.getSalesOrder(order.id))).not.toContain("tok-");
    expect(JSON.stringify(await readOrder(order.id))).not.toContain("tok-");

    const created = calls("createShipment");
    expect(created).toHaveLength(1);
    const payload = created[0]!.args[0] as ProviderShipment;
    expect(payload.referenceId).toBe(order.orderNumber);
    expect(payload.parcels).toEqual([{ kind: "package", lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 15, quantity: 1, stackable: true, loadingMeters: null, description: "Kolli" }]);
    expect(calls("getRates")[0]!.args[1]).toEqual({ date: "2026-10-07", time: "10:00" });
    expect(calls("deleteShipment").map((c) => c.args[0])).toEqual(["fake-1"]);
  });

  it("deletes the probe even when the broker fails to price it", async () => {
    const { order } = await goodsOrder();
    fake.state.ratesError = new Error("Sendify svarar inte");
    await expect(quotes.fetchRates(order.id, [PARCEL])).rejects.toThrow("Sendify svarar inte");
    expect(calls("deleteShipment")).toHaveLength(1);
    expect((await readOrder(order.id)).freightQuote).toBeNull();
  });

  it("refuses before calling the broker when the recipient cannot be reached", async () => {
    const { order } = await goodsOrder("quote", { phone: null, email: null });
    const err = await quotes.fetchRates(order.id, [PARCEL]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightValidationError);
    expect((err as FreightValidationError).fieldErrors).toEqual(["Mottagare: telefon eller e-post"]);
    expect(calls("createShipment")).toHaveLength(0);
  });

  it("refuses an order that has left the editable statuses", async () => {
    const { order } = await goodsOrder("delivered");
    await expect(quotes.fetchRates(order.id, [PARCEL])).rejects.toBeInstanceOf(FreightOrderStatusError);
    await expect(quotes.addFreight(order.id, randomUUID(), null)).rejects.toBeInstanceOf(FreightOrderStatusError);
    expect(calls("createShipment")).toHaveLength(0);
  });

  it("refuses when the freight integration is switched off", async () => {
    const { order } = await goodsOrder();
    await settings.update({ enabled: false }, null);
    const err = await quotes.fetchRates(order.id, [PARCEL]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightNotConfiguredError);
    expect((err as FreightNotConfiguredError).reason).toBe("disabled");
  });
});

describe("addFreight", () => {
  it("adds the freight row at the customer price and remembers the chosen product", async () => {
    const { order, goods } = await goodsOrder("confirmed");
    const view = await quotes.fetchRates(order.id, [PARCEL]);
    const dhl = view.rates.find((r) => r.carrierCode === "dhl")!;

    const rows = await quotes.addFreight(order.id, dhl.id, null);
    const freightRow = rows.find((r) => r.articleId === freightArticleId)!;
    expect(freightRow).toBeDefined();
    expect(Number(freightRow.quantityOrdered)).toBe(1);
    expect(Number(freightRow.unitPrice)).toBe(454);
    expect(rows.find((r) => r.articleId === goods.id)).toBeDefined();

    const stored = await readOrder(order.id);
    expect(stored.freightProductId).not.toBeNull();
    expect(Number(stored.freightCarrierPrice)).toBe(412.4);

    const state = await quotes.get(order.id);
    expect(state.freightProduct).toMatchObject({ id: stored.freightProductId, carrierName: "DHL Freight", productName: "DHL Paket" });
    expect(state.carrierPrice).toBe(412.4);
    expect(state.rates?.rates.map((r) => r.carrierCode)).toEqual(["dhl", "ups"]);
  });

  it("writes a freight_added audit entry on the order with both prices", async () => {
    const { order } = await goodsOrder("confirmed");
    const view = await quotes.fetchRates(order.id, [PARCEL]);
    const ups = view.rates.find((r) => r.carrierCode === "ups")!;
    await quotes.addFreight(order.id, ups.id, "user-1");
    expect(auditEntries.filter((e) => e.action === "freight_added")).toEqual([
      {
        entityType: "sales_order",
        entityId: order.orderNumber,
        action: "freight_added",
        detail: { carrier: "UPS", product: "UPS Express", carrierPrice: 520, customerPrice: 572 },
        userId: "user-1",
      },
    ]);
  });

  it("rejects a rate id that is not in the stored answer", async () => {
    const { order } = await goodsOrder();
    await quotes.fetchRates(order.id, [PARCEL]);
    await expect(quotes.addFreight(order.id, randomUUID(), null)).rejects.toBeInstanceOf(FreightRateNotFoundError);
    expect(await sales.listRows(order.id)).toHaveLength(1);
  });

  it("points at the settings when no freight article is configured", async () => {
    const { order } = await goodsOrder();
    const view = await quotes.fetchRates(order.id, [PARCEL]);
    await settings.update({ freightArticleId: null }, null);
    const err = await quotes.addFreight(order.id, view.rates[0]!.id, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FreightNotConfiguredError);
    expect((err as FreightNotConfiguredError).reason).toBe("no-article");
    expect(await sales.listRows(order.id)).toHaveLength(1);
  });

  it("starts empty: no product, no price, no rates", async () => {
    const { order } = await goodsOrder();
    expect(await quotes.get(order.id)).toEqual({ freightProduct: null, carrierPrice: null, rates: null });
  });

  // Two "Lägg till frakt" at once: the loser's insert hits
  // sales_order_rows_order_article_unique (ordinary rows) and the row is
  // repriced on a second call instead.
  it("retries setFreightRow once on a unique violation, rethrows anything else", async () => {
    const { order } = await goodsOrder();
    const view = await quotes.fetchRates(order.id, [PARCEL]);
    const rateId = view.rates[0]!.id;

    let errors: Error[] = [Object.assign(new Error("dup"), { code: "23505" })];
    let attempts = 0;
    const stub = {
      async setFreightRow() {
        attempts++;
        const err = errors.shift();
        if (err) throw err;
      },
      async listRows() {
        return "rows";
      },
    };
    const racing = createFreightQuoteService({ repo, settings, sales: stub, audit, now });

    await expect(racing.addFreight(order.id, rateId, null)).resolves.toBe("rows");
    expect(attempts).toBe(2);
    expect((await readOrder(order.id)).freightProductId).not.toBeNull();

    attempts = 0;
    errors = [new Error("boom")];
    await expect(racing.addFreight(order.id, rateId, null)).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });
});
