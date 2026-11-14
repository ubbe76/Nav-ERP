import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import type { PurchaseService } from "../src/modules/purchase/service/purchase.service.js";

// Route-level contract of GET /supplier-price-quote with a faked service —
// no database. The resolution itself is covered by supplier-price.test.ts
// (pure) and article-suppliers.service.test.ts (against Postgres).

function buildApp(service: Pick<PurchaseService, "getSupplierPriceQuote">) {
  const app = Fastify();
  // app.ts's global ZodError branch, so a bad query is the 400 it is in the app.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: crypto.randomUUID(), role: "user" } as any;
  });
  app.register(purchaseRoutes, { service: service as PurchaseService });
  return app;
}

describe("GET /supplier-price-quote (route, inject)", () => {
  it("200s with the resolved price shape and parses quantity as a number", async () => {
    const supplierId = crypto.randomUUID();
    const articleId = crypto.randomUUID();
    const app = buildApp({
      async getSupplierPriceQuote(query) {
        expect(query).toEqual({ supplierId, articleId, quantity: 12.5 });
        return { articleNumber: "ART-1", price: { unitPrice: 9, currency: "SEK", fromQuantity: 10, source: "break" } };
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/supplier-price-quote?supplierId=${supplierId}&articleId=${articleId}&quantity=12.5`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      articleNumber: "ART-1",
      price: { unitPrice: 9, currency: "SEK", fromQuantity: 10, source: "break" },
    });
  });

  it("200s with price: null when the supplier has no catalog price", async () => {
    const app = buildApp({
      async getSupplierPriceQuote() {
        return { articleNumber: "ART-1", price: null };
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/supplier-price-quote?supplierId=${crypto.randomUUID()}&articleId=${crypto.randomUUID()}&quantity=1`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ articleNumber: "ART-1", price: null });
  });

  it("404s for an unknown article", async () => {
    const app = buildApp({
      async getSupplierPriceQuote() {
        return null;
      },
    });
    const res = await app.inject({
      method: "GET",
      url: `/supplier-price-quote?supplierId=${crypto.randomUUID()}&articleId=${crypto.randomUUID()}&quantity=1`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("article-not-found");
  });

  it("400s without a quantity (or with one that is not a positive number), and the service is never asked", async () => {
    let asked = 0;
    const app = buildApp({
      async getSupplierPriceQuote() {
        asked++;
        return null;
      },
    });
    const base = `/supplier-price-quote?supplierId=${crypto.randomUUID()}&articleId=${crypto.randomUUID()}`;
    for (const url of [base, `${base}&quantity=`, `${base}&quantity=-1`, `${base}&quantity=abc`]) {
      const res = await app.inject({ method: "GET", url });
      expect([url.split("&").pop(), res.statusCode, res.json().code]).toEqual([url.split("&").pop(), 400, "validation-failed"]);
    }
    expect(asked).toBe(0);
  });
});
