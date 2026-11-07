import { describe, expect, it } from "vitest";
import Fastify, { type RouteOptions } from "fastify";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import {
  ManufacturingOrderNotFoundError,
  type ManufacturingOrderCoverage,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";
import { MO_READ } from "../src/modules/auth/middleware/access-rules.js";

// GET /manufacturing-orders/:id/coverage (pegging #9) — the HTTP contract
// with a faked service, no database: the answer is passed through, an
// unknown TO is 404 manufacturing-order-not-found, and the route carries
// MO_READ (the workshop profile reads the TO card). The rules live in
// pegging.test.ts (pure) and pegging.integration.test.ts (Postgres).

const id = () => crypto.randomUUID();

function appWith(fake: Partial<PlanningService>, routes: RouteOptions[] = []) {
  const app = Fastify();
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
