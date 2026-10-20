import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { ERROR_CODES } from "@navet/shared";
import { manufacturingRoutes } from "../src/modules/manufacturing/routes/manufacturing.routes.js";
import {
  MoReportNoPalletCardError,
  MoReportNotFoundError,
  type ManufacturingService,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { DeliveryNotFoundError, DeliveryRowNotInDeliveryError, type SalesService } from "../src/modules/sales/service/sales.service.js";
import { systemRoutes } from "../src/modules/system/routes/system.routes.js";
import type { SystemService } from "../src/modules/system/service/system.service.js";

// Pallkort — the HTTP contract of the print routes (no database): the query
// shapes handed to the services, the status and code of every domain error
// (the web's Swedish dictionary keys off them) and the two small settings
// reads. The rules themselves are covered against Postgres in
// pallet-card.test.ts.

const id = () => crypto.randomUUID();

function appWith(opts: { manufacturing?: Partial<ManufacturingService>; sales?: Partial<SalesService>; system?: Partial<SystemService> }) {
  const app = Fastify();
  // app.ts's zod handler, so a refused query is 400 validation-failed here too.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed" });
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: id(), role: "admin" } as never;
  });
  if (opts.manufacturing) app.register(manufacturingRoutes, { service: opts.manufacturing as ManufacturingService });
  if (opts.sales) app.register(salesRoutes, { service: opts.sales as SalesService });
  if (opts.system) app.register(systemRoutes, { service: opts.system as SystemService });
  return app;
}

const throwing = (err: Error) => async () => {
  throw err;
};
const pdf = { filename: "pallkort-TO-1-op10.pdf", content: Buffer.from("%PDF-1.3 fake") };

describe("Pallkort — operation and report routes", () => {
  it("GET …/operations/:opId/pallet-card hands repeated ?quantity on as a list and answers a PDF", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      manufacturing: {
        getOperationPalletCardPdf: async (moId, opId, quantities) => {
          calls.push([moId, opId, quantities]);
          return pdf;
        },
      },
    });
    const moId = id();
    const opId = id();
    const res = await app.inject({ method: "GET", url: `/manufacturing-orders/${moId}/operations/${opId}/pallet-card?quantity=10&quantity=10&quantity=4` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("pallkort-TO-1-op10.pdf");
    expect(calls[0]).toEqual([moId, opId, [10, 10, 4]]);

    const single = await app.inject({ method: "GET", url: `/manufacturing-orders/${moId}/operations/${opId}/pallet-card?quantity=3` });
    expect(single.statusCode).toBe(200);
    expect(calls[1]).toEqual([moId, opId, [3]]);

    const none = await app.inject({ method: "GET", url: `/manufacturing-orders/${moId}/operations/${opId}/pallet-card` });
    expect(none.statusCode).toBe(200);
    expect(calls[2]).toEqual([moId, opId, undefined]);

    const zero = await app.inject({ method: "GET", url: `/manufacturing-orders/${moId}/operations/${opId}/pallet-card?quantity=0` });
    expect(zero.statusCode).toBe(400);
    expect(zero.json().code).toBe("validation-failed");
  });

  it("GET …/reports/:reportId/pallet-card: 200 with the quantities, 404 mo-report-not-found, 409 report-has-no-pallet-card", async () => {
    const calls: unknown[] = [];
    const ok = appWith({
      manufacturing: {
        getReportPalletCardPdf: async (moId, reportId, quantities) => {
          calls.push([moId, reportId, quantities]);
          return pdf;
        },
      },
    });
    const moId = id();
    const reportId = id();
    const res = await ok.inject({ method: "GET", url: `/manufacturing-orders/${moId}/reports/${reportId}/pallet-card?quantity=2&quantity=3` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(calls[0]).toEqual([moId, reportId, [2, 3]]);

    const missing = appWith({ manufacturing: { getReportPalletCardPdf: throwing(new MoReportNotFoundError(reportId)) } });
    const notFound = await missing.inject({ method: "GET", url: `/manufacturing-orders/${moId}/reports/${reportId}/pallet-card` });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().code).toBe(ERROR_CODES.MO_REPORT_NOT_FOUND);

    const refused = appWith({ manufacturing: { getReportPalletCardPdf: throwing(new MoReportNoPalletCardError()) } });
    const conflict = await refused.inject({ method: "GET", url: `/manufacturing-orders/${moId}/reports/${reportId}/pallet-card` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: "Rapporten har inget pallkort — bara en operationsrapport som inte är ångrad kan skrivas ut",
      code: ERROR_CODES.REPORT_HAS_NO_PALLET_CARD,
    });
  });
});

