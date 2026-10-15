import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { manufacturingRoutes } from "../src/modules/manufacturing/routes/manufacturing.routes.js";
import { MaterialShortageError, type ManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import type { PurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { timeReportRoutes } from "../src/modules/timereport/routes/timereport.routes.js";
import type { TimeReportService } from "../src/modules/timereport/service/timereport.service.js";

// Route-level contract of Materialbrist vid rapportering on the five routes
// that draw material — no database. The 409 body is what the web's
// "Rapportera ändå" dialog is built on: code material-shortage, overridable
// and the shortages. The modes themselves are covered against Postgres in
// material-shortage.test.ts.

const SHORTAGE = {
  articleId: "6f7b2a6e-0e4c-4a5b-9d1c-1f2e3d4c5b6a",
  articleNumber: "PL-2",
  articleName: "Plåt 2 mm",
  unitCode: "st",
  required: 8,
  available: 3,
};

const EXPECTED_BODY = {
  error: "Det finns inte tillräckligt med ingående delar: Plåt 2 mm (behöver 8 st, tillgängligt 3 st)",
  code: "material-shortage",
  overridable: true,
  shortages: [SHORTAGE],
};

function withUser(app: ReturnType<typeof Fastify>) {
  app.addHook("preHandler", async (req) => {
    req.user = { id: crypto.randomUUID(), role: "admin" } as any;
  });
  return app;
}

function throwing(overridable: boolean) {
  return async () => {
    throw new MaterialShortageError([SHORTAGE], overridable);
  };
}

const id = () => crypto.randomUUID();

describe("Materialbrist — 409 material-shortage body (route, inject)", () => {
  it("POST /manufacturing-orders/:id/operations/:opId/complete", async () => {
    const calls: unknown[] = [];
    const app = withUser(Fastify());
    app.register(manufacturingRoutes, {
      service: {
        completeOperation: async (_opId: string, input: unknown) => {
          calls.push(input);
          throw new MaterialShortageError([SHORTAGE], true);
        },
      } as unknown as ManufacturingService,
    });
    const res = await app.inject({
      method: "POST",
      url: `/manufacturing-orders/${id()}/operations/${id()}/complete`,
      payload: { quantityCompleted: 4, allowMaterialShortage: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(EXPECTED_BODY);
    // The flag survives the schema and reaches the service.
    expect(calls[0]).toMatchObject({ quantityCompleted: 4, allowMaterialShortage: true });
  });

  it("POST /manufacturing-orders/:id/complete — block mode answers overridable: false", async () => {
    const app = withUser(Fastify());
    app.register(manufacturingRoutes, { service: { complete: throwing(false) } as unknown as ManufacturingService });
    const res = await app.inject({ method: "POST", url: `/manufacturing-orders/${id()}/complete`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ...EXPECTED_BODY, overridable: false });
  });

  it("POST /manufacturing-orders/:id/materials/:rowId/consume", async () => {
    const calls: unknown[] = [];
    const app = withUser(Fastify());
    app.register(manufacturingRoutes, {
      service: {
        consumeMaterial: async (_moId: string, _rowId: string, input: unknown) => {
          calls.push(input);
          throw new MaterialShortageError([SHORTAGE], true);
        },
      } as unknown as ManufacturingService,
    });
    const res = await app.inject({
      method: "POST",
      url: `/manufacturing-orders/${id()}/materials/${id()}/consume`,
      payload: { quantity: 5, allowMaterialShortage: false },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(EXPECTED_BODY);
    expect(calls[0]).toMatchObject({ quantity: 5, allowMaterialShortage: false });
  });

  it("POST /stamp-sessions/:id/stop", async () => {
    const calls: unknown[] = [];
    const app = withUser(Fastify());
    app.register(timeReportRoutes, {
      service: {
        stampOut: async (_sessionId: string, input: unknown) => {
          calls.push(input);
          throw new MaterialShortageError([SHORTAGE], true);
        },
      } as unknown as TimeReportService,
    });
    const res = await app.inject({
      method: "POST",
      url: `/stamp-sessions/${id()}/stop`,
      payload: { quantityOk: 4, allowMaterialShortage: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(EXPECTED_BODY);
    expect(calls[0]).toMatchObject({ quantityOk: 4, quantityScrapped: 0, allowMaterialShortage: true });
  });

  it("POST /purchase-orders/:id/rows/:rowId/receive", async () => {
    const calls: unknown[] = [];
    const app = withUser(Fastify());
    app.register(purchaseRoutes, {
      service: {
        receiveGoods: async (_orderId: string, _rowId: string, input: unknown) => {
          calls.push(input);
          throw new MaterialShortageError([SHORTAGE], true);
        },
      } as unknown as PurchaseService,
    });
    const res = await app.inject({
      method: "POST",
      url: `/purchase-orders/${id()}/rows/${id()}/receive`,
      payload: { quantity: 4, allowMaterialShortage: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(EXPECTED_BODY);
    expect(calls[0]).toMatchObject({ quantity: 4, allowMaterialShortage: true });
  });
});
