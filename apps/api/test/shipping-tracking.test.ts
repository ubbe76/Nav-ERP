import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { db, shipments, shipmentTrackingEvents } from "@navet/db";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { shippingRoutes } from "../src/modules/shipping/routes/shipping.routes.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import type { FreightQuoteService } from "../src/modules/shipping/service/freight-quote.service.js";
import { createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import { createTrackingService } from "../src/modules/shipping/service/tracking.service.js";
import { InvalidShipmentStatusError } from "../src/modules/shipping/service/shipping.errors.js";
import { FreightProviderError } from "../src/modules/shipping/service/freight-provider.js";
import { createFakeFreightProvider, SANDBOX_PRICES } from "./helpers/fake-freight-provider.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery, resetShipping } from "./helpers/shipping-fixtures.js";

// Frakt etapp 2 — spårning: trackShipment (shared by "Uppdatera spårning"
// and the scheduler), the due/lease logic of runTrackingIfDue, and the route.

const repo = createShippingRepository(db);
const auditEntries: { action: string; entityId?: string | null }[] = [];
const audit = {
  async log(e: { action: string; entityId?: string | null }) {
    auditEntries.push(e);
  },
};
const fake = createFakeFreightProvider();
let clock = new Date("2026-10-08T10:00:00Z");
const now = () => clock;
const settings = createFreightSettingsService({ repo, audit, providerFactory: fake.factory });
const shipping = createShippingService({ repo, settings, audit });
const tracking = createTrackingService({ repo, settings, audit, now });

beforeEach(async () => {
  await resetShipping();
  await enableFreight();
  auditEntries.length = 0;
  fake.calls.length = 0;
  Object.assign(fake.state, {
    prices: SANDBOX_PRICES.map((p) => ({ ...p })),
    tracking: {},
    trackingError: null,
    bookError: null,
    round: 0,
    created: [],
  });
  clock = new Date("2026-10-08T10:00:00Z");
});
afterAll(resetShipping);
afterEach(() => vi.restoreAllMocks());

async function draft() {
  const customer = await makeCustomer();
  const article = await makeArticle({ weight: 5 });
  const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 1 }]);
  const { shipment } = await shipping.create({ deliveryIds: [delivery.deliveryId] }, null);
  return shipment;
}

// A booked shipment: draft → rates → book DHL. Returns the row.
async function booked() {
  const shipment = await draft();
  const rates = await shipping.fetchRates(shipment.id);
  await shipping.book(shipment.id, { rateId: rates.rates.find((r) => r.carrierCode === "dhl")!.id }, null);
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipment.id));
  return row!;
}

const ev = (occurredAt: string, status: string | null, description: string | null = null, location: string | null = null) => ({
  occurredAt,
  status,
  description,
  location,
  url: null,
});

const rowOf = async (id: string) => (await db.select().from(shipments).where(eq(shipments.id, id)))[0]!;

