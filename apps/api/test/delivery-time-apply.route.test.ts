import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  DeliveryTimeChangedError,
  NothingToReserveError,
  SalesOrderNotFoundError,
  SalesOrderNotOpenError,
  type ApplyDeliveryTimeResult,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";
import { LinkedRowNotFoundError } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { RowConfigurationChangedError } from "../src/modules/sales/service/sales.errors.js";
import { InvalidStatusTransitionError } from "../src/modules/sales/service/sales.service.js";
import { ConfiguratorInvalidConfigurationError } from "../src/modules/configurator/service/configurator.errors.js";

// Route-level contract of POST /delivery-time-check/apply with a faked
// service — no database. The rules are covered by
// delivery-time-apply.integration.test.ts (Postgres); the access rule
// (DELIVERY_CHECK) by permissions-coverage.test.ts.

function buildApp(apply: PlanningService["applyDeliveryTime"]) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: USER };
  });
  app.register(planningRoutes, { service: { applyDeliveryTime: apply } as PlanningService });
  return app;
}

const USER = crypto.randomUUID();
const id = () => crypto.randomUUID();
const result: ApplyDeliveryTimeResult = {
  deliveryDate: "2030-03-11",
  shipDate: "2030-03-11",
  manufacturingOrders: [
    { id: id(), orderNumber: "TO-100", articleNumber: "BARN", quantity: 10, level: 2, salesOrderRowId: null },
    { id: id(), orderNumber: "TO-101", articleNumber: "FAR", quantity: 10, level: 1, salesOrderRowId: id() },
  ],
  warnings: [],
};

describe("POST /delivery-time-check/apply (route, inject)", () => {
  it("200s with the result and passes the input and the user through", async () => {
    const salesOrderId = id();
    const app = buildApp(async (input, userId) => {
      expect([input, userId]).toEqual([{ salesOrderId, deliveryDate: "2030-03-11" }, USER]);
      return result;
    });
    const res = await app.inject({ method: "POST", url: "/delivery-time-check/apply", payload: { salesOrderId, deliveryDate: "2030-03-11" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });

  it.each([
    {},
    { salesOrderId: id() },
    { deliveryDate: "2030-03-11" },
    { salesOrderId: "nope", deliveryDate: "2030-03-11" },
    { salesOrderId: id(), deliveryDate: "2030-13-01" },
    { salesOrderId: id(), deliveryDate: "11/03/2030" },
  ])("400s %o", async (payload) => {
    const res = await buildApp(async () => {
      throw new Error("the service must not be called");
    }).inject({ method: "POST", url: "/delivery-time-check/apply", payload });
    expect(res.statusCode).toBe(400);
  });

  it("409 delivery-time-changed carries the new check result in the body", async () => {
    const newResult = { shipDate: "2030-03-18", deliveryDate: "2030-03-18", rows: [], notes: [], batches: [] };
    const app = buildApp(async () => {
      throw new DeliveryTimeChangedError("2030-03-18", newResult);
    });
    const res = await app.inject({ method: "POST", url: "/delivery-time-check/apply", payload: { salesOrderId: id(), deliveryDate: "2030-03-11" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: "delivery-time-changed",
      error: "Läget har ändrats sedan kontrollen — det nya datumet är 2030-03-18",
      result: newResult,
    });
  });

  it.each([
    [new SalesOrderNotFoundError("x"), 404, "sales-order-not-found"],
    [new LinkedRowNotFoundError("x"), 404, "linked-row-not-found"],
    [new SalesOrderNotOpenError("cancelled", "reserve"), 409, "sales-order-not-open"],
    [new NothingToReserveError(), 409, "nothing-to-reserve"],
    [new ConfigurationRequiredError("63000"), 409, "configuration-required"],
    [new RowConfigurationChangedError(), 409, "row-configuration-changed"],
    [new InvalidStatusTransitionError("closed"), 409, "invalid-status-transition"],
    [new ConfigurationNotAllowedError("1001"), 400, "configuration-not-allowed"],
    [new ConfiguratorInvalidConfigurationError(["BREDD saknas"]), 400, "configurator-invalid-configuration"],
  ] as const)("maps %s", async (error, status, code) => {
    const app = buildApp(async () => {
      throw error;
    });
    const res = await app.inject({ method: "POST", url: "/delivery-time-check/apply", payload: { salesOrderId: id(), deliveryDate: "2030-03-11" } });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });
});
