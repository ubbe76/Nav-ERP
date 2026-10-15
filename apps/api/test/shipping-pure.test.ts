import { describe, expect, it } from "vitest";
import {
  addDays,
  isoWeekday,
  nextPickup,
  pickupFor,
  pickupProblem,
  requestedPickupTime,
  stockholmNow,
  type PickupTime,
} from "../src/modules/shipping/service/pickup.js";
import { customerPriceFor, priceChangeExceeds } from "../src/modules/shipping/service/pricing.js";
import { resolveRecipient, senderReferenceFor, splitAddress, type RecipientSource } from "../src/modules/shipping/service/recipient.js";
import { missingForBooking, type PartyFields } from "../src/modules/shipping/service/shipment-validation.js";
import {
  classifyTrackingStatus,
  isTrackingDue,
  latestEvent,
  trackingStatusLabel,
  trackingText,
} from "../src/modules/shipping/service/tracking-status.js";

// 2030-01-07 is a Monday.
const WEEKDAYS: PickupTime[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, timeFrom: "09:00:00", timeTo: weekday === 5 ? "12:00:00" : "15:00:00" }));
const none = new Set<string>();

describe("pickup", () => {
  it("knows ISO weekdays and adds days across months", () => {
    expect(isoWeekday("2030-01-07")).toBe(1);
    expect(isoWeekday("2030-01-13")).toBe(7);
    expect(addDays("2030-01-31", 1)).toBe("2030-02-01");
  });

  it("gives the weekday's times, none on a weekday without a row or a full-day holiday", () => {
    expect(pickupFor("2030-01-11", WEEKDAYS, none)).toEqual({ date: "2030-01-11", timeFrom: "09:00", timeTo: "12:00" });
    expect(pickupFor("2030-01-12", WEEKDAYS, none)).toBeNull();
    expect(pickupFor("2030-01-08", WEEKDAYS, new Set(["2030-01-08"]))).toBeNull();
  });

  it("takes today only while a pickup can still be asked for", () => {
    // Till 15:00: 14:45 is the last quarter that can be requested today.
    expect(nextPickup({ date: "2030-01-07", time: "14:45" }, WEEKDAYS, none)?.date).toBe("2030-01-07");
    expect(nextPickup({ date: "2030-01-07", time: "14:46" }, WEEKDAYS, none)?.date).toBe("2030-01-08");
    expect(nextPickup({ date: "2030-01-07", time: "15:00" }, WEEKDAYS, none)?.date).toBe("2030-01-08");
  });

  it("names what is wrong with a stored pickup, or nothing", () => {
    const slot = { date: "2030-01-07", timeFrom: "09:00", timeTo: "15:00" };
    expect(pickupProblem(slot, slot, { date: "2030-01-07", time: "10:00" })).toBeNull();
    expect(pickupProblem(slot, slot, { date: "2030-01-06", time: "23:00" })).toBeNull();
    expect(pickupProblem(slot, slot, { date: "2030-01-08", time: "08:00" })).toBe("Upphämtningsdatumet har passerat — välj ett nytt datum");
    expect(pickupProblem(slot, null, { date: "2030-01-06", time: "08:00" })).toBe("Ingen upphämtning 2030-01-07 — välj en annan dag");
    expect(pickupProblem(slot, slot, { date: "2030-01-07", time: "14:50" })).toBe("Dagens upphämtningstid har passerat — välj ett nytt datum");
  });

  it("skips the weekend and holidays", () => {
    expect(nextPickup({ date: "2030-01-11", time: "13:00" }, WEEKDAYS, none)?.date).toBe("2030-01-14");
    expect(nextPickup({ date: "2030-01-11", time: "13:00" }, WEEKDAYS, new Set(["2030-01-14"]))?.date).toBe("2030-01-15");
  });

  it("a Saturday row works", () => {
    const withSaturday = [...WEEKDAYS, { weekday: 6, timeFrom: "10:00", timeTo: "11:00" }];
    expect(nextPickup({ date: "2030-01-11", time: "13:00" }, withSaturday, none)?.date).toBe("2030-01-12");
  });

  it("gives up after 14 days", () => {
    expect(nextPickup({ date: "2030-01-07", time: "08:00" }, [], none)).toBeNull();
  });

  it("asks for the window's Från time on another day, but never a time already passed today", () => {
    const slot = { date: "2030-01-07", timeFrom: "08:00", timeTo: "16:00" };
    expect(requestedPickupTime(slot, { date: "2030-01-06", time: "23:59" })).toBe("08:00");
    expect(requestedPickupTime(slot, { date: "2030-01-07", time: "07:10" })).toBe("08:00");
    // Inside the window: now rounded UP to the next quarter hour.
    expect(requestedPickupTime(slot, { date: "2030-01-07", time: "10:31" })).toBe("10:45");
    expect(requestedPickupTime(slot, { date: "2030-01-07", time: "10:45" })).toBe("10:45");
    expect(requestedPickupTime(slot, { date: "2030-01-07", time: "10:46" })).toBe("11:00");
    expect(requestedPickupTime(slot, { date: "2030-01-07", time: "15:45" })).toBe("15:45");
    // Past the last quarter before Till (or past Till): nothing left today.
    expect(requestedPickupTime(slot, { date: "2030-01-07", time: "15:46" })).toBeNull();
    expect(requestedPickupTime(slot, { date: "2030-01-07", time: "17:00" })).toBeNull();
    // Postgres time columns ("HH:MM:SS") are accepted as the window.
    expect(requestedPickupTime({ ...slot, timeFrom: "08:00:00", timeTo: "16:00:00" }, { date: "2030-01-07", time: "09:00" })).toBe("09:00");
  });

  it("reads Stockholm wall-clock time (summer and winter)", () => {
    expect(stockholmNow(new Date("2030-07-01T22:30:00Z"))).toEqual({ date: "2030-07-02", time: "00:30" });
    expect(stockholmNow(new Date("2030-01-07T08:05:00Z"))).toEqual({ date: "2030-01-07", time: "09:05" });
  });
});

