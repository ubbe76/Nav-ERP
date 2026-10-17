import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import {
  OperationNotFoundError,
  OperationNotPlannableError,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";

// Route-level contract of the three plan writes with a faked service — no
// database. The rules are covered by production-plan.test.ts (pure) and
// production-plan.integration.test.ts (Postgres); the access rules by
// permissions-coverage.test.ts (module default: write = tillverkning).

type Fake = Partial<Pick<PlanningService, "planProductionRun" | "moveOperation" | "unlockOperation">>;

function buildApp(fake: Fake) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  // The routes read req.user.id; the bare app has no auth, so a user is set
  // here the way requireAuth would.
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: USER };
  });
  app.register(planningRoutes, { service: fake as PlanningService });
  return app;
}

const USER = crypto.randomUUID();
const id = () => crypto.randomUUID();
const weeks = { plannedStartWeek: "2030-03-11", plannedEndWeek: "2030-03-18", planLocked: true };

describe("POST /planning/plan", () => {
  it("200s with the run and the user", async () => {
    const result = { plannedAt: "2030-03-04T08:00:00.000Z", orders: 3, operations: 7, warnings: [] };
    const app = buildApp({
      planProductionRun: async (userId) => {
        expect(userId).toBe(USER);
        return result;
      },
    });
    const res = await app.inject({ method: "POST", url: "/planning/plan" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });
});

describe("POST /planning/operations/:opId/move", () => {
  it("200s, defaults moveFollowing to true and passes the week through", async () => {
    const opId = id();
    const result = { operation: weeks, following: [], warnings: [] };
    const app = buildApp({
      moveOperation: async (op, input, userId) => {
        expect([op, input, userId]).toEqual([opId, { weekMonday: "2030-03-11", moveFollowing: true }, USER]);
        return result;
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${opId}/move`, payload: { weekMonday: "2030-03-11" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });

  it("passes moveFollowing: false through", async () => {
    const app = buildApp({
      moveOperation: async (_op, input) => {
        expect(input).toEqual({ weekMonday: "2030-03-11", moveFollowing: false });
        return { operation: weeks, following: [], warnings: [] };
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/planning/operations/${id()}/move`,
      payload: { weekMonday: "2030-03-11", moveFollowing: false },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    {},
    { weekMonday: "2030-03-12" }, // a Wednesday
    { weekMonday: "2030-03-11", moveFollowing: "yes" },
    { weekMonday: "nope" },
    { weekMonday: "0001-01-01" },
  ])("400s %o", async (payload) => {
    const app = buildApp({
      moveOperation: async () => {
        throw new Error("the service must not be called");
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${id()}/move`, payload });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    [new OperationNotFoundError("x"), 404, "operation-not-found"],
    [new OperationNotPlannableError("done"), 409, "operation-not-plannable"],
    [new OperationNotPlannableError("subcontract"), 409, "operation-not-plannable"],
  ] as const)("maps %s", async (error, status, code) => {
    const app = buildApp({
      moveOperation: async () => {
        throw error;
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${id()}/move`, payload: { weekMonday: "2030-03-11" } });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });
});

describe("POST /planning/operations/:opId/unlock", () => {
  it("200s with the operation", async () => {
    const opId = id();
    const app = buildApp({
      unlockOperation: async (op, userId) => {
        expect([op, userId]).toEqual([opId, USER]);
        return { operation: { ...weeks, planLocked: false } };
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${opId}/unlock` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ operation: { ...weeks, planLocked: false } });
  });

  it("404s an unknown operation", async () => {
    const app = buildApp({
      unlockOperation: async () => {
        throw new OperationNotFoundError("x");
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${id()}/unlock` });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("operation-not-found");
  });
});
