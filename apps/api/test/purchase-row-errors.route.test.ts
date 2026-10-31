import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { DuplicatePurchaseOrderRowError, type PurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { InvalidUnitError } from "../src/modules/article/service/article.service.js";

// Route-level contract of the purchase order and inquiry row errors that
// used to surface as 500 — no database. The service throws are covered in
// purchase.service.test.ts and purchase-units.service.test.ts.

function buildApp(service: Partial<PurchaseService>) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = { id: crypto.randomUUID(), role: "user" } as any;
  });
  app.register(purchaseRoutes, { service: service as PurchaseService });
  return app;
}

const row = { articleId: crypto.randomUUID(), quantity: 1, unitPrice: 10 };
const throwing = (err: Error) => async () => {
  throw err;
};

describe("purchase order and inquiry rows — error mapping (route, inject)", () => {
  it("409s an article already on the purchase order", async () => {
    const app = buildApp({ addRow: throwing(new DuplicatePurchaseOrderRowError()) });
    const res = await app.inject({ method: "POST", url: `/purchase-orders/${crypto.randomUUID()}/rows`, payload: row });
    expect([res.statusCode, res.json().code]).toEqual([409, "duplicate-purchase-order-row"]);
  });

  it("400s a unit the article does not have — adding and changing a purchase order row", async () => {
    const add = buildApp({ addRow: throwing(new InvalidUnitError()) });
    const added = await add.inject({ method: "POST", url: `/purchase-orders/${crypto.randomUUID()}/rows`, payload: row });
    expect([added.statusCode, added.json().code]).toEqual([400, "invalid-unit"]);

    const update = buildApp({ updateRow: throwing(new InvalidUnitError()) });
    const updated = await update.inject({
      method: "PATCH",
      url: `/purchase-orders/${crypto.randomUUID()}/rows/${crypto.randomUUID()}`,
      payload: { unitId: crypto.randomUUID() },
    });
    expect([updated.statusCode, updated.json().code]).toEqual([400, "invalid-unit"]);
  });

  it("400s a unit the article does not have on an inquiry row", async () => {
    const add = buildApp({ addInquiryRow: throwing(new InvalidUnitError()) });
    const added = await add.inject({ method: "POST", url: `/inquiries/${crypto.randomUUID()}/rows`, payload: { articleId: row.articleId, quantity: 1 } });
    expect([added.statusCode, added.json().code]).toEqual([400, "invalid-unit"]);

    const update = buildApp({ updateInquiryRow: throwing(new InvalidUnitError()) });
    const updated = await update.inject({
      method: "PATCH",
      url: `/inquiries/${crypto.randomUUID()}/rows/${crypto.randomUUID()}`,
      payload: { unitId: crypto.randomUUID() },
    });
    expect([updated.statusCode, updated.json().code]).toEqual([400, "invalid-unit"]);
  });
});