describe("pricing", () => {
  it("adds percent and amount and rounds to whole kronor", () => {
    expect(customerPriceFor(412.4, 10, 0)).toBe(454);
    expect(customerPriceFor(412.4, 0, 50)).toBe(462);
    expect(customerPriceFor(100, 12.5, 25)).toBe(138);
  });

  it("flags a price change over the threshold only", () => {
    expect(priceChangeExceeds(400, 420, 5)).toBe(false);
    expect(priceChangeExceeds(400, 421, 5)).toBe(true);
    expect(priceChangeExceeds(400, 379, 5)).toBe(true);
    expect(priceChangeExceeds(0, 10, 5)).toBe(true);
  });
});

describe("recipient", () => {
  const base: RecipientSource = {
    customer: { name: "Kund AB", address: "Besöksvägen 1", postalCode: "11111", city: "Stad", country: "SE", phone: "08-1", email: "kund@example.com", privatePerson: false },
    orderAddress: null,
    defaultAddress: null,
    primaryContact: null,
    order: { customerOrderNumber: null, customerReference: null },
  };

  it("splits a multi-line address on the first line break", () => {
    expect(splitAddress("Port 3\nLastkajen 5\nBakgården")).toEqual(["Port 3", "Lastkajen 5, Bakgården"]);
    expect(splitAddress("  ")).toEqual([null, null]);
    expect(splitAddress(null)).toEqual([null, null]);
  });

  it("prefers the order's delivery address, then the default, then the visiting address", () => {
    const order = { address: "Ordergatan 2", postalCode: "22222", city: "Orderstad", country: "NO" };
    const def = { address: "Förvald 3", postalCode: "33333", city: "Förvaldstad", country: "SE" };
    expect(resolveRecipient({ ...base, orderAddress: order, defaultAddress: def }).recipientCity).toBe("Orderstad");
    expect(resolveRecipient({ ...base, orderAddress: order }).recipientCountry).toBe("NO");
    expect(resolveRecipient({ ...base, defaultAddress: def }).recipientAddressLine1).toBe("Förvald 3");
    expect(resolveRecipient(base).recipientAddressLine1).toBe("Besöksvägen 1");
  });

  it("takes the primary contact, field by field falling back to the customer", () => {
    const r = resolveRecipient({ ...base, primaryContact: { name: "Anna", phone: null, mobile: "070-1", email: null } });
    expect(r).toMatchObject({ recipientContactName: "Anna", recipientPhone: "070-1", recipientEmail: "kund@example.com" });
    expect(resolveRecipient(base)).toMatchObject({ recipientContactName: null, recipientPhone: "08-1" });
  });

  it("uses Ert ordernummer before Er referens", () => {
    expect(resolveRecipient({ ...base, order: { customerOrderNumber: "PO-9", customerReference: "Anna" } }).receiverReference).toBe("PO-9");
    expect(resolveRecipient({ ...base, order: { customerOrderNumber: null, customerReference: "Anna" } }).receiverReference).toBe("Anna");
  });

  it("joins följesedel numbers for the sender reference", () => {
    expect(senderReferenceFor(["FS-1002", "FS-1001"])).toBe("FS-1001, FS-1002");
    expect(senderReferenceFor([])).toBeNull();
  });
});

