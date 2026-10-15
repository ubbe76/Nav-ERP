import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companyInfo, db, shipments } from "@navet/db";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import { FreightProviderError } from "../src/modules/shipping/service/freight-provider.js";
import { SENDIFY_MESSAGES } from "../src/modules/shipping/service/sendify-provider.js";
import {
  FreightBookingInProgressError,
  FreightBookingTakenOverError,
  FreightCancelRefusedError,
  FreightNoSelectionError,
  FreightNotConfiguredError,
  FreightPickupDayError,
  FreightPriceChangedError,
  FreightProductUnavailableError,
  FreightRatesExpiredError,
  FreightShipmentChangedError,
  FreightValidationError,
  InvalidShipmentStatusError,
} from "../src/modules/shipping/service/shipping.errors.js";
import { createFakeFreightProvider, refused, SANDBOX_PRICES } from "./helpers/fake-freight-provider.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery, resetShipping } from "./helpers/shipping-fixtures.js";

const repo = createShippingRepository(db);
const auditEntries: { action: string; detail?: unknown }[] = [];
const audit = {
  async log(entry: { action: string; detail?: unknown }) {
    auditEntries.push(entry);
  },
};
const fake = createFakeFreightProvider();
const settings = createFreightSettingsService({ repo, audit, providerFactory: fake.factory });
const service = createShippingService({ repo, settings, audit });

