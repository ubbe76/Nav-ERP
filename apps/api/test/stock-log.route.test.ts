import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { stockRoutes } from "../src/modules/stock/routes/stock.routes.js";
import type { StockService } from "../src/modules/stock/service/stock.service.js";

// GET /stock/transactions — À-pris/Värde are visible only to admin and the
// ekonomi permission; the CSV drops the two columns for everyone else.

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  createdAt: new Date("2026-03-01T10:00:00Z"),
  articleNumber: "A-1",
  articleName: "Skruv",
  warehouseName: "Huvudlager",
  locationName: "A1",
  transactionType: "purchase_receipt",
  quantityDelta: "4.0000",
  balance: "4.0000",
  reference: { kind: "purchase_order", id: "22222222-2222-4222-8222-222222222222", number: "IO-1" },
  createdByName: "Kalle Kula",
  unitCost: "12.5000",
  value: "50.0000",
  note: null,
};

function buildApp(user: { role: "admin" | "supervisor" | "user"; permissions: string[] }) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: unknown }).user = user;
  });
  const service = { listTransactions: async () => ({ rows: [row], total: 1 }) } as unknown as StockService;
  app.register(stockRoutes, { service, valuation: {} as never, counts: {} as never });
  return app;
}

describe("lagerlogg — kostnadsdöljning", () => {
  it("shows unitCost and value to admin", async () => {
    const res = await buildApp({ role: "admin", permissions: [] }).inject({ method: "GET", url: "/stock/transactions" });
    expect(res.json().rows[0]).toMatchObject({ unitCost: "12.5000", value: "50.0000" });
  });

  it("shows them to a user with the ekonomi permission", async () => {
    const res = await buildApp({ role: "user", permissions: ["ekonomi"] }).inject({ method: "GET", url: "/stock/transactions" });
    expect(res.json().rows[0]).toMatchObject({ unitCost: "12.5000", value: "50.0000" });
  });

  it("nulls them (same shape) for a user without ekonomi", async () => {
    const res = await buildApp({ role: "user", permissions: ["lager"] }).inject({ method: "GET", url: "/stock/transactions" });
    const r = res.json().rows[0];
    expect(r).toMatchObject({ unitCost: null, value: null, quantityDelta: "4.0000", balance: "4.0000" });
  });

  it("CSV: cost columns only for ekonomi/admin, Källa and Vem for all", async () => {
    const withCost = await buildApp({ role: "user", permissions: ["ekonomi"] }).inject({ method: "GET", url: "/stock/transactions/csv?articleId=11111111-1111-4111-8111-111111111111" });
    const header = withCost.body.replace(/^﻿/, "").split(/\r?\n/)[0]!;
    expect(header).toBe("Datum;Artikel;Lagerplats;Typ;Mängd;Saldo;Källa;Vem;À-pris;Värde;Anteckning");
    expect(withCost.body).toContain("IO-1");
    expect(withCost.body).toContain("Kalle Kula");

    const without = await buildApp({ role: "user", permissions: ["lager"] }).inject({ method: "GET", url: "/stock/transactions/csv?articleId=11111111-1111-4111-8111-111111111111" });
    const header2 = without.body.replace(/^﻿/, "").split(/\r?\n/)[0]!;
    expect(header2).toBe("Datum;Artikel;Lagerplats;Typ;Mängd;Saldo;Källa;Vem;Anteckning");
    expect(without.body).not.toContain("12,5");
    expect(without.body).not.toContain("50,00");
  });

  it("400s an invalid filter on the CSV route — an empty articleId included, never an empty Saldo column", async () => {
    const res = await buildApp({ role: "admin", permissions: [] }).inject({ method: "GET", url: "/stock/transactions/csv?direction=sideways" });
    expect(res.statusCode).toBe(400);
    const blank = await buildApp({ role: "admin", permissions: [] }).inject({ method: "GET", url: "/stock/transactions/csv?articleId=" });
    expect(blank.statusCode).toBe(400);
  });

  it("CSV drops Saldo without an article filter and labels transfer legs Flytt till/från", async () => {
    const transferRows = [
      { ...row, quantityDelta: "-2.0000", reference: { kind: "transfer", counterpartLocation: "Huvudlager — B2" } },
      { ...row, quantityDelta: "2.0000", reference: { kind: "transfer", counterpartLocation: "Huvudlager — A1" } },
    ];
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { role: "admin", permissions: [] };
    });
    app.register(stockRoutes, {
      service: { listTransactions: async () => ({ rows: transferRows, total: 2 }) } as unknown as StockService,
      valuation: {} as never,
      counts: {} as never,
    });
    const res = await app.inject({ method: "GET", url: "/stock/transactions/csv" });
    const body = res.body.replace(/^\uFEFF/, "");
    expect(body.split(/\r?\n/)[0]).toBe("Datum;Artikel;Lagerplats;Typ;Mängd;Källa;Vem;À-pris;Värde;Anteckning");
    expect(body).toContain("Flytt till Huvudlager — B2");
    expect(body).toContain("Flytt från Huvudlager — A1");
  });

  it("POST /stock/transactions passes the signed-in user to the service", async () => {
    let seen: unknown;
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { id: "99999999-9999-4999-8999-999999999999", role: "admin", permissions: [] };
    });
    app.register(stockRoutes, {
      service: { recordTransaction: async (_i: unknown, userId: unknown) => { seen = userId; return { id: "x" }; } } as unknown as StockService,
      valuation: {} as never,
      counts: {} as never,
    });
    const res = await app.inject({
      method: "POST",
      url: "/stock/transactions",
      payload: { articleId: "11111111-1111-4111-8111-111111111111", quantityDelta: 1, transactionType: "inventory_adjustment" },
    });
    expect(res.statusCode).toBe(201);
    expect(seen).toBe("99999999-9999-4999-8999-999999999999");
  });
});
