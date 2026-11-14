import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  articleDrawingRevisions,
  articleDrawings,
  articleFiles,
  articles,
  bomComponents,
  customers,
  db,
  salesOrders,
  shipments,
  units,
} from "@navet/db";
import { API_CLIENT_SCOPES, testFreightConnectionSchema, updateFreightSettingsSchema, updateShipmentSchema, type ConfiguratorEvaluation } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { toPublicEvaluation } from "../src/modules/configurator/service/public-template.js";
import { toPublicOrderRow } from "../src/modules/oauth/service/public-responses.js";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { FreightProviderError, type ProviderShipment } from "../src/modules/shipping/service/freight-provider.js";
import { createSendifyProvider, SENDIFY_MESSAGES } from "../src/modules/shipping/service/sendify-provider.js";
import { createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import { FreightShipmentChangedError } from "../src/modules/shipping/service/shipping.errors.js";
import { createFakeFreightProvider, sampleContext, SANDBOX_PRICES } from "./helpers/fake-freight-provider.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery, resetShipping } from "./helpers/shipping-fixtures.js";

// Fraktgranskningen 2026-11-11: the external API's answers are whitelists,
// and the freight findings — an unreadable 2xx on BOOK, two racing price
// fetches, the products' pickup time, the booking trace on an unpriced
// draft, an impossible pickup date and a non-ASCII key.

// ---------------------------------------------------------------------------
// 1. The external API's answers to a client token are whitelists.
// ---------------------------------------------------------------------------

const OAUTH_TRUNCATE = sql`TRUNCATE api_clients, sales_orders, customers, articles, audit_log, user_settings, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

const PUBLIC_ORDER_KEYS = [
  "costCenterId", "createdAt", "currency", "customerId", "customerInquiryNumber", "customerOrderNumber", "customerReference",
  "deliveryAddressId", "documentKind", "exchangeRate", "expectedDeliveryDate", "id", "note", "orderNumber", "projectId",
  "quoteNumber", "quoteValidUntil", "revision", "status",
];
const PUBLIC_ROW_KEYS = [
  "articleId", "calculatedPrice", "configuration", "discountPercent", "expectedDeliveryDate", "id", "quantityOrdered",
  "setupForRowId", "unitFactor", "unitId", "unitPrice",
];
// Internal fields that reached a client before the whitelist (the session
// answer still has them).
const INTERNAL_ORDER_KEYS = [
  "freightQuote", "freightCarrierPrice", "freightProductId", "generalMarkupPercent", "materialMarkupPercent",
  "deliveryTermId", "paymentTermId", "carrierId", "createdBy", "quoted", "lostReasonId", "invoiceNumber", "updatedAt",
];

describe("klientsvaren är vitlistor", () => {
  let app: ReturnType<typeof buildApp>;
  let admin: string;
  let customerId: string;
  let articleId: string;
  let client: Record<string, string>;

  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
    app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });

  beforeEach(async () => {
    await db.execute(OAUTH_TRUNCATE);
    app = buildApp();
    await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code } });
    admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
    const [customer] = await db.insert(customers).values({ customerNumber: "K-1", name: "Egen kund" }).returning({ id: customers.id });
    customerId = customer!.id;
    await db.insert(units).values({ code: "st", name: "Styck" }).onConflictDoNothing();
    const [st] = await db.select({ id: units.id }).from(units).where(eq(units.code, "st"));
    const [article] = await db
      .insert(articles)
      .values({ articleNumber: "A-1", name: "Artikel", type: "purchased", unitId: st!.id, salesPrice: "100" })
      .returning({ id: articles.id });
    articleId = article!.id;
    const created = (await call("POST", "/api-clients", { cookie: admin }, { name: "Klient", scopes: [...API_CLIENT_SCOPES], customerId: null })).json();
    const token = (await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: created.client.id, clientSecret: created.clientSecret } })).json();
    client = { authorization: `Bearer ${token.accessToken}` };
  });
  afterEach(async () => app.close());
  afterAll(async () => db.execute(OAUTH_TRUNCATE));

  const quoteFor = () => ({ customerId, rows: [{ articleId, quantity: 2 }] });

  // What a seller may have put on the quote before the client confirms it:
  // a freight probe with every carrier's price, Sendify's price, markups.
  async function withInternalFields(orderId: string) {
    await db
      .update(salesOrders)
      .set({
        freightQuote: {
          fetchedAt: "2030-01-07T09:00:00.000Z",
          warnings: ["Schenker: för tungt"],
          rates: SANDBOX_PRICES.map((p, i) => ({
            id: crypto.randomUUID(), ...p, daysMin: 1, daysMax: 2, pickupDate: null, estimatedDeliveryDate: null, expiresAt: null, bookingToken: `tok-${i}`,
          })),
        },
        freightCarrierPrice: "412.40",
        generalMarkupPercent: "20.00",
      })
      .where(eq(salesOrders.id, orderId));
  }

  it("POST /quotes: the client gets exactly the whitelisted order and row fields, the session everything", async () => {
    const forClient = await call("POST", "/quotes", client, quoteFor());
    expect(forClient.statusCode, forClient.body).toBe(201);
    expect(Object.keys(forClient.json().order).sort()).toEqual(PUBLIC_ORDER_KEYS);
    expect(Object.keys(forClient.json().rows[0]).sort()).toEqual(PUBLIC_ROW_KEYS);
    expect(forClient.json().order).toMatchObject({ customerId, status: "quote", documentKind: "quote", currency: "SEK", exchangeRate: "1.000000" });
    expect(forClient.json().rows[0]).toMatchObject({ articleId, quantityOrdered: "2.0000", unitPrice: "100.0000", calculatedPrice: false, configuration: null });

    const forSession = await call("POST", "/quotes", { cookie: admin }, quoteFor());
    expect(forSession.statusCode).toBe(201);
    for (const key of INTERNAL_ORDER_KEYS) expect(forSession.json().order).toHaveProperty(key);
    expect(forSession.json().rows[0]).toHaveProperty("priceOrigin", "chain");
  });

  it("POST /sales-orders/:id/confirm: no freight probe, Sendify price or markups for the client; the session sees them", async () => {
    const forClient = (await call("POST", "/quotes", client, quoteFor())).json().order;
    await withInternalFields(forClient.id);
    const confirmed = await call("POST", `/sales-orders/${forClient.id}/confirm`, client);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(Object.keys(confirmed.json()).sort()).toEqual(PUBLIC_ORDER_KEYS);
    expect(confirmed.json()).toMatchObject({ status: "confirmed", documentKind: "order" });
    for (const leak of ["DHL Paket", "412.4", "tok-", "freight", "Markup"]) expect(confirmed.body).not.toContain(leak);

    const forSession = (await call("POST", "/quotes", { cookie: admin }, quoteFor())).json().order;
    await withInternalFields(forSession.id);
    const seen = await call("POST", `/sales-orders/${forSession.id}/confirm`, { cookie: admin });
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ freightCarrierPrice: "412.40", generalMarkupPercent: "20.00" });
    expect(seen.json().freightQuote.rates).toHaveLength(2);
  });

  it("GET /price-quote: the client gets the price and its source only", async () => {
    const url = `/price-quote?customerId=${customerId}&articleId=${articleId}&quantity=1`;
    const forClient = await call("GET", url, client);
    expect(forClient.json()).toEqual({ articleNumber: "A-1", price: { unitPrice: 100, discountPercent: 0, source: "article" }, currency: "SEK", exchangeRate: 1 });
    expect((await call("GET", url, { cookie: admin })).json()).toMatchObject({ articleNumber: "A-1", price: { unitPrice: 100 } });
  });

  it("GET /articles/:id/bom: no internal operation id or file ids/names for the client; the session keeps them", async () => {
    const [st] = await db.select({ id: units.id }).from(units).where(eq(units.code, "st"));
    const [component] = await db
      .insert(articles)
      .values({ articleNumber: "K-1", name: "Komponent", type: "purchased", unitId: st!.id })
      .returning({ id: articles.id });
    await db.insert(bomComponents).values({ parentArticleId: articleId, componentArticleId: component!.id, quantity: "2", position: "1" });
    const [drawing] = await db.insert(articleDrawings).values({ articleId: component!.id, drawingNumber: "R-100" }).returning();
    const [revision] = await db.insert(articleDrawingRevisions).values({ drawingId: drawing!.id, revision: "B", isActive: true }).returning();
    await db.insert(articleFiles).values({
      articleId: component!.id, filename: "R-100-B.pdf", contentType: "application/pdf", sizeBytes: 4, data: Buffer.from("%PDF"), drawingRevisionId: revision!.id,
    });

    const forClient = await call("GET", `/articles/${articleId}/bom`, client);
    expect(forClient.statusCode).toBe(200);
    const [row] = forClient.json();
    expect(row).not.toHaveProperty("routingOperationId");
    expect(row).toMatchObject({ componentArticleNumber: "K-1", quantity: "2.0000", position: "1", unitCode: "st", componentDrawings: [{ drawingNumber: "R-100", revision: "B" }] });
    expect(forClient.body).not.toContain("R-100-B.pdf");

    const [full] = (await call("GET", `/articles/${articleId}/bom`, { cookie: admin })).json();
    expect(full).toHaveProperty("routingOperationId", null);
    expect(full.componentDrawings[0]).toMatchObject({ filename: "R-100-B.pdf" });
  });

  // 6 and 7 through the real app: refused by the schema before any service
  // call (an impossible date reached Postgres = 500; a non-ASCII key reached
  // fetch's header check = "Sendify svarar inte").
  it("PATCH /shipments/:id with an impossible pickup date is 400 validation-failed", async () => {
    const res = await call("PATCH", `/shipments/${crypto.randomUUID()}`, { cookie: admin }, { pickupDate: "2030-02-30" });
    expect([res.statusCode, res.json().code]).toEqual([400, "validation-failed"]);
  });

  // An en dash from a copied key: fetch refuses it as a header value (before
  // any network), which used to answer "Sendify svarar inte".
  it("Testa anslutning with a non-ASCII key is 400 validation-failed, never a call to Sendify", async () => {
    const res = await call("POST", "/freight-settings/test", { cookie: admin }, { apiKey: "abc\u2013123", environment: "sandbox" });
    expect([res.statusCode, res.json().code]).toEqual([400, "validation-failed"]);
  });
});

describe("vitlistorna (rena)", () => {
  it("toPublicOrderRow copies the configuration field by field — nothing added to the jsonb follows", () => {
    const row = toPublicOrderRow({
      id: "r1", articleId: "a1", quantityOrdered: "1.0000", unitId: null, unitFactor: null, unitPrice: "1050.0000", discountPercent: "0.00",
      calculatedPrice: false, expectedDeliveryDate: null, setupForRowId: null,
      configuration: {
        templateArticleId: "t1", key: "LOCK=B", internalNote: "intern",
        selection: [{ groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "B", valueName: "Bättre", value: "B", unit: null, articleId: "secret" }],
        price: { base: 1000, additions: [{ groupCode: "LOCK", label: "Lås: Bättre", amount: 50, cost: 12 }], unitPrice: 1050, discountPercent: 0, source: "article", cost: 700 },
      },
    });
    expect(row.configuration).toEqual({
      templateArticleId: "t1", key: "LOCK=B",
      selection: [{ groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "B", valueName: "Bättre", value: "B", unit: null }],
      price: { base: 1000, additions: [{ groupCode: "LOCK", label: "Lås: Bättre", amount: 50 }], unitPrice: 1050, discountPercent: 0, source: "article" },
    });
  });

  it("toPublicEvaluation keeps the engine's answer and drops anything else", () => {
    const evaluation: ConfiguratorEvaluation = {
      valid: true, key: "BREDD=1200;LOCK=B",
      groups: [
        { code: "LOCK", kind: "choice", value: "B", defaulted: false, availableValueCodes: ["A", "B"], errors: [] },
        { code: "BREDD", kind: "number", value: 1200, defaulted: false, min: 500, max: 2000, errors: [] },
      ],
      errors: [],
      price: { base: 1000, additions: [{ groupCode: "LOCK", label: "Lås: B", amount: 50 }], unitPrice: 1050, discountPercent: 0, source: "article" },
      warnings: [], currency: "SEK", exchangeRate: 1,
    };
    expect(toPublicEvaluation(evaluation)).toEqual(evaluation);
    expect(toPublicEvaluation({ ...evaluation, derived: { cost: 700 } } as ConfiguratorEvaluation)).not.toHaveProperty("derived");
  });
});

describe("scheman", () => {
  it("an impossible pickup date is refused; a real one passes", () => {
    expect(updateShipmentSchema.safeParse({ pickupDate: "2030-02-30" }).success).toBe(false);
    expect(updateShipmentSchema.safeParse({ pickupDate: "2030-02-28" }).success).toBe(true);
  });

  it("Testa anslutning refuses a non-ASCII key like the saved key does", () => {
    for (const apiKey of ["nyckel-åäö", "abc\u2013123"]) {
      expect(testFreightConnectionSchema.safeParse({ apiKey }).success).toBe(false);
      expect(updateFreightSettingsSchema.safeParse({ apiKey }).success).toBe(false);
    }
    expect(testFreightConnectionSchema.parse({ apiKey: " abc-123 " })).toEqual({ apiKey: "abc-123" });
    expect(testFreightConnectionSchema.safeParse({ apiKey: "  " }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Sendify: a 2xx on BOOK that cannot be read is booking-unknown and logged.
// ---------------------------------------------------------------------------

const SENDER = { name: "Vi AB", addressLine1: "Gatan 1", addressLine2: null, postalCode: "41107", city: "Göteborg", countryCode: "SE", contactName: null, phone: null, email: null };
const SHIPMENT: ProviderShipment = { sender: SENDER, recipient: SENDER, parcels: [], referenceId: "FR-1", senderReference: null, receiverReference: null };

describe("Sendify — ett olästbart 2xx på BOOK", () => {
  type Logged = { method: string; path: string; status: number; requestId: string | null; body: string };
  const headers = { "content-type": "application/json", "x-sendify-request-id": "req-77" };
  // A body that breaks off mid-stream (the connection dropped, a timeout).
  const brokenBody = () =>
    new Response(new ReadableStream({ pull(c) { c.error(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } })); } }), { status: 200, headers });

  function providerAnswering(response: Response) {
    const logged: Logged[] = [];
    const fetchOnce = (async () => response) as unknown as typeof fetch;
    return { provider: createSendifyProvider({ environment: "sandbox", apiKey: "k" }, { fetch: fetchOnce, log: (e) => logged.push(e) }), logged };
  }

  it.each([
    ["a body that breaks off", brokenBody, expect.stringMatching(/^unreadable body/)],
    ["an empty body", () => new Response("", { status: 200, headers }), "empty body"],
    ["a body that is not JSON", () => new Response("<html>ok</html>", { status: 200, headers }), "<html>ok</html>"],
    ["JSON that is not an object", () => new Response("[]", { status: 201, headers }), "[]"],
  ])("%s is booking-unknown with the request id, and logged", async (_name, response, body) => {
    const { provider, logged } = providerAnswering(response());
    const err = await provider.book("tok-1", sampleContext("snd-1")).catch((e) => e);
    expect(err).toBeInstanceOf(FreightProviderError);
    expect(err).toMatchObject({ kind: "booking-unknown", message: SENDIFY_MESSAGES.bookingUnknown, requestId: "req-77" });
    expect(logged).toEqual([{ method: "POST", path: "/shipments/book", status: expect.any(Number), requestId: "req-77", body }]);
  });

  it("the same answer to any other call is still unexpected", async () => {
    const { provider } = providerAnswering(new Response("<html>ok</html>", { status: 200, headers }));
    await expect(provider.createShipment(SHIPMENT)).rejects.toMatchObject({ kind: "unexpected" });
  });
});

// ---------------------------------------------------------------------------
// 3–5. The shipping service against the fake provider.
// ---------------------------------------------------------------------------

describe("försändelsen mot fejkleverantören", () => {
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
      prices: SANDBOX_PRICES.map((p) => ({ ...p })), expiresInMs: 60 * 60 * 1000, createDelayMs: 0, ratesDelayMs: 0, ratesError: null,
      bookError: null, bookDelayMs: 0, documentError: null, documentTypes: ["label", "waybill"], round: 0, created: [],
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(resetShipping);

  async function draft() {
    const customer = await makeCustomer();
    const article = await makeArticle({ weight: 5 });
    const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 2 }]);
    return (await service.create({ deliveryIds: [delivery.deliveryId] }, null)).shipment;
  }
  const stored = async (id: string) => (await db.select().from(shipments).where(eq(shipments.id, id)))[0]!;
  const callsOf = (method: string) => fake.calls.filter((c) => c.method === method);

  // 2 (the service side): the reservation is released as for every booking
  // failure (spec 3.4 step 3), but the server log and the history name the
  // shipment, its Sendify id and Sendify's request id.
  it("booking-unknown releases the reservation and leaves a trace: console.error and booking_unknown in the history", async () => {
    const shipment = await draft();
    const rates = await service.fetchRates(shipment.id);
    const providerId = (await stored(shipment.id)).providerShipmentId;
    fake.state.bookError = new FreightProviderError(SENDIFY_MESSAGES.bookingUnknown, "booking-unknown", [], "req-42");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const dhl = rates.rates.find((r) => r.carrierCode === "dhl")!;
    await expect(service.book(shipment.id, { rateId: dhl.id }, null)).rejects.toMatchObject({ kind: "booking-unknown" });

    expect(await stored(shipment.id)).toMatchObject({ status: "draft", bookingStartedAt: null });
    const trace = { shipmentNumber: shipment.shipmentNumber, providerShipmentId: providerId, requestId: "req-42", carrier: "DHL Freight", product: "DHL Paket", price: 412.4, currency: "SEK" };
    expect(auditEntries.filter((e) => e.action === "booking_unknown")).toEqual([expect.objectContaining({ action: "booking_unknown", detail: trace })]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("may have gone through"), trace);
  });

  // 3: the second fetch's broker copy is created after the first fetch has
  // already stored its id and rates. Before: its unconditional save pointed
  // the draft at its own copy while the stored rates (tokens) were the
  // first copy's. Now the stored id stays, the loser drops its copy, and the
  // rates on the row belong to the id on the row.
  it("two racing price fetches: one Sendify id on the draft, and its stored rates are that copy's", async () => {
    const shipment = await draft();
    const createOriginal = fake.provider.createShipment.bind(fake.provider);
    let creates = 0;
    let secondStarted!: () => void;
    const bothRead = new Promise<void>((r) => (secondStarted = r));
    let releaseSecond!: () => void;
    const secondMayFinish = new Promise<void>((r) => (releaseSecond = r));
    vi.spyOn(fake.provider, "createShipment").mockImplementation(async (s) => {
      const n = ++creates;
      if (n === 1) await bothRead; // both fetches have read an unpriced draft
      if (n === 2) {
        secondStarted();
        await secondMayFinish; // ... and the second copy comes back after the first fetch is done
      }
      return createOriginal(s);
    });

    const fetches = [service.fetchRates(shipment.id), service.fetchRates(shipment.id)];
    await Promise.race(fetches.map((f) => f.catch(() => undefined)));
    releaseSecond();
    const results = await Promise.allSettled(fetches);

    const row = await stored(shipment.id);
    const created = callsOf("createShipment").length;
    expect(created).toBe(2);
    // The first copy (fake-n) stays; the second is deleted at Sendify.
    const firstId = row.providerShipmentId!;
    const deleted = callsOf("deleteShipment").map((c) => c.args[0]);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).not.toBe(firstId);
    // Every rates call went to the stored copy, and the stored tokens come
    // from a rates call on it (round n = the n-th getRates call).
    const rateCalls = callsOf("getRates");
    expect(rateCalls.every((c) => c.args[0] === firstId)).toBe(true);
    const round = Number(row.lastRates!.rates[0]!.bookingToken!.split("-").at(-1));
    expect(rateCalls[round - 1]!.args[0]).toBe(firstId);
    // The loser read the draft before the winner stored its rates: 409.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(FreightShipmentChangedError) });
  });

  // 4: Hämta transportörsprodukter asks for requestedPickupTime like every
  // other price fetch — today's window from now, not its passed Från.
  it("Hämta transportörsprodukter asks for today's pickup from now (rounded up to the quarter), not the window's Från", async () => {
    // 2030-01-07 is a Monday; pickup 08–16 on weekdays.
    const now = () => new Date("2030-01-07T10:31:00+01:00");
    const clocked = createFreightSettingsService({ repo, audit, providerFactory: fake.factory, now });
    await clocked.fetchProducts(null);
    expect(callsOf("getRates").map((c) => c.args[1])).toEqual([{ date: "2030-01-07", time: "10:45" }]);

    // After today's window: the next weekday's Från.
    fake.calls.length = 0;
    const late = createFreightSettingsService({ repo, audit, providerFactory: fake.factory, now: () => new Date("2030-01-07T15:50:00+01:00") });
    await late.fetchProducts(null);
    expect(callsOf("getRates").map((c) => c.args[1])).toEqual([{ date: "2030-01-08", time: "08:00" }]);
  });

  // 5: "Boka vald produkt" on a draft never priced — the price fetch inside
  // the booking creates the Sendify copy, and the trace names it.
  it("Boka vald produkt on an unpriced draft logs the Sendify id in booked", async () => {
    const shipment = await draft();
    const { ids } = await repo.upsertFreightProducts("sendify", [SANDBOX_PRICES[0]!]);
    await db.update(shipments).set({ freightProductId: [...ids.values()][0]! }).where(eq(shipments.id, shipment.id));
    expect((await stored(shipment.id)).providerShipmentId).toBeNull();

    await service.book(shipment.id, { useSelection: true }, null);

    const providerId = (await stored(shipment.id)).providerShipmentId;
    expect(providerId).toMatch(/^fake-/);
    const booked = auditEntries.find((e) => e.action === "booked");
    expect(booked?.detail).toMatchObject({ shipmentNumber: shipment.shipmentNumber, providerShipmentId: providerId });
  });
});
