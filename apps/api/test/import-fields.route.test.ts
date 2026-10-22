import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { importRoutes } from "../src/modules/import/routes/import.routes.js";
import { IMPORT_FIELD_HELP } from "../src/modules/import/service/field-help.js";
import type { ImportService } from "../src/modules/import/service/import.service.js";

// GET /imports/:entity/fields — the HTTP contract (no database): the shape
// the wizard's mapping step reads, 404 for an unknown entity, 403 for a
// non-admin. The texts themselves are covered in import-field-help.test.ts.

function appWith(role: "admin" | "user") {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = { id: crypto.randomUUID(), role } as never;
  });
  // The field help needs no service; an empty stub keeps the route file's
  // signature honest.
  app.register(importRoutes, { service: {} as ImportService });
  return app;
}

describe("GET /imports/:entity/fields", () => {
  it("answers the field help in the wizard's field order", async () => {
    const app = appWith("admin");
    const res = await app.inject({ url: "/imports/articles/fields" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ field: string; label: string; required: boolean; header: string; description: string; example: string }[]>();
    expect(body.map((f) => f.field)).toEqual(IMPORT_FIELD_HELP.articles.map((h) => h.field));
    expect(body[0]).toEqual({
      field: "articleNumber",
      label: "Artikelnummer",
      required: true,
      header: "Artikelnummer",
      description: IMPORT_FIELD_HELP.articles[0]!.description,
      example: "SB-1200",
    });
    for (const entry of body) {
      expect(Object.keys(entry).sort()).toEqual(["description", "example", "field", "header", "label", "required"]);
    }
    await app.close();
  });

  it("404s for an unknown entity", async () => {
    const app = appWith("admin");
    const res = await app.inject({ url: "/imports/nonsense/fields" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Okänd importtyp: nonsense" });
    await app.close();
  });

  it("403s for a non-admin", async () => {
    const app = appWith("user");
    const res = await app.inject({ url: "/imports/articles/fields" });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
