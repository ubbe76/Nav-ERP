import { locationLabelsSchema } from "@navet/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  addStockCountRowSchema,
  articleLocationsSchema,
  blockStockLocationSchema,
  createStockCountSchema,
  createStockLocationSchema,
  createStockAdjustmentSchema,
  listStockBatchBalancesQuerySchema,
  listStockBatchesQuerySchema,
  createStockTransferSchema,
  createWarehouseSchema,
  listStockTransactionsQuerySchema,
  listStockBalancesQuerySchema,
  listStockCountsQuerySchema,
  listStockLocationRegisterQuerySchema,
  listStockLocationsQuerySchema,
  postStockCountSchema,
  stockCountPdfQuerySchema,
  updateStockCountRowSchema,
  updateStockLocationSchema,
  updateWarehouseSchema,
  valuationQuerySchema,
} from "@navet/shared";
import { requireRole } from "../../auth/middleware/auth.middleware.js";
import { articleCardWrite, canSeeStockCost, LABEL_PRINT } from "../../auth/middleware/access-rules.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  stockBalanceExportColumns,
  stockCountExportColumns,
  stockLocationRegisterExportColumns,
  stockTransactionColumns,
} from "../service/export-columns.js";
import type { StockService } from "../service/stock.service.js";
import {
  ArticleLocationInvalidError,
  ArticleNotFoundError,
  DuplicateStockCountRowError,
  FallbackLocationNotBlockableError,
  InactiveStockLocationError,
  InsufficientStockError,
  LocationUnderStockCountError,
  StockCountAlreadyOpenError,
  StockCountNotFoundError,
  StockCountBackdateRefusedError,
  StockCountNotOpenError,
  StockCountRowNotFoundError,
  StockLocationAlreadyBlockedError,
  StockLocationNotBlockedError,
  StockLocationNotEmptyError,
  ServiceArticleNotStockedError,
  StockLocationNameReservedError,
  StockLocationNotFoundError,
  WarehouseNotFoundError,
} from "../service/stock.service.js";
import type { ValuationService } from "../service/valuation.service.js";
import type { StockCountService } from "../service/stock-count.service.js";

