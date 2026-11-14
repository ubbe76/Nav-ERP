import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, freightProducts, shipmentFiles, shipments } from "@navet/db";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import type { BrokerName, FreightProvider, Rate } from "../src/modules/shipping/service/freight-provider.js";
import { FreightNotConfiguredError, InvalidShipmentStatusError } from "../src/modules/shipping/service/shipping.errors.js";
import { createTrackingService } from "../src/modules/shipping/service/tracking.service.js";
import { createFakeFreightProvider } from "./helpers/fake-freight-provider.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery, resetShipping } from "./helpers/shipping-fixtures.js";

// Förmedlare per försändelse (0221): the broker a new shipment gets, a
// draft changing broker, a broker without drafts (nShift, Shipmondo) priced
// and booked from the shipment itself, a price that is missing, documents
// that come with the booking, the booked shipment's own id at the broker,
// and Markera levererad for the brokers that are not tracked. The brokers
// are fakes here (their HTTP is pinned in freight-brokers.test.ts).

const repo = createShippingRepository(db);
const audit = { async log() {} };
const sendify = createFakeFreightProvider();

interface BrokerFake {
  provider: FreightProvider;
  calls: { method: string; args: unknown[] }[];
}

// A broker that keeps no draft: one priced product and one without a price.
function draftlessBroker(name: BrokerName): BrokerFake {
  const calls: BrokerFake["calls"] = [];
  const rate = (code: string, price: number | null): Rate => ({
    bookingToken: JSON.stringify({ code }),
    carrierCode: code,
    carrierName: "DHL Freight",
    productName: `Produkt ${code}`,
    price,
    currency: "SEK",
    daysMin: null,
    daysMax: null,
    pickupDate: null,
    estimatedDeliveryDate: null,
    expiresAt: null,
  });
  const fail = async () => {
    throw new Error(`${name} keeps no draft`);
  };
  const provider: FreightProvider = {
    name,
    remoteDrafts: false,
    tracks: false,
    async checkKey() {
      return { team: name };
    },
    createShipment: fail,
    updateShipment: fail,
    deleteShipment: fail,
    async getRates(ctx) {
      calls.push({ method: "getRates", args: [ctx] });
      return { rates: [rate("PALL", 900), rate("EGET", null)], warnings: [] };
    },
    async book(token, ctx) {
      calls.push({ method: "book", args: [token, ctx] });
      return {
        trackingNumber: `${name.toUpperCase()}-1`,
        documentTypes: ["label"],
        remoteId: `${name}-booked-1`,
        documents: [{ type: "label", content: Buffer.from(`%PDF ${name}`) }],
      };
    },
    async fetchDocument() {
      calls.push({ method: "fetchDocument", args: [] });
      return Buffer.from("%PDF fetched");
    },
    async cancel(id) {
      calls.push({ method: "cancel", args: [id] });
    },
    async getTracking() {
      throw new Error("not tracked");
    },
  };
  return { provider, calls };
}

const nshift = draftlessBroker("nshift");
const shipmondo = draftlessBroker("shipmondo");
const settings = createFreightSettingsService({
  repo,
  audit,
  providerFactory: sendify.factory,
  providerFactories: { nshift: () => nshift.provider, shipmondo: () => shipmondo.provider },
});
const service = createShippingService({ repo, settings, audit });
const tracking = createTrackingService({ repo, settings, audit });

beforeEach(async () => {
  await resetShipping();
  await enableFreight();
  for (const fake of [nshift, shipmondo]) fake.calls.length = 0;
  sendify.calls.length = 0;
  await settings.update(
    {
      nshift: { enabled: true, apiKeyId: "nshift-id", apiSecret: "nshift-secret", services: ["PALL", "EGET"] },
      shipmondo: { enabled: true, apiUser: "user", apiKey: "key" },
    },
    null
  );
});
afterAll(resetShipping);

async function draft(customerOver = {}) {
  const customer = await makeCustomer(customerOver);
  const article = await makeArticle({ weight: 5 });
  const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 2 }]);
  const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
  return { shipment, customer };
}

