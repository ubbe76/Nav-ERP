import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { shippingRoutes } from "../src/modules/shipping/routes/shipping.routes.js";
import { FreightRowDeliveredError } from "../src/modules/sales/service/sales.errors.js";
import { FreightProviderError } from "../src/modules/shipping/service/freight-provider.js";
import type { FreightQuoteService } from "../src/modules/shipping/service/freight-quote.service.js";
import type { FreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import type { ShippingService } from "../src/modules/shipping/service/shipping.service.js";
import type { TrackingService } from "../src/modules/shipping/service/tracking.service.js";
import {
  FreightOrderStatusError,
  FreightPriceChangedError,
  FreightRatesExpiredError,
  FreightShipmentChangedError,
  FreightValidationError,
  ShipmentNotFoundError,
} from "../src/modules/shipping/service/shipping.errors.js";

const ID = "11111111-1111-4111-8111-111111111111";

function buildApp(
  service: Partial<ShippingService>,
  quotes: Partial<FreightQuoteService> = {},
  settings: Partial<FreightSettingsService> = {}
) {
  const app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: "u1" };
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.register(shippingRoutes, {
    settings: settings as FreightSettingsService,
    service: service as ShippingService,
    quotes: quotes as FreightQuoteService,
    tracking: {} as TrackingService,
  });
  return app;
}

describe("shipping routes — error envelope", () => {
  it("404s an unknown shipment and 400s a malformed id", async () => {
    const app = buildApp({
      get: async (id) => {
        throw new ShipmentNotFoundError(id);
      },
    });
    expect((await app.inject({ url: `/shipments/${ID}` })).statusCode).toBe(404);
    expect((await app.inject({ url: "/shipments/not-a-uuid" })).statusCode).toBe(400);
  });

  it("returns fresh rates with an expired-price 409", async () => {
    const rates = { fetchedAt: "2030-01-01T00:00:00Z", warnings: [], rates: [] };
    const app = buildApp({
      book: async () => {
        throw new FreightRatesExpiredError(rates);
      },
    });
    const res = await app.inject({ method: "POST", url: `/shipments/${ID}/book`, payload: { rateId: ID } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "freight-rates-expired", rates });
  });

  it("returns both prices with a price-change 409", async () => {
    const app = buildApp({
      book: async () => {
        throw new FreightPriceChangedError(412.4, 500, "SEK");
      },
    });
    const res = await app.inject({ method: "POST", url: `/shipments/${ID}/book`, payload: { useSelection: true } });
    expect(res.json()).toMatchObject({ code: "freight-price-changed", savedPrice: 412.4, newPrice: 500, currency: "SEK" });
  });

  it("maps validation to 400 with fieldErrors and an unreachable broker to 502", async () => {
    let next: Error = new FreightValidationError(["Mottagare: ort"]);
    const app = buildApp({
      fetchRates: async () => {
        throw next;
      },
    });
    const bad = await app.inject({ method: "POST", url: `/shipments/${ID}/rates` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "freight-validation", fieldErrors: ["Mottagare: ort"] });
    next = new FreightProviderError("Sendify svarar inte, försök igen", "unavailable", [], "req-1");
    const down = await app.inject({ method: "POST", url: `/shipments/${ID}/rates` });
    expect(down.statusCode).toBe(502);
    expect(down.json()).toMatchObject({ code: "freight-provider", kind: "unavailable", requestId: "req-1" });
  });

  it("answers 409 when the shipment changed while the prices were being fetched", async () => {
    const app = buildApp({
      fetchRates: async () => {
        throw new FreightShipmentChangedError();
      },
    });
    const res = await app.inject({ method: "POST", url: `/shipments/${ID}/rates` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "freight-shipment-changed", error: "Försändelsen ändrades under prishämtningen — hämta priser igen" });
  });

  it("maps a rejected API key to 409 so the user is pointed at the settings", async () => {
    const app = buildApp({
      fetchRates: async () => {
        throw new FreightProviderError("Sendify godkände inte API-nyckeln", "unauthorized");
      },
    });
    const res = await app.inject({ method: "POST", url: `/shipments/${ID}/rates` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "freight-provider", kind: "unauthorized" });
  });

  it("rejects a book body that is neither a rate nor useSelection", async () => {
    const app = buildApp({ book: async () => ({}) as never });
    expect((await app.inject({ method: "POST", url: `/shipments/${ID}/book`, payload: { useSelection: false } })).statusCode).toBe(400);
  });
});

describe("frakt på offert — error envelope", () => {
  it("409s a freight row that has already been delivered", async () => {
    const app = buildApp(
      {},
      {
        addFreight: async () => {
          throw new FreightRowDeliveredError();
        },
      }
    );
    const res = await app.inject({ method: "POST", url: `/sales-orders/${ID}/freight`, payload: { rateId: ID } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "freight-row-delivered" });
  });

  it("409s an order outside the editable statuses and 400s a body without rateId", async () => {
    const app = buildApp(
      {},
      {
        fetchRates: async () => {
          throw new FreightOrderStatusError();
        },
        addFreight: async () => [],
      }
    );
    const res = await app.inject({ method: "POST", url: `/sales-orders/${ID}/freight-rates`, payload: { parcels: [] } });
    expect(res.statusCode).toBe(400);
    const parcels = [{ parcelKind: "package", lengthCm: 1, widthCm: 1, heightCm: 1, weightKg: 1, quantity: 1, stackable: true, loadingMeters: null, description: null }];
    const status = await app.inject({ method: "POST", url: `/sales-orders/${ID}/freight-rates`, payload: { parcels } });
    expect(status.statusCode).toBe(409);
    expect(status.json()).toMatchObject({ code: "freight-order-status" });
    expect((await app.inject({ method: "POST", url: `/sales-orders/${ID}/freight`, payload: {} })).statusCode).toBe(400);
  });

  it("passes the typed key to Testa anslutning and rejects unknown fields", async () => {
    const seen: unknown[] = [];
    const app = buildApp({}, {}, {
      testConnection: async (input?: unknown) => {
        seen.push(input);
        return { team: "T" };
      },
    } as unknown as Partial<FreightSettingsService>);
    const ok = await app.inject({ method: "POST", url: "/freight-settings/test", payload: { apiKey: " typed ", environment: "sandbox" } });
    expect(ok.statusCode).toBe(200);
    expect(seen).toEqual([{ apiKey: "typed", environment: "sandbox" }]);
    expect((await app.inject({ method: "POST", url: "/freight-settings/test" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/freight-settings/test", payload: { foo: 1 } })).statusCode).toBe(400);
  });
});
