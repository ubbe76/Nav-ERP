import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import {
  ArticleNotFoundError,
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  CustomerNotFoundError,
  SalesOrderNotFoundError,
  SalesOrderNotOpenError,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";

// Route-level contract of POST /delivery-time-check with a faked service —
// no database. The rules are covered by delivery-time-check.test.ts (pure)
// and planning.service.test.ts / planning-configured.test.ts (Postgres).

function buildApp(check: PlanningService["checkDeliveryTime"]) {
  const app = Fastify();
  // The bare app lacks app.ts's error handler; map zod like it does.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.register(planningRoutes, { service: { checkDeliveryTime: check } as PlanningService });
  return app;
}

const id = () => crypto.randomUUID();
const result = { shipDate: "2026-10-26", deliveryDate: "2026-10-28", rows: [], notes: [] };

describe("POST /delivery-time-check (route, inject)", () => {
  it("200s with the result and passes the request through", async () => {
    const articleId = id();
    const app = buildApp(async (request) => {
      expect(request).toEqual({ rows: [{ articleId, quantity: 2, configuration: { selection: { LOCK: "B" } } }] });
      return result;
    });
    const res = await app.inject({
      method: "POST",
      url: "/delivery-time-check",
      payload: { rows: [{ articleId, quantity: "2", configuration: { selection: { LOCK: "B" } } }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });

  it.each([
    {},
    { rows: [] },
    // An empty rows list with an order would check nothing — refused rather
    // than answered with an empty result.
    { salesOrderId: id(), rows: [] },
    { rows: [{ articleId: "nope", quantity: 1 }] },
    { rows: [{ articleId: id(), quantity: 0 }] },
  ])("400s %o", async (payload) => {
    const res = await buildApp(async () => {
      throw new Error("the service must not be called");
    }).inject({ method: "POST", url: "/delivery-time-check", payload });
    expect(res.statusCode).toBe(400);
  });

  it("passes an order without rows through (the order's open rows are checked)", async () => {
    const salesOrderId = id();
    const app = buildApp(async (request) => {
      expect(request).toEqual({ salesOrderId });
      return result;
    });
    const res = await app.inject({ method: "POST", url: "/delivery-time-check", payload: { salesOrderId } });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    [new ArticleNotFoundError("x"), 404, "article-not-found"],
    [new CustomerNotFoundError("x"), 404, "customer-not-found"],
    [new SalesOrderNotFoundError("x"), 404, "sales-order-not-found"],
    [new SalesOrderNotOpenError("cancelled"), 409, "sales-order-not-open"],
    [new ConfigurationRequiredError("63000"), 409, "configuration-required"],
    [new ConfigurationNotAllowedError("1001"), 400, "configuration-not-allowed"],
  ] as const)("maps %s", async (error, status, code) => {
    const app = buildApp(async () => {
      throw error;
    });
    const res = await app.inject({ method: "POST", url: "/delivery-time-check", payload: { salesOrderId: id() } });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });
});
