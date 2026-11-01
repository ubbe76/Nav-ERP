import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import type { PlanningService } from "../src/modules/planning/service/planning.service.js";

// Route-level coverage for POST /planning/orders — tidsfasade förslag (#13):
// a proposal's needDate reaches the service as parsed, a malformed one is a
// 400, and a proposal without one still passes (integrations). The dating
// itself is covered by planning-timephased.test.ts; the service is faked.
const ARTICLE = "11111111-1111-4111-8111-111111111111";

function buildApp(create: PlanningService["createOrdersFromProposals"]) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  // The route reads req.user.id (set by the auth plugin in the real app).
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: "user-1" };
  });
  app.register(planningRoutes, { service: { createOrdersFromProposals: create } as unknown as PlanningService });
  return app;
}

const empty = { purchaseOrders: [], manufacturingOrders: [], errors: [], warnings: [] };

describe("POST /planning/orders", () => {
  it("passes each proposal's needDate through to the service", async () => {
    const calls: unknown[] = [];
    const app = buildApp(async (input, createdBy) => {
      calls.push([input, createdBy]);
      return empty;
    });
    const res = await app.inject({
      method: "POST",
      url: "/planning/orders",
      payload: {
        proposals: [
          { articleId: ARTICLE, quantity: "5", kind: "manufacture", needDate: "2030-03-11" },
          { articleId: ARTICLE, quantity: 3, kind: "purchase" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(empty);
    expect(calls).toEqual([
      [
        {
          proposals: [
            { articleId: ARTICLE, quantity: 5, kind: "manufacture", needDate: "2030-03-11" },
            { articleId: ARTICLE, quantity: 3, kind: "purchase" },
          ],
        },
        "user-1",
      ],
    ]);
  });

  it("400s a needDate that is not a business date", async () => {
    const app = buildApp(async () => {
      throw new Error("must not be called");
    });
    const res = await app.inject({
      method: "POST",
      url: "/planning/orders",
      payload: { proposals: [{ articleId: ARTICLE, quantity: 5, kind: "manufacture", needDate: "nyss" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
  });
});
