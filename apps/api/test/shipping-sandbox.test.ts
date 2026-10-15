import { describe, expect, it } from "vitest";
import { createSendifyProvider } from "../src/modules/shipping/service/sendify-provider.js";
import { addDays, nextPickup, stockholmNow } from "../src/modules/shipping/service/pickup.js";

// Röktest mot Sendifys sandlåda — körs bara när SENDIFY_SANDBOX_API_KEY finns
// i miljön (samma nyckel som ERPNext Sverige Frakts sandlådetest). I sandlådan
// går fullständig bokning bara med DHL, UPS och DSV.
const KEY = process.env.SENDIFY_SANDBOX_API_KEY;

const PARTY = {
  addressLine2: null,
  countryCode: "SE",
  contactName: "Test Testsson",
  phone: "0701234567",
  email: "test@example.com",
  privatePerson: false,
};

describe.skipIf(!KEY)("Sendify-sandlådan", () => {
  it("creates, prices, books, prints and cancels", async () => {
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY! });
    expect((await p.checkKey()).team).toBeTruthy();

    const id = await p.createShipment({
      sender: { ...PARTY, name: "Nav Test AB", addressLine1: "Testgatan 1", postalCode: "41107", city: "Göteborg" },
      recipient: { ...PARTY, name: "Mottagare AB", addressLine1: "Drottninggatan 1", postalCode: "11151", city: "Stockholm" },
      parcels: [{ kind: "package", lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, quantity: 1, stackable: true, loadingMeters: null, description: "Testgods" }],
      referenceId: "nav-sandlada",
      senderReference: "FS-TEST",
      receiverReference: null,
    });

    const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, timeFrom: "09:00", timeTo: "16:00" }));
    const slot = nextPickup(stockholmNow(new Date()), weekdays, new Set()) ?? { date: addDays(stockholmNow(new Date()).date, 1), timeFrom: "09:00" };
    const { rates } = await p.getRates(id, { date: slot.date, time: slot.timeFrom });
    expect(rates.length).toBeGreaterThan(0);

    const rate = rates.find((r) => ["dhl", "ups", "dsv"].some((c) => (r.carrierCode || r.carrierName).toLowerCase().includes(c)));
    expect(rate, "ingen DHL/UPS/DSV-produkt i sandlådan").toBeDefined();
    const booked = await p.book(rate!.bookingToken);
    expect(booked.trackingNumber).toBeTruthy();

    const label = await p.fetchDocument(id, "label");
    expect(label.subarray(0, 4).toString()).toBe("%PDF");

    const tracking = await p.getTracking(id);
    expect(tracking[0]?.status).toBe("ORDERED");

    await p.cancel(id);
    // A second cancel (retry after a failed database write) is not an error.
    await p.cancel(id);
  }, 120_000);
});
