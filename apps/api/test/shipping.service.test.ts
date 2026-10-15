import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customerContacts, customerDeliveryAddresses, db, packageTypes, salesOrders, shipments } from "@navet/db";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { BOOKING_STALE_MS, createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import {
  DeliveryAlreadyShippedError,
  FreightBookingInProgressError,
  FreightNotConfiguredError,
  FreightPickupDayError,
  InvalidShipmentStatusError,
  MixedCustomersError,
  ShipmentNeedsDeliveryError,
} from "../src/modules/shipping/service/shipping.errors.js";
import { createFakeFreightProvider } from "./helpers/fake-freight-provider.js";
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
  auditEntries.length = 0;
  await resetShipping();
  await enableFreight();
});
afterAll(resetShipping);

async function oneDelivery(customerOver = {}) {
  const customer = await makeCustomer(customerOver);
  const article = await makeArticle({ name: "Låda", weight: 2, length: 400, width: 300, height: 200 });
  const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 3 }], { customerOrderNumber: "PO-77" });
  return { customer, article, delivery };
}

describe("skapa försändelse", () => {
  it("creates a draft with recipient, references, pickup and suggested parcels", async () => {
    const { customer, delivery } = await oneDelivery();
    const { shipment, warnings } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    expect(warnings).toEqual([]);
    expect(shipment.shipmentNumber).toMatch(/^FR-\d+$/);
    expect(shipment).toMatchObject({
      status: "draft",
      customerId: customer.id,
      recipientName: customer.name,
      recipientAddressLine1: "Kundgatan 1",
      recipientPostalCode: "11151",
      recipientCity: "Stockholm",
      recipientPhone: "08-111111",
      senderName: "Vi AB",
      senderReference: delivery.deliveryNumber,
      receiverReference: "PO-77",
      rates: null,
    });
    expect(shipment.pickupDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(shipment.pickupFrom).toBe("08:00");
    expect(shipment.parcels).toMatchObject([{ parcelKind: "package", lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 2, quantity: 3 }]);
    expect(shipment.deliveries).toMatchObject([{ id: delivery.deliveryId, deliveryNumber: delivery.deliveryNumber, active: true }]);
  });

  it("combines several följesedlar to the same customer", async () => {
    const customer = await makeCustomer();
    const [eur] = await db
      .insert(packageTypes)
      .values({ code: "EUR", name: "EUR-pall", parcelKind: "pallet", lengthMm: "1200", widthMm: "800", heightMm: "1000", tareWeight: "25" })
      .returning();
    const a = await makeArticle({ name: "A", weight: 1, length: undefined, width: undefined, height: undefined, packageTypeId: eur!.id, quantityPerPackage: 40 });
    const d1 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 60 }]);
    const d2 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 40 }]);
    const { shipment } = await service.create({ deliveryIds: [d1.deliveryId, d2.deliveryId] }, null);
    expect(shipment.parcels).toMatchObject([{ parcelKind: "pallet", quantity: 3, weightKg: 58.33 }]);
    expect(shipment.senderReference).toBe([d1.deliveryNumber, d2.deliveryNumber].sort().join(", "));
  });

  it("refuses följesedlar to different customers", async () => {
    const one = await oneDelivery();
    const two = await oneDelivery();
    await expect(service.create({ deliveryIds: [one.delivery.deliveryId, two.delivery.deliveryId] }, null)).rejects.toBeInstanceOf(MixedCustomersError);
  });

  it("refuses a följesedel that is already in a live shipment, naming it", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    const err = await service.create({ deliveryIds: [delivery.deliveryId] }, null).catch((e) => e);
    expect(err).toBeInstanceOf(DeliveryAlreadyShippedError);
    expect(err.message).toContain(shipment.shipmentNumber);
    expect(err.message).toContain(delivery.deliveryNumber);
  });

  it("refuses when frakten is not enabled", async () => {
    const { delivery } = await oneDelivery();
    await settings.update({ enabled: false }, null);
    await expect(service.create({ deliveryIds: [delivery.deliveryId] }, null)).rejects.toBeInstanceOf(FreightNotConfiguredError);
  });

  it("prefers the order's delivery address and the primary contact", async () => {
    const { customer, delivery } = await oneDelivery();
    const [addr] = await db
      .insert(customerDeliveryAddresses)
      .values({ customerId: customer.id, label: "Lager", address: "Lastkajen 5\nPort 2", postalCode: "22222", city: "Lund", country: "SE" })
      .returning();
    await db.update(salesOrders).set({ deliveryAddressId: addr!.id }).where(eq(salesOrders.id, delivery.orderId));
    await db.insert(customerContacts).values({ customerId: customer.id, name: "Anna", mobile: "070-1", isPrimary: true });
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    expect(shipment).toMatchObject({
      recipientAddressLine1: "Lastkajen 5",
      recipientAddressLine2: "Port 2",
      recipientCity: "Lund",
      recipientContactName: "Anna",
      recipientPhone: "070-1",
    });
  });
});

