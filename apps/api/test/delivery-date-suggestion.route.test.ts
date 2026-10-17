import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import type { PurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import type { SalesService } from "../src/modules/sales/service/sales.service.js";

// Route-level contract of the two delivery date suggestions with faked
// services — no database. The rules are covered by delivery-days.test.ts
// (pure) and delivery-days-db.test.ts (against Postgres).

function buildApp(
  purchase: Partial<PurchaseService>,
  sales: Partial<SalesService>
) {
  const app = Fastify();
  // The bare app lacks app.ts's error handler; map zod like it does.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.register(purchaseRoutes, { service: purchase as PurchaseService });
  app.register(salesRoutes, { service: sales as SalesService });
  return app;
}

const settings = { weekdays: [1, 4], mode: "arrival" as const, transitDays: 0 };

describe("GET /supplier-delivery-date-suggestion (route, inject)", () => {
  it("200s with the suggestion and passes the query through", async () => {
    const supplierId = crypto.randomUUID();
    const articleId = crypto.randomUUID();
    const body = { date: "2026-10-19", leadTimeDays: 5, settings, summary: "Levereras till oss mån, tor", warning: null };
    const app = buildApp(
      {
        async getSupplierDeliveryDateSuggestion(query) {
          expect(query).toEqual({ supplierId, articleId, date: "2026-10-21" });
          return body;
        },
      },
      {}
    );
    const res = await app.inject({
      method: "GET",
      url: `/supplier-delivery-date-suggestion?supplierId=${supplierId}&articleId=${articleId}&date=2026-10-21`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
  });

  it.each(["supplierId=nope", `supplierId=${crypto.randomUUID()}&date=2026-13-40`])("400s %s", async (query) => {
    const app = buildApp({ getSupplierDeliveryDateSuggestion: async () => null }, {});
    const res = await app.inject({ method: "GET", url: `/supplier-delivery-date-suggestion?${query}` });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown supplier", async () => {
    const app = buildApp({ getSupplierDeliveryDateSuggestion: async () => null }, {});
    const res = await app.inject({
      method: "GET",
      url: `/supplier-delivery-date-suggestion?supplierId=${crypto.randomUUID()}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("supplier-not-found");
  });
});

describe("GET /customer-delivery-date-suggestion (route, inject)", () => {
  it("200s with the suggestion and passes the query through", async () => {
    const customerId = crypto.randomUUID();
    const body = { date: "2026-10-27", settings, summary: "Kunden tar emot mån, tor", warning: null };
    const app = buildApp(
      {},
      {
        async getCustomerDeliveryDateSuggestion(query) {
          expect(query).toEqual({ customerId });
          return body;
        },
      }
    );
    const res = await app.inject({ method: "GET", url: `/customer-delivery-date-suggestion?customerId=${customerId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
  });

  it.each(["customerId=nope", `customerId=${crypto.randomUUID()}&date=igår`])("400s %s", async (query) => {
    const app = buildApp({}, { getCustomerDeliveryDateSuggestion: async () => null });
    const res = await app.inject({ method: "GET", url: `/customer-delivery-date-suggestion?${query}` });
    expect(res.statusCode).toBe(400);
  });

  it("404s for an unknown customer", async () => {
    const app = buildApp({}, { getCustomerDeliveryDateSuggestion: async () => null });
    const res = await app.inject({
      method: "GET",
      url: `/customer-delivery-date-suggestion?customerId=${crypto.randomUUID()}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("customer-not-found");
  });
});
