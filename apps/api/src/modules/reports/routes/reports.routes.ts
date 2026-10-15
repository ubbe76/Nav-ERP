import type { FastifyInstance, FastifyReply } from "fastify";
import {
  reportRangeSchema,
  orderMarginQuerySchema,
  salesStatisticsQuerySchema,
  purchaseStatisticsQuerySchema,
  scrapStatisticsQuerySchema,
  deliveryPrecisionCsvQuerySchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import type { ReportsService } from "../service/reports.service.js";
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
export async function reportsRoutes(app: FastifyInstance, opts: { service: ReportsService }) {
  const { service } = opts;
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
}
