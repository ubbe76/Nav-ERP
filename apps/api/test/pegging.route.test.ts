import { describe, expect, it } from "vitest";
import Fastify, { type RouteOptions } from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import {
  COMPONENT_MOVE_NOTICE,
  ComponentMoveChangedError,
  InvalidStatusTransitionError,
  ManufacturingOrderNotFoundError,
  MissingComponentsChangedError,
  NothingToCreateError,
  type ManufacturingOrderCoverage,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";
import type { MissingComponentsPreview } from "../src/modules/planning/service/missing-components.js";
import { ArticleIsTemplateError } from "../src/modules/article/service/article.service.js";
import { MO_READ } from "../src/modules/auth/middleware/access-rules.js";

// GET /manufacturing-orders/:id/coverage and POST …/component-moves
// (pegging #9) — the HTTP contract with a faked service, no database: the
// answer is passed through, an unknown TO is 404
// manufacturing-order-not-found, the GET carries MO_READ (the workshop
// profile reads the TO card) while the POST keeps the module's write
// (tillverkning), and the POST's refusals. The rules live in pegging.test.ts
// / component-moves.test.ts (pure) and pegging*.test.ts (Postgres).

const id = () => crypto.randomUUID();

function appWith(fake: Partial<PlanningService>, routes: RouteOptions[] = []) {
  const app = Fastify();
  // app.ts's zod handler, so a refused body is 400 here too.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation-failed" });
    throw err;
  });
  app.addHook("onRoute", (route) => {
    routes.push(route);
  });
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: id() };
  });
  app.register(planningRoutes, { service: fake as PlanningService });
  return app;
}

