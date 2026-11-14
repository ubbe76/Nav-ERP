import { describe, expect, it } from "vitest";
import { FreightProviderError, type ProviderShipment } from "../src/modules/shipping/service/freight-provider.js";
import { carrierFromDescription, createNshiftProvider, NSHIFT_BASE_URL, toNshiftShipment, nshiftOptions } from "../src/modules/shipping/service/nshift-provider.js";
import { createShipmondoProvider, SHIPMONDO_BASE_URL, shipmondoParcels } from "../src/modules/shipping/service/shipmondo-provider.js";

// nShift (Delivery) and Shipmondo against the answers their documentation
// shows — fetch is replaced, nothing leaves the machine. Built from the docs
// only (private/superpowers/specs/2026-11-14-research-*.md); these tests pin
// the request shapes and the reading of the answers. All data made up.

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (req: Seen) => { status?: number; body?: unknown } | undefined;

function fakeFetch(route: Route) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const req: Seen = {
      method: init.method ?? "GET",
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(req);
    const answer = route(req) ?? { status: 404, body: { error: "not found" } };
    const status = answer.status ?? 200;
    const text = answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return new Response(status === 204 ? null : text, { status });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

const quiet = { log: () => {} };

const SHIPMENT: ProviderShipment = {
  sender: {
    name: "Exempelverkstaden AB",
    addressLine1: "Industrigatan 4",
    addressLine2: null,
    postalCode: "12345",
    city: "Småstad",
    countryCode: "SE",
    contactName: "Anna",
    phone: "0123-45 67 00",
    email: "frakt@exempel.invalid",
  },
  recipient: {
    name: "Kunden AB",
    addressLine1: "Kundgatan 1",
    addressLine2: "Port 2",
    postalCode: "11151",
    city: "Stockholm",
    countryCode: "SE",
    contactName: "Bertil",
    phone: "08-111111",
    email: "kund@exempel.invalid",
    privatePerson: false,
  },
  parcels: [
    { kind: "pallet", lengthCm: 120, widthCm: 80, heightCm: 100, weightKg: 250.5, quantity: 2, stackable: false, loadingMeters: 0.4, description: "Bänkar" },
  ],
  referenceId: "FR-1001",
  senderReference: "FS-2001",
  receiverReference: "Er order 77",
};
const PICKUP = { date: "2030-01-07", time: "10:45" };
const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("nShift", () => {
  const config = {
    environment: "sandbox" as const,
    apiKey: "KEYID00000000000",
    apiSecret: "SECRET000000000000000000",
    options: {
      senderQuickId: "7",
      services: ["DHLPALL", "BHP"],
      serviceNames: { DHLPALL: { carrierName: "DHL Freight", productName: "DHL Freight Pall" } },
      priceEnquiry: true,
      testMode: true,
    },
  };

  it("builds the shipment from the stored sender (own agreements), in metres, with Testläge", () => {
    const body = toNshiftShipment(SHIPMENT, nshiftOptions(config), "DHLPALL", PICKUP) as Record<string, unknown>;
    expect(body).toMatchObject({
      sender: { quickId: "7", name: "Exempelverkstaden AB", zipcode: "12345", country: "SE", contact: "Anna" },
      receiver: { name: "Kunden AB", address2: "Port 2", city: "Stockholm" },
      service: { id: "DHLPALL", pickupBooking: true, pickupDate: "2030-01-07", pickupTimeFrom: "10:45" },
      parcels: [{ copies: 2, weight: 250.5, length: 1.2, width: 0.8, height: 1, volume: 0.96, loadingMeters: 0.4, stackable: false, contents: "Bänkar" }],
      orderNo: "FR-1001",
      senderReference: "FS-2001",
      receiverReference: "Er order 77",
      test: true,
    });
    expect(toNshiftShipment(SHIPMENT, nshiftOptions({ ...config, options: { ...config.options, testMode: false } }), "X")).not.toHaveProperty("test");
  });

  it("prices each chosen service (Basic auth), names them from the register, and offers a refused one without a price", async () => {
    const { fetchFn, seen } = fakeFetch((req) => {
      if (req.url.endsWith("/prices")) {
        const id = (req.body as { shipment: { service: { id: string } } }).shipment.service.id;
        return id === "DHLPALL" ? { body: { price: 1234.5, priceWithAdditionalSurcharges: 1234.5 } } : { status: 422, body: [{ message: "Prisfråga saknas", type: "error" }] };
      }
    });
    const nshift = createNshiftProvider(config, { fetch: fetchFn, ...quiet });
    const { rates, warnings } = await nshift.getRates({ remoteId: null, shipment: SHIPMENT, pickup: PICKUP });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${NSHIFT_BASE_URL}/prices`, `POST ${NSHIFT_BASE_URL}/prices`]);
    expect(seen[0]!.headers.Authorization).toBe(`Basic ${base64("KEYID00000000000:SECRET000000000000000000")}`);
    expect(rates).toMatchObject([
      { carrierCode: "DHLPALL", carrierName: "DHL Freight", productName: "DHL Freight Pall", price: 1234.5, currency: "SEK" },
      { carrierCode: "BHP", productName: "BHP", price: null },
    ]);
    expect(JSON.parse(rates[0]!.bookingToken)).toEqual({ serviceId: "DHLPALL" });
    expect(warnings).toEqual(["BHP: nShift kunde inte behandla försändelsen"]);

    // Prisfråga off: no price calls at all, every service without a price.
    const off = fakeFetch(() => undefined);
    const noPrices = createNshiftProvider({ ...config, options: { ...config.options, priceEnquiry: false } }, { fetch: off.fetchFn, ...quiet });
    expect((await noPrices.getRates({ remoteId: null, shipment: SHIPMENT, pickup: PICKUP })).rates.map((r) => r.price)).toEqual([null, null]);
    expect(off.seen).toEqual([]);
  });

  it("books with POST /shipments?returnFile=true and keeps the inline PDFs (they live an hour at nShift)", async () => {
    const { fetchFn, seen } = fakeFetch((req) => {
      if (req.url.endsWith("/shipments?returnFile=true")) {
        return {
          status: 201,
          body: [
            {
              id: "5666303",
              shipmentNo: null,
              parcels: [{ parcelNo: "69563053687SE" }],
              prints: [{ id: "10234334", type: "pdf", description: "Label", data: base64("%PDF-1.4 label") }],
            },
          ],
        };
      }
    });
    const nshift = createNshiftProvider(config, { fetch: fetchFn, ...quiet });
    const booked = await nshift.book(JSON.stringify({ serviceId: "DHLPALL" }), { remoteId: null, shipment: SHIPMENT, pickup: PICKUP });
    expect(booked).toMatchObject({ remoteId: "5666303", trackingNumber: "69563053687SE", documentTypes: ["label"] });
    expect(booked.documents![0]!.content.toString()).toBe("%PDF-1.4 label");
    expect(seen[0]!.body).toMatchObject({
      printConfig: { target1Media: "laser-a4", target1Type: "pdf" },
      shipment: { service: { id: "DHLPALL", pickupDate: "2030-01-07" }, sender: { quickId: "7" } },
    });
  });

  it("maps the errors like Sendify's: 401 unauthorized, 5xx on booking unknown, 422 the messages that are errors", async () => {
    const book = (status: number, body: unknown) =>
      createNshiftProvider(config, { fetch: fakeFetch(() => ({ status, body })).fetchFn, ...quiet }).book(JSON.stringify({ serviceId: "X" }), {
        remoteId: null,
        shipment: SHIPMENT,
        pickup: PICKUP,
      });
    await expect(book(401, { code: "AUTH", message: "no" })).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(book(503, "")).rejects.toMatchObject({ kind: "booking-unknown" });
    await expect(book(201, "")).rejects.toMatchObject({ kind: "booking-unknown" });
    const refused = await book(422, [
      { message: "Postnummer saknas", field: "receiver.zipcode", type: "error" },
      { message: "Bara en varning", type: "ignorable" },
    ]).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FreightProviderError);
    expect(refused).toMatchObject({ kind: "validation", fieldErrors: ["receiver.zipcode: Postnummer saknas"] });
  });

  it("cancels, makes new document copies, checks the sender, and lists the services", async () => {
    const { fetchFn, seen } = fakeFetch((req) => {
      if (req.method === "DELETE") return { status: 204 };
      if (req.url.includes("/prints?returnFile=true")) return { body: [{ description: "Label", type: "pdf", data: base64("%PDF copy") }] };
      if (req.url.includes("/addresses/senders?quickId=7")) return { body: [{ quickId: "7", name: "Exempelverkstaden AB" }] };
      if (req.url.includes("/meta/lists/partners")) {
        return {
          body: [
            { id: "P19", description: "PostNord MyPack Collect" },
            { id: "DHLROAD", description: "DHL Freight", services: [{ id: "DHLPALL", description: "DHL Freight Pall" }] },
          ],
        };
      }
    });
    const nshift = createNshiftProvider(config, { fetch: fetchFn, ...quiet });
    await nshift.cancel("5666303");
    expect((await nshift.fetchDocument("5666303", "label")).toString()).toBe("%PDF copy");
    expect(await nshift.checkKey()).toEqual({ team: "Exempelverkstaden AB" });
    expect(await nshift.listProducts!()).toEqual([
      { carrierCode: "P19", carrierName: "PostNord", productName: "PostNord MyPack Collect" },
      { carrierCode: "DHLPALL", carrierName: "DHL Freight", productName: "DHL Freight Pall" },
    ]);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: `${NSHIFT_BASE_URL}/shipments/5666303` });
    expect(carrierFromDescription("DB Schenker System")).toBe("DB Schenker");
    expect(carrierFromDescription("Okänd Fraktare Paket")).toBe("Okänd");
  });
});

describe("Shipmondo", () => {
  const config = {
    environment: "sandbox" as const,
    apiUser: "",
    apiKey: "user-uuid",
    apiSecret: "key-uuid",
    options: { shipmondoRates: true, ownAgreementProducts: ["DSV_SYSTEM"] },
  };
  const catalogue = [
    { code: "DHLF_PALL", name: "DHL Freight Pall", carrier: { code: "dhl_freight_se", name: "DHL Freight" }, available_customer_numbers: [] },
    { code: "DSV_SYSTEM", name: "DSV System", carrier: { code: "db_schenker", name: "DSV Road" }, available_customer_numbers: ["123456"] },
  ];

  it("weighs parcels in whole grams and measures them in whole cm with running metres", () => {
    expect(shipmondoParcels(SHIPMENT)).toEqual([
      { quantity: 2, weight: 250500, length: 120, width: 80, height: 100, running_metre: 0.4, stackable: false, description: "Bänkar" },
    ]);
  });

  it("offers Shipmondo's rates excl. VAT and the own agreement's carrier price, named from the catalogue", async () => {
    const { fetchFn, seen } = fakeFetch((req) => {
      if (req.url.includes("/products?")) return { body: catalogue };
      if (req.url.endsWith("/quotes/list")) {
        return {
          body: [{ carrier_code: "dhl_freight_se", description: "Pall", product_code: "DHLF_PALL", service_codes: "", price: 1250, price_before_vat: 1000, currency_code: "SEK" }],
        };
      }
      if (req.url.endsWith("/shipments/quote")) return { body: { price: 0.82, carrier_price: { price: 840, currency_code: "SEK" } } };
    });
    const shipmondo = createShipmondoProvider(config, { fetch: fetchFn, ...quiet });
    const { rates, warnings } = await shipmondo.getRates({ remoteId: null, shipment: SHIPMENT, pickup: PICKUP });
    expect(rates).toMatchObject([
      { carrierCode: "DHLF_PALL", carrierName: "DHL Freight", productName: "DHL Freight Pall", price: 1000, currency: "SEK" },
      { carrierCode: "DSV_SYSTEM+eget", carrierName: "DSV Road", productName: "DSV System (eget avtal)", price: 840 },
    ]);
    expect(warnings).toEqual([]);
    expect(JSON.parse(rates[1]!.bookingToken)).toEqual({ productCode: "DSV_SYSTEM", serviceCodes: "", ownAgreement: true });
    expect(seen[0]!.url).toBe(`${SHIPMONDO_BASE_URL.sandbox}/products?sender_country_code=SE&receiver_country_code=SE&per_page=100&page=1`);
    expect(seen[0]!.headers.Authorization).toBe(`Basic ${base64("user-uuid:key-uuid")}`);
    expect(seen[1]!.body).toMatchObject({ sender: { zipcode: "12345", country_code: "SE" }, receiver: { address2: "Port 2" }, parcels: [{ weight: 250500 }] });
    expect(seen[2]!.body).toMatchObject({
      own_agreement: true,
      product_code: "DSV_SYSTEM",
      parties: [{ type: "sender", postal_code: "12345" }, { type: "receiver", attention: "Bertil" }],
    });

    // An own agreement whose carrier gives no price: offered without one.
    const noPrice = fakeFetch((req) => {
      if (req.url.includes("/products?")) return { body: catalogue };
      if (req.url.endsWith("/shipments/quote")) return { body: { price: 0.82, carrier_price: null } };
    });
    const own = createShipmondoProvider({ ...config, options: { shipmondoRates: false, ownAgreementProducts: ["DSV_SYSTEM"] } }, { fetch: noPrice.fetchFn, ...quiet });
    const answer = await own.getRates({ remoteId: null, shipment: SHIPMENT, pickup: PICKUP });
    expect(answer.rates.map((r) => r.price)).toEqual([null]);
    expect(answer.warnings).toEqual(["DSV System (eget avtal): transportören gav inget pris"]);
  });

  it("books at once with the label as A4 PDF, on the own agreement when the rate says so", async () => {
    const { fetchFn, seen } = fakeFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/shipments")) {
        return { body: { id: 987654, pkg_no: "SE123", labels: [{ base64: base64("%PDF-1.4 label"), file_format: "pdf" }] } };
      }
    });
    const shipmondo = createShipmondoProvider(config, { fetch: fetchFn, ...quiet });
    const token = JSON.stringify({ productCode: "DSV_SYSTEM", serviceCodes: "", ownAgreement: true });
    const booked = await shipmondo.book(token, { remoteId: null, shipment: SHIPMENT, pickup: PICKUP });
    expect(booked).toMatchObject({ remoteId: "987654", trackingNumber: "SE123", documentTypes: ["label"] });
    expect(booked.documents![0]!.content.toString()).toBe("%PDF-1.4 label");
    expect(seen[0]!.body).toMatchObject({
      own_agreement: true,
      product_code: "DSV_SYSTEM",
      pickup_details: { date: "2030-01-07", from: "10:45:00" },
      reference: "FS-2001",
      additional_reference: "Er order 77",
      label_format: "a4_pdf",
      parcels: [{ weight: 250500 }],
    });
  });

  it("maps errors, cancels, fetches the label and checks the account", async () => {
    const refused = await createShipmondoProvider(config, { fetch: fakeFetch(() => ({ status: 422, body: { error: "Ogiltigt postnummer" } })).fetchFn, ...quiet })
      .book(JSON.stringify({ productCode: "X", serviceCodes: "", ownAgreement: false }), { remoteId: null, shipment: SHIPMENT, pickup: PICKUP })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: "validation", message: "Ogiltigt postnummer" });

    const { fetchFn } = fakeFetch((req) => {
      if (req.url.endsWith("/cancel")) return { body: { cancelled: req.url.includes("/1/"), cancelled_at_carrier: true, refunded: false } };
      if (req.url.includes("/labels?label_format=a4_pdf")) return { body: [{ base64: base64("%PDF again"), file_format: "pdf" }] };
      if (req.url.endsWith("/account/")) return { body: { name: "Exempelverkstaden AB" } };
    });
    const shipmondo = createShipmondoProvider({ ...config, environment: "production" }, { fetch: fetchFn, ...quiet });
    await shipmondo.cancel("1");
    await expect(shipmondo.cancel("2")).rejects.toMatchObject({ kind: "validation" });
    expect((await shipmondo.fetchDocument("1", "label")).toString()).toBe("%PDF again");
    expect(await shipmondo.checkKey()).toEqual({ team: "Exempelverkstaden AB" });
  });
});
