import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { manufacturingRoutes } from "../src/modules/manufacturing/routes/manufacturing.routes.js";
import {
  RoutingAlternativeInvalidError,
  RoutingOperationHasAlternativesError,
  WorkCenterInAlternativesError,
  type ManufacturingService,
} from "../src/modules/manufacturing/service/manufacturing.service.js";

// Alternativa resurser (#15), etapp 1 — the HTTP contract without a
// database: the alternatives on the routing routes (schema, 400/409 codes)
// and resourceLocked on Ändra operationer. No new routes (permissions-coverage
// and read-only-account cover the existing ones); the rules themselves are in
// routing-alternatives.test.ts and mo-operation-resources.test.ts.

const id = () => crypto.randomUUID();

function appWith(service: Partial<ManufacturingService>) {
  const app = Fastify();
  // app.ts's zod handler, so a refused body is 400 here too.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "validation-failed" });
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: id(), role: "admin" } as never;
  });
  app.register(manufacturingRoutes, { service: service as ManufacturingService });
  return app;
}

const throwing = (err: Error) => async () => {
  throw err;
};

describe("the routing routes — alternatives", () => {
  it("POST passes the alternatives on in order with coerced and null times, and answers 201 with the operation", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      createRoutingOperation: async (articleId, input) => {
        calls.push([articleId, input]);
        return { id: "op", alternatives: [] } as never;
      },
    });
    const articleId = id();
    const [a, b] = [id(), id()];
    const res = await app.inject({
      method: "POST",
      url: `/articles/${articleId}/routing`,
      payload: {
        sequenceNo: 10,
        workCenterId: id(),
        setupTime: 1,
        runTimePerUnit: 2,
        alternatives: [{ workCenterId: a, setupTime: "5", runTimePerUnit: null }, { workCenterId: b }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect((calls[0] as [string, { alternatives: unknown }])[1].alternatives).toEqual([
      { workCenterId: a, setupTime: 5, runTimePerUnit: null },
      { workCenterId: b },
    ]);
  });

  it("refuses more than five, a duplicate, a negative time and a malformed resource with 400 before the service", async () => {
    const app = appWith({ updateRoutingOperation: async () => ({}) as never });
    const url = `/articles/${id()}/routing/${id()}`;
    const same = id();
    for (const alternatives of [
      Array.from({ length: 6 }, () => ({ workCenterId: id() })),
      [{ workCenterId: same }, { workCenterId: same }],
      [{ workCenterId: id(), runTimePerUnit: -1 }],
      [{ workCenterId: "110" }],
    ]) {
      const res = await app.inject({ method: "PATCH", url, payload: { alternatives } });
      expect(res.statusCode).toBe(400);
    }
    // [] alone is a valid PATCH: it removes the set.
    const cleared = await app.inject({ method: "PATCH", url, payload: { alternatives: [] } });
    expect(cleared.statusCode).toBe(200);
  });

  it("answers a broken rule with 400 routing-alternative-invalid and an operation that keeps its alternatives with 409", async () => {
    const invalid = new RoutingAlternativeInvalidError("Resurs 900 är en legoresurs — en alternativ resurs ska vara en maskin eller personal");
    const has = new RoutingOperationHasAlternativesError("Operationen har alternativa resurser — ta bort dem innan den görs till Kalkyl");
    const post = await appWith({ createRoutingOperation: throwing(invalid) }).inject({
      method: "POST",
      url: `/articles/${id()}/routing`,
      payload: { sequenceNo: 10, workCenterId: id(), setupTime: 0, runTimePerUnit: 0, alternatives: [{ workCenterId: id() }] },
    });
    expect([post.statusCode, post.json()]).toEqual([400, { error: invalid.message, code: "routing-alternative-invalid" }]);
    for (const [err, status, code] of [
      [invalid, 400, "routing-alternative-invalid"],
      [has, 409, "routing-operation-has-alternatives"],
    ] as const) {
      const res = await appWith({ updateRoutingOperation: throwing(err) }).inject({
        method: "PATCH",
        url: `/articles/${id()}/routing/${id()}`,
        payload: { costingOnly: true },
      });
      expect([res.statusCode, res.json()]).toEqual([status, { error: err.message, code }]);
    }
  });
});

describe("Ändra operationer — resourceLocked", () => {
  it("passes resourceLocked on (also alone) and refuses a non-boolean", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      updateOperation: async (_moId, _opId, input) => {
        calls.push(input);
        return { operation: { id: "op" } as never, warnings: [] };
      },
    });
    const url = `/manufacturing-orders/${id()}/operations/${id()}`;
    const wc = id();
    expect((await app.inject({ method: "PATCH", url, payload: { workCenterId: wc } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url, payload: { resourceLocked: false } })).statusCode).toBe(200);
    expect(calls).toEqual([{ workCenterId: wc }, { resourceLocked: false }]);
    expect((await app.inject({ method: "PATCH", url, payload: { resourceLocked: "ja" } })).statusCode).toBe(400);
  });
});

describe("PATCH /work-centers/:id — a resource in alternatives", () => {
  it("answers 409 work-center-in-alternatives when it would become a legoresurs", async () => {
    const err = new WorkCenterInAlternativesError();
    const res = await appWith({ updateWorkCenter: throwing(err) }).inject({
      method: "PATCH",
      url: `/work-centers/${id()}`,
      payload: { type: "subcontract" },
    });
    expect([res.statusCode, res.json()]).toEqual([409, { error: err.message, code: "work-center-in-alternatives" }]);
  });
});
