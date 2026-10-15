import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { InvalidFreightProductError } from "../src/modules/sales/service/sales.errors.js";
import type { SalesService } from "../src/modules/sales/service/sales.service.js";

const ID = "11111111-1111-4111-8111-111111111111";

function buildApp(service: Partial<SalesService>) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.register(salesRoutes, { service: service as SalesService });
  return app;
}

const refuse = async () => {
  throw new InvalidFreightProductError();
};

describe("kundens förvalda fraktprodukt — rutter", () => {
  it("400s an unknown freight product on create and update, with the Swedish message", async () => {
    const app = buildApp({ createCustomer: refuse, updateCustomer: refuse } as Partial<SalesService>);
    for (const req of [
      { method: "POST" as const, url: "/customers", payload: { name: "Kund AB", defaultFreightProductId: ID } },
      { method: "PATCH" as const, url: `/customers/${ID}`, payload: { defaultFreightProductId: ID } },
    ]) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid-freight-product", error: "Fraktprodukten finns inte" });
    }
  });

  it("400s a non-uuid before reaching the service", async () => {
    const app = buildApp({ createCustomer: refuse } as Partial<SalesService>);
    const res = await app.inject({ method: "POST", url: "/customers", payload: { name: "Kund AB", defaultFreightProductId: "dhl" } });
    expect(res.json()).toEqual({ code: "validation-failed" });
  });
});
