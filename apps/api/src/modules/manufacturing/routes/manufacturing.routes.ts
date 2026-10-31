import type { FastifyInstance, FastifyReply } from "fastify";
import { deviationLinkForbidden } from "../../quality/service/deviation-link-access.js";
import { DeviationLinkNotAllowedError } from "../../quality/service/deviation-errors.js";
import { articleCardWrite, canSeePrices, MO_READ, TERMINAL_READ } from "../../auth/middleware/access-rules.js";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import {
  completeManufacturingOrderSchema,
  completeOperationSchema,
  consumeMaterialSchema,
  createFromSalesOrderRowSchema,
  createManufacturingOrderSchema,
  createMoMaterialSchema,
  createMoOperationSchema,
  createProductionGroupSchema,
  createRoutingOperationSchema,
  createWorkCenterSchema,
  idListQuerySchema,
  listManufacturingOrdersQuerySchema,
  listWorkCentersQuerySchema,
  palletCardQuerySchema,
  setProductionGroupWorkCentersSchema,
  terminalOperationsQuerySchema,
  updateManufacturingOrderSchema,
  updateMoMaterialSchema,
  updateMoOperationSchema,
  updateProductionGroupSchema,
  updateRoutingOperationSchema,
  updateWorkCenterSchema,
} from "@navet/shared";
import type { ManufacturingService } from "../service/manufacturing.service.js";
import {
  DuplicateProductionGroupCodeError,
  DuplicateSequenceNoError,
  DuplicateWorkCenterCodeError,
  InvalidOperationFileTypeError,
  InvalidStatusTransitionError,
  LastOperationLockedError,
  ManufacturingOrderNotEditableError,
  MoMaterialConsumedError,
  MoMaterialDuplicateError,
  MoMaterialOwnArticleError,
  MoMaterialPhantomError,
  MoOperationDoneError,
  MoOperationLinkedPurchaseError,
  MoOperationNotOnOrderError,
  MoOperationReportedError,
  MoOperationSequenceTakenError,
  MoOperationStampedError,
  NotSubcontractOperationError,
  OperationFileNotFoundError,
  WorkCenterSupplierNotFoundError,
  LinkedOrderStatusError,
  LinkedRowArticleMismatchError,
  LinkedRowNotFoundError,
  LinkedRowNotManufacturedError,
  ManufacturingOrderHasReportsError,
  ManufacturingOrderNotFoundError,
  ManufacturingOrderStampedInError,
  MoReportAlreadyUndoneError,
  MoReportFromPurchaseReceiptError,
  MoReportNoPalletCardError,
  MoReportNotFoundError,
  MoReportStockMissingError,
  MoReportTimeLockedError,
  MOMaterialConsumptionNotFoundError,
  MOOperationNotFoundError,
  NothingLeftToManufactureError,
  OperationHasLinkedMaterialError,
  OverConsumptionError,
  MaterialShortageError,
  ScrapReasonInvalidError,
  ScrapReasonRequiredError,
  ProductionGroupNotFoundError,
  RoutingOperationNotFoundError,
  WeekScheduleNotFoundError,
  WorkCenterNotFoundError,
} from "../service/manufacturing.service.js";
import { LocationUnderStockCountError } from "../../stock/service/stock.service.js";
import { materialShortageBody } from "../service/material-shortage.js";
import { ArticleIsTemplateError, ArticleNotFoundError, InvalidUnitError } from "../../article/service/article.service.js";
// Konfigurator 4c: the TO paths of a beställningsvara answer with the same
// row-configuration errors as the order row (sales.routes.ts).
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  RowConfigurationChangedError,
} from "../../sales/service/sales.errors.js";
import {
  ConfiguratorInvalidConfigurationError,
  ConfiguratorModeChangedError,
  ConfiguratorNotToOrderModeError,
} from "../../configurator/service/configurator.errors.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { manufacturingOrderExportColumns } from "../service/export-columns.js";

// Same cap as the article drawings (app.ts registers fastify-multipart at 20MB).
const MAX_OPERATION_FILE_BYTES = 20 * 1024 * 1024;