describe("trackShipment", () => {
  it("stores new events once and keeps the latest as status", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [
      ev("2026-10-08T09:00:00Z", "IN_TRANSIT", "På väg", "Göteborg"),
      ev("2026-10-08T08:00:00Z", "ORDERED", "Bokad"),
    ];
    await tracking.trackShipment(s.id);
    await tracking.trackShipment(s.id);
    const events = await db.select().from(shipmentTrackingEvents).where(eq(shipmentTrackingEvents.shipmentId, s.id));
    expect(events).toHaveLength(2);
    const after = await rowOf(s.id);
    expect(after).toMatchObject({ status: "booked", trackingStatus: "IN_TRANSIT", lastTrackingText: "På väg (Göteborg)", trackingException: false });
    expect(after.trackingCheckedAt?.toISOString()).toBe(clock.toISOString());
  });

  it("DELIVERED marks the shipment delivered with the event time and logs it once", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [ev("2026-10-08T09:30:00Z", "DELIVERED", "Levererad")];
    expect(await tracking.trackShipment(s.id)).toEqual({ delivered: true });
    // "Uppdatera spårning" on a delivered shipment is allowed and idempotent.
    expect(await tracking.trackShipment(s.id)).toEqual({ delivered: false });
    const after = await rowOf(s.id);
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt?.toISOString()).toBe("2026-10-08T09:30:00.000Z");
    expect(auditEntries.filter((e) => e.action === "delivered")).toHaveLength(1);
  });

  it("an exception flags the shipment and a later normal event clears it", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [ev("2026-10-08T09:00:00Z", "EXCEPTION", "Skadat gods")];
    await tracking.trackShipment(s.id);
    expect((await rowOf(s.id)).trackingException).toBe(true);
    fake.state.tracking[s.providerShipmentId!]!.push(ev("2026-10-08T11:00:00Z", "IN_TRANSIT", "Omlastad"));
    await tracking.trackShipment(s.id);
    const after = await rowOf(s.id);
    expect(after.trackingException).toBe(false);
    expect(after.lastTrackingText).toBe("Omlastad");
  });

  it("a tracking url on the latest event is stored, a missing one keeps the current", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [{ ...ev("2026-10-08T09:00:00Z", "ORDERED"), url: "https://track.example/1" }];
    await tracking.trackShipment(s.id);
    expect((await rowOf(s.id)).trackingUrl).toBe("https://track.example/1");
    fake.state.tracking[s.providerShipmentId!]!.push(ev("2026-10-08T11:00:00Z", "IN_TRANSIT"));
    await tracking.trackShipment(s.id);
    expect((await rowOf(s.id)).trackingUrl).toBe("https://track.example/1");
  });

  it("no events only stamps tracking_checked_at", async () => {
    const s = await booked();
    await tracking.trackShipment(s.id);
    const after = await rowOf(s.id);
    expect(after).toMatchObject({ status: "booked", trackingStatus: null, lastTrackingText: null, trackingException: false });
    expect(after.trackingCheckedAt?.toISOString()).toBe(clock.toISOString());
    expect(await db.select().from(shipmentTrackingEvents).where(eq(shipmentTrackingEvents.shipmentId, s.id))).toHaveLength(0);
  });

  it("a shipment cancelled meanwhile is not moved to delivered", async () => {
    const s = await booked();
    await db.update(shipments).set({ status: "cancelled" }).where(eq(shipments.id, s.id));
    fake.state.tracking[s.providerShipmentId!] = [ev("2026-10-08T09:30:00Z", "DELIVERED")];
    // trackShipment refuses cancelled up front; simulate the race at the repo level:
    const r = await repo.applyTracking(
      s.id,
      fake.state.tracking[s.providerShipmentId!]!,
      { trackingStatus: "DELIVERED", lastTrackingText: "DELIVERED", trackingException: false, trackingUrl: null, trackingCheckedAt: clock },
      new Date("2026-10-08T09:30:00Z")
    );
    expect(r.delivered).toBe(false);
    const after = await rowOf(s.id);
    expect(after.status).toBe("cancelled");
    expect(after.deliveredAt).toBeNull();
  });

  it("refuses a draft", async () => {
    const shipment = await draft();
    await expect(tracking.trackShipment(shipment.id)).rejects.toBeInstanceOf(InvalidShipmentStatusError);
    expect(fake.calls.filter((c) => c.method === "getTracking")).toHaveLength(0);
  });

  it("truncates an over-long status to the column width instead of failing every poll", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [ev("2026-10-08T09:00:00Z", "X".repeat(60), "Lång status")];
    await tracking.trackShipment(s.id);
    const after = await rowOf(s.id);
    expect(after.trackingStatus).toBe("X".repeat(50));
    expect(after.lastTrackingText).toBe("Lång status");
    const events = await db.select().from(shipmentTrackingEvents).where(eq(shipmentTrackingEvents.shipmentId, s.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("X".repeat(50));
  });

  it("ignores an event whose time cannot be parsed and stores the rest", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [
      ev("not a date", "IN_TRANSIT", "Trasig tid"),
      ev("2026-10-08T09:00:00Z", "ORDERED", "Bokad"),
    ];
    await tracking.trackShipment(s.id);
    const events = await db.select().from(shipmentTrackingEvents).where(eq(shipmentTrackingEvents.shipmentId, s.id));
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("ORDERED");
    const after = await rowOf(s.id);
    expect(after).toMatchObject({ trackingStatus: "ORDERED", lastTrackingText: "Bokad" });
  });

  it("the detail view carries the tracking block with events newest first", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [
      ev("2026-10-08T08:00:00Z", "ORDERED", "Bokad"),
      ev("2026-10-08T09:00:00Z", "IN_TRANSIT", "På väg", "Göteborg"),
    ];
    await tracking.trackShipment(s.id);
    const view = await shipping.get(s.id);
    expect(view.tracking).toMatchObject({ status: "IN_TRANSIT", text: "På väg (Göteborg)", exception: false, deliveredAt: null });
    expect(view.tracking.checkedAt?.toISOString()).toBe(clock.toISOString());
    expect(view.tracking.events.map((e) => e.status)).toEqual(["IN_TRANSIT", "ORDERED"]);
    expect(view.tracking.events[0]).toMatchObject({ status: "IN_TRANSIT", statusLabel: "Under transport", description: "På väg", location: "Göteborg" });
    expect(view.tracking.events[1]).toMatchObject({ status: "ORDERED", statusLabel: "Beställd" });
    const { rows } = await shipping.list({ limit: 50, offset: 0 });
    expect(rows.find((r) => r.id === s.id)).toMatchObject({ trackingText: "På väg (Göteborg)", trackingException: false, deliveredAt: null });
  });
});

