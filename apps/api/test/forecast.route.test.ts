import { describe, expect, it } from "vitest";
import Fastify, { type HTTPMethods, type RouteOptions } from "fastify";
import { ZodError } from "zod";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import {
  ArticleNotFoundError,
  ForecastMonthOutsideHorizonError,
  type ArticleForecast,
  type PlanningService,
} from "../src/modules/planning/service/planning.service.js";
import { OVERVIEW_READ } from "../src/modules/auth/middleware/access-rules.js";

// GET/PUT /articles/:id/forecast (prognos #10) — the HTTP contract with a
// faked service, no database: the answer is passed through, the PUT's body
// is validated (400), a month outside the horizon is 400
// forecast-month-outside-horizon, an unknown article 404, and the access
// rules: the GET reads like the artikelöversikt (OVERVIEW_READ), the PUT is
// a write under /articles that the Artiklar menu may make as well as
// Tillverkning. The rules live in forecast.test.ts (pure) and
// forecast.integration.test.ts (Postgres).

const ARTICLE = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const forecast: ArticleForecast = {
  forecastControlled: true,
  historyMonths: 12,
  horizonMonths: 2,
  average: 10,
  history: [{ month: "2029-03", consumed: 12 }],
  months: [
    { month: "2030-03", average: 10, own: null, forecast: 10, actualDemand: 4, alreadyConsumed: 2, forecastDemand: 4 },
    { month: "2030-04", average: 10, own: 20, forecast: 20, actualDemand: 0, alreadyConsumed: null, forecastDemand: 20 },
  ],
};

function appWith(fake: Partial<PlanningService>, routes: RouteOptions[] = []) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation-failed" });
    throw err;
  });
  app.addHook("onRoute", (route) => {
    routes.push(route);
  });
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: USER };
  });
  app.register(planningRoutes, { service: fake as PlanningService });
  return app;
}

describe("GET /articles/:id/forecast", () => {
  it("answers the service's forecast as is", async () => {
    const calls: string[] = [];
    const app = appWith({
      getArticleForecast: async (id) => {
        calls.push(id);
        return forecast;
      },
    });
    const res = await app.inject({ url: `/articles/${ARTICLE}/forecast` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(forecast);
    expect(calls).toEqual([ARTICLE]);
  });

  it("404s an unknown article", async () => {
    const app = appWith({
      getArticleForecast: async (id) => {
        throw new ArticleNotFoundError(id);
      },
    });
    const res = await app.inject({ url: `/articles/${ARTICLE}/forecast` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "article-not-found" });
  });
});

describe("PUT /articles/:id/forecast", () => {
  it("passes the parsed months and the user through and answers the fresh forecast", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      updateArticleForecast: async (id, input, userId) => {
        calls.push([id, input, userId]);
        return forecast;
      },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/articles/${ARTICLE}/forecast`,
      payload: { months: [{ month: "2030-04", quantity: "20" }, { month: "2030-05", quantity: null }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(forecast);
    expect(calls).toEqual([[ARTICLE, { months: [{ month: "2030-04", quantity: 20 }, { month: "2030-05", quantity: null }] }, USER]]);
  });

  it("refuses an empty list, a month that is not YYYY-MM, a negative quantity and a repeated month with 400", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      updateArticleForecast: async (...args) => {
        calls.push(args);
        return forecast;
      },
    });
    for (const payload of [
      { months: [] },
      { months: [{ month: "2030-4", quantity: 1 }] },
      { months: [{ month: "2030-04-01", quantity: 1 }] },
      { months: [{ month: "2030-13", quantity: 1 }] },
      { months: [{ month: "2030-04", quantity: -1 }] },
      { months: [{ month: "2030-04", quantity: 1 }, { month: "2030-04", quantity: 2 }] },
      {},
    ]) {
      const res = await app.inject({ method: "PUT", url: `/articles/${ARTICLE}/forecast`, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("maps a month outside the horizon to 400 forecast-month-outside-horizon and an unknown article to 404", async () => {
    const outside = appWith({
      updateArticleForecast: async () => {
        throw new ForecastMonthOutsideHorizonError("2031-01");
      },
    });
    const res = await outside.inject({ method: "PUT", url: `/articles/${ARTICLE}/forecast`, payload: { months: [{ month: "2031-01", quantity: 1 }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "forecast-month-outside-horizon", month: "2031-01" });

    const missing = appWith({
      updateArticleForecast: async (id) => {
        throw new ArticleNotFoundError(id);
      },
    });
    const notFound = await missing.inject({ method: "PUT", url: `/articles/${ARTICLE}/forecast`, payload: { months: [{ month: "2030-04", quantity: 1 }] } });
    expect(notFound.statusCode).toBe(404);
  });

  it("the GET reads with OVERVIEW_READ, the PUT writes for Artiklar as well as Tillverkning", async () => {
    const routes: RouteOptions[] = [];
    const app = appWith({}, routes);
    await app.ready();
    const access = (method: HTTPMethods) =>
      (routes.find((r) => r.url === "/articles/:id/forecast" && (Array.isArray(r.method) ? r.method : [r.method]).includes(method))!.config as {
        access?: unknown;
      }).access;
    expect(access("GET")).toEqual(OVERVIEW_READ);
    expect(access("PUT")).toEqual(["artiklar", "tillverkning"]);
  });
});
