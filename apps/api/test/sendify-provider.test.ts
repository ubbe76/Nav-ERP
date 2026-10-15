import { describe, expect, it } from "vitest";
import { FreightProviderError, type ProviderShipment } from "../src/modules/shipping/service/freight-provider.js";
import {
  createSendifyProvider,
  fieldLabel,
  SENDIFY_MESSAGES,
  stockholmIso,
  toSendifyShipment,
} from "../src/modules/shipping/service/sendify-provider.js";

const KEY = "secret-sendify-key-123";

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const SHIPMENT: ProviderShipment = {
  sender: { name: "Vi AB", addressLine1: "Fabriken 1", addressLine2: null, postalCode: "41107", city: "Göteborg", countryCode: "SE", contactName: null, phone: "0701234567", email: "", privatePerson: false },
  recipient: { name: "Kund AB", addressLine1: "Gatan 1", addressLine2: "Port 3", postalCode: "11151", city: "Stockholm", countryCode: "SE", contactName: "Anna", phone: null, email: "a@example.com", privatePerson: true },
  parcels: [{ kind: "pallet", lengthCm: 120, widthCm: 80, heightCm: 100, weightKg: 65, quantity: 3, stackable: false, loadingMeters: null, description: "A, B" }],
  referenceId: "FR-1001",
  senderReference: "FS-1001",
  receiverReference: null,
};

describe("Sendify format", () => {
  it("maps our shipment, strips empty values and always sends is_private_individual", () => {
    expect(toSendifyShipment(SHIPMENT)).toEqual({
      enable_bookable_validation: true,
      from: {
        name: "Vi AB",
        address: { address_line_1: "Fabriken 1", postal_code: "41107", city: "Göteborg", country_code: "SE" },
        // Sendify requires contact.name on both parties — a missing
        // contact person falls back to the party's name.
        contact: { name: "Vi AB", phone: "0701234567" },
      },
      to: {
        name: "Kund AB",
        address: { address_line_1: "Gatan 1", address_line_2: "Port 3", postal_code: "11151", city: "Stockholm", country_code: "SE" },
        contact: { name: "Anna", email: "a@example.com" },
        is_private_individual: true,
      },
      reference_id: "FR-1001",
      sender_reference: "FS-1001",
      packages: [{ depth_cm: 120, width_cm: 80, height_cm: 100, weight_kg: 65, quantity: 3, type: "PALLET", stackable: false, description: "A, B" }],
      system: "Nav ERP",
    });
  });

  it("always sends PACKAGE parcels as stackable — Sendify refuses them otherwise", () => {
    const body = toSendifyShipment({
      ...SHIPMENT,
      parcels: [
        { kind: "package", lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, quantity: 2, stackable: false, loadingMeters: null, description: "Kartong" },
        { kind: "pallet", lengthCm: 120, widthCm: 80, heightCm: 100, weightKg: 65, quantity: 1, stackable: false, loadingMeters: null, description: null },
      ],
    }) as { packages: { type: string; stackable: boolean }[] };
    expect(body.packages.map((p) => [p.type, p.stackable])).toEqual([
      ["PACKAGE", true],
      ["PALLET", false],
    ]);
  });

  it("names Sendify's fields in Swedish", () => {
    expect(fieldLabel("packages[0].weight_kg")).toBe("Kolli 1: vikt");
    expect(fieldLabel("to.contact.email")).toBe("Mottagare: e-post");
    expect(fieldLabel("from.address.postal_code")).toBe("Avsändare: postnummer");
    expect(fieldLabel("requested_pickup_time")).toBe("upphämtningstid");
    expect(fieldLabel("something_else")).toBe("something_else");
  });

  it("sends the pickup time in Swedish local time with the right offset", () => {
    expect(stockholmIso("2030-07-02", "09:00")).toBe("2030-07-02T09:00:00+02:00");
    expect(stockholmIso("2030-01-07", "09:30")).toBe("2030-01-07T09:30:00+01:00");
  });
});

