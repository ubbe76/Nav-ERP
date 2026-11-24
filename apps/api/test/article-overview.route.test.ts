import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import { ArticleNotFoundError, type PlanningService } from "../src/modules/planning/service/planning.service.js";
import type { ArticleOverview } from "../src/modules/planning/service/article-overview.js";

// GET /articles/:id/overview — the HTTP contract with a faked service, no
// database: `planned=true` asks for the planned view (the behovsberäkning's
// derived demand and proposals), anything else for the firm one; a value
// other than true/false is 400; an unknown article 404. The rules live in
// article-overview-planned.test.ts (pure) and forecast.integration.test.ts.

const ARTICLE = "11111111-1111-4111-8111-111111111111";

const overview: ArticleOverview = {
  article: {
    articleId: ARTICLE,
    articleNumber: "1001",
    name: "Plåt",
    type: "purchased",
    isPhantom: false,
    active: true,
    unitCode: "st",
    reorderPoint: null,
    safetyStock: null,
    orderQuantity: null,
    rounding: null,
  },
  primarySupplier: null,
  onHand: 0,
  blockedOnHand: 0,
  rows: [],
  closingBalance: 0,
};

function appWith(fake: Partial<PlanningService>) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation-failed" });
    throw err;
  });
  app.register(planningRoutes, { service: fake as PlanningService });
  return app;
}

describe("GET /articles/:id/overview", () => {
  it("passes planned through: absent and false are the firm overview, true the planned view", async () => {
    const calls: [string, boolean | undefined][] = [];
    const app = appWith({
      getArticleOverview: async (id, opts) => {
        calls.push([id, opts?.planned]);
        return overview;
      },
    });
    for (const query of ["", "?planned=false", "?planned=true"]) {
      const res = await app.inject({ method: "GET", url: `/articles/${ARTICLE}/overview${query}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(overview);
    }
    expect(calls).toEqual([
      [ARTICLE, false],
      [ARTICLE, false],
      [ARTICLE, true],
    ]);
  });

  it("refuses another planned value with 400 and answers an unknown article with 404", async () => {
    const app = appWith({
      getArticleOverview: async (id) => {
        throw new ArticleNotFoundError(id);
      },
    });
    expect((await app.inject({ method: "GET", url: `/articles/${ARTICLE}/overview?planned=1` })).statusCode).toBe(400);
    const missing = await app.inject({ method: "GET", url: `/articles/${ARTICLE}/overview?planned=true` });
    expect(missing.statusCode).toBe(404);
  });
});
