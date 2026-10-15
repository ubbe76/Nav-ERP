import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { OverReceiptError, type PurchaseService } from "../src/modules/purchase/service/purchase.service.js";

// Route-level contract of POST /purchase-orders/:id/rows/:rowId/receive when a
// receipt breaks Tillåten överleverans — no database. The limit itself is
// covered against Postgres in purchase.service.test.ts.

function buildApp(service: Pick<PurchaseService, "receiveGoods">) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = { id: crypto.randomUUID(), role: "user" } as any;
  });
  app.register(purchaseRoutes, { service: service as PurchaseService });
  return app;
}

describe("POST /purchase-orders/:id/rows/:rowId/receive — over-receipt (route, inject)", () => {
  it("409s with the broken limit on the error body so the web can name the percentage", async () => {
    const app = buildApp({
      async receiveGoods() {
        throw new OverReceiptError({ allowedPercent: 10, maxQuantity: 11 });
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/purchase-orders/${crypto.randomUUID()}/rows/${crypto.randomUUID()}/receive`,
      payload: { quantity: 12 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "over-receipt", allowedPercent: 10, maxQuantity: 11 });
  });

  it("409s with the plain over-receipt body when no limit is attached", async () => {
    const app = buildApp({
      async receiveGoods() {
        throw new OverReceiptError();
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/purchase-orders/${crypto.randomUUID()}/rows/${crypto.randomUUID()}/receive`,
      payload: { quantity: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "Received quantity would exceed the ordered quantity for this row",
      code: "over-receipt",
    });
  });
});
