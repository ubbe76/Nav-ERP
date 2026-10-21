import type { FastifyInstance, FastifyReply } from "fastify";
import {
  reportRangeSchema,
  orderMarginQuerySchema,
  salesStatisticsQuerySchema,
  purchaseStatisticsQuerySchema,
  scrapStatisticsQuerySchema,
  deliveryPrecisionCsvQuerySchema,
  purchaseOrderRegisterQuerySchema,
  quoteFollowupQuerySchema,
  salesOrderRegisterQuerySchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import type { ReportsService } from "../service/reports.service.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  OrderRegisterTooLargeError,
  type OrderRegisterKind,
  type OrderRegisterService,
} from "../service/order-register.service.js";
import { QuoteFollowupTooLargeError, type QuoteFollowupService } from "../service/quote-followup.service.js";
import {
  buildCalculationOutcomeCsv,
  buildDeliveryPrecisionCsv,
  buildPurchaseStatisticsCsv,
  buildSalesStatisticsCsv,
  buildScrapStatisticsCsv,
  buildOrderMarginCsv,
} from "../service/reports-csv.js";

// F1 Rapporter — the whole section requires the Rapporter permission
// (management information; the admin role always has it). The plugin-level
// hook keeps the guard in mini-app tests that register this plugin directly.
export async function reportsRoutes(
  app: FastifyInstance,
  opts: { service: ReportsService; orderRegister: OrderRegisterService; quoteFollowup: QuoteFollowupService }
) {
  const { service, orderRegister, quoteFollowup } = opts;
  app.addHook("preHandler", requirePermission("rapporter"));

  // F2: CSV download — same content, text/csv instead of JSON.
  function sendCsv(reply: FastifyReply, filename: string, content: string) {
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", contentDisposition(filename));
    return reply.send(content);
  }

  app.get("/reports/delivery-precision", async (req) => {
    const query = reportRangeSchema.parse(req.query);
    return service.getDeliveryPrecision(query);
  });

  app.get("/reports/delivery-precision/csv", async (req, reply) => {
    const query = deliveryPrecisionCsvQuerySchema.parse(req.query);
    const result = await service.getDeliveryPrecisionSection(query.kind, query);
    const filename = `leveransprecision-${query.kind}-${result.from}-${result.to}.csv`;
    return sendCsv(reply, filename, buildDeliveryPrecisionCsv(result.section.months));
  });

  app.get("/reports/calculation-outcome", async (req) => {
    const query = reportRangeSchema.parse(req.query);
    return service.getCalculationOutcome(query);
  });

  app.get("/reports/calculation-outcome/csv", async (req, reply) => {
    const query = reportRangeSchema.parse(req.query);
    const result = await service.getCalculationOutcome(query);
    const filename = `kalkylutfall-${result.from}-${result.to}.csv`;
    return sendCsv(reply, filename, buildCalculationOutcomeCsv(result.rows));
  });

  app.get("/reports/sales-statistics", async (req) => {
    const query = salesStatisticsQuerySchema.parse(req.query);
    return service.getSalesStatistics(query);
  });

  app.get("/reports/sales-statistics/csv", async (req, reply) => {
    const query = salesStatisticsQuerySchema.parse(req.query);
    const result = await service.getSalesStatistics(query);
    const filename = `forsaljningsstatistik-${result.groupBy}-${result.from}-${result.to}.csv`;
    return sendCsv(reply, filename, buildSalesStatisticsCsv(result));
  });

  app.get("/reports/order-margin", async (req) => {
    const query = orderMarginQuerySchema.parse(req.query);
    return service.getOrderMargin(query);
  });

  app.get("/reports/order-margin/csv", async (req, reply) => {
    const query = orderMarginQuerySchema.parse(req.query);
    const result = await service.getOrderMargin(query);
    const filename = `marginal-${result.groupBy}-${result.from}-${result.to}.csv`;
    return sendCsv(reply, filename, buildOrderMarginCsv(result));
  });

  app.get("/reports/purchase-statistics", async (req) => {
    const query = purchaseStatisticsQuerySchema.parse(req.query);
    return service.getPurchaseStatistics(query);
  });

  app.get("/reports/purchase-statistics/csv", async (req, reply) => {
    const query = purchaseStatisticsQuerySchema.parse(req.query);
    const result = await service.getPurchaseStatistics(query);
    const filename = `inkopsstatistik-${result.groupBy}-${result.from}-${result.to}.csv`;
    return sendCsv(reply, filename, buildPurchaseStatisticsCsv(result));
  });

  app.get("/reports/scrap-statistics", async (req) => {
    const query = scrapStatisticsQuerySchema.parse(req.query);
    return service.getScrapStatistics(query);
  });

  app.get("/reports/scrap-statistics/csv", async (req, reply) => {
    const query = scrapStatisticsQuerySchema.parse(req.query);
    const result = await service.getScrapStatistics(query);
    const filename = `kassationsstatistik-${result.groupBy}-${result.from}-${result.to}.csv`;
    return sendCsv(reply, filename, buildScrapStatisticsCsv(result));
  });

  // Offertuppföljning — hit rate per customer/month/loss reason over the
  // quotes created in the range; the CSV is the quote list.
  app.get("/reports/quote-followup", async (req, reply) => {
    const query = quoteFollowupQuerySchema.parse(req.query);
    try {
      return await quoteFollowup.get(query);
    } catch (err) {
      if (err instanceof QuoteFollowupTooLargeError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.get("/reports/quote-followup/csv", async (req, reply) => {
    const query = quoteFollowupQuerySchema.parse(req.query);
    try {
      const { filename, content } = await quoteFollowup.getCsv(query);
      return sendCsv(reply, filename, content);
    } catch (err) {
      if (err instanceof QuoteFollowupTooLargeError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Orderförteckning — kundorder and inköp share one service; each side has
  // its JSON, CSV and PDF variants over the same query.
  const registers = [
    { kind: "sales", path: "/reports/sales-order-register", schema: salesOrderRegisterQuerySchema },
    { kind: "purchase", path: "/reports/purchase-order-register", schema: purchaseOrderRegisterQuerySchema },
  ] as const satisfies readonly { kind: OrderRegisterKind; path: string; schema: unknown }[];

  for (const register of registers) {
    async function run<T>(reply: FastifyReply, work: () => Promise<T>) {
      try {
        return await work();
      } catch (err) {
        if (err instanceof OrderRegisterTooLargeError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }

    app.get(register.path, async (req, reply) => {
      const query = register.schema.parse(req.query);
      return run(reply, () => orderRegister.get(register.kind, query));
    });

    app.get(`${register.path}/csv`, async (req, reply) => {
      const query = register.schema.parse(req.query);
      return run(reply, async () => {
        const { filename, content } = await orderRegister.getCsv(register.kind, query);
        return sendCsv(reply, filename, content);
      });
    });

    app.get(`${register.path}/pdf`, async (req, reply) => {
      const query = register.schema.parse(req.query);
      return run(reply, async () => {
        const { filename, content } = await orderRegister.getPdf(register.kind, query);
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", contentDisposition(filename, "inline"));
        return reply.send(content);
      });
    });
  }
}