beforeEach(async () => {
  await resetShipping();
  await enableFreight();
  auditEntries.length = 0;
  fake.calls.length = 0;
  Object.assign(fake.state, {
    prices: SANDBOX_PRICES.map((p) => ({ ...p })),
    expiresInMs: 60 * 60 * 1000,
    createDelayMs: 0,
    ratesDelayMs: 0,
    bookError: null,
    bookDelayMs: 0,
    cancelError: null,
    cancelDelayMs: 0,
    documentError: null,
    documentTypes: ["label", "waybill"],
    round: 0,
    created: [],
    tracking: {},
    trackingError: null,
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(resetShipping);

const count = (method: string) => fake.calls.filter((c) => c.method === method).length;

async function draft(customerOver = {}) {
  const customer = await makeCustomer(customerOver);
  const article = await makeArticle({ weight: 5 });
  const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 2 }]);
  const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
  return { shipment, delivery, customer };
}

const dhl = (rates: { rates: { id: string; carrierCode: string }[] }) => rates.rates.find((r) => r.carrierCode === "dhl")!;

describe("priser", () => {
  it("creates the shipment at the broker once, updates it on the next fetch, never exposes tokens", async () => {
    const { shipment } = await draft();
    const first = await service.fetchRates(shipment.id);
    expect(first.rates.map((r) => r.carrierCode)).toEqual(["dhl", "ups"]);
    expect(first.rates[0]).toMatchObject({ price: 412.4, customerPrice: 412 });
    expect(first.warnings).toEqual(["Schenker: för tungt"]);
    await service.fetchRates(shipment.id);
    expect(count("createShipment")).toBe(1);
    expect(count("updateShipment")).toBe(1);
    const view = await service.get(shipment.id);
    expect(view.rates?.rates).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain("tok-");
    expect((await settings.listProducts()).map((p) => p.productName)).toEqual(["DHL Paket", "UPS Express"]);
  });

  it("refreshes the sender from company info at every fetch", async () => {
    const { shipment } = await draft();
    await db.update(companyInfo).set({ city: "Borås" });
    await service.fetchRates(shipment.id);
    expect((await service.get(shipment.id)).senderCity).toBe("Borås");
  });

  it("sends the company address's second line as the sender's address line 2", async () => {
    await db.update(companyInfo).set({ address: "Fabriken 1\nPort 3" });
    const { shipment } = await draft();
    await service.fetchRates(shipment.id);
    expect(fake.state.created.at(-1)!.sender).toMatchObject({ addressLine1: "Fabriken 1", addressLine2: "Port 3" });
    expect(await service.get(shipment.id)).toMatchObject({ senderAddressLine1: "Fabriken 1", senderAddressLine2: "Port 3" });
  });

  it("drops prices quoted for parcels that were edited while the broker was answering", async () => {
    const { shipment } = await draft();
    fake.state.ratesDelayMs = 200;
    const fetching = service.fetchRates(shipment.id);
    // The broker call is in flight (no lock held): another user saves new kollin.
    while (count("getRates") === 0) await new Promise((r) => setTimeout(r, 5));
    await service.replaceParcels(shipment.id, [
      { parcelKind: "pallet", lengthCm: 120, widthCm: 80, heightCm: 100, weightKg: 200, quantity: 1, stackable: false, loadingMeters: null, description: null },
    ]);
    await expect(fetching).rejects.toBeInstanceOf(FreightShipmentChangedError);
    // The stale quote (for the old parcels) must not be stored — the user has to fetch again.
    expect((await service.get(shipment.id)).rates).toBeNull();
    expect((await service.fetchRates(shipment.id)).rates).toHaveLength(2);
  });

  // A service on a fixed Swedish wall clock (2030-01-07 is a Monday, pickup 08–16).
  function serviceAt(stockholmTime: string) {
    const now = () => new Date(`2030-01-07T${stockholmTime}:00+01:00`);
    const clocked = createFreightSettingsService({ repo, audit, providerFactory: fake.factory, now });
    return createShippingService({ repo, settings: clocked, audit, now });
  }

  it("asks the broker for a same-day pickup no earlier than now, rounded up to the quarter hour", async () => {
    const at = serviceAt("10:31");
    const customer = await makeCustomer();
    const delivery = await makeDelivery(customer.id, [{ articleId: (await makeArticle({ weight: 5 })).id, quantity: 1 }]);
    const { shipment } = await at.create({ deliveryIds: [delivery.deliveryId] }, null);
    expect(shipment).toMatchObject({ pickupDate: "2030-01-07", pickupFrom: "08:00" });
    await at.fetchRates(shipment.id);
    expect(fake.calls.find((c) => c.method === "getRates")?.args[1]).toEqual({ date: "2030-01-07", time: "10:45" });
    // The stored window is untouched.
    expect(await at.get(shipment.id)).toMatchObject({ pickupFrom: "08:00", pickupTo: "16:00" });
  });

  it("refuses to fetch prices when today's pickup window has run out", async () => {
    // Created while today's pickup could still be requested, fetched after it ran out.
    const customer = await makeCustomer();
    const delivery = await makeDelivery(customer.id, [{ articleId: (await makeArticle({ weight: 5 })).id, quantity: 1 }]);
    const { shipment } = await serviceAt("10:00").create({ deliveryIds: [delivery.deliveryId] }, null);
    expect(shipment.pickupDate).toBe("2030-01-07");
    const at = serviceAt("15:50");
    const err = await at.fetchRates(shipment.id).catch((e) => e);
    expect(err).toBeInstanceOf(FreightPickupDayError);
    expect(err.message).toBe("Dagens upphämtningstid har passerat — välj ett nytt datum");
    expect(count("createShipment")).toBe(0);
  });

  it("drops the prices even when the edit landed while the shipment was being created at the broker", async () => {
    // First fetch: the broker's copy does not exist yet, so the edit falls
    // between our read and the save of the broker id — that save must not
    // mask the edit.
    const { shipment } = await draft();
    fake.state.createDelayMs = 200;
    const fetching = service.fetchRates(shipment.id);
    while (count("createShipment") === 0) await new Promise((r) => setTimeout(r, 5));
    await service.update(shipment.id, { recipientCity: "Malmö" }, null);
    await expect(fetching).rejects.toBeInstanceOf(FreightShipmentChangedError);
    expect((await service.get(shipment.id)).rates).toBeNull();
    // The broker's copy is still remembered — the next fetch updates it instead of creating another.
    fake.state.createDelayMs = 0;
    await service.fetchRates(shipment.id);
    expect(count("createShipment")).toBe(1);
    expect(count("updateShipment")).toBe(1);
  });

  it("stops before calling the broker when the recipient has neither phone nor e-mail", async () => {
    const { shipment } = await draft({ phone: null, email: null });
    const err = await service.fetchRates(shipment.id).catch((e) => e);
    expect(err).toBeInstanceOf(FreightValidationError);
    expect(err.fieldErrors).toContain("Mottagare: telefon eller e-post");
    expect(count("createShipment")).toBe(0);
  });
});

describe("spara val", () => {
  it("saves product, price and customer price with markup; a manual customer price stays", async () => {
    await settings.update({ markupPercent: 10 }, null);
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    const saved = await service.saveSelection(shipment.id, dhl(rates).id);
    expect(saved).toMatchObject({ carrierPrice: 412.4, carrierCurrency: "SEK", customerPrice: 454, freightProduct: { productName: "DHL Paket" } });
    await service.update(shipment.id, { customerPrice: 400 }, null);
    const again = await service.fetchRates(shipment.id);
    expect((await service.saveSelection(shipment.id, dhl(again).id)).customerPrice).toBe(400);
  });
});

// Frakt på offert: a följesedel whose order already carries a chosen product
// and Sendify's quoted price (Lägg till frakt on the kundorder).
describe("förval från kundordern", () => {
  async function quotedDraft() {
    const { ids } = await repo.upsertFreightProducts("sendify", [{ carrierCode: "dhl", carrierName: "DHL Freight", productName: "DHL Paket" }]);
    const customer = await makeCustomer();
    const article = await makeArticle({ weight: 5 });
    const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 2 }], {
      freightProductId: ids.get("dhl|DHL Paket")!,
      freightCarrierPrice: "412.4",
    });
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    return shipment;
  }

  it("inherits the order's product and quoted price, with the customer price marked up", async () => {
    await settings.update({ markupPercent: 10 }, null);
    const shipment = await quotedDraft();
    expect(shipment).toMatchObject({
      freightProduct: { productName: "DHL Paket", carrierName: "DHL Freight" },
      carrierPrice: 412.4,
      carrierCurrency: "SEK",
      customerPrice: 454,
      customerPriceManual: false,
    });
    expect(count("getRates")).toBe(0);
  });

  it("checks the fresh price against the quoted one when booking the chosen product", async () => {
    const shipment = await quotedDraft();
    fake.state.prices[0]!.price = 500;
    const err = await service.book(shipment.id, { useSelection: true }, null).catch((e) => e);
    expect(err).toBeInstanceOf(FreightPriceChangedError);
    expect(err).toMatchObject({ savedPrice: 412.4, newPrice: 500, currency: "SEK" });
    const { shipment: booked } = await service.book(shipment.id, { useSelection: true, confirmPriceChange: true }, null);
    expect(booked).toMatchObject({ status: "booked", carrierPrice: 500, freightProduct: { productName: "DHL Paket" } });
  });

  it("starts without a selection when the order has none", async () => {
    const { shipment } = await draft();
    expect(shipment).toMatchObject({ freightProduct: null, carrierPrice: null, customerPrice: null });
  });
});