describe("förmedlare per försändelse", () => {
  it("a new shipment gets Förvald förmedlare, else the first switched on, else the customer's product's broker", async () => {
    expect(await settings.enabledBrokers()).toEqual(["sendify", "nshift", "shipmondo"]);
    expect((await draft()).shipment.provider).toBe("sendify");
    await settings.update({ defaultBroker: "shipmondo" }, null);
    expect((await draft()).shipment.provider).toBe("shipmondo");
    // Förvald förmedlare switched off: the first one on.
    await settings.update({ shipmondo: { enabled: false } }, null);
    expect((await draft()).shipment.provider).toBe("sendify");

    // The customer's förvalda fraktprodukt is nShift's: the shipment goes there with it.
    const [product] = await db
      .insert(freightProducts)
      .values({ provider: "nshift", carrierCode: "PALL", carrierName: "DHL Freight", productName: "Produkt PALL" })
      .returning();
    const { shipment } = await draft({ defaultFreightProductId: product!.id });
    expect(shipment).toMatchObject({ provider: "nshift", freightProduct: { id: product!.id } });

    // Nothing switched on: refused as before.
    await settings.update({ enabled: false, nshift: { enabled: false } }, null);
    await expect(draft()).rejects.toBeInstanceOf(FreightNotConfiguredError);
  });

  it("a draft changes broker — prices, product and the old broker's draft go", async () => {
    const { shipment } = await draft();
    await service.fetchRates(shipment.id);
    const priced = await service.get(shipment.id);
    expect(priced.rates?.rates.length).toBeGreaterThan(0);
    const remote = (await db.select().from(shipments).where(eq(shipments.id, shipment.id)))[0]!.providerShipmentId;
    expect(remote).not.toBeNull();

    const switched = await service.update(shipment.id, { broker: "nshift" }, null);
    expect(switched).toMatchObject({ provider: "nshift", rates: null, freightProduct: null, carrierPrice: null });
    expect(sendify.calls.filter((c) => c.method === "deleteShipment").map((c) => c.args[0])).toEqual([remote]);
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.providerShipmentId).toBeNull();

    // Not to a broker that is switched off.
    await settings.update({ shipmondo: { enabled: false } }, null);
    await expect(service.update(shipment.id, { broker: "shipmondo" }, null)).rejects.toBeInstanceOf(FreightNotConfiguredError);
  });

  it("a broker without drafts is priced from the shipment; a product without a price leaves the kundpris to be typed", async () => {
    await settings.update({ defaultBroker: "nshift" }, null);
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    expect(rates.rates.map((r) => [r.carrierCode, r.price, r.customerPrice])).toEqual([
      ["PALL", 900, 900],
      ["EGET", null, null],
    ]);
    const ctx = nshift.calls[0]!.args[0] as { remoteId: string | null; shipment: { parcels: unknown[] } };
    expect(ctx.remoteId).toBeNull();
    expect(ctx.shipment.parcels.length).toBeGreaterThan(0);
    expect(sendify.calls.filter((c) => c.method === "createShipment")).toEqual([]);

    const eget = rates.rates.find((r) => r.carrierCode === "EGET")!;
    const selected = await service.saveSelection(shipment.id, eget.id);
    expect(selected).toMatchObject({ carrierPrice: null, customerPrice: null, freightProduct: { productName: "Produkt EGET" } });
  });

  it("books from the shipment: the broker's own id, its documents kept, no price → no kundpris", async () => {
    await settings.update({ defaultBroker: "shipmondo" }, null);
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    const eget = rates.rates.find((r) => r.carrierCode === "EGET")!;
    const { shipment: booked, warnings } = await service.book(shipment.id, { rateId: eget.id }, null);
    expect(warnings).toEqual([]);
    expect(booked).toMatchObject({ status: "booked", provider: "shipmondo", trackingNumber: "SHIPMONDO-1", carrierPrice: null, customerPrice: null });
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.providerShipmentId).toBe("shipmondo-booked-1");
    const files = await db.select().from(shipmentFiles).where(eq(shipmentFiles.shipmentId, shipment.id));
    expect(files.map((f) => [f.kind, f.data.toString()])).toEqual([["label", "%PDF shipmondo"]]);
    expect(shipmondo.calls.map((c) => c.method)).toEqual(["getRates", "book"]);
    const [, ctx] = shipmondo.calls[1]!.args as [string, { remoteId: string | null; pickup: { date: string } }];
    expect(ctx.remoteId).toBeNull();
    expect(ctx.pickup.date).toBe(shipment.pickupDate);

    // Cancel goes to the booked id at the same broker.
    await service.cancel(shipment.id, null);
    expect(shipmondo.calls.at(-1)).toEqual({ method: "cancel", args: ["shipmondo-booked-1"] });
  });

  it("nShift and Shipmondo are marked delivered by hand; Sendify only by its tracking", async () => {
    await settings.update({ defaultBroker: "nshift" }, null);
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    await service.book(shipment.id, { rateId: rates.rates[0]!.id }, null);
    await expect(tracking.trackShipment(shipment.id)).rejects.toBeInstanceOf(InvalidShipmentStatusError);
    expect((await service.markDelivered(shipment.id, null)).status).toBe("delivered");

    await settings.update({ defaultBroker: "sendify" }, null);
    const { shipment: viaSendify } = await draft();
    const sendifyRates = await service.fetchRates(viaSendify.id);
    await service.book(viaSendify.id, { rateId: sendifyRates.rates[0]!.id }, null);
    await expect(service.markDelivered(viaSendify.id, null)).rejects.toBeInstanceOf(InvalidShipmentStatusError);
  });

  it("each broker keeps its credentials write-only, and Testa anslutning asks the broker named", async () => {
    const view = await settings.view();
    expect(view).toMatchObject({
      anyEnabled: true,
      enabledBrokers: ["sendify", "nshift", "shipmondo"],
      nshift: { enabled: true, apiKeyIdSet: true, apiSecretSet: true, services: ["PALL", "EGET"] },
      shipmondo: { enabled: true, apiUserSet: true, apiKeySet: true, shipmondoRates: true },
    });
    expect(JSON.stringify(view)).not.toMatch(/nshift-secret|nshift-id|"user"|"key"/);
    expect(await settings.testConnection({ broker: "nshift" })).toEqual({ team: "nshift" });
    expect(await settings.testConnection({ broker: "shipmondo" })).toEqual({ team: "shipmondo" });
    // "" keeps, null removes.
    await settings.update({ nshift: { apiSecret: "" } }, null);
    expect((await settings.view()).nshift.apiSecretSet).toBe(true);
    await settings.update({ nshift: { apiSecret: null } }, null);
    expect((await settings.view()).enabledBrokers).toEqual(["sendify", "shipmondo"]);
  });
});
