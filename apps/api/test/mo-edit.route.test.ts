import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { ERROR_CODES } from "@navet/shared";
import { manufacturingRoutes } from "../src/modules/manufacturing/routes/manufacturing.routes.js";
import {
  LastOperationLockedError,
  ManufacturingOrderNotEditableError,
  ManufacturingOrderNotFoundError,
  MoMaterialConsumedError,
  MoMaterialDuplicateError,
  MoMaterialOwnArticleError,
  MoMaterialPhantomError,
  MOMaterialConsumptionNotFoundError,
  MoOperationDoneError,
  MoOperationLinkedPurchaseError,
  MoOperationNotOnOrderError,
  MOOperationNotFoundError,
  MoOperationReportedError,
  MoOperationSequenceTakenError,
  MoOperationStampedError,
  NotSubcontractOperationError,
  WorkCenterNotFoundError,
  WorkCenterSupplierNotFoundError,
  type ManufacturingService,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { ArticleIsTemplateError, ArticleNotFoundError, InvalidUnitError } from "../src/modules/article/service/article.service.js";

// Ändra material och operationer — the HTTP contract of the six routes
// (no database): the response shapes, and every domain error's status and
// code as the web's Swedish dictionary keys off them. The rules themselves
// are covered against Postgres in mo-edit.test.ts.

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

describe("Ändra material — routes", () => {
  it("POST /manufacturing-orders/:id/materials answers 201 { material, warnings } and passes the body on", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      addMaterial: async (moId, input) => {
        calls.push([moId, input]);
        return { material: { id: "m1" } as never, warnings: ["Komponent 2: behöver 3, tillgängligt 0"] };
      },
    });
    const moId = id();
    const opId = id();
    const res = await app.inject({ method: "POST", url: `/manufacturing-orders/${moId}/materials`, payload: { componentArticleId: opId, quantity: "3", moOperationId: opId } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ material: { id: "m1" }, warnings: ["Komponent 2: behöver 3, tillgängligt 0"] });
    expect(calls[0]).toEqual([moId, { componentArticleId: opId, quantity: 3, moOperationId: opId }]);
  });

  it("PATCH …/materials/:rowId answers 200 { material, warnings }; an empty body is 400", async () => {
    const app = appWith({ updateMaterial: async () => ({ material: { id: "m1" } as never, warnings: [] }) });
    const ok = await app.inject({ method: "PATCH", url: `/manufacturing-orders/${id()}/materials/${id()}`, payload: { quantity: 2, unitId: null } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ material: { id: "m1" }, warnings: [] });
    const empty = await app.inject({ method: "PATCH", url: `/manufacturing-orders/${id()}/materials/${id()}`, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it("DELETE …/materials/:rowId answers 204", async () => {
    const app = appWith({ removeMaterial: async () => undefined });
    const res = await app.inject({ method: "DELETE", url: `/manufacturing-orders/${id()}/materials/${id()}` });
    expect(res.statusCode).toBe(204);
  });

  const materialErrors: [Error, number, string][] = [
    [new ManufacturingOrderNotFoundError("x"), 404, "manufacturing-order-not-found"],
    [new MOMaterialConsumptionNotFoundError("x"), 404, "mo-material-consumption-not-found"],
    [new ArticleNotFoundError("x"), 404, ERROR_CODES.ARTICLE_NOT_FOUND],
    [new ManufacturingOrderNotEditableError("done"), 409, ERROR_CODES.MANUFACTURING_ORDER_NOT_EDITABLE],
    [new MoMaterialConsumedError(), 409, ERROR_CODES.MO_MATERIAL_CONSUMED],
    [new MoMaterialDuplicateError(), 409, ERROR_CODES.MO_MATERIAL_DUPLICATE],
    [new ArticleIsTemplateError("63000"), 409, ERROR_CODES.ARTICLE_IS_TEMPLATE],
    [new MoMaterialOwnArticleError(), 400, ERROR_CODES.MO_MATERIAL_OWN_ARTICLE],
    [new MoMaterialPhantomError("F1"), 400, ERROR_CODES.MO_MATERIAL_PHANTOM],
    [new MoOperationNotOnOrderError("x"), 400, ERROR_CODES.MO_OPERATION_NOT_ON_ORDER],
    [new InvalidUnitError(), 400, ERROR_CODES.INVALID_UNIT],
  ];
  for (const [err, status, code] of materialErrors) {
    it(`maps ${err.name} to ${status} ${code} on all three material routes`, async () => {
      const app = appWith({ addMaterial: throwing(err), updateMaterial: throwing(err), removeMaterial: throwing(err) });
      const moId = id();
      const post = await app.inject({ method: "POST", url: `/manufacturing-orders/${moId}/materials`, payload: { componentArticleId: id(), quantity: 1 } });
      const patch = await app.inject({ method: "PATCH", url: `/manufacturing-orders/${moId}/materials/${id()}`, payload: { quantity: 1 } });
      const del = await app.inject({ method: "DELETE", url: `/manufacturing-orders/${moId}/materials/${id()}` });
      for (const res of [post, patch, del]) {
        expect(res.statusCode).toBe(status);
        expect(res.json()).toEqual({ error: err.message, code });
      }
    });
  }
});

describe("Ändra operationer — routes", () => {
  it("POST /manufacturing-orders/:id/operations answers 201 { operation, warnings }", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      addOperation: async (moId, input) => {
        calls.push([moId, input]);
        return { operation: { id: "o1", sequenceNo: 30 } as never, warnings: ["Op 30 … orimligt mycket tid"] };
      },
    });
    const moId = id();
    const wc = id();
    const res = await app.inject({
      method: "POST",
      url: `/manufacturing-orders/${moId}/operations`,
      payload: { sequenceNo: "30", workCenterId: wc, setupTime: 10, runTimePerUnit: "2.5", description: " Efterkontroll ", timeUnit: "units_per_hour" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ operation: { id: "o1", sequenceNo: 30 }, warnings: ["Op 30 … orimligt mycket tid"] });
    expect(calls[0]).toEqual([moId, { sequenceNo: 30, workCenterId: wc, setupTime: 10, runTimePerUnit: 2.5, description: "Efterkontroll", timeUnit: "units_per_hour" }]);
    // costingOnly / useArticleDrawing are not part of the schema.
    const stripped = await app.inject({
      method: "POST",
      url: `/manufacturing-orders/${moId}/operations`,
      payload: { sequenceNo: 30, workCenterId: wc, setupTime: 0, runTimePerUnit: 1, costingOnly: true, useArticleDrawing: false },
    });
    expect(stripped.statusCode).toBe(201);
    expect(calls[1]).toEqual([moId, { sequenceNo: 30, workCenterId: wc, setupTime: 0, runTimePerUnit: 1 }]);
  });

  it("PATCH …/operations/:opId answers 200 { operation, warnings }; an empty body is 400", async () => {
    const app = appWith({ updateOperation: async () => ({ operation: { id: "o1" } as never, warnings: [] }) });
    const ok = await app.inject({ method: "PATCH", url: `/manufacturing-orders/${id()}/operations/${id()}`, payload: { runTimePerUnit: 3, comment: null } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ operation: { id: "o1" }, warnings: [] });
    const empty = await app.inject({ method: "PATCH", url: `/manufacturing-orders/${id()}/operations/${id()}`, payload: {} });
    expect(empty.statusCode).toBe(400);
  });

  it("DELETE …/operations/:opId answers 200 { warnings, unlinkedMaterials }", async () => {
    const app = appWith({ removeOperation: async () => ({ warnings: ["TO-1 beräknas bli sen"], unlinkedMaterials: 2 }) });
    const res = await app.inject({ method: "DELETE", url: `/manufacturing-orders/${id()}/operations/${id()}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ warnings: ["TO-1 beräknas bli sen"], unlinkedMaterials: 2 });
  });

  const operationErrors: [Error, number, string][] = [
    [new ManufacturingOrderNotFoundError("x"), 404, "manufacturing-order-not-found"],
    [new MOOperationNotFoundError("x"), 404, "mo-operation-not-found"],
    [new WorkCenterNotFoundError("x"), 404, ERROR_CODES.WORK_CENTER_NOT_FOUND],
    [new ManufacturingOrderNotEditableError("planned"), 409, ERROR_CODES.MANUFACTURING_ORDER_NOT_EDITABLE],
    [new MoOperationSequenceTakenError(10), 409, ERROR_CODES.MO_OPERATION_SEQUENCE_TAKEN],
    [new MoOperationDoneError(), 409, ERROR_CODES.MO_OPERATION_DONE],
    [new MoOperationStampedError(), 409, ERROR_CODES.MO_OPERATION_STAMPED],
    [new MoOperationLinkedPurchaseError(), 409, ERROR_CODES.MO_OPERATION_LINKED_PURCHASE],
    [new MoOperationReportedError(), 409, ERROR_CODES.MO_OPERATION_REPORTED],
    [new LastOperationLockedError(), 409, ERROR_CODES.LAST_OPERATION_LOCKED],
    [new NotSubcontractOperationError(), 400, ERROR_CODES.NOT_SUBCONTRACT_OPERATION],
    [new WorkCenterSupplierNotFoundError("x"), 400, ERROR_CODES.WORK_CENTER_SUPPLIER_NOT_FOUND],
  ];
  for (const [err, status, code] of operationErrors) {
    it(`maps ${err.name} to ${status} ${code} on all three operation routes`, async () => {
      const app = appWith({ addOperation: throwing(err), updateOperation: throwing(err), removeOperation: throwing(err) });
      const moId = id();
      const post = await app.inject({
        method: "POST",
        url: `/manufacturing-orders/${moId}/operations`,
        payload: { sequenceNo: 30, workCenterId: id(), setupTime: 0, runTimePerUnit: 1 },
      });
      const patch = await app.inject({ method: "PATCH", url: `/manufacturing-orders/${moId}/operations/${id()}`, payload: { setupTime: 1 } });
      const del = await app.inject({ method: "DELETE", url: `/manufacturing-orders/${moId}/operations/${id()}` });
      for (const res of [post, patch, del]) {
        expect(res.statusCode).toBe(status);
        expect(res.json()).toEqual({ error: err.message, code });
      }
    });
  }
});