export async function stockRoutes(
  app: FastifyInstance,
  opts: { service: StockService; valuation: ValuationService; counts: StockCountService }
) {
  const { service, valuation, counts } = opts;

  app.get("/stock/warehouses", async () => service.listWarehouses());

  app.post("/stock/warehouses", async (req, reply) => {
    const input = createWarehouseSchema.parse(req.body);
    const row = await service.createWarehouse(input);
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string } }>("/stock/warehouses/:id", async (req, reply) => {
    const input = updateWarehouseSchema.parse(req.body);
    try {
      return await service.updateWarehouse(req.params.id, input);
    } catch (err) {
      if (err instanceof WarehouseNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.get("/stock/locations", async (req) =>
    service.listLocations(listStockLocationsQuerySchema.parse(req.query))
  );

  // Lagerplatsregistret (/lager/platser): the list pattern with search,
  // filters and pages; the module's read rule (office). GET /stock/locations
  // above stays an array — the place pickers and integrations read it.
  app.get("/stock/locations/register", async (req) =>
    service.listLocationRegister(listStockLocationRegisterQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/stock/locations/register/csv",
    querySchema: listStockLocationRegisterQuerySchema,
    filenameBase: "lagerplatser",
    columns: stockLocationRegisterExportColumns,
    fetch: (query) => service.listLocationRegister(query),
  });

  // Etiketter (#4): lagerplats labels as a PDF. POST for the id list;
  // prints and writes nothing, so office may and Endast läsning may.
  app.post("/stock/locations/labels", { config: { access: LABEL_PRINT, readOnlySafe: true } }, async (req, reply) => {
    const input = locationLabelsSchema.parse(req.body);
    try {
      const pdf = await service.renderLocationLabels(input);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition("lagerplatsetiketter.pdf", "inline"));
      return reply.send(pdf);
    } catch (err) {
      if (err instanceof StockLocationNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/stock/locations/:id", async (req, reply) => {
    const input = updateStockLocationSchema.parse(req.body);
    try {
      return await service.updateLocation(req.params.id, input);
    } catch (err) {
      if (err instanceof StockLocationNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof StockLocationNotEmptyError) return reply.code(409).send(errorBody(err));
      // blockedNote on an open place / a blocked place renamed to "***".
      if (err instanceof StockLocationNotBlockedError) return reply.code(409).send(errorBody(err));
      if (err instanceof FallbackLocationNotBlockableError) return reply.code(409).send(errorBody(err));
      if (err instanceof StockLocationNameReservedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post("/stock/locations", async (req, reply) => {
    const input = createStockLocationSchema.parse(req.body);
    try {
      const row = await service.createLocation(input, req.user?.id ?? null);
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof FallbackLocationNotBlockableError) return reply.code(409).send(errorBody(err));
      if (err instanceof StockLocationNameReservedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  // Spärra lagerplats / Släpp spärr (0185) — the module's write rule (lager).
  // Block answers with the place and what the spärr touches (articles with a
  // balance there, articles that have it as Lagerplats); unblock with the place.
  const blockError = (err: unknown, reply: FastifyReply) => {
    if (err instanceof StockLocationNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof StockLocationAlreadyBlockedError) return reply.code(409).send(errorBody(err));
    if (err instanceof StockLocationNotBlockedError) return reply.code(409).send(errorBody(err));
    if (err instanceof FallbackLocationNotBlockableError) return reply.code(409).send(errorBody(err));
    throw err;
  };

  app.post<{ Params: { id: string } }>("/stock/locations/:id/block", async (req, reply) => {
    const input = blockStockLocationSchema.parse(req.body ?? {});
    try {
      return await service.blockLocation(req.params.id, input.note ?? null, req.user!.id);
    } catch (err) {
      return blockError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/stock/locations/:id/unblock", async (req, reply) => {
    try {
      return await service.unblockLocation(req.params.id, req.user!.id);
    } catch (err) {
      return blockError(err, reply);
    }
  });

  // Flera lagerplatser per artikel (0186): the Lager tab's Lagerplatser card.
  // Served here, the article card's sub-resource like /articles/:id/suppliers
  // (purchase): reading is the module's office, writing is Artiklar or Lager
  // (articleCardWrite — every write under /articles lets artiklar through).
  app.get<{ Params: { id: string } }>("/articles/:id/locations", async (req, reply) => {
    try {
      return await service.getArticleLocations(req.params.id);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Batch (#8): saldo per batch on the article card's Lager tab — Okänd
  // first, then the oldest batch, each with its places. The module's read
  // rule (office); no prices.
  app.get<{ Params: { id: string } }>("/articles/:id/batch-balances", async (req, reply) => {
    try {
      return await service.getArticleBatchBalances(req.params.id);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.put<{ Params: { id: string } }>(
    "/articles/:id/locations",
    { config: { access: articleCardWrite(["lager"]) } },
    async (req, reply) => {
      const input = articleLocationsSchema.parse(req.body);
      try {
        return await service.setArticleLocations(req.params.id, input);
      } catch (err) {
        if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
        if (err instanceof ArticleLocationInvalidError) return reply.code(400).send(errorBody(err));
        throw err;
      }
    }
  );

  app.post("/stock/transactions", async (req, reply) => {
    const input = createStockAdjustmentSchema.parse(req.body);
    try {
      const row = await service.recordTransaction(input, req.user!.id);
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
      if (err instanceof ServiceArticleNotStockedError) return reply.code(400).send(errorBody(err));
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Lagerflytt — moves balances between locations and deactivates the source
  // when the move empties it. requireAuth has already run, so req.user is set.
  app.post("/stock/transfers", async (req, reply) => {
    const input = createStockTransferSchema.parse(req.body);
    try {
      const result = await service.transferStock(input, req.user!.id);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof StockLocationNotFoundError || err instanceof ArticleNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof InsufficientStockError) return reply.code(409).send(errorBody(err));
      if (err instanceof LocationUnderStockCountError) return reply.code(409).send(errorBody(err));
      if (err instanceof ServiceArticleNotStockedError) return reply.code(400).send(errorBody(err));
      if (err instanceof InactiveStockLocationError) {
        return reply.code(400).send(errorBody(err));
      }
      throw err;
    }
  });

  // Översikten's Lager station: articles with physical stock, in one query.
  app.get("/stock/summary", async () => service.getStockSummary());

  app.get("/stock/balances", async (req) => service.getBalances(listStockBalancesQuerySchema.parse(req.query)));

  // Batch (#8): saldo per cell (place, batch) for the BATCHSTYRDA among the
  // listed articles (at most 200), optionally on one place — the batch
  // choices of Utleverans, Förbruka, flytt and justering. Per article in the
  // order Automatiskt draws: Okänd first, then the oldest batch, within a
  // batch the places in pick-list order. Physical, with `blocked` as a flag.
  app.get("/stock/batch-balances", async (req) => {
    const query = listStockBatchBalancesQuerySchema.parse(req.query);
    return { rows: await service.pickBatchCellsForArticles(query.articleIds, { locationId: query.locationId }) };
  });

  // Spårbarhet (#8): the batch register (list pattern; search on the batch
  // number or the article) and one batch's trace backward and forward. The
  // module's read rule (office); no prices. An unknown batch is 404
  // stock-batch-not-found (batchErrorStatus in app.ts).
  app.get("/stock/batches", async (req) => service.listBatches(listStockBatchesQuerySchema.parse(req.query)));

  app.get<{ Params: { id: string } }>("/stock/batches/:id/trace", async (req) => service.traceBatch(req.params.id));

  registerListCsvRoute(app, {
    path: "/stock/balances/csv",
    querySchema: listStockBalancesQuerySchema,
    filenameBase: "lagersaldon",
    columns: stockBalanceExportColumns,
    fetch: (query) => service.getBalances(query),
  });

  // À-pris/värde are cost data (admin + ekonomi): nulled for everyone else,
  // same response shape. req.user is set by requireAuth.
  const maskCost = <R extends { unitCost: string | null; value: string | null }>(req: FastifyRequest, rows: R[]): R[] =>
    canSeeStockCost(req.user!) ? rows : rows.map((r) => ({ ...r, unitCost: null, value: null }));

  app.get("/stock/transactions", async (req) => {
    const result = await service.listTransactions(listStockTransactionsQuerySchema.parse(req.query));
    return { ...result, rows: maskCost(req, result.rows) };
  });

  registerListCsvRoute(app, {
    path: "/stock/transactions/csv",
    querySchema: listStockTransactionsQuerySchema,
    filenameBase: "lagertransaktioner",
    // Saldo only exists with an article filter — judged on the parsed query,
    // the same one the rows were fetched with.
    columns: (req, query) => stockTransactionColumns(canSeeStockCost(req.user!), query.articleId !== undefined),
    fetch: async (query) => service.listTransactions(query),
  });

  // --- Lagervärdering (D1) ---
  // Admin-only (unlike the plain-auth balance list above): a valuation
  // exposes cost data (standard price / purchase price / weighted average),
  // which belongs to the same economy-report audience as B6a's balance
  // sheet, not to every authenticated user.

  app.get("/stock/valuation", { preHandler: requireRole("admin") }, async (req) =>
    valuation.getValuation(valuationQuerySchema.parse(req.query))
  );

  app.get("/stock/valuation/pdf", { preHandler: requireRole("admin") }, async (req, reply) => {
    const query = valuationQuerySchema.parse(req.query);
    const { filename, content } = await valuation.getValuationPdf(query);
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", contentDisposition(filename));
    return reply.send(content);
  });

  // --- Inventering (D2) ---
  // Admin-only like valuation: posting differences is a bookkeeping-adjacent
  // action, and the count sheet exposes complete balance data.

  const admin = { preHandler: requireRole("admin") };

  app.post("/stock-counts", admin, async (req, reply) => {
    const input = createStockCountSchema.parse(req.body);
    try {
      const session = await counts.createSession(input, req.user!.id);
      return reply.code(201).send(session);
    } catch (err) {
      if (err instanceof StockLocationNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InactiveStockLocationError) return reply.code(400).send(errorBody(err));
      if (err instanceof StockCountAlreadyOpenError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get("/stock-counts", admin, async (req) =>
    counts.listSessions(listStockCountsQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/stock-counts/csv",
    preHandler: requireRole("admin"),
    querySchema: listStockCountsQuerySchema,
    filenameBase: "inventeringar",
    columns: stockCountExportColumns,
    fetch: (query) => counts.listSessions(query),
  });

  app.get<{ Params: { id: string } }>("/stock-counts/:id", admin, async (req, reply) => {
    try {
      return await counts.getSession(req.params.id);
    } catch (err) {
      if (err instanceof StockCountNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/stock-counts/:id/rows", admin, async (req, reply) => {
    const input = addStockCountRowSchema.parse(req.body);
    try {
      const row = await counts.addRow(req.params.id, input);
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof StockCountNotFoundError || err instanceof ArticleNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof StockCountNotOpenError || err instanceof DuplicateStockCountRowError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof ServiceArticleNotStockedError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>(
    "/stock-counts/:id/rows/:rowId",
    admin,
    async (req, reply) => {
      const input = updateStockCountRowSchema.parse(req.body);
      try {
        return await counts.updateRow(req.params.id, req.params.rowId, input);
      } catch (err) {
        if (err instanceof StockCountNotFoundError || err instanceof StockCountRowNotFoundError) {
          return reply.code(404).send(errorBody(err));
        }
        if (err instanceof StockCountNotOpenError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  app.delete<{ Params: { id: string; rowId: string } }>(
    "/stock-counts/:id/rows/:rowId",
    admin,
    async (req, reply) => {
      try {
        await counts.deleteRow(req.params.id, req.params.rowId);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof StockCountNotFoundError || err instanceof StockCountRowNotFoundError) {
          return reply.code(404).send(errorBody(err));
        }
        if (err instanceof StockCountNotOpenError) return reply.code(409).send(errorBody(err));
        throw err;
      }
    }
  );

  app.post<{ Params: { id: string } }>("/stock-counts/:id/post", admin, async (req, reply) => {
    // The body is optional (older callers post nothing) — {} = the default.
    const input = postStockCountSchema.parse(req.body ?? {});
    try {
      return await counts.postSession(req.params.id, req.user!.id, input.bookOn);
    } catch (err) {
      if (err instanceof StockCountNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof StockCountNotOpenError) return reply.code(409).send(errorBody(err));
      if (err instanceof StockCountBackdateRefusedError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/stock-counts/:id/cancel", admin, async (req, reply) => {
    try {
      return await counts.cancelSession(req.params.id, req.user!.id);
    } catch (err) {
      if (err instanceof StockCountNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof StockCountNotOpenError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/stock-counts/:id/pdf", admin, async (req, reply) => {
    const query = stockCountPdfQuerySchema.parse(req.query);
    try {
      const { filename, content } = await counts.getCountSheetPdf(req.params.id, query.showBalances);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      if (err instanceof StockCountNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });
}