describe("boka", () => {
  it("books a rate, stores tracking number, documents and the customer price", async () => {
    const { shipment, delivery } = await draft();
    const rates = await service.fetchRates(shipment.id);
    const { shipment: booked, warnings } = await service.book(shipment.id, { rateId: dhl(rates).id }, null);
    expect(warnings).toEqual([]);
    expect(booked).toMatchObject({
      status: "booked",
      trackingNumber: "TRK-tok-dhl-1",
      carrierPrice: 412.4,
      customerPrice: 412,
      freightProduct: { carrierName: "DHL Freight" },
      bookingInProgress: false,
    });
    expect(booked.files.map((f) => f.kind)).toEqual(["label", "waybill"]);
    expect((await service.getFile(shipment.id, booked.files[0]!.id)).data.toString()).toContain("%PDF");
    const [live] = await repo.liveShipmentsForDeliveries([delivery.deliveryId]);
    expect(live).toMatchObject({ status: "booked", carrierName: "DHL Freight", trackingNumber: "TRK-tok-dhl-1" });
  });

  it("keeps a manual customer price typed while the carrier call is in flight", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    fake.state.bookDelayMs = 200;
    const booking = service.book(shipment.id, { rateId: dhl(rates).id }, null);
    // Wait until the broker call is in flight: the reservation is held and
    // a price-only PATCH is still allowed.
    while (count("book") === 0) await new Promise((r) => setTimeout(r, 5));
    const during = await service.update(shipment.id, { customerPrice: 777 }, null);
    expect(during).toMatchObject({ customerPrice: 777, customerPriceManual: true, bookingInProgress: true });
    const { shipment: booked } = await booking;
    expect(booked).toMatchObject({ status: "booked", carrierPrice: 412.4, customerPrice: 777, customerPriceManual: true });
  });

  it("refetches and answers 409 when the chosen price has expired", async () => {
    fake.state.expiresInMs = -1000;
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    const err = await service.book(shipment.id, { rateId: dhl(rates).id }, null).catch((e) => e);
    expect(err).toBeInstanceOf(FreightRatesExpiredError);
    expect(err.rates.rates).toHaveLength(2);
    expect(count("book")).toBe(0);
    expect(await service.get(shipment.id)).toMatchObject({ status: "draft", bookingInProgress: false });
  });

  it("asks for confirmation when the saved product's price moved more than the threshold", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    await service.saveSelection(shipment.id, dhl(rates).id);
    fake.state.prices[0]!.price = 500;
    const err = await service.book(shipment.id, { useSelection: true }, null).catch((e) => e);
    expect(err).toBeInstanceOf(FreightPriceChangedError);
    expect(err).toMatchObject({ savedPrice: 412.4, newPrice: 500 });
    const { shipment: booked } = await service.book(shipment.id, { useSelection: true, confirmPriceChange: true }, null);
    expect(booked).toMatchObject({ status: "booked", carrierPrice: 500 });
  });

  it("books the saved product without asking when the price is within the threshold", async () => {
    const { shipment } = await draft();
    await service.saveSelection(shipment.id, dhl(await service.fetchRates(shipment.id)).id);
    fake.state.prices[0]!.price = 420;
    expect((await service.book(shipment.id, { useSelection: true }, null)).shipment.status).toBe("booked");
  });

  it("reports a saved product that is no longer offered", async () => {
    const { shipment } = await draft();
    await service.saveSelection(shipment.id, dhl(await service.fetchRates(shipment.id)).id);
    fake.state.prices = fake.state.prices.filter((p) => p.carrierCode !== "dhl");
    await expect(service.book(shipment.id, { useSelection: true }, null)).rejects.toBeInstanceOf(FreightProductUnavailableError);
  });

  it("needs a saved product for useSelection", async () => {
    const { shipment } = await draft();
    await expect(service.book(shipment.id, { useSelection: true }, null)).rejects.toBeInstanceOf(FreightNoSelectionError);
  });

  it("books only once when Boka is clicked twice at the same time", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    fake.state.bookDelayMs = 200;
    const results = await Promise.allSettled([
      service.book(shipment.id, { rateId: dhl(rates).id }, null),
      service.book(shipment.id, { rateId: dhl(rates).id }, null),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(FreightBookingInProgressError);
    expect(count("book")).toBe(1);
  });

  it("releases the reservation when the broker never answers the booking", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    fake.state.bookError = new FreightProviderError(SENDIFY_MESSAGES.bookingUnknown, "booking-unknown");
    await expect(service.book(shipment.id, { rateId: dhl(rates).id }, null)).rejects.toMatchObject({ kind: "booking-unknown" });
    expect(await service.get(shipment.id)).toMatchObject({ status: "draft", bookingInProgress: false });
  });

  it("a booker whose reservation was taken over neither marks nor frees the newer one", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    fake.state.bookDelayMs = 200;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = service.book(shipment.id, { rateId: dhl(rates).id }, null);
    await new Promise((r) => setTimeout(r, 50));
    // Another booking took the (by then stale) reservation over meanwhile.
    const takeover = new Date(Date.now() + 1000);
    await db.update(shipments).set({ bookingStartedAt: takeover }).where(eq(shipments.id, shipment.id));
    await expect(first).rejects.toBeInstanceOf(FreightBookingTakenOverError);
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.status).toBe("draft");
    expect(row!.bookingStartedAt?.getTime()).toBe(takeover.getTime());
    // The transport Sendify booked for the first attempt is traceable.
    expect(JSON.stringify(error.mock.calls)).toContain("TRK-tok-dhl-1");
  });

  it("a failed booking does not free a reservation another booker took over", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    fake.state.bookDelayMs = 200;
    fake.state.bookError = refused("Ogiltig token");
    const first = service.book(shipment.id, { rateId: dhl(rates).id }, null);
    await new Promise((r) => setTimeout(r, 50));
    const takeover = new Date(Date.now() + 1000);
    await db.update(shipments).set({ bookingStartedAt: takeover }).where(eq(shipments.id, shipment.id));
    await expect(first).rejects.toThrow("Ogiltig token");
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.bookingStartedAt?.getTime()).toBe(takeover.getTime());
  });

  it("refuses edits while a booking is in progress", async () => {
    const { shipment, customer } = await draft();
    const extra = await makeDelivery(customer.id, [{ articleId: (await makeArticle()).id, quantity: 1 }]);
    await db.update(shipments).set({ bookingStartedAt: new Date() }).where(eq(shipments.id, shipment.id));
    await expect(service.update(shipment.id, { recipientCity: "Malmö" }, null)).rejects.toBeInstanceOf(FreightBookingInProgressError);
    await expect(service.replaceParcels(shipment.id, [])).rejects.toBeInstanceOf(FreightBookingInProgressError);
    await expect(service.addDelivery(shipment.id, extra.deliveryId, null)).rejects.toBeInstanceOf(FreightBookingInProgressError);
    await expect(service.fetchRates(shipment.id)).rejects.toBeInstanceOf(FreightBookingInProgressError);
  });

  it("leaves a trace when the database fails after the broker has booked", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    vi.spyOn(repo, "markBooked").mockRejectedValueOnce(new Error("connection reset"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(service.book(shipment.id, { rateId: dhl(rates).id }, null)).rejects.toThrow("connection reset");
    expect(count("book")).toBe(1);
    // The audit entry was written before the failing write, naming the booking at Sendify.
    const booked = auditEntries.find((e) => e.action === "booked");
    expect(booked?.detail).toMatchObject({
      shipmentNumber: shipment.shipmentNumber,
      providerShipmentId: (await repo.findShipment(shipment.id))!.providerShipmentId,
      trackingNumber: "TRK-tok-dhl-1",
      carrier: "DHL Freight",
      product: "DHL Paket",
      price: 412.4,
    });
    // ...and the server log names it too, never the token or the key.
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls[0]);
    expect(logged).toContain("TRK-tok-dhl-1");
    expect(logged).toContain(shipment.shipmentNumber);
    expect(logged).not.toContain("test-key");
    // Still reserved: nobody books a second transport while this is sorted out.
    expect(await service.get(shipment.id)).toMatchObject({ status: "draft", bookingInProgress: true });
  });

  it("keeps the booking when the documents fail, and fetches them later", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    fake.state.documentError = new FreightProviderError(SENDIFY_MESSAGES.unavailable, "unavailable");
    const { shipment: booked, warnings } = await service.book(shipment.id, { rateId: dhl(rates).id }, null);
    expect(booked.status).toBe("booked");
    expect(booked.files).toEqual([]);
    expect(warnings).toEqual(["Fraktsedel och etikett kunde inte hämtas — använd Hämta fraktsedel"]);
    fake.state.documentError = null;
    expect((await service.fetchDocuments(shipment.id)).files).toHaveLength(2);
  });
});