describe("GET /manufacturing-orders/:id/coverage", () => {
  it("answers the service's coverage as is", async () => {
    const moId = id();
    const coverage: ManufacturingOrderCoverage = {
      manufacturingOrderId: moId,
      orderNumber: "TO-1001",
      status: "released",
      materials: [
        {
          rowId: "mat:r1",
          kind: "mo_material",
          articleId: id(),
          articleNumber: "HF-1",
          articleName: "Halvfabrikat",
          articleType: "manufactured",
          needDate: "2030-03-22",
          quantity: 2,
          allocations: [
            { kind: "stock", documentId: null, documentNumber: null, quantity: 1, readyDate: "2030-03-04", late: false, undated: false, daysLate: 0, isDraft: false },
            { kind: "manufacturing_order", documentId: id(), documentNumber: "TO-1002", quantity: 1, readyDate: "2030-03-27", late: true, undated: false, daysLate: 3, isDraft: false },
          ],
          uncovered: 0,
        },
      ],
      goesTo: [{ kind: "sales_order", documentId: id(), documentNumber: "KO-7", partner: "Kund", needDate: "2030-04-01", quantity: 2, late: false, daysLate: 0 }],
      surplus: 0,
      componentLate: true,
      moves: [],
    };
    const calls: string[] = [];
    const app = appWith({
      getManufacturingOrderCoverage: async (x) => {
        calls.push(x);
        return coverage;
      },
    });
    const res = await app.inject({ method: "GET", url: `/manufacturing-orders/${moId}/coverage` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(coverage);
    expect(calls).toEqual([moId]);
  });

  it("404 manufacturing-order-not-found for an unknown TO", async () => {
    const app = appWith({
      getManufacturingOrderCoverage: async (x) => {
        throw new ManufacturingOrderNotFoundError(x);
      },
    });
    const res = await app.inject({ method: "GET", url: `/manufacturing-orders/${id()}/coverage` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "manufacturing-order-not-found" });
  });

  it("is read with MO_READ, like the TO card", async () => {
    const routes: RouteOptions[] = [];
    const app = appWith({}, routes);
    await app.ready();
    const route = routes.find((r) => r.url === "/manufacturing-orders/:id/coverage" && r.method === "GET");
    expect(route?.config).toMatchObject({ access: MO_READ });
  });
});

describe("POST /manufacturing-orders/:id/component-moves", () => {
  const move = { manufacturingOrderId: id(), dueDate: "2030-03-21", expectedDueDate: "2030-03-27" };

  it("passes the parsed body and the user on and answers { moved, notice }", async () => {
    const moId = id();
    const calls: unknown[] = [];
    const app = appWith({
      moveComponentOrders: async (parentId, input, userId) => {
        calls.push([parentId, input, typeof userId]);
        return { moved: [{ id: move.manufacturingOrderId, orderNumber: "TO-1002", dueDate: "2030-03-21" }], notice: COMPONENT_MOVE_NOTICE };
      },
    });
    const res = await app.inject({ method: "POST", url: `/manufacturing-orders/${moId}/component-moves`, payload: { moves: [move] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ moved: [{ id: move.manufacturingOrderId, orderNumber: "TO-1002", dueDate: "2030-03-21" }], notice: COMPONENT_MOVE_NOTICE });
    expect(calls).toEqual([[moId, { moves: [move] }, "string"]]);
  });

  it("400 for an empty list, a TO listed twice, a malformed date or id", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      moveComponentOrders: async () => {
        calls.push(1);
        return { moved: [], notice: COMPONENT_MOVE_NOTICE };
      },
    });
    const url = `/manufacturing-orders/${id()}/component-moves`;
    for (const payload of [
      { moves: [] },
      { moves: [move, { ...move, dueDate: "2030-03-22" }] },
      { moves: [{ ...move, dueDate: "2030-13-01" }] },
      { moves: [{ ...move, expectedDueDate: undefined }] },
      { moves: [{ ...move, manufacturingOrderId: "TO-1002" }] },
      {},
    ]) {
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // null is a valid expected date (an undated TO).
    expect((await app.inject({ method: "POST", url, payload: { moves: [{ ...move, expectedDueDate: null }] } })).statusCode).toBe(200);
    expect(calls).toEqual([1]);
  });

  it("404 manufacturing-order-not-found, 409 component-move-changed with the dates, 409 invalid-status-transition", async () => {
    const url = `/manufacturing-orders/${id()}/component-moves`;
    const payload = { moves: [move] };
    const notFound = await appWith({
      moveComponentOrders: async (x) => {
        throw new ManufacturingOrderNotFoundError(x);
      },
    }).inject({ method: "POST", url, payload });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ code: "manufacturing-order-not-found" });

    const changed = await appWith({
      moveComponentOrders: async () => {
        throw new ComponentMoveChangedError("TO-1002", "2030-03-27", "2030-03-25");
      },
    }).inject({ method: "POST", url, payload });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "component-move-changed", orderNumber: "TO-1002", expectedDueDate: "2030-03-27", currentDueDate: "2030-03-25" });

    const closed = await appWith({
      moveComponentOrders: async () => {
        throw new InvalidStatusTransitionError("TO-1002", "closed");
      },
    }).inject({ method: "POST", url, payload });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ code: "invalid-status-transition", orderNumber: "TO-1002" });
  });

  it("is the module's write (tillverkning) — no access override, never readOnlySafe", async () => {
    const routes: RouteOptions[] = [];
    const app = appWith({}, routes);
    await app.ready();
    const route = routes.find((r) => r.url === "/manufacturing-orders/:id/component-moves" && r.method === "POST");
    expect(route).toBeDefined();
    expect(route?.config ?? {}).not.toHaveProperty("access");
    expect(route?.config ?? {}).not.toHaveProperty("readOnlySafe");
  });
});