// This module is registered inside app.ts's protected route scope, so
// requireAuth has already run and req.user is guaranteed to be set.
export async function manufacturingRoutes(app: FastifyInstance, opts: { service: ManufacturingService }) {
  const { service } = opts;

  // Stämpelterminalen: the operation list and the station picker. Terminal
  // reads, no prices.
  app.get("/terminal/operations", { config: { access: TERMINAL_READ } }, async (req) =>
    service.listTerminalOperations(terminalOperationsQuerySchema.parse(req.query))
  );
  app.get("/terminal/stations", { config: { access: TERMINAL_READ } }, async () => service.listTerminalStations());

  app.get("/work-centers", async (req) => service.listWorkCenters(listWorkCentersQuerySchema.parse(req.query)));

  app.get<{ Params: { id: string } }>("/work-centers/:id", async (req, reply) => {
    const workCenter = await service.getWorkCenter(req.params.id);
    if (!workCenter) return reply.code(404).send({ error: "Work center not found" });
    return workCenter;
  });

  app.post("/work-centers", async (req, reply) => {
    const input = createWorkCenterSchema.parse(req.body);
    try {
      const workCenter = await service.createWorkCenter(input);
      return reply.code(201).send(workCenter);
    } catch (err) {
      if (err instanceof DuplicateWorkCenterCodeError) return reply.code(409).send(errorBody(err));
      if (err instanceof ProductionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof WeekScheduleNotFoundError) return reply.code(400).send(errorBody(err));
      if (err instanceof WorkCenterSupplierNotFoundError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/work-centers/:id", async (req, reply) => {
    const input = updateWorkCenterSchema.parse(req.body);
    try {
      return await service.updateWorkCenter(req.params.id, input);
    } catch (err) {
      if (err instanceof WorkCenterNotFoundError || err instanceof ProductionGroupNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof DuplicateWorkCenterCodeError) return reply.code(409).send(errorBody(err));
      if (err instanceof WeekScheduleNotFoundError) return reply.code(400).send(errorBody(err));
      if (err instanceof WorkCenterSupplierNotFoundError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Produktionsgrupper — groups of resources (one group per resource).
  app.get("/production-groups", async () => service.listProductionGroups());

  app.post("/production-groups", async (req, reply) => {
    const input = createProductionGroupSchema.parse(req.body);
    try {
      const group = await service.createProductionGroup(input);
      return reply.code(201).send(group);
    } catch (err) {
      if (err instanceof DuplicateProductionGroupCodeError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/production-groups/:id", async (req, reply) => {
    try {
      return await service.getProductionGroup(req.params.id);
    } catch (err) {
      if (err instanceof ProductionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/production-groups/:id", async (req, reply) => {
    const input = updateProductionGroupSchema.parse(req.body);
    try {
      return await service.updateProductionGroup(req.params.id, input);
    } catch (err) {
      if (err instanceof ProductionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicateProductionGroupCodeError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>("/production-groups/:id/work-centers", async (req, reply) => {
    const input = setProductionGroupWorkCentersSchema.parse(req.body);
    try {
      return await service.setProductionGroupWorkCenters(req.params.id, input);
    } catch (err) {
      if (err instanceof ProductionGroupNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/articles/:id/routing", async (req) => {
    return service.listRoutingOperations(req.params.id);
  });

  // Legoförfrågan: feeds the inquiry row form's Legooperation select. Never
  // 404s — an article with no lego operations (or that isn't manufactured)
  // just yields [].
  app.get<{ Params: { id: string } }>("/articles/:id/lego-operations", async (req) => {
    return service.listLegoOperationOptions(req.params.id);
  });

  app.post<{ Params: { id: string } }>(
    "/articles/:id/routing",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      const input = createRoutingOperationSchema.parse(req.body);
      try {
        const operation = await service.createRoutingOperation(req.params.id, input);
        return reply.code(201).send(operation);
      } catch (err) {
        if (err instanceof DuplicateSequenceNoError) return reply.code(409).send(errorBody(err));
        if (err instanceof WorkCenterNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof NotSubcontractOperationError) return reply.code(400).send(errorBody(err));
        if (err instanceof WorkCenterSupplierNotFoundError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  app.patch<{ Params: { id: string; opId: string } }>(
    "/articles/:id/routing/:opId",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      const input = updateRoutingOperationSchema.parse(req.body);
      try {
        return await service.updateRoutingOperation(req.params.id, req.params.opId, input);
      } catch (err) {
        if (err instanceof RoutingOperationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof WorkCenterNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof DuplicateSequenceNoError) return reply.code(409).send(errorBody(err));
        if (err instanceof OperationHasLinkedMaterialError) return reply.code(409).send(errorBody(err));
        if (err instanceof NotSubcontractOperationError) return reply.code(400).send(errorBody(err));
        if (err instanceof WorkCenterSupplierNotFoundError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  // --- Lego operation drawing (one per operation) — GET meta, GET download,
  // PUT replace, DELETE. Multipart like /articles/:id/files. ---

  app.get<{ Params: { id: string; opId: string } }>("/articles/:id/routing/:opId/file", async (req, reply) => {
    try {
      const meta = await service.getOperationFileMeta(req.params.id, req.params.opId);
      // Meta as JSON; null when the operation has no drawing (the UI shows
      // an empty upload state rather than an error).
      return meta;
    } catch (err) {
      if (err instanceof RoutingOperationNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string; opId: string } }>(
    "/articles/:id/routing/:opId/file/download",
    async (req, reply) => {
      try {
        const file = await service.downloadOperationFile(req.params.id, req.params.opId);
        reply.header("Content-Type", file.contentType);
        reply.header("Content-Disposition", contentDisposition(file.filename, "inline"));
        return reply.send(file.data);
      } catch (err) {
        if (err instanceof RoutingOperationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof OperationFileNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.put<{ Params: { id: string; opId: string } }>(
    "/articles/:id/routing/:opId/file",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      const file = await req.file({ limits: { fileSize: MAX_OPERATION_FILE_BYTES } });
      if (!file) return reply.code(400).send({ error: "No file provided" });
      const data = await file.toBuffer();
      // fastify-multipart truncates instead of throwing once the limit is hit.
      if (file.file.truncated) {
        return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
      }
      try {
        return await service.putOperationFile(req.params.id, req.params.opId, {
          filename: file.filename,
          contentType: file.mimetype,
          data,
        });
      } catch (err) {
        if (err instanceof RoutingOperationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidOperationFileTypeError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; opId: string } }>(
    "/articles/:id/routing/:opId/file",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      try {
        await service.deleteOperationFile(req.params.id, req.params.opId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RoutingOperationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof OperationFileNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; opId: string } }>(
    "/articles/:id/routing/:opId",
    { config: { access: articleCardWrite(["tillverkning"]) } },
    async (req, reply) => {
      try {
        await service.removeRoutingOperation(req.params.id, req.params.opId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof RoutingOperationNotFoundError) return reply.code(404).send(errorBody(err));
        throw err;
      }
    }
  );

  // Konfigurator 4c: a configured TO's förkalkyl (configuration.cost) is
  // office data like setupPrice/unitPrice on /operations below — the
  // verkstad profile gets the same shape with the figure nulled.
  const hideConfigurationCost = <T extends { configuration: unknown }>(order: T, user: Parameters<typeof canSeePrices>[0]): T => {
    if (canSeePrices(user)) return order;
    const configuration = order.configuration as { cost?: Record<string, unknown> } | null;
    if (!configuration?.cost) return order;
    return { ...order, configuration: { ...configuration, cost: { ...configuration.cost, manufacturingCostPerUnit: null } } };
  };

  app.get("/manufacturing-orders", { config: { access: MO_READ } }, async (req) => {
    const result = await service.listManufacturingOrders(listManufacturingOrdersQuerySchema.parse(req.query));
    return { ...result, rows: result.rows.map((row) => hideConfigurationCost(row, req.user!)) };
  });

  registerListCsvRoute(app, {
    path: "/manufacturing-orders/csv",
    querySchema: listManufacturingOrdersQuerySchema,
    filenameBase: "tillverkningsordrar",
    columns: manufacturingOrderExportColumns,
    fetch: (query) => service.listManufacturingOrders(query),
  });

  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id", { config: { access: MO_READ } }, async (req, reply) => {
    const order = await service.getManufacturingOrder(req.params.id);
    if (!order) return reply.code(404).send({ error: "Manufacturing order not found" });
    return hideConfigurationCost(order, req.user!);
  });

  app.post("/manufacturing-orders", async (req, reply) => {
    const input = createManufacturingOrderSchema.parse(req.body);
    const forbidden = deviationLinkForbidden(input.deviationId, req.user);
    if (forbidden) return reply.code(403).send(errorBody(forbidden));
    try {
      const order = await service.createManufacturingOrder(input, req.user!.id);
      return reply.code(201).send(order);
    } catch (err) {
      if (err instanceof LinkedRowNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof LinkedRowArticleMismatchError) return reply.code(400).send(errorBody(err));
      if (err instanceof LinkedRowNotManufacturedError) return reply.code(400).send(errorBody(err));
      if (err instanceof LinkedOrderStatusError) return reply.code(409).send(errorBody(err));
      // Produktkonfigurator: a template in mode variants never gets a TO.
      if (err instanceof ArticleIsTemplateError) return reply.code(409).send(errorBody(err));
      if (err instanceof ConfigurationRequiredError) return reply.code(409).send(errorBody(err));
      if (err instanceof ConfigurationNotAllowedError) return reply.code(400).send(errorBody(err));
      if (err instanceof RowConfigurationChangedError) return reply.code(409).send(errorBody(err));
      if (err instanceof ConfiguratorNotToOrderModeError || err instanceof ConfiguratorModeChangedError) return reply.code(409).send(errorBody(err));
      if (err instanceof ConfiguratorInvalidConfigurationError) return reply.code(400).send({ ...errorBody(err), details: err.details });
      // Avvikelser: the case cannot take the link (closed, wrong type).
      if (err instanceof DeviationLinkNotAllowedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // E3 (KO→TO-koppling): "Skapa TO" from a KO row card. Registered here
  // (not in the sales module) same precedence as purchase serving
  // /articles/:id/suppliers — a flat route scope, not a module-owned prefix.
  // Row-belongs-to-order is validated against the URL's :id before
  // delegating, independently of the service's own row/article/status
  // checks (which fire regardless of how the link was requested).
  app.post<{ Params: { id: string; rowId: string } }>(
    "/sales-orders/:id/rows/:rowId/manufacturing-order",
    async (req, reply) => {
      const input = createFromSalesOrderRowSchema.parse(req.body);
      const link = await service.getLinkedSalesOrderRow(req.params.rowId);
      if (!link || link.salesOrderId !== req.params.id) {
        // Same envelope+code as the service's own LinkedRowNotFoundError path.
        return reply.code(404).send(errorBody(new LinkedRowNotFoundError(req.params.rowId)));
      }
      try {
        const order = await service.createFromSalesOrderRow(req.params.rowId, input, req.user!.id);
        return reply.code(201).send(order);
      } catch (err) {
        if (err instanceof LinkedRowNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof LinkedRowArticleMismatchError) return reply.code(400).send(errorBody(err));
        if (err instanceof LinkedRowNotManufacturedError) return reply.code(400).send(errorBody(err));
        if (err instanceof LinkedOrderStatusError) return reply.code(409).send(errorBody(err));
        if (err instanceof NothingLeftToManufactureError) return reply.code(400).send(errorBody(err));
        // Produktkonfigurator: the KO row's article became a template in mode
        // variants after the row was created — no TO on the template.
        if (err instanceof ArticleIsTemplateError) return reply.code(409).send(errorBody(err));
        if (err instanceof ConfigurationRequiredError) return reply.code(409).send(errorBody(err));
        if (err instanceof ConfigurationNotAllowedError) return reply.code(400).send(errorBody(err));
        if (err instanceof RowConfigurationChangedError) return reply.code(409).send(errorBody(err));
        if (err instanceof ConfiguratorNotToOrderModeError || err instanceof ConfiguratorModeChangedError) return reply.code(409).send(errorBody(err));
        if (err instanceof ConfiguratorInvalidConfigurationError) return reply.code(400).send({ ...errorBody(err), details: err.details });
        throw err;
      }
    }
  );

  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id/materials", { config: { access: MO_READ } }, async (req) => {
    return service.listMaterialConsumptions(req.params.id);
  });

  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id/operations", { config: { access: MO_READ } }, async (req) => {
    const operations = await service.listOperations(req.params.id);
    if (canSeePrices(req.user!)) return operations;
    return operations.map((op) => ({ ...op, setupPrice: null, transportPrice: null, unitPrice: null }));
  });

  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id/scrap", { config: { access: MO_READ } }, async (req) => {
    return service.listScrapForOrder(req.params.id);
  });

  // Batch printout: ?ids=<uuid>,<uuid> → one PDF with the TO printouts
  // (drawings included) back to back. Static segment, never collides with
  // /:id/pdf below.
  app.get("/manufacturing-orders/pdf", async (req, reply) => {
    const { ids } = idListQuerySchema.parse(req.query);
    try {
      const { filename, content } = await service.getManufacturingOrdersPdf(ids);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id/pdf", { config: { access: MO_READ } }, async (req, reply) => {
    try {
      const { filename, content } = await service.getManufacturingOrderPdf(req.params.id);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Pallkort (Etapp F) — the card placed on the pallet when the operation is
  // reported. ?quantity overrides the printed quantity (defaults to the
  // operation's accumulated OK quantity, then the order quantity); repeated
  // ⇒ one card per kolli with that quantity.
  app.get<{ Params: { id: string; opId: string } }>(
    "/manufacturing-orders/:id/operations/:opId/pallet-card",
    { config: { access: MO_READ } },
    async (req, reply) => {
      const { quantity } = palletCardQuerySchema.parse(req.query);
      try {
        const { filename, content } = await service.getOperationPalletCardPdf(req.params.id, req.params.opId, quantity);
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", contentDisposition(filename));
        return reply.send(content);
      } catch (err) {
        if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof MOOperationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Pallkort per rapport (omutskrift from Rapporteringar): the report's
  // operation card dated on the report with the reporter's name; ?quantity
  // (repeatable, one card per kolli) defaults to the report's OK quantity.
  // Same shop-floor read rule as the
  // operation route. 404 when the report is not on this order, 409
  // report-has-no-pallet-card for anything but a live operation report.
  app.get<{ Params: { id: string; reportId: string } }>(
    "/manufacturing-orders/:id/reports/:reportId/pallet-card",
    { config: { access: MO_READ } },
    async (req, reply) => {
      const { quantity } = palletCardQuerySchema.parse(req.query);
      try {
        const { filename, content } = await service.getReportPalletCardPdf(req.params.id, req.params.reportId, quantity);
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", contentDisposition(filename));
        return reply.send(content);
      } catch (err) {
        if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof MoReportNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof MOOperationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof MoReportNoPalletCardError) return reply.code(409).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  // Header PATCH — today only the planned finish date (Planerat färdigdatum).
  app.patch<{ Params: { id: string } }>("/manufacturing-orders/:id", async (req, reply) => {
    const input = updateManufacturingOrderSchema.parse(req.body);
    try {
      return await service.updateManufacturingOrder(req.params.id, input, req.user!.id);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/release", async (req, reply) => {
    try {
      return await service.release(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/start", async (req, reply) => {
    try {
      return await service.start(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/cancel", async (req, reply) => {
    try {
      return await service.cancel(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      if (err instanceof ManufacturingOrderHasReportsError) return reply.code(409).send(errorBody(err));
      if (err instanceof ManufacturingOrderStampedInError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // Rapporteringar — the TO card's report log.
  app.get<{ Params: { id: string } }>("/manufacturing-orders/:id/reports", { config: { access: MO_READ } }, async (req) => {
    return service.listReports(req.params.id);
  });

  // Ångra rapportering removes a stamp's time report too, so it takes the
  // same roles as deleting a time report (admin/arbetsledare).
  app.post<{ Params: { id: string; reportId: string } }>(
    "/manufacturing-orders/:id/reports/:reportId/undo",
    { preHandler: requireRole("admin", "supervisor") },
    async (req, reply) => {
      try {
        return await service.undoReport(req.params.id, req.params.reportId, req.user!.id);
      } catch (err) {
        if (err instanceof MoReportNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof MoReportAlreadyUndoneError) return reply.code(409).send(errorBody(err));
        if (err instanceof MoReportFromPurchaseReceiptError) return reply.code(409).send(errorBody(err));
        if (err instanceof MoReportStockMissingError) return reply.code(409).send(errorBody(err));
        if (err instanceof MoReportTimeLockedError) return reply.code(409).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/close", async (req, reply) => {
    try {
      return await service.close(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/complete", async (req, reply) => {
    const input = completeManufacturingOrderSchema.parse(req.body);
    try {
      return await service.complete(req.params.id, input, req.user!.id);
    } catch (err) {
      if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
      if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
      if (err instanceof MaterialShortageError) return reply.code(409).send(materialShortageBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string; rowId: string } }>(
    "/manufacturing-orders/:id/materials/:rowId/consume",
    async (req, reply) => {
      const input = consumeMaterialSchema.parse(req.body);
      try {
        const row = await service.consumeMaterial(req.params.id, req.params.rowId, input, req.user!.id);
        return reply.code(201).send(row);
      } catch (err) {
        if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof MOMaterialConsumptionNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        if (err instanceof OverConsumptionError) return reply.code(409).send(errorBody(err));
        if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
        if (err instanceof MaterialShortageError) return reply.code(409).send(materialShortageBody(err));
        throw err;
      }
    }
  );

  // --- Ändra material och operationer på en skapad TO (Frisläppt/Pågår).
  // Write = tillverkning via the module registration. Lägg till/ändra answer
  // { material | operation, warnings } — the row in the same shape as the
  // list endpoints, the shortage/plan warnings as texts.
  const materialEditError = (err: unknown, reply: FastifyReply) => {
    if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof MOMaterialConsumptionNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof ManufacturingOrderNotEditableError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoMaterialConsumedError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoMaterialDuplicateError) return reply.code(409).send(errorBody(err));
    if (err instanceof ArticleIsTemplateError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoMaterialOwnArticleError) return reply.code(400).send(errorBody(err));
    if (err instanceof MoMaterialPhantomError) return reply.code(400).send(errorBody(err));
    if (err instanceof MoOperationNotOnOrderError) return reply.code(400).send(errorBody(err));
    if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
    throw err;
  };
  const operationEditError = (err: unknown, reply: FastifyReply) => {
    if (err instanceof ManufacturingOrderNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof MOOperationNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof WorkCenterNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof ManufacturingOrderNotEditableError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoOperationSequenceTakenError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoOperationDoneError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoOperationStampedError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoOperationLinkedPurchaseError) return reply.code(409).send(errorBody(err));
    if (err instanceof MoOperationReportedError) return reply.code(409).send(errorBody(err));
    if (err instanceof LastOperationLockedError) return reply.code(409).send(errorBody(err));
    if (err instanceof NotSubcontractOperationError) return reply.code(400).send(errorBody(err));
    if (err instanceof WorkCenterSupplierNotFoundError) return reply.code(400).send(errorBody(err));
    throw err;
  };

  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/materials", async (req, reply) => {
    const input = createMoMaterialSchema.parse(req.body);
    try {
      const result = await service.addMaterial(req.params.id, input, req.user!.id);
      return reply.code(201).send(result);
    } catch (err) {
      return materialEditError(err, reply);
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/manufacturing-orders/:id/materials/:rowId", async (req, reply) => {
    const input = updateMoMaterialSchema.parse(req.body);
    try {
      return await service.updateMaterial(req.params.id, req.params.rowId, input, req.user!.id);
    } catch (err) {
      return materialEditError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; rowId: string } }>("/manufacturing-orders/:id/materials/:rowId", async (req, reply) => {
    try {
      await service.removeMaterial(req.params.id, req.params.rowId, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return materialEditError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/manufacturing-orders/:id/operations", async (req, reply) => {
    const input = createMoOperationSchema.parse(req.body);
    try {
      const result = await service.addOperation(req.params.id, input, req.user!.id);
      return reply.code(201).send(result);
    } catch (err) {
      return operationEditError(err, reply);
    }
  });

  app.patch<{ Params: { id: string; opId: string } }>("/manufacturing-orders/:id/operations/:opId", async (req, reply) => {
    const input = updateMoOperationSchema.parse(req.body);
    try {
      return await service.updateOperation(req.params.id, req.params.opId, input, req.user!.id);
    } catch (err) {
      return operationEditError(err, reply);
    }
  });

  app.delete<{ Params: { id: string; opId: string } }>("/manufacturing-orders/:id/operations/:opId", async (req, reply) => {
    try {
      return await service.removeOperation(req.params.id, req.params.opId, req.user!.id);
    } catch (err) {
      return operationEditError(err, reply);
    }
  });

  app.post<{ Params: { id: string; opId: string } }>(
    "/manufacturing-orders/:id/operations/:opId/complete",
    async (req, reply) => {
      const input = completeOperationSchema.parse(req.body);
      try {
        return await service.completeOperation(req.params.opId, input, req.user!.id);
      } catch (err) {
        if (err instanceof MOOperationNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof InvalidStatusTransitionError) return reply.code(409).send(errorBody(err));
        if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
        if (err instanceof MaterialShortageError) return reply.code(409).send(materialShortageBody(err));
        if (err instanceof ScrapReasonRequiredError || err instanceof ScrapReasonInvalidError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );
}