describe("missingForBooking", () => {
  const ok: PartyFields = {
    recipientName: "Kund AB",
    recipientAddressLine1: "Gatan 1",
    recipientPostalCode: "11111",
    recipientCity: "Stad",
    recipientCountry: "SE",
    recipientPhone: null,
    recipientEmail: "a@example.com",
    senderName: "Vi AB",
    senderAddressLine1: "Fabriken 1",
    senderPostalCode: "22222",
    senderCity: "Bruket",
    senderCountry: "SE",
    senderPhone: "0123",
    senderEmail: null,
  };

  it("passes a complete shipment", () => {
    expect(missingForBooking(ok, [{ weightKg: 5 }])).toEqual([]);
  });

  it("lists what is missing in Swedish", () => {
    expect(
      missingForBooking({ ...ok, recipientEmail: null, recipientPostalCode: " ", senderAddressLine1: null }, [{ weightKg: 0 }, { weightKg: 3 }])
    ).toEqual(["Mottagare: postnummer", "Mottagare: telefon eller e-post", "Avsändare: adress", "Kolli 1: vikt"]);
    expect(missingForBooking(ok, [])).toEqual(["Minst ett kolli"]);
  });
});

// Frakt etapp 2 — spårning.
describe("spårning — klassning", () => {
  it("classifies broker statuses", () => {
    expect(classifyTrackingStatus("DELIVERED")).toBe("delivered");
    expect(classifyTrackingStatus("delivered")).toBe("delivered");
    for (const s of ["EXCEPTION", "RETURNED", "LOST", "DEVIATION"]) expect(classifyTrackingStatus(s)).toBe("exception");
    for (const s of ["ORDERED", "IN_TRANSIT", "SOMETHING_NEW", null, ""]) expect(classifyTrackingStatus(s)).toBe("in_transit");
  });

  it("picks the latest event by time, not array order", () => {
    const a = { occurredAt: "2026-10-08T10:00:00Z", n: 1 };
    const b = { occurredAt: "2026-10-08T12:00:00+02:00", n: 2 }; // = 10:00Z, tie → later in array wins
    const c = { occurredAt: "2026-10-08T09:00:00Z", n: 3 };
    expect(latestEvent([c, a, b])?.n).toBe(2);
    expect(latestEvent([])).toBeNull();
  });

  it("names known statuses in Swedish and humanises unknown ones", () => {
    expect(trackingStatusLabel("ORDERED")).toBe("Beställd");
    expect(trackingStatusLabel("delivered")).toBe("Levererad");
    expect(trackingStatusLabel("IN_TRANSIT")).toBe("Under transport");
    expect(trackingStatusLabel("CANCELED")).toBe("Avbokad");
    expect(trackingStatusLabel("SOMETHING_NEW")).toBe("Something new");
    expect(trackingStatusLabel("")).toBeNull();
    expect(trackingStatusLabel(null)).toBeNull();
  });

  it("formats the text with location when present", () => {
    expect(trackingText({ status: "IN_TRANSIT", description: "På väg", location: "Göteborg" })).toBe("På väg (Göteborg)");
    expect(trackingText({ status: "ORDERED", description: null, location: null })).toBe("Beställd");
    expect(trackingText({ status: null, description: null, location: null })).toBeNull();
  });

  it("is due by interval with a 5 minute margin", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(isTrackingDue(null, "hourly", now)).toBe(true);
    expect(isTrackingDue(new Date("2026-10-08T11:10:00Z"), "hourly", now)).toBe(false);
    expect(isTrackingDue(new Date("2026-10-08T11:04:00Z"), "hourly", now)).toBe(true); // 56 min ≥ 55
    expect(isTrackingDue(new Date("2026-10-08T09:00:00Z"), "every_4h", now)).toBe(false);
    expect(isTrackingDue(new Date("2026-10-07T12:04:00Z"), "daily", now)).toBe(true);
  });
});
