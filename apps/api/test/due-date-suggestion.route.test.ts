import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import { ArticleNotFoundError, type PlanningService } from "../src/modules/planning/service/planning.service.js";

// Route-level coverage for GET /articles/:id/due-date-suggestion — the
// envelope, the salesOrderRowId pass-through, query validation and the
// ArticleNotFoundError → 404 mapping. The rules themselves are covered by
// due-date-suggestion.test.ts and planning.service.test.ts; the service is
// faked here so no database is needed.
const ARTICLE = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";

function buildApp(suggest: PlanningService["suggestManufacturingDueDate"]) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.register(planningRoutes, { service: { suggestManufacturingDueDate: suggest } as unknown as PlanningService });
  return app;
}

describe("GET /articles/:id/due-date-suggestion", () => {
  it("wraps the suggestion and passes salesOrderRowId through", async () => {
    const calls: unknown[] = [];
    const app = buildApp(async (articleId, opts) => {
      calls.push([articleId, opts]);
      return {
        dueDate: "2030-03-01",
        demandDate: "2030-03-04",
        source: "sales_order_row",
        documentType: "sales_order",
        documentId: "so-1",
        documentNumber: "KO-1",
        clampedToToday: false,
      };
    });

    const res = await app.inject({ url: `/articles/${ARTICLE}/due-date-suggestion?salesOrderRowId=${ROW}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ suggestion: { dueDate: "2030-03-01", documentNumber: "KO-1" } });
    expect(calls).toEqual([[ARTICLE, { salesOrderRowId: ROW }]]);
  });

  it("answers { suggestion: null } when there is nothing to suggest", async () => {
    const app = buildApp(async () => null);
    const res = await app.inject({ url: `/articles/${ARTICLE}/due-date-suggestion` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ suggestion: null });
  });

  it("404s an unknown article", async () => {
    const app = buildApp(async (id) => {
      throw new ArticleNotFoundError(id);
    });
    const res = await app.inject({ url: `/articles/${ARTICLE}/due-date-suggestion` });
    expect(res.statusCode).toBe(404);
  });

  it("400s a salesOrderRowId that is not a uuid", async () => {
    const app = buildApp(async () => null);
    const res = await app.inject({ url: `/articles/${ARTICLE}/due-date-suggestion?salesOrderRowId=nope` });
    expect(res.statusCode).toBe(400);
  });
});
