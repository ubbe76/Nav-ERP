import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import {
  OperationNotFoundError,
  OperationNotPlannableError,
  OperationPlanChangedError,
  PlanDateInPastError,
  PlanDateNoCapacityError,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";

// Route-level contract of the three plan writes with a faked service — no
// database. The rules are covered by production-plan.test.ts (pure) and
// production-plan.integration.test.ts (Postgres); the access rules by
// permissions-coverage.test.ts (module default: write = tillverkning).

type Fake = Partial<Pick<PlanningService, "planProductionRun" | "moveOperation" | "previewMoveOperation" | "unlockOperation">>;

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
const dates = { plannedStartDate: "2030-03-13", plannedEndDate: "2030-03-18", planLocked: true };

describe("POST /planning/plan", () => {
  it("200s with the run and the user — the förslag på resurs ride along (#15)", async () => {
    const result = {
      plannedAt: "2030-03-04T08:00:00.000Z",
      orders: 3,
      operations: 7,
      warnings: [],
      resourceSuggestions: [
        {
          moOperationId: id(),
          manufacturingOrderId: id(),
          orderNumber: "TO-1001",
          sequenceNo: 20,
          fromWorkCenterId: id(),
          fromCode: "110",
          toWorkCenterId: id(),
          toCode: "120",
          toName: "Kantpress 2",
          currentToDate: "2030-03-25",
          toDate: "2030-03-13",
          reason: "overloaded" as const,
        },
      ],
    };
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
  it("200s, defaults moveFollowing to true and passes the day through", async () => {
    const opId = id();
    const result = { operation: dates, following: [], warnings: [] };
    const app = buildApp({
      moveOperation: async (op, input, userId) => {
        expect([op, input, userId]).toEqual([opId, { date: "2030-03-13", moveFollowing: true }, USER]);
        return result;
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${opId}/move`, payload: { date: "2030-03-13" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(result);
  });

  it("passes moveFollowing: false through", async () => {
    const app = buildApp({
      moveOperation: async (_op, input) => {
        expect(input).toEqual({ date: "2030-03-13", moveFollowing: false });
        return { operation: dates, following: [], warnings: [] };
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/planning/operations/${id()}/move`,
      payload: { date: "2030-03-13", moveFollowing: false },
    });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    {},
    { weekMonday: "2030-03-11" }, // the week-based body is gone (#18)
    { date: "2030-03-13", moveFollowing: "yes" },
    { date: "nope" },
    { date: "0001-01-01" },
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
    [new PlanDateInPastError("2030-03-01", "2030-03-04"), 400, "plan-date-in-past"],
    [new PlanDateNoCapacityError("2030-03-09", "110"), 409, "plan-date-no-capacity"],
  ] as const)("maps %s", async (error, status, code) => {
    const app = buildApp({
      moveOperation: async () => {
        throw error;
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${id()}/move`, payload: { date: "2030-03-13" } });
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });
});

// Etapp 6a: the preview takes the move's body and maps the move's errors;
// expectedStartDate rides along on both. The access (write rule tillverkning,
// not readOnlySafe) is tested through the real app in
// production-plan-preview.route.test.ts.
describe("POST /planning/operations/:opId/move/preview and expectedStartDate", () => {
  const load = { date: "2030-03-13", loadHours: 4, availableHours: 8, overloaded: false };
  const preview = {
    operation: { plannedStartDate: "2030-03-13", plannedEndDate: "2030-03-18" },
    following: [],
    warnings: [],
    dayLoad: { before: load, after: { ...load, loadHours: 12, overloaded: true } },
  };

  it("200s with the preview, defaults moveFollowing and never calls the move", async () => {
    const opId = id();
    const app = buildApp({
      moveOperation: async () => {
        throw new Error("the preview must not move");
      },
      previewMoveOperation: async (op, input) => {
        expect([op, input]).toEqual([opId, { date: "2030-03-13", moveFollowing: true }]);
        return preview;
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${opId}/move/preview`, payload: { date: "2030-03-13" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(preview);
  });

  it.each(["move", "move/preview"])("%s passes expectedStartDate through — a day, null (unplanned) or left out", async (path) => {
    const seen: unknown[] = [];
    const app = buildApp({
      moveOperation: async (_op, input) => {
        seen.push(input);
        return { operation: dates, following: [], warnings: [] };
      },
      previewMoveOperation: async (_op, input) => {
        seen.push(input);
        return preview;
      },
    });
    const url = `/planning/operations/${id()}/${path}`;
    for (const extra of [{ expectedStartDate: "2030-03-11" }, { expectedStartDate: null }, {}]) {
      const res = await app.inject({ method: "POST", url, payload: { date: "2030-03-13", moveFollowing: false, ...extra } });
      expect(res.statusCode).toBe(200);
    }
    expect(seen).toEqual([
      { date: "2030-03-13", moveFollowing: false, expectedStartDate: "2030-03-11" },
      { date: "2030-03-13", moveFollowing: false, expectedStartDate: null },
      { date: "2030-03-13", moveFollowing: false },
    ]);
  });

  it.each([
    ["move", {}],
    ["move/preview", {}],
    ["move/preview", { date: "nope" }],
    ["move/preview", { date: "2030-03-13", moveFollowing: "yes" }],
    ["move", { date: "2030-03-13", expectedStartDate: "nope" }],
    ["move/preview", { date: "2030-03-13", expectedStartDate: "nope" }],
    ["move/preview", { date: "2030-03-13", expectedStartDate: 20300311 }],
  ] as const)("%s 400s %o", async (path, payload) => {
    const app = buildApp({
      moveOperation: async () => {
        throw new Error("the service must not be called");
      },
      previewMoveOperation: async () => {
        throw new Error("the service must not be called");
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${id()}/${path}`, payload });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    [new OperationNotFoundError("x"), 404, "operation-not-found"],
    [new OperationNotPlannableError("done"), 409, "operation-not-plannable"],
    [new PlanDateInPastError("2030-03-01", "2030-03-04"), 400, "plan-date-in-past"],
    [new PlanDateNoCapacityError("2030-03-09", "110"), 409, "plan-date-no-capacity"],
    [new OperationPlanChangedError("TO-1050", 20), 409, "operation-plan-changed"],
  ] as const)("maps %s on both routes", async (error, status, code) => {
    const fail = async () => {
      throw error;
    };
    const app = buildApp({ moveOperation: fail, previewMoveOperation: fail });
    for (const path of ["move", "move/preview"]) {
      const res = await app.inject({ method: "POST", url: `/planning/operations/${id()}/${path}`, payload: { date: "2030-03-13" } });
      expect(res.statusCode, path).toBe(status);
      expect(res.json().code).toBe(code);
    }
  });
});

describe("POST /planning/operations/:opId/unlock", () => {
  it("200s with the operation", async () => {
    const opId = id();
    const app = buildApp({
      unlockOperation: async (op, userId) => {
        expect([op, userId]).toEqual([opId, USER]);
        return { operation: { ...dates, planLocked: false } };
      },
    });
    const res = await app.inject({ method: "POST", url: `/planning/operations/${opId}/unlock` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ operation: { ...dates, planLocked: false } });
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
