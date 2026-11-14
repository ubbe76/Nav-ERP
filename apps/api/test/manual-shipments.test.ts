import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import { auditLog, carriers, db, shipments } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { fact, pdfText } from "./helpers/pdf.js";
import { makeArticle, makeCustomer, makeDelivery, resetShipping, setCompany } from "./helpers/shipping-fixtures.js";

// Egna fraktsätt (migration 0220): a shipment with an own freight method —
// Egen bil, Kunden hämtar, an own agreement with a carrier — registered as
// sent at once with a Speditör from the register, without Sendify (switched
// off here throughout). Through the real app: the default Speditör, the
// följesedel, the invoice's freight row, Ändra/Markera levererad/Makulera,
// the Sendify actions refused, the CHECKs and the register's reassignment.
// All data made up.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
let app: ReturnType<typeof buildApp>;
let cookie: string;

beforeAll(async () => {
  app = buildApp(db);
  await app.ready();
});

beforeEach(async () => {
  await resetShipping();
  await db.execute(sql`TRUNCATE invoice_rows, invoices, user_settings, users CASCADE`);
  await db.execute(sql`DELETE FROM carriers WHERE code LIKE 'EF-%'`);
  await setCompany();
  const email = `frakt-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Säljaren", role: "admin" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
});

afterAll(async () => {
  await app.close();
  await resetShipping();
  await db.execute(sql`TRUNCATE invoice_rows, invoices, user_settings, users CASCADE`);
  await db.execute(sql`DELETE FROM carriers WHERE code LIKE 'EF-%'`);
});

function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  return app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function ok<T = Record<string, unknown>>(response: Promise<{ statusCode: number; body: string; json(): unknown }>, status = 200) {
  const res = await response;
  if (res.statusCode !== status) throw new Error(`${res.statusCode}: ${res.body}`);
  return (res.statusCode === 204 ? {} : res.json()) as T;
}

async function carrier(name: string) {
  const [row] = await db
    .insert(carriers)
    .values({ code: `EF-${crypto.randomUUID().slice(0, 8)}`, name: `${name} ${crypto.randomUUID().slice(0, 4)}` })
    .returning();
  return row!;
}

interface Shipment {
  id: string;
  shipmentNumber: string;
  status: string;
  provider: string;
  carrier: { id: string; name: string } | null;
  trackingNumber: string | null;
  customerPrice: number | null;
  pickupDate: string;
  pickupFrom: string | null;
  parcels: unknown[];
  tracking: { deliveredAt: string | null };
}

async function setup(opts: { orderCarrier?: boolean; customerCarrier?: boolean } = {}) {
  const ownCar = await carrier("Egen bil");
  const pickup = await carrier("Kunden hämtar");
  const customer = await makeCustomer(opts.customerCarrier ? { carrierId: pickup.id } : {});
  const article = await makeArticle();
  const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 2 }], opts.orderCarrier ? { carrierId: ownCar.id } : {});
  return { ownCar, pickup, customer, article, delivery };
}

describe("Eget fraktsätt", () => {
  it("is registered as sent at once with the order's Speditör, else the customer's — Sendify switched off", async () => {
    const { ownCar, pickup, customer, article, delivery } = await setup({ orderCarrier: true, customerCarrier: true });
    // Sendify itself is off: its own create still says so.
    expect((await call("POST", "/shipments", { deliveryIds: [delivery.deliveryId] })).json()).toMatchObject({ code: "freight-not-configured" });

    const { shipment } = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId] }), 201);
    expect(shipment).toMatchObject({
      provider: "manual",
      status: "booked",
      carrier: { id: ownCar.id, name: ownCar.name },
      trackingNumber: null,
      customerPrice: null,
      pickupDate: stockholmToday(),
      pickupFrom: null,
      parcels: [],
    });
    const list = await ok<{ rows: { id: string; provider: string; carrierName: string; productName: string | null }[] }>(call("GET", "/shipments"));
    expect(list.rows.find((r) => r.id === shipment.id)).toMatchObject({ provider: "manual", carrierName: ownCar.name, productName: null });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.entityId, shipment.id));
    expect(audit).toMatchObject({ action: "created", detail: expect.objectContaining({ provider: "manual", carrier: ownCar.name }) });
    // The följesedel is on a live shipment now.
    expect((await call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId] })).json()).toMatchObject({
      code: "delivery-already-shipped",
    });

    // Without one on the order: the customer's.
    const other = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }]);
    const second = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [other.deliveryId] }), 201);
    expect(second.shipment.carrier?.id).toBe(pickup.id);
  });

  it("asks for a Speditör when neither the order nor the customer has one, and refuses an unknown one", async () => {
    const { delivery, ownCar } = await setup();
    expect((await call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId] })).json()).toMatchObject({
      code: "shipment-carrier-required",
    });
    const unknown = await call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId], carrierId: crypto.randomUUID() });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: "shipment-carrier-not-found" });
    const { shipment } = await ok<{ shipment: Shipment }>(
      call("POST", "/shipments/manual", {
        deliveryIds: [delivery.deliveryId],
        carrierId: ownCar.id,
        trackingNumber: "  ",
        customerPrice: 250,
        shippedDate: "2026-11-02",
      }),
      201
    );
    expect(shipment).toMatchObject({ carrier: { id: ownCar.id }, trackingNumber: null, customerPrice: 250, pickupDate: "2026-11-02" });
  });

  it("prints the Speditör and the fraktsedelsnummer on the följesedel", async () => {
    const { delivery, ownCar } = await setup({ orderCarrier: true });
    await ok(call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId], trackingNumber: "DHL-778899" }), 201);
    const res = await call("GET", `/deliveries/${delivery.deliveryId}/pdf`);
    expect(res.statusCode).toBe(200);
    const text = pdfText(res.rawPayload);
    expect(text).toContain(fact("Transportör", ownCar.name));
    expect(text).toContain(fact("Fraktsedelsnr", "DHL-778899"));
    const [row] = await ok<{ id: string; shipment: { provider: string; carrierName: string } }[]>(
      call("GET", `/sales-orders/${delivery.orderId}/deliveries`)
    );
    expect(row!.shipment).toMatchObject({ provider: "manual", carrierName: ownCar.name });
  });

  it("is invoiced with its kundpris as a freight row named after the Speditör — none without a price", async () => {
    const { delivery, customer, article, ownCar } = await setup({ orderCarrier: true });
    const freightArticle = await makeArticle({ type: "service", name: "Frakt" });
    await db.execute(
      sql`INSERT INTO system_settings (key, value) VALUES ('freight_article_id', ${freightArticle.id}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    );
    const { shipment } = await ok<{ shipment: Shipment }>(
      call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId], customerPrice: 350 }),
      201
    );
    const without = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }], { carrierId: ownCar.id });
    const free = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [without.deliveryId] }), 201);

    const billable = await ok<{ shipmentId: string; carrierName: string; productName: string | null; customerPrice: string }[]>(
      call("GET", `/invoiceable-shipments?customerId=${customer.id}`)
    );
    expect(billable.map((b) => b.shipmentId)).toEqual([shipment.id]);
    expect(billable[0]).toMatchObject({ carrierName: ownCar.name, productName: null, customerPrice: "350.00" });
    expect(free.shipment.customerPrice).toBeNull();

    // On a draft invoice: not changed, not cancelled.
    const draft = await ok<{ id: string }>(
      call("POST", "/invoices", {
        customerId: customer.id,
        rows: [{ articleId: freightArticle.id, shipmentId: shipment.id, description: `Frakt ${ownCar.name}`, quantity: 1, unitPrice: 350, vatRate: 25 }],
      }),
      201
    );
    expect(draft.id).toBeTruthy();
    expect((await call("PATCH", `/shipments/${shipment.id}/manual`, { trackingNumber: "X" })).json()).toMatchObject({
      code: "manual-shipment-invoiced",
    });
    expect((await call("POST", `/shipments/${shipment.id}/cancel`)).json()).toMatchObject({ code: "shipment-on-draft-invoice" });
  });

  it("Ändra, Markera levererad and Makulera", async () => {
    const { delivery, customer, article, ownCar, pickup } = await setup({ orderCarrier: true });
    const { shipment } = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId] }), 201);

    const edited = await ok<Shipment>(
      call("PATCH", `/shipments/${shipment.id}/manual`, { carrierId: pickup.id, trackingNumber: "SCH-1", customerPrice: 120.5, shippedDate: "2026-11-03" })
    );
    expect(edited).toMatchObject({ carrier: { id: pickup.id }, trackingNumber: "SCH-1", customerPrice: 120.5, pickupDate: "2026-11-03" });
    const [updated] = await db.select().from(auditLog).where(eq(auditLog.entityId, shipment.id)).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(updated).toMatchObject({
      action: "updated",
      detail: { changes: expect.objectContaining({ carrierId: { before: ownCar.id, after: pickup.id }, trackingNumber: { before: null, after: "SCH-1" } }) },
    });
    expect((await call("PATCH", `/shipments/${shipment.id}/manual`, {})).statusCode).toBe(400);
    expect((await call("PATCH", `/shipments/${shipment.id}/manual`, { colour: "red" })).statusCode).toBe(400);
    expect((await call("PATCH", `/shipments/${shipment.id}/manual`, { carrierId: crypto.randomUUID() })).json()).toMatchObject({
      code: "shipment-carrier-not-found",
    });
    // Blank fraktsedelsnummer and kundpris clear them.
    expect(await ok<Shipment>(call("PATCH", `/shipments/${shipment.id}/manual`, { trackingNumber: "", customerPrice: null }))).toMatchObject({
      trackingNumber: null,
      customerPrice: null,
    });

    const delivered = await ok<Shipment>(call("POST", `/shipments/${shipment.id}/delivered`));
    expect(delivered.status).toBe("delivered");
    expect(delivered.tracking.deliveredAt).not.toBeNull();
    expect((await call("POST", `/shipments/${shipment.id}/delivered`)).statusCode).toBe(409);
    // Still editable once delivered; no longer cancelled.
    expect((await ok<Shipment>(call("PATCH", `/shipments/${shipment.id}/manual`, { trackingNumber: "SCH-2" }))).trackingNumber).toBe("SCH-2");
    expect((await call("POST", `/shipments/${shipment.id}/cancel`)).statusCode).toBe(409);

    // Makulera a sent one: the följesedel is free for a new shipment.
    const next = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }], { carrierId: ownCar.id });
    const sent = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [next.deliveryId] }), 201);
    expect((await ok<Shipment>(call("POST", `/shipments/${sent.shipment.id}/cancel`))).status).toBe("cancelled");
    expect((await call("PATCH", `/shipments/${sent.shipment.id}/manual`, { trackingNumber: "Y" })).statusCode).toBe(409);
    expect((await call("POST", "/shipments/manual", { deliveryIds: [next.deliveryId] })).statusCode).toBe(201);
  });

  it("refuses everything that belongs to Sendify", async () => {
    const { delivery } = await setup({ orderCarrier: true });
    const { shipment } = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId] }), 201);
    const id = shipment.id;
    for (const [method, url, payload] of [
      ["POST", `/shipments/${id}/rates`, undefined],
      ["POST", `/shipments/${id}/book`, { useSelection: true }],
      ["POST", `/shipments/${id}/documents`, undefined],
      ["POST", `/shipments/${id}/tracking`, undefined],
      ["PATCH", `/shipments/${id}`, { customerPrice: 99 }],
      ["PUT", `/shipments/${id}/parcels`, { parcels: [] }],
      ["DELETE", `/shipments/${id}`, undefined],
    ] as const) {
      const res = await call(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(409);
    }
    // And a Sendify shipment is not changed or delivered by hand.
    await db.update(shipments).set({ provider: "sendify", carrierId: null, pickupFrom: "08:00", pickupTo: "16:00" }).where(eq(shipments.id, id));
    expect((await call("PATCH", `/shipments/${id}/manual`, { trackingNumber: "Z" })).statusCode).toBe(409);
    expect((await call("POST", `/shipments/${id}/delivered`)).statusCode).toBe(409);
  });

  it("the database holds the rules: a Speditör, no draft, a pickup window for Sendify", async () => {
    const { delivery } = await setup({ orderCarrier: true });
    const { shipment } = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId] }), 201);
    const violates = (patch: Partial<typeof shipments.$inferInsert>) =>
      db.update(shipments).set(patch).where(eq(shipments.id, shipment.id));
    await expect(violates({ carrierId: null })).rejects.toMatchObject({ cause: expect.objectContaining({ constraint_name: "shipments_manual_carrier" }) });
    await expect(violates({ status: "draft" })).rejects.toMatchObject({ cause: expect.objectContaining({ constraint_name: "shipments_manual_not_draft" }) });
    await expect(violates({ provider: "sendify" })).rejects.toMatchObject({ cause: expect.objectContaining({ constraint_name: "shipments_pickup_window" }) });
    await expect(violates({ provider: "dhl", pickupFrom: "08:00", pickupTo: "16:00" })).rejects.toMatchObject({ cause: expect.objectContaining({ constraint_name: "shipments_provider_known" }) });
  });

  it("a Speditör on shipments is moved with the register's reassignment, never deleted under them", async () => {
    const { delivery, ownCar, pickup } = await setup({ orderCarrier: true });
    const { shipment } = await ok<{ shipment: Shipment }>(call("POST", "/shipments/manual", { deliveryIds: [delivery.deliveryId] }), 201);
    const inUse = await call("DELETE", `/carriers/${ownCar.id}`);
    expect(inUse.statusCode).toBe(409);
    expect(JSON.stringify(inUse.json())).toContain("försändelse");
    await ok(call("DELETE", `/carriers/${ownCar.id}`, { replacementId: pickup.id }), 204);
    const [row] = await db.select({ carrierId: shipments.carrierId }).from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.carrierId).toBe(pickup.id);
  });
});

