import type { FastifyInstance, FastifyReply } from "fastify";
import {
  calculationOutcomeQuerySchema,
  orderMarginQuerySchema,
  salesStatisticsQuerySchema,
  purchaseStatisticsQuerySchema,
  scrapStatisticsQuerySchema,
  deliveryPrecisionCsvQuerySchema,
  deliveryPrecisionQuerySchema,
  purchaseOrderRegisterQuerySchema,
  projectReportQuerySchema,
  quoteFollowupQuerySchema,
  salesOrderRegisterQuerySchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { canSeePrices } from "../../auth/middleware/access-rules.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { registerTableExportRoutes } from "../../system/routes/csv-export.js";
import type { ReportsService } from "../service/reports.service.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  OrderRegisterTooLargeError,
  type OrderRegisterKind,
  type OrderRegisterService,
} from "../service/order-register.service.js";
import { QuoteFollowupTooLargeError, type QuoteFollowupService } from "../service/quote-followup.service.js";
import { ProjectNotFoundError, type ProjectReportService } from "../service/project-report.service.js";
import {
  buildCalculationOutcomeAnalysisTable,
  buildCalculationOutcomeTable,
  buildDeliveryPrecisionTable,
  buildCounterpartyPrecisionTable,
  buildPurchaseStatisticsTable,
  buildSalesStatisticsTable,
  buildScrapStatisticsTable,
  buildOrderMarginTable,
} from "../service/reports-csv.js";

// F1 Rapporter — the whole section requires the Rapporter permission
// (management information; the admin role always has it). The plugin-level
// hook keeps the guard in mini-app tests that register this plugin directly.
export async function reportsRoutes(
  app: FastifyInstance,
  opts: { service: ReportsService; orderRegister: OrderRegisterService; quoteFollowup: QuoteFollowupService; projectReport: ProjectReportService }
) {
  const { service, orderRegister, quoteFollowup, projectReport } = opts;
  app.addHook("preHandler", requirePermission("rapporter"));

  // F2/#35: every report's download is one table served as …/csv and
  // …/xlsx (registerTableExportRoutes) — same content as the JSON.

  // Gruppera: Månad (default) | Motpart — the latter with the quality
  // columns (Kvalitet); Avvikelsekostnad follows canSeePrices.
  app.get("/reports/delivery-precision", async (req) => {
    const query = deliveryPrecisionQuerySchema.parse(req.query);
    return service.getDeliveryPrecision(query, { seePrices: canSeePrices(req.user!) });
  });

  registerTableExportRoutes(app, "/reports/delivery-precision/csv", {}, async (req) => {
    const query = deliveryPrecisionCsvQuerySchema.parse(req.query);
    const seePrices = canSeePrices(req.user!);
    const result = await service.getDeliveryPrecisionSection(query.kind, query, { seePrices });
    const early = result.section.margins.earlyDays !== null;
    if (query.groupBy === "counterparty") {
      return {
        basename: `leveransprecision-${query.kind}-motpart-${result.from}-${result.to}`,
        table: buildCounterpartyPrecisionTable(result.section.counterparties!, { kind: query.kind, seePrices, early }),
      };
    }
    return {
      basename: `leveransprecision-${query.kind}-${result.from}-${result.to}`,
      table: buildDeliveryPrecisionTable(result.section.months, { early }),
    };
  });

  // Kalkylutfall: ?view=pre (Mot förkalkyl, default) | analysis
  // (Avvikelseanalys, &groupBy=order|article|workCenter).
  app.get("/reports/calculation-outcome", async (req) => {
    const query = calculationOutcomeQuerySchema.parse(req.query);
    return service.getCalculationOutcome(query);
  });

  registerTableExportRoutes(app, "/reports/calculation-outcome/csv", {}, async (req) => {
    const query = calculationOutcomeQuerySchema.parse(req.query);
    const result = await service.getCalculationOutcome(query);
    if (result.view === "analysis") {
      return {
        basename: `kalkylutfall-avvikelseanalys-${result.groupBy}-${result.from}-${result.to}`,
        table: buildCalculationOutcomeAnalysisTable(result),
      };
    }
    return { basename: `kalkylutfall-${result.from}-${result.to}`, table: buildCalculationOutcomeTable(result.rows) };
  });

  app.get("/reports/sales-statistics", async (req) => {
    const query = salesStatisticsQuerySchema.parse(req.query);
    return service.getSalesStatistics(query);
  });

  registerTableExportRoutes(app, "/reports/sales-statistics/csv", {}, async (req) => {
    const query = salesStatisticsQuerySchema.parse(req.query);
    const result = await service.getSalesStatistics(query);
    return { basename: `forsaljningsstatistik-${result.groupBy}-${result.from}-${result.to}`, table: buildSalesStatisticsTable(result) };
  });

  app.get("/reports/order-margin", async (req) => {
    const query = orderMarginQuerySchema.parse(req.query);
    return service.getOrderMargin(query);
  });

  registerTableExportRoutes(app, "/reports/order-margin/csv", {}, async (req) => {
    const query = orderMarginQuerySchema.parse(req.query);
    const result = await service.getOrderMargin(query);
    return { basename: `marginal-${result.groupBy}-${result.from}-${result.to}`, table: buildOrderMarginTable(result) };
  });

  app.get("/reports/purchase-statistics", async (req) => {
    const query = purchaseStatisticsQuerySchema.parse(req.query);
    return service.getPurchaseStatistics(query);
  });

  registerTableExportRoutes(app, "/reports/purchase-statistics/csv", {}, async (req) => {
    const query = purchaseStatisticsQuerySchema.parse(req.query);
    const result = await service.getPurchaseStatistics(query);
    return { basename: `inkopsstatistik-${result.groupBy}-${result.from}-${result.to}`, table: buildPurchaseStatisticsTable(result) };
  });

  app.get("/reports/scrap-statistics", async (req) => {
    const query = scrapStatisticsQuerySchema.parse(req.query);
    return service.getScrapStatistics(query);
  });

  registerTableExportRoutes(app, "/reports/scrap-statistics/csv", {}, async (req) => {
    const query = scrapStatisticsQuerySchema.parse(req.query);
    const result = await service.getScrapStatistics(query);
    return { basename: `kassationsstatistik-${result.groupBy}-${result.from}-${result.to}`, table: buildScrapStatisticsTable(result) };
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

  registerTableExportRoutes(app, "/reports/quote-followup/csv", {}, async (req, reply) => {
    const query = quoteFollowupQuerySchema.parse(req.query);
    try {
      return await quoteFollowup.getTable(query);
    } catch (err) {
      if (err instanceof QuoteFollowupTooLargeError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Projektrapport (kostnadsställen och projekt) — one project's result out
  // of the booked rows carrying it, plus its customer orders.
  app.get("/reports/project-report", async (req, reply) => {
    const query = projectReportQuerySchema.parse(req.query);
    try {
      return await projectReport.get(query);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  registerTableExportRoutes(app, "/reports/project-report/csv", {}, async (req, reply) => {
    const query = projectReportQuerySchema.parse(req.query);
    try {
      return await projectReport.getTable(query);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) return reply.code(404).send(errorBody(err));
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

    registerTableExportRoutes(app, `${register.path}/csv`, {}, async (req, reply) => {
      const query = register.schema.parse(req.query);
      return run(reply, () => orderRegister.getTable(register.kind, query));
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