describe("runTrackingIfDue", () => {
  it("does nothing when freight is disabled", async () => {
    await db.execute(sql`UPDATE system_settings SET value = 'false' WHERE key = 'freight_enabled'`);
    expect(await tracking.runTrackingIfDue()).toBe("disabled");
  });

  it("runs, stamps after the run, then is not due until the interval passed", async () => {
    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [ev("2026-10-08T09:00:00Z", "ORDERED")];
    expect(await tracking.runTrackingIfDue()).toEqual({ checked: 1, delivered: 0, failed: 0 });
    expect((await settings.read()).lastTrackingRunAt?.toISOString()).toBe(clock.toISOString());
    clock = new Date("2026-10-08T10:30:00Z");
    expect(await tracking.runTrackingIfDue()).toBe("not-due");
    clock = new Date("2026-10-08T10:56:00Z");
    expect(await tracking.runTrackingIfDue()).toEqual({ checked: 1, delivered: 0, failed: 0 });
    // The lease is released after the run.
    const lease = await repo.claimTrackingLease(clock, 15 * 60_000);
    expect(lease).not.toBeNull();
    await repo.releaseTrackingLease(lease!);
  });

  it("honours the configured interval", async () => {
    await settings.update({ trackingInterval: "every_4h" }, null);
    expect(await tracking.runTrackingIfDue()).toEqual({ checked: 0, delivered: 0, failed: 0 });
    clock = new Date("2026-10-08T11:30:00Z");
    expect(await tracking.runTrackingIfDue()).toBe("not-due");
    clock = new Date("2026-10-08T13:56:00Z");
    expect(await tracking.runTrackingIfDue()).toEqual({ checked: 0, delivered: 0, failed: 0 });
  });

  it("one failing shipment does not stop the others", async () => {
    const a = await booked();
    const b = await booked();
    fake.state.tracking[b.providerShipmentId!] = [ev("2026-10-08T09:00:00Z", "DELIVERED")];
    const original = fake.provider.getTracking;
    fake.provider.getTracking = async (id) => {
      if (id === a.providerShipmentId) throw new FreightProviderError("Sendify svarar inte", "unavailable");
      return original(id);
    };
    try {
      expect(await tracking.runTrackingIfDue()).toEqual({ checked: 2, delivered: 1, failed: 1 });
    } finally {
      fake.provider.getTracking = original;
    }
    expect((await rowOf(b.id)).status).toBe("delivered");
    expect((await rowOf(a.id)).status).toBe("booked");
  });

  it("counts a broker error as failed and logs it through the injected log", async () => {
    const logged: string[] = [];
    const logging = createTrackingService({ repo, settings, audit, now, log: (msg) => logged.push(msg) });
    await booked();
    fake.state.trackingError = new FreightProviderError("Sendify svarar inte", "unavailable");
    expect(await logging.runTrackingIfDue()).toEqual({ checked: 1, delivered: 0, failed: 1 });
    expect(logged).toEqual(["Tracking failed for shipment"]);
  });

  it("a run that throws leaves the run stamp unwritten and frees the lease", async () => {
    vi.spyOn(repo, "listTrackableShipments").mockRejectedValueOnce(new Error("db down"));
    await expect(tracking.runTrackingIfDue()).rejects.toThrow("db down");
    expect((await settings.read()).lastTrackingRunAt).toBeNull();
    // Not busy: the lease was released, so the next tick runs at once.
    expect(await tracking.runTrackingIfDue()).toEqual({ checked: 0, delivered: 0, failed: 0 });
  });

  it("skips shipments booked more than 60 days ago", async () => {
    const s = await booked();
    await db.update(shipments).set({ bookedAt: new Date("2026-08-01T00:00:00Z") }).where(eq(shipments.id, s.id));
    expect(await tracking.runTrackingIfDue()).toEqual({ checked: 0, delivered: 0, failed: 0 });
  });

  it("is busy while another run holds the lease, and takes over when it expired", async () => {
    expect(await repo.claimTrackingLease(clock, 15 * 60_000)).not.toBeNull();
    expect(await tracking.runTrackingIfDue()).toBe("busy");
    expect((await settings.read()).lastTrackingRunAt).toBeNull();
    clock = new Date("2026-10-08T10:16:00Z"); // lease (15 min) expired — the earlier run died
    expect(await tracking.runTrackingIfDue()).toEqual({ checked: 0, delivered: 0, failed: 0 });
  });

  it("a release carrying another run's lease value leaves the live lease in place", async () => {
    const mine = await repo.claimTrackingLease(clock, 15 * 60_000);
    expect(mine).not.toBeNull();
    // A run that died earlier and wakes up late releases with ITS value.
    await repo.releaseTrackingLease(new Date(clock.getTime() - 60_000).toISOString());
    expect(await repo.claimTrackingLease(clock, 15 * 60_000)).toBeNull();
    // The owner's release frees it.
    await repo.releaseTrackingLease(mine!);
    const next = await repo.claimTrackingLease(clock, 15 * 60_000);
    expect(next).not.toBeNull();
    await repo.releaseTrackingLease(next!);
  });

  it("the lease keys never leak into the settings view and are not writable through update", async () => {
    const lease = await repo.claimTrackingLease(clock, 15 * 60_000);
    await repo.stampTrackingRun(clock);
    const view = await settings.view();
    expect(view.lastTrackingRunAt?.toISOString()).toBe(clock.toISOString());
    expect(JSON.stringify(view)).not.toContain("lease");
    await settings.update({ trackingInterval: "daily" }, null);
    expect((await settings.view()).trackingInterval).toBe("daily");
    expect((await settings.read()).lastTrackingRunAt?.toISOString()).toBe(clock.toISOString());
    await repo.releaseTrackingLease(lease!);
  });
});

describe("POST /shipments/:id/tracking", () => {
  function buildApp() {
    const app = Fastify();
    app.decorateRequest("user", null);
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: { id: string } }).user = { id: "u1" };
    });
    app.register(shippingRoutes, { settings, service: shipping, quotes: {} as FreightQuoteService, tracking });
    return app;
  }

  it("409s a draft and returns the detail view for a booked shipment", async () => {
    const app = buildApp();
    const d = await draft();
    expect((await app.inject({ method: "POST", url: `/shipments/${d.id}/tracking` })).statusCode).toBe(409);

    const s = await booked();
    fake.state.tracking[s.providerShipmentId!] = [ev("2026-10-08T09:00:00Z", "IN_TRANSIT", "På väg")];
    const res = await app.inject({ method: "POST", url: `/shipments/${s.id}/tracking` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.id, status: "booked", tracking: { status: "IN_TRANSIT", text: "På väg", exception: false } });
    expect(res.json().tracking.events).toHaveLength(1);
  });
});