describe("avboka och avbryt", () => {
  it("cancels a booked shipment at the broker and frees the följesedel", async () => {
    const { shipment, delivery } = await draft();
    await service.book(shipment.id, { rateId: dhl(await service.fetchRates(shipment.id)).id }, null);
    const cancelled = await service.cancel(shipment.id, null);
    expect(cancelled).toMatchObject({ status: "cancelled", deliveries: [{ id: delivery.deliveryId, active: false }] });
    expect(count("cancel")).toBe(1);
    expect((await service.create({ deliveryIds: [delivery.deliveryId] }, null)).shipment.status).toBe("draft");
  });

  it("keeps the booking when the broker refuses to cancel", async () => {
    const { shipment } = await draft();
    await service.book(shipment.id, { rateId: dhl(await service.fetchRates(shipment.id)).id }, null);
    fake.state.cancelError = refused("Redan upphämtad");
    const err = await service.cancel(shipment.id, null).catch((e) => e);
    expect(err).toBeInstanceOf(FreightCancelRefusedError);
    expect(err.message).toContain("Redan upphämtad");
    expect((await service.get(shipment.id)).status).toBe("booked");
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.cancelStartedAt).toBeNull();
  });

  it("releases the cancel claim when the provider cannot be resolved", async () => {
    const { shipment } = await draft();
    await service.book(shipment.id, { rateId: dhl(await service.fetchRates(shipment.id)).id }, null);
    await settings.update({ apiKey: null }, null);
    await expect(service.cancel(shipment.id, null)).rejects.toBeInstanceOf(FreightNotConfiguredError);
    const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.status).toBe("booked");
    expect(row!.cancelStartedAt).toBeNull();
  });

  it("cancels a draft without calling the broker's cancel", async () => {
    const { shipment } = await draft();
    expect((await service.cancel(shipment.id, null)).status).toBe("cancelled");
    expect(count("cancel")).toBe(0);
  });

  it("refuses to book or cancel a cancelled shipment", async () => {
    const { shipment } = await draft();
    const rates = await service.fetchRates(shipment.id);
    await service.cancel(shipment.id, null);
    await expect(service.book(shipment.id, { rateId: dhl(rates).id }, null)).rejects.toBeInstanceOf(InvalidShipmentStatusError);
    await expect(service.cancel(shipment.id, null)).rejects.toBeInstanceOf(InvalidShipmentStatusError);
  });
});

describe("upphämtning på kortet", () => {
  it("warns on a draft whose pickup date has passed, never on a booked shipment", async () => {
    const { shipment } = await draft();
    expect((await service.get(shipment.id)).pickupWarning).toBeNull();
    await db.update(shipments).set({ pickupDate: "2020-01-06" }).where(eq(shipments.id, shipment.id));
    expect((await service.get(shipment.id)).pickupWarning).toBe("Upphämtningsdatumet har passerat — välj ett nytt datum");
    await db.update(shipments).set({ status: "booked" }).where(eq(shipments.id, shipment.id));
    expect((await service.get(shipment.id)).pickupWarning).toBeNull();
  });
});