// Skapa saknade halvfabrikat (pegging #9, etapp 3): the preview and the
// create — the contract with a faked service.
describe("GET /manufacturing-orders/:id/missing-components", () => {
  const preview: MissingComponentsPreview = {
    orders: [
      { key: "mc:1", parentKey: null, level: 1, articleId: id(), articleNumber: "HF-1", articleName: "Halvfabrikat", quantity: 5, dueDate: "2030-03-21", late: false, needDate: "2030-03-22" },
      { key: "mc:2", parentKey: "mc:1", level: 2, articleId: id(), articleNumber: "DH-1", articleName: "Delhalvfabrikat", quantity: 5, dueDate: "2030-03-19", late: true, needDate: "2030-03-20" },
    ],
    notes: ["R-1 köps (5 st saknas) — syns i Behovsberäkningen"],
  };

  it("answers the service's preview as is", async () => {
    const moId = id();
    const calls: string[] = [];
    const app = appWith({
      getMissingComponents: async (x) => {
        calls.push(x);
        return preview;
      },
    });
    const res = await app.inject({ method: "GET", url: `/manufacturing-orders/${moId}/missing-components` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(preview);
    expect(calls).toEqual([moId]);
  });

  it("404 manufacturing-order-not-found for an unknown TO", async () => {
    const app = appWith({
      getMissingComponents: async (x) => {
        throw new ManufacturingOrderNotFoundError(x);
      },
    });
    const res = await app.inject({ method: "GET", url: `/manufacturing-orders/${id()}/missing-components` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "manufacturing-order-not-found" });
  });

  it("is read with MO_READ, like the TO card", async () => {
    const routes: RouteOptions[] = [];
    const app = appWith({}, routes);
    await app.ready();
    const route = routes.find((r) => r.url === "/manufacturing-orders/:id/missing-components" && r.method === "GET");
    expect(route?.config).toMatchObject({ access: MO_READ });
  });
});

describe("POST /manufacturing-orders/:id/missing-components", () => {
  const expected = [
    { articleId: id(), quantity: 5, level: 1 },
    { articleId: id(), quantity: 5, level: 2 },
  ];
  const answer = {
    manufacturingOrders: [
      { id: id(), orderNumber: "TO-1003", articleNumber: "DH-1", quantity: 5, level: 2 },
      { id: id(), orderNumber: "TO-1004", articleNumber: "HF-1", quantity: 5, level: 1 },
    ],
    warnings: ["DH-1: Färdigdatumet (2030-03-19) hinner inte före behovet (2030-03-20)"],
  };

  it("passes the parsed body and the user on and answers { manufacturingOrders, warnings }", async () => {
    const moId = id();
    const calls: unknown[] = [];
    const app = appWith({
      createMissingComponents: async (parentId, input, userId) => {
        calls.push([parentId, input, typeof userId]);
        return answer;
      },
    });
    const res = await app.inject({ method: "POST", url: `/manufacturing-orders/${moId}/missing-components`, payload: { expected } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(answer);
    expect(calls).toEqual([[moId, { expected }, "string"]]);
  });

  it("400 for an empty list, a missing level, a non-positive quantity, a malformed id or no body", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      createMissingComponents: async () => {
        calls.push(1);
        return answer;
      },
    });
    const url = `/manufacturing-orders/${id()}/missing-components`;
    for (const payload of [
      { expected: [] },
      { expected: [{ articleId: id(), quantity: 5 }] },
      { expected: [{ articleId: id(), quantity: 0, level: 1 }] },
      { expected: [{ articleId: id(), quantity: 5, level: 0 }] },
      { expected: [{ articleId: "HF-1", quantity: 5, level: 1 }] },
      {},
    ]) {
      const res = await app.inject({ method: "POST", url, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("404 not found; 409 missing-components-changed with the fresh preview; 409 nothing-to-create; 409 invalid-status-transition; 409 for a template the create refuses", async () => {
    const url = `/manufacturing-orders/${id()}/missing-components`;
    const payload = { expected };
    const notFound = await appWith({
      createMissingComponents: async (x) => {
        throw new ManufacturingOrderNotFoundError(x);
      },
    }).inject({ method: "POST", url, payload });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ code: "manufacturing-order-not-found" });

    const fresh: MissingComponentsPreview = { orders: [], notes: ["x"] };
    const changed = await appWith({
      createMissingComponents: async () => {
        throw new MissingComponentsChangedError(fresh);
      },
    }).inject({ method: "POST", url, payload });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: "missing-components-changed", result: fresh });

    const nothing = await appWith({
      createMissingComponents: async () => {
        throw new NothingToCreateError();
      },
    }).inject({ method: "POST", url, payload });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json()).toMatchObject({ code: "nothing-to-create" });

    const closed = await appWith({
      createMissingComponents: async () => {
        throw new InvalidStatusTransitionError("TO-1002", "done");
      },
    }).inject({ method: "POST", url, payload });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ code: "invalid-status-transition", orderNumber: "TO-1002" });

    const template = await appWith({
      createMissingComponents: async () => {
        throw new ArticleIsTemplateError("HF-1");
      },
    }).inject({ method: "POST", url, payload });
    expect(template.statusCode).toBe(409);
    expect(template.json()).toMatchObject({ code: "article-is-template" });
  });

  it("is the module's write (tillverkning) — no access override, never readOnlySafe", async () => {
    const routes: RouteOptions[] = [];
    const app = appWith({}, routes);
    await app.ready();
    const route = routes.find((r) => r.url === "/manufacturing-orders/:id/missing-components" && r.method === "POST");
    expect(route).toBeDefined();
    expect(route?.config ?? {}).not.toHaveProperty("access");
    expect(route?.config ?? {}).not.toHaveProperty("readOnlySafe");
  });
});