describe("redigera utkast", () => {
  it("updates the recipient, drops stale rates and keeps a manual customer price", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    await db
      .update(shipments)
      .set({ lastRates: { fetchedAt: new Date().toISOString(), rates: [], warnings: [] }, ratesFetchedAt: new Date() })
      .where(eq(shipments.id, shipment.id));
    const updated = await service.update(shipment.id, { recipientCity: "Malmö", customerPrice: 499 }, null);
    expect(updated).toMatchObject({ recipientCity: "Malmö", customerPrice: 499, customerPriceManual: true, rates: null });
  });

  it("refuses a pickup date without pickup", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    // 2099-01-03 is a Saturday — no pickup row for weekday 6.
    await expect(service.update(shipment.id, { pickupDate: "2099-01-03" }, null)).rejects.toBeInstanceOf(FreightPickupDayError);
    const moved = await service.update(shipment.id, { pickupDate: "2099-01-05" }, null);
    expect(moved).toMatchObject({ pickupDate: "2099-01-05", pickupFrom: "08:00", pickupTo: "16:00" });
  });

  it("replaces parcels as a whole set", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    const updated = await service.replaceParcels(shipment.id, [
      { parcelKind: "pallet", lengthCm: 120, widthCm: 80, heightCm: 150, weightKg: 300, quantity: 1, stackable: false, loadingMeters: 0.4, description: "Allt" },
    ]);
    expect(updated.parcels).toMatchObject([{ position: 1, parcelKind: "pallet", weightKg: 300, loadingMeters: 0.4 }]);
  });

  it("stores a Paket parcel as stackable whatever the input says — that is what Sendify gets", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    const view = await service.replaceParcels(shipment.id, [
      { parcelKind: "package", lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, quantity: 1, stackable: false, loadingMeters: null, description: null },
      { parcelKind: "pallet", lengthCm: 120, widthCm: 80, heightCm: 100, weightKg: 65, quantity: 1, stackable: false, loadingMeters: null, description: null },
    ]);
    expect(view.parcels.map((p) => p.stackable)).toEqual([true, false]);
  });

  it("refuses edits once booked, but still takes the customer price", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    await db.update(shipments).set({ status: "booked" }).where(eq(shipments.id, shipment.id));
    await expect(service.update(shipment.id, { recipientCity: "Malmö" }, null)).rejects.toBeInstanceOf(InvalidShipmentStatusError);
    await expect(service.replaceParcels(shipment.id, [])).rejects.toBeInstanceOf(InvalidShipmentStatusError);
    expect((await service.update(shipment.id, { customerPrice: 300 }, null)).customerPrice).toBe(300);
  });

  it("adds and removes följesedlar, re-suggesting parcels and the sender reference", async () => {
    const customer = await makeCustomer();
    const a = await makeArticle({ weight: 1 });
    const d1 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 1 }]);
    const d2 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 2 }]);
    const { shipment } = await service.create({ deliveryIds: [d1.deliveryId] }, null);
    const added = await service.addDelivery(shipment.id, d2.deliveryId, null);
    expect(added.shipment.parcels[0]!.quantity).toBe(3);
    expect(added.shipment.senderReference).toBe([d1.deliveryNumber, d2.deliveryNumber].sort().join(", "));
    const removed = await service.removeDelivery(shipment.id, d1.deliveryId, null);
    expect(removed.shipment.parcels[0]!.quantity).toBe(2);
    await expect(service.removeDelivery(shipment.id, d2.deliveryId, null)).rejects.toBeInstanceOf(ShipmentNeedsDeliveryError);
    // Both link events name the följesedel, never its uuid.
    expect(auditEntries.filter((e) => e.action.startsWith("delivery_")).map((e) => e.detail)).toEqual([
      { delivery: d2.deliveryNumber },
      { delivery: d1.deliveryNumber },
    ]);
  });

  it("blocks draft edits and deletion while a booking reservation is fresh, not once it is stale", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    await db.update(shipments).set({ bookingStartedAt: new Date() }).where(eq(shipments.id, shipment.id));
    await expect(service.update(shipment.id, { recipientCity: "Malmö" }, null)).rejects.toBeInstanceOf(FreightBookingInProgressError);
    await expect(service.replaceParcels(shipment.id, [])).rejects.toBeInstanceOf(FreightBookingInProgressError);
    await expect(service.remove(shipment.id, null)).rejects.toBeInstanceOf(FreightBookingInProgressError);
    // Abandoned reservation (older than BOOKING_STALE_MS): the draft is editable again.
    await db
      .update(shipments)
      .set({ bookingStartedAt: new Date(Date.now() - BOOKING_STALE_MS - 60_000) })
      .where(eq(shipments.id, shipment.id));
    expect((await service.update(shipment.id, { recipientCity: "Malmö" }, null)).recipientCity).toBe("Malmö");
  });

  it("keeps a sender reference typed by hand when följesedlar change", async () => {
    const customer = await makeCustomer();
    const a = await makeArticle();
    const d1 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 1 }]);
    const d2 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 1 }]);
    const { shipment } = await service.create({ deliveryIds: [d1.deliveryId] }, null);
    await service.update(shipment.id, { senderReference: "Märk: Kök" }, null);
    expect((await service.addDelivery(shipment.id, d2.deliveryId, null)).shipment.senderReference).toBe("Märk: Kök");
  });
});

