import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { invoiceRoutes } from "../src/modules/sales/routes/invoice.routes.js";
import type { InvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { InvalidUnitError } from "../src/modules/article/service/article.service.js";

// Enhet on a free invoice row: a unit that is not the article's (or a unit on
// a row without an article) is the client's mistake — 400 invalid-unit, the
// same code the order rows answer with.
const ID = "11111111-1111-4111-8111-111111111111";

function routesApp(service: Partial<InvoiceService>) {
  const app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: "u1" };
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.register(invoiceRoutes, { service: service as InvoiceService });
  return app;
}

describe("invoice row Enhet — the route envelope", () => {
  it("answers 400 invalid-unit on Lägg till rad and on Ändra", async () => {
    const refuse = async () => {
      throw new InvalidUnitError();
    };
    const app = routesApp({ addRow: refuse, updateRow: refuse });
    const payload = { articleId: ID, description: "Plåt", quantity: 1, unitPrice: 10, unitId: ID };
    const added = await app.inject({ method: "POST", url: `/invoices/${ID}/rows`, payload });
    expect(added.statusCode).toBe(400);
    expect(added.json()).toMatchObject({ code: "invalid-unit" });
    const updated = await app.inject({ method: "PATCH", url: `/invoices/${ID}/rows/${ID}`, payload: { unitId: ID } });
    expect(updated.statusCode).toBe(400);
    expect(updated.json()).toMatchObject({ code: "invalid-unit" });
  });

  it("refuses a unitId that is not a uuid before the service", async () => {
    const app = routesApp({});
    const res = await app.inject({
      method: "POST",
      url: `/invoices/${ID}/rows`,
      payload: { description: "Plåt", quantity: 1, unitPrice: 10, unitId: "kg" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "validation-failed" });
  });
});
