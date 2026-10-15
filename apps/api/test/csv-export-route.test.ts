import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { z } from "zod";
import { listQuerySchema, CSV_EXPORT_MAX_ROWS } from "@navet/shared";
import { registerListCsvRoute } from "../src/modules/system/routes/csv-export.js";

// Route-helper tests via app.inject with a stubbed fetch — no database.

const testSchema = listQuerySchema.extend({ type: z.enum(["purchased", "manufactured"]).optional() });

interface Row {
  articleNumber: string;
  name: string;
}

function makeApp(overrides: {
  rows?: Row[];
  total?: number;
  preHandler?: Parameters<typeof registerListCsvRoute>[1]["preHandler"];
  capture?: (query: unknown) => void;
}) {
  const app = Fastify();
  registerListCsvRoute<z.infer<typeof testSchema>, Row>(app, {
    path: "/articles/csv",
    preHandler: overrides.preHandler,
    querySchema: testSchema,
    filenameBase: "artiklar",
    columns: [
      { label: "Artikelnummer", value: (r) => r.articleNumber },
      { label: "Benämning", value: (r) => r.name },
    ],
    fetch: async (query) => {
      overrides.capture?.(query);
      return { rows: overrides.rows ?? [], total: overrides.total ?? (overrides.rows ?? []).length };
    },
  });
  return app;
}

describe("registerListCsvRoute", () => {
  it("strips pagination from the incoming query and fetches the full capped set", async () => {
    let seen: any;
    const app = makeApp({ capture: (q) => (seen = q) });
    const res = await app.inject({ url: "/articles/csv?search=stål&type=purchased&limit=25&offset=50&page=3" });
    expect(res.statusCode).toBe(200);
    expect(seen.search).toBe("stål");
    expect(seen.type).toBe("purchased");
    expect(seen.limit).toBe(CSV_EXPORT_MAX_ROWS);
    expect(seen.offset).toBe(0);
  });

  it("responds with CSV headers, a dated filename and BOM + header + rows", async () => {
    const app = makeApp({ rows: [{ articleNumber: "A-1", name: "Skruv" }] });
    const res = await app.inject({ url: "/articles/csv" });
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="artiklar-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.body.startsWith("﻿Artikelnummer;Benämning\r\n")).toBe(true);
    expect(res.body).toContain("A-1;Skruv\r\n");
  });

  it("fails loudly with 400 when the result exceeds the export cap", async () => {
    const app = makeApp({ rows: [], total: CSV_EXPORT_MAX_ROWS + 1 });
    const res = await app.inject({ url: "/articles/csv" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("10 000");
  });

  it("runs the provided preHandler (auth passthrough)", async () => {
    const app = makeApp({
      preHandler: async (_req, reply) => {
        reply.code(403).send({ error: "Förbjuden" });
      },
    });
    const res = await app.inject({ url: "/articles/csv" });
    expect(res.statusCode).toBe(403);
  });

  it("rejects invalid filter values via the module schema", async () => {
    const app = makeApp({});
    const res = await app.inject({ url: "/articles/csv?type=nonsense" });
    expect(res.statusCode).toBe(400);
  });
});