describe("listor och borttag", () => {
  it("lists open följesedlar for a customer without the ones already in a shipment", async () => {
    const customer = await makeCustomer();
    const a = await makeArticle();
    const d1 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 1 }]);
    const d2 = await makeDelivery(customer.id, [{ articleId: a.id, quantity: 1 }]);
    await service.create({ deliveryIds: [d1.deliveryId] }, null);
    expect((await service.listOpenDeliveries(customer.id)).map((d) => d.id)).toEqual([d2.deliveryId]);
  });

  it("searches on följesedel number and filters on status", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    const found = await service.list({ search: delivery.deliveryNumber, limit: 50, offset: 0 });
    expect(found.total).toBe(1);
    expect(found.rows[0]).toMatchObject({ id: shipment.id, deliveryNumbers: delivery.deliveryNumber, status: "draft" });
    expect((await service.list({ status: "booked", limit: 50, offset: 0 })).total).toBe(0);
  });

  it("deletes a draft and frees its följesedel; a booked one cannot be deleted", async () => {
    const { delivery } = await oneDelivery();
    const { shipment } = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    await service.remove(shipment.id, null);
    const again = await service.create({ deliveryIds: [delivery.deliveryId] }, null);
    await db.update(shipments).set({ status: "booked" }).where(eq(shipments.id, again.shipment.id));
    await expect(service.remove(again.shipment.id, null)).rejects.toBeInstanceOf(InvalidShipmentStatusError);
  });
});