describe("Sendify HTTP", () => {
  it("creates a shipment against the sandbox with the api key header", async () => {
    const f = fakeFetch([json({ id: "snd-1" }, 201)]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    expect(await p.createShipment(SHIPMENT)).toBe("snd-1");
    expect(f.calls[0]!.url).toBe("https://app.dev.sendify.se/external/v1/shipments");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
  });

  it("uses the production URL in production", async () => {
    const f = fakeFetch([json({ team: "Vi AB" })]);
    const p = createSendifyProvider({ environment: "production", apiKey: KEY }, { fetch: f.fn });
    expect(await p.checkKey()).toEqual({ team: "Vi AB" });
    expect(f.calls[0]!.url).toBe("https://app.sendify.se/external/v1/status");
  });

  it("fetches and parses rates", async () => {
    const f = fakeFetch([
      json({
        rates: [
          {
            booking_token: "tok-1",
            carrier_code: "dhl",
            carrier_name: "DHL Freight",
            product_name: "DHL Paket",
            price: 412.4,
            currency: "SEK",
            transport_business_days_min: 1,
            transport_business_days_max: 2,
            pickup: { date: "2030-07-02" },
            estimated_delivery: { earliest_date: "2030-07-03" },
            expires_at: "2030-07-02T10:00:00Z",
          },
        ],
        warnings: [{ carrier_name: "Schenker", warnings: ["för tungt", "för långt"] }],
      }),
    ]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    const result = await p.getRates("snd-1", { date: "2030-07-02", time: "09:00" });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ shipment_id: "snd-1", requested_pickup_time: "2030-07-02T09:00:00+02:00" });
    expect(result).toEqual({
      rates: [
        {
          bookingToken: "tok-1",
          carrierCode: "dhl",
          carrierName: "DHL Freight",
          productName: "DHL Paket",
          price: 412.4,
          currency: "SEK",
          daysMin: 1,
          daysMax: 2,
          pickupDate: "2030-07-02",
          estimatedDeliveryDate: "2030-07-03",
          expiresAt: "2030-07-02T10:00:00Z",
        },
      ],
      warnings: ["Schenker: för tungt; för långt"],
    });
  });

  it("turns a 422 with an errors object into Swedish field errors", async () => {
    const f = fakeFetch([
      json({ message: "Validation failed", errors: { "packages[0].weight_kg": ["must be > 0"], "to.contact.phone": "required" } }, 422, { "x-sendify-request-id": "req-9" }),
    ]);
    const logged: unknown[] = [];
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: (e) => logged.push(e) });
    const err = await p.createShipment(SHIPMENT).catch((e) => e);
    expect(err).toBeInstanceOf(FreightProviderError);
    expect(err).toMatchObject({ kind: "validation", message: "Validation failed", requestId: "req-9", fieldErrors: ["Kolli 1: vikt: must be > 0", "Mottagare: telefon: required"] });
    expect(JSON.stringify(logged)).toContain("req-9");
    expect(JSON.stringify(logged)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(err.message).not.toContain(KEY);
  });

  it("reads an errors list with field/message entries", async () => {
    const f = fakeFetch([json({ errors: [{ field: "from.address.city", message: "required" }, { message: "general" }] }, 400)]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: () => {} });
    const err = await p.createShipment(SHIPMENT).catch((e) => e);
    expect(err).toMatchObject({ kind: "validation", message: "Sendify kunde inte behandla sändningen", fieldErrors: ["Avsändare: ort: required", "general"] });
  });

  it("reports 5xx and network errors as unavailable", async () => {
    const f = fakeFetch([new Response("boom", { status: 503 }), new TypeError("fetch failed")]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: () => {} });
    await expect(p.deleteShipment("snd-1")).rejects.toMatchObject({ kind: "unavailable", message: SENDIFY_MESSAGES.unavailable });
    await expect(p.deleteShipment("snd-1")).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("logs a transport failure by name and cause code only, never the key", async () => {
    const f = fakeFetch([Object.assign(new TypeError("fetch failed " + KEY), { cause: { code: "ECONNREFUSED" } })]);
    const logged: unknown[] = [];
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: (e) => logged.push(e) });
    const err = await p.deleteShipment("snd-1").catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
    expect(logged).toEqual([{ method: "DELETE", path: "/shipments/snd-1", status: 0, requestId: null, body: "TypeError ECONNREFUSED" }]);
    expect(JSON.stringify(logged)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(err.message).not.toContain(KEY);
    expect(err.cause).toBeUndefined();
  });

  it("reports a network error on BOOK as booking-unknown", async () => {
    const f = fakeFetch([new TypeError("fetch failed")]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: () => {} });
    await expect(p.book("tok-1")).rejects.toMatchObject({ kind: "booking-unknown", message: SENDIFY_MESSAGES.bookingUnknown });
  });

  it("reports a 5xx on BOOK as booking-unknown, not as something to retry", async () => {
    const f = fakeFetch([json({}, 502)]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: () => {} });
    await expect(p.book("tok-1")).rejects.toMatchObject({ kind: "booking-unknown", message: SENDIFY_MESSAGES.bookingUnknown });
  });

  it("reports 401 as unauthorized with a hint about the settings page", async () => {
    const f = fakeFetch([json({ message: "Unauthorized" }, 401)]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: () => {} });
    await expect(p.checkKey()).rejects.toMatchObject({ kind: "unauthorized", message: SENDIFY_MESSAGES.unauthorized });
    expect(SENDIFY_MESSAGES.unauthorized).toBe("Sendify godkände inte API-nyckeln — kontrollera den under System → Frakt");
  });

  it("reports 429 as unavailable", async () => {
    const f = fakeFetch([json({ message: "Too many requests" }, 429)]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: () => {} });
    await expect(p.deleteShipment("snd-1")).rejects.toMatchObject({ kind: "unavailable", message: SENDIFY_MESSAGES.unavailable });
  });

  it("books and returns the tracking number and document types", async () => {
    const f = fakeFetch([json({ main_tracking_id: "JJD000123", available_document_types: ["label", "waybill"] })]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    expect(await p.book("tok-1")).toEqual({ trackingNumber: "JJD000123", documentTypes: ["label", "waybill"] });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ booking_token: "tok-1" });
  });

  it("downloads a document through its output url", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake");
    const f = fakeFetch([json({ output_url: "https://files.example/label.pdf" }), new Response(pdf, { status: 200 })]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    expect((await p.fetchDocument("snd-1", "label")).toString()).toBe("%PDF-1.4 fake");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ shipment_ids: ["snd-1"], document_type: "label", label_layout: "a4", output_format: "url" });
    expect(f.calls[1]!.url).toBe("https://files.example/label.pdf");
  });

  it("logs a failed document download without the signed url or the key", async () => {
    const f = fakeFetch([json({ output_url: "https://files.example/label.pdf?sig=abc" }), Object.assign(new DOMException("timed out", "TimeoutError"), { cause: undefined })]);
    const logged: unknown[] = [];
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn, log: (e) => logged.push(e) });
    await expect(p.fetchDocument("snd-1", "label")).rejects.toMatchObject({ kind: "unavailable" });
    expect(logged).toEqual([{ method: "GET", path: "output_url", status: 0, requestId: null, body: "TimeoutError" }]);
    expect(JSON.stringify(logged)).not.toContain("sig=abc");
  });

  it("rejects an unreadable answer", async () => {
    const f = fakeFetch([new Response("not json", { status: 200 })]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    await expect(p.createShipment(SHIPMENT)).rejects.toMatchObject({ kind: "unexpected" });
  });

  it("reads tracking events and drops entries without a parsable time", async () => {
    const f = fakeFetch([
      json([
        { created_at: "2026-10-08T09:00:00Z", status: "ORDERED", description: "Bokad", location_name: "Göteborg", url: "https://t.example/1" },
        { created_at: "not a date", status: "IN_TRANSIT" },
        { status: "NO_TIME" },
      ]),
    ]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    expect(await p.getTracking("snd-1")).toEqual([
      { occurredAt: "2026-10-08T09:00:00Z", status: "ORDERED", description: "Bokad", location: "Göteborg", url: "https://t.example/1" },
    ]);
    expect(f.calls[0]!.url).toBe("https://app.dev.sendify.se/external/v1/shipments/snd-1/tracking");
  });

  it("cancels with the shipment id", async () => {
    const f = fakeFetch([new Response(null, { status: 204 })]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    await p.cancel("snd-1");
    expect(f.calls[0]!.url).toBe("https://app.dev.sendify.se/external/v1/shipments/cancel");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ shipment_id: "snd-1" });
  });

  it("counts a refused cancel as done when Sendify reports the shipment as CANCELED", async () => {
    const f = fakeFetch([json({ message: "Cannot cancel" }, 422), json({ id: "snd-1", status: "CANCELED" })]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    await expect(p.cancel("snd-1")).resolves.toBeUndefined();
    expect(f.calls[1]!.url).toBe("https://app.dev.sendify.se/external/v1/shipments/snd-1");
  });

  it("rethrows the original refusal when the shipment is in any other status", async () => {
    const f = fakeFetch([json({ message: "Already picked up" }, 422), json({ status: "IN_PROGRESS" })]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    await expect(p.cancel("snd-1")).rejects.toMatchObject({ kind: "validation", message: "Already picked up" });
  });

  it("rethrows the original refusal when the status lookup fails", async () => {
    const f = fakeFetch([json({ message: "Already picked up" }, 422), new TypeError("fetch failed")]);
    const p = createSendifyProvider({ environment: "sandbox", apiKey: KEY }, { fetch: f.fn });
    await expect(p.cancel("snd-1")).rejects.toMatchObject({ kind: "validation", message: "Already picked up" });
  });
});
