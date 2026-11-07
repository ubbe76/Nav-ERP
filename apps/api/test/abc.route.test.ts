import { describe, expect, it } from "vitest";
import Fastify, { type RouteOptions } from "fastify";
import { ZodError } from "zod";
import type { Permission, UserRole } from "@navet/shared";
import { planningRoutes } from "../src/modules/planning/routes/planning.routes.js";
import type { AbcList, PlanningService } from "../src/modules/planning/service/planning.service.js";

// GET /planning/abc and its CSV (ABC-klassning #10, etapp 2) — the HTTP
// contract with a faked service, no database: the query is parsed with the
// list pattern (class list, type, search, paging; junk is 400), the price
// columns are nulled for a user without price permission (the same
// response shape), the CSV leaves them out for that user, and both routes
// read with the module's default rule (office, like the behovsberäkning —
// no override). The classification itself is tested in abc.test.ts (pure)
// and abc.integration.test.ts (Postgres).

const USER = "22222222-2222-4222-8222-222222222222";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "11111111-1111-4111-8111-222222222222";

const list: AbcList = {
  rows: [
    {
      articleId: ID_A,
      articleNumber: "P-1",
      name: "Plåt",
      type: "purchased",
      consumed: 100,
      standardCost: 10,
      value: 1000,
      share: 83.33,
      cumulativeShare: 83.33,
      abcClass: "A",
      missingStandardCost: false,
      reorderPoint: 20,
      safetyStock: 5,
      forecastControlled: true,
    },
    {
      articleId: ID_B,
      articleNumber: "M-1",
      name: "Bänk",
      type: "manufactured",
      consumed: 4,
      standardCost: 50,
      value: 200,
      share: 16.67,
      cumulativeShare: 100,
      abcClass: "B",
      missingStandardCost: false,
      reorderPoint: null,
      safetyStock: null,
      forecastControlled: false,
    },
  ],
  total: 2,
  summary: [
    { abcClass: "A", count: 1, value: 1000, share: 83.33 },
    { abcClass: "B", count: 1, value: 200, share: 16.67 },
    { abcClass: "C", count: 0, value: 0, share: 0 },
  ],
  period: { months: 12, from: "2029-03-01", to: "2030-02-28" },
  limits: { aPercent: 80, bPercent: 95 },
};

type User = { id: string; role: UserRole; permissions: Permission[] };
const OFFICE: User = { id: USER, role: "user", permissions: ["lager"] };
const WORKSHOP: User = { id: USER, role: "user", permissions: ["terminal", "artikeloversikt", "tillverkningsorder_las"] };

function appWith(fake: Partial<PlanningService>, user: User, routes: RouteOptions[] = []) {
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
    (req as unknown as { user: User }).user = user;
  });
  app.register(planningRoutes, { service: fake as PlanningService });
  return app;
}

describe("GET /planning/abc", () => {
  it("parses the list query (class list, type, search, paging) and answers the service's list as is for an office user", async () => {
    const calls: unknown[] = [];
    const app = appWith(
      {
        listAbc: async (query) => {
          calls.push(query);
          return list;
        },
      },
      OFFICE
    );
    const res = await app.inject({ url: "/planning/abc?class=A,B&type=purchased&search=pl&limit=2&offset=1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(list);
    expect(calls).toEqual([{ class: ["A", "B"], type: "purchased", search: "pl", limit: 2, offset: 1 }]);

    const bare = await app.inject({ url: "/planning/abc" });
    expect(bare.statusCode).toBe(200);
    expect(calls[1]).toEqual({ limit: 50, offset: 0 });
  });

  it("refuses an unknown class, a service type and a bad limit with 400", async () => {
    const calls: unknown[] = [];
    const app = appWith(
      {
        listAbc: async (query) => {
          calls.push(query);
          return list;
        },
      },
      OFFICE
    );
    for (const qs of ["class=D", "class=A,,X", "type=service", "limit=0", "limit=1001", "offset=-1"]) {
      expect((await app.inject({ url: `/planning/abc?${qs}` })).statusCode, qs).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("nulls the price columns (rows and summary) for a user without price permission, keeping class, quantity and the planning fields", async () => {
    const app = appWith({ listAbc: async () => list }, WORKSHOP);
    const res = await app.inject({ url: "/planning/abc" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AbcList;
    expect(body.total).toBe(2);
    expect(body.period).toEqual(list.period);
    expect(body.limits).toEqual(list.limits);
    expect(body.rows[0]).toEqual({
      ...list.rows[0],
      standardCost: null,
      value: null,
      share: null,
      cumulativeShare: null,
    });
    expect(body.rows[0]).toMatchObject({ abcClass: "A", consumed: 100, reorderPoint: 20, safetyStock: 5, forecastControlled: true, missingStandardCost: false });
    expect(body.summary).toEqual([
      { abcClass: "A", count: 1, value: null, share: null },
      { abcClass: "B", count: 1, value: null, share: null },
      { abcClass: "C", count: 0, value: null, share: null },
    ]);
    // Admin sees everything.
    const admin = appWith({ listAbc: async () => list }, { id: USER, role: "admin", permissions: [] });
    expect((await admin.inject({ url: "/planning/abc" })).json()).toEqual(list);
  });
});

describe("GET /planning/abc/csv", () => {
  it("exports the whole filtered set with Swedish headers; the price columns only with price permission", async () => {
    const calls: unknown[] = [];
    const service: Partial<PlanningService> = {
      listAbc: async (query) => {
        calls.push(query);
        return list;
      },
    };
    const office = await appWith(service, OFFICE).inject({ url: "/planning/abc/csv?class=A&limit=5&offset=10" });
    expect(office.statusCode).toBe(200);
    expect(office.headers["content-type"]).toContain("text/csv");
    expect(office.headers["content-disposition"]).toContain("abc-analys-");
    const lines = office.body.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      "Artikelnummer;Benämning;Typ;ABC-klass;Förbrukat antal;Standardkostnad;Förbrukningsvärde;Andel (%);Ackumulerad andel (%);Saknar standardpris;Beställningspunkt;Säkerhetslager;Prognosstyrd"
    );
    expect(lines[1]).toBe("P-1;Plåt;Inköp;A;100;10,00;1000,00;83,33;83,33;Nej;20;5;Ja");
    expect(lines[2]).toBe("M-1;Bänk;Tillverkad;B;4;50,00;200,00;16,67;100;Nej;;;Nej");
    // Paging stripped, the filter kept, the export cap as the limit.
    expect(calls[0]).toEqual({ class: ["A"], limit: 10000, offset: 0 });

    const workshop = await appWith(service, WORKSHOP).inject({ url: "/planning/abc/csv" });
    expect(workshop.statusCode).toBe(200);
    const wl = workshop.body.replace(/^﻿/, "").trim().split(/\r?\n/);
    expect(wl[0]).toBe("Artikelnummer;Benämning;Typ;ABC-klass;Förbrukat antal;Saknar standardpris;Beställningspunkt;Säkerhetslager;Prognosstyrd");
    expect(wl[1]).toBe("P-1;Plåt;Inköp;A;100;Nej;20;5;Ja");
  });

  it("both routes read with the module's rule (no override), like the behovsberäkning", async () => {
    const routes: RouteOptions[] = [];
    const app = appWith({}, OFFICE, routes);
    await app.ready();
    for (const url of ["/planning/abc", "/planning/abc/csv", "/planning/requirements"]) {
      const route = routes.find((r) => r.url === url)!;
      expect(route, url).toBeDefined();
      expect((route.config as { access?: unknown } | undefined)?.access, url).toBeUndefined();
    }
  });
});