describe("Pallkort — delivery routes", () => {
  it("GET /deliveries/:id/pallet-card parses row=<id>:<antal>,<antal> (string or list), 400 for an unknown row or zero cards", async () => {
    const calls: unknown[] = [];
    const app = appWith({
      sales: {
        deliveryPalletCardPdf: async (deliveryId, selection) => {
          calls.push([deliveryId, selection]);
          return { filename: "pallkort-FS-1.pdf", pdf: pdf.content };
        },
      },
    });
    const deliveryId = id();
    const a = id();
    const b = id();
    const res = await app.inject({ method: "GET", url: `/deliveries/${deliveryId}/pallet-card?row=${a}:4,6&row=${b}:` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(calls[0]).toEqual([
      deliveryId,
      [
        { deliveryRowId: a, quantities: [4, 6] },
        { deliveryRowId: b, quantities: [] },
      ],
    ]);

    const single = await app.inject({ method: "GET", url: `/deliveries/${deliveryId}/pallet-card?row=${a}:2.5` });
    expect(single.statusCode).toBe(200);
    expect(calls[1]).toEqual([deliveryId, [{ deliveryRowId: a, quantities: [2.5] }]]);

    const all = await app.inject({ method: "GET", url: `/deliveries/${deliveryId}/pallet-card` });
    expect(all.statusCode).toBe(200);
    expect(calls[2]).toEqual([deliveryId, undefined]);

    // Only skipped rows ⇒ nothing to print.
    const zero = await app.inject({ method: "GET", url: `/deliveries/${deliveryId}/pallet-card?row=${a}:&row=${b}:` });
    expect(zero.statusCode).toBe(400);
    expect(zero.json().code).toBe("validation-failed");

    const unknown = appWith({ sales: { deliveryPalletCardPdf: throwing(new DeliveryRowNotInDeliveryError(a)) } });
    const bad = await unknown.inject({ method: "GET", url: `/deliveries/${deliveryId}/pallet-card?row=${a}:1` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("delivery-row-not-in-delivery");

    const gone = appWith({ sales: { deliveryPalletCardPdf: throwing(new DeliveryNotFoundError(deliveryId)) } });
    expect((await gone.inject({ method: "GET", url: `/deliveries/${deliveryId}/pallet-card` })).statusCode).toBe(404);
  });

  it("GET /deliveries/:id/rows answers { deliveryNumber, rows } and 404 for an unknown delivery", async () => {
    const rows = {
      deliveryNumber: "FS-1",
      rows: [{ id: id(), articleNumber: "A", articleName: "Modul A", quantity: 10, unit: "st" }],
    };
    const app = appWith({ sales: { deliveryRows: async () => rows } });
    const res = await app.inject({ method: "GET", url: `/deliveries/${id()}/rows` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(rows);

    const gone = appWith({ sales: { deliveryRows: throwing(new DeliveryNotFoundError("x")) } });
    expect((await gone.inject({ method: "GET", url: `/deliveries/${id()}/rows` })).statusCode).toBe(404);
  });
});

describe("Pallkort — settings", () => {
  it("GET /settings/pallet-card answers { allowQuantityMismatch } only", async () => {
    const app = appWith({
      system: { getSettings: async () => ({ palletCardAllowQuantityMismatch: true, palletCardCode: "qr", smtpHost: "secret" }) as never },
    });
    const res = await app.inject({ method: "GET", url: "/settings/pallet-card" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allowQuantityMismatch: true });
  });
});
