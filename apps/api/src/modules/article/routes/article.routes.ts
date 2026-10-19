import type { FastifyInstance } from "fastify";
import { SeriesExhaustedError } from "../../system/service/number-series.js";
import {
  createArticleDrawingSchema,
  createArticleGroupSchema,
  createArticleRevisionSchema,
  createArticleSchema,
  createArticleUnitSchema,
  batchUpdateArticlesSchema,
  createBomComponentSchema,
  createDrawingRevisionSchema,
  listArticlesQuerySchema,
  updateArticleDrawingSchema,
  updateArticleGroupSchema,
  updateArticleRevisionSchema,
  updateArticleSchema,
  updateArticleUnitSchema,
  updateBomComponentSchema,
  updateDrawingRevisionSchema,
  updateStandardCostSchema,
} from "@navet/shared";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { ConfiguratorModeNotAllowedError } from "../../configurator/service/configurator.errors.js";
import { canSeePrices, OVERVIEW_READ } from "../../auth/middleware/access-rules.js";
import { articleExportColumns } from "../service/export-columns.js";
import type { ArticleService } from "../service/article.service.js";
import {
  ArticleCopyPartNotAllowedError,
  ArticleDrawingNotFoundError,
  ArticleFileNotFoundError,
  ArticleGroupNotFoundError,
  ArticleRevisionNotFoundError,
  ArticleUnitInUseError,
  ArticleUnitNotFoundError,
  BaseUnitConflictError,
  BaseUnitLockedError,
  DuplicateArticleGroupError,
  DuplicateArticleUnitError,
  DuplicateDrawingNumberError,
  DuplicateRevisionError,
  ArticleNotFoundError,
  BomComponentNotFoundError,
  BomCycleError,
  CostingOnlyOperationLinkError,
  DuplicateArticleNumberError,
  DuplicateBomComponentError,
  InvalidFileTypeError,
  InvalidReferenceError,
  InvalidUnitError,
  RoutingOperationMismatchError,
  MAX_FILE_BYTES,
} from "../service/article.service.js";

export async function articleRoutes(app: FastifyInstance, opts: { service: ArticleService }) {
  const { service } = opts;

  app.get("/articles", { config: { access: OVERVIEW_READ } }, async (req) => {
    const page = await service.listArticles(listArticlesQuerySchema.parse(req.query));
    if (canSeePrices(req.user!)) return page;
    return { ...page, rows: page.rows.map((row) => ({ ...row, standardCost: null, salesPrice: null })) };
  });

  registerListCsvRoute(app, {
    path: "/articles/csv",
    querySchema: listArticlesQuerySchema,
    filenameBase: "artiklar",
    columns: articleExportColumns,
    fetch: (query) => service.listArticles(query),
  });

  app.get<{ Params: { id: string } }>("/articles/:id", async (req, reply) => {
    const article = await service.getArticle(req.params.id);
    if (!article) return reply.code(404).send({ error: "Article not found" });
    return article;
  });

  app.post("/articles", async (req, reply) => {
    const input = createArticleSchema.parse(req.body);
    try {
      const article = await service.createArticle(input);
      return reply.code(201).send(article);
    } catch (err) {
      if (err instanceof DuplicateArticleNumberError) return reply.code(409).send(errorBody(err));
      // The article number series kept colliding (or is full).
      if (err instanceof SeriesExhaustedError) return reply.code(409).send(errorBody(err));
      if (err instanceof InvalidReferenceError) return reply.code(400).send(errorBody(err));
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      if (err instanceof ArticleCopyPartNotAllowedError) return reply.code(400).send(errorBody(err));
      // Only reachable through copyFrom: the source article does not exist.
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // Artikelnummerserier for Ny artikel and the group register, each with
  // the number it would issue right now.
  app.get("/article-number-series", async () => service.listArticleNumberSeries());

  app.get("/article-groups", async () => service.listArticleGroups());

  app.post("/article-groups", async (req, reply) => {
    const input = createArticleGroupSchema.parse(req.body);
    try {
      const group = await service.createArticleGroup(input);
      return reply.code(201).send(group);
    } catch (err) {
      if (err instanceof DuplicateArticleGroupError) return reply.code(409).send(errorBody(err));
      if (err instanceof InvalidReferenceError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // Inline editing in the register. A static segment wins over /articles/:id in
  // find-my-way, so this is not swallowed (and rejectMalformedIds never sees
  // an :id). Per-row failures are 200 with ok: false, never a request error.
  app.patch("/articles/batch", async (req) => {
    const { rows } = batchUpdateArticlesSchema.parse(req.body);
    return service.updateArticlesBatch(rows);
  });

  app.patch<{ Params: { id: string } }>("/articles/:id", async (req, reply) => {
    const input = updateArticleSchema.parse(req.body);
    try {
      const article = await service.updateArticle(req.params.id, input);
      return article;
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicateArticleNumberError) return reply.code(409).send(errorBody(err));
      if (err instanceof BaseUnitLockedError) return reply.code(409).send(errorBody(err));
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      if (err instanceof InvalidReferenceError) return reply.code(400).send(errorBody(err));
      if (err instanceof ConfiguratorModeNotAllowedError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  // --- Alternative units (alternativa enheter) ---

  app.get<{ Params: { id: string } }>("/articles/:id/units", async (req, reply) => {
    try {
      return await service.listArticleUnits(req.params.id);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/articles/:id/units", async (req, reply) => {
    const input = createArticleUnitSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.addArticleUnit(req.params.id, input));
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      if (err instanceof BaseUnitConflictError) return reply.code(400).send(errorBody(err));
      if (err instanceof DuplicateArticleUnitError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/articles/:id/units/:rowId", async (req, reply) => {
    const input = updateArticleUnitSchema.parse(req.body);
    try {
      return await service.updateArticleUnit(req.params.id, req.params.rowId, input);
    } catch (err) {
      if (err instanceof ArticleUnitNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { id: string; rowId: string } }>("/articles/:id/units/:rowId", async (req, reply) => {
    try {
      await service.removeArticleUnit(req.params.id, req.params.rowId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ArticleUnitNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof ArticleUnitInUseError) return reply.code(409).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/article-groups/:id", async (req, reply) => {
    const input = updateArticleGroupSchema.parse(req.body);
    try {
      return await service.updateArticleGroup(req.params.id, input);
    } catch (err) {
      if (err instanceof ArticleGroupNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof DuplicateArticleGroupError) return reply.code(409).send(errorBody(err));
      if (err instanceof InvalidReferenceError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/articles/:id/standard-cost", async (req, reply) => {
    const input = updateStandardCostSchema.parse(req.body);
    try {
      const article = await service.updateStandardCost(req.params.id, input.standardCost);
      return article;
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // GET /articles/:id/bom lives in modules/oauth/routes/configurator.routes.ts —
  // reachable by both a human session and a scoped API client token.

  app.get<{ Params: { id: string } }>("/articles/:id/bom-tree", async (req, reply) => {
    try {
      return await service.getBomTree(req.params.id);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/articles/:id/bom", async (req, reply) => {
    const input = createBomComponentSchema.parse(req.body);
    try {
      const row = await service.addBomComponent(req.params.id, input);
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) {
        return reply.code(404).send(errorBody(err));
      }
      if (err instanceof BomCycleError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof DuplicateBomComponentError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof RoutingOperationMismatchError) {
        return reply.code(400).send(errorBody(err));
      }
      if (err instanceof CostingOnlyOperationLinkError) {
        return reply.code(409).send(errorBody(err));
      }
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.patch<{ Params: { id: string; rowId: string } }>("/articles/:id/bom/:rowId", async (req, reply) => {
    const input = updateBomComponentSchema.parse(req.body);
    try {
      return await service.updateBomComponent(req.params.id, req.params.rowId, input);
    } catch (err) {
      if (err instanceof BomComponentNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof RoutingOperationMismatchError) return reply.code(400).send(errorBody(err));
      if (err instanceof CostingOnlyOperationLinkError) return reply.code(409).send(errorBody(err));
      if (err instanceof InvalidUnitError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { id: string; rowId: string } }>("/articles/:id/bom/:rowId", async (req, reply) => {
    try {
      await service.removeBomComponent(req.params.id, req.params.rowId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof BomComponentNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // --- Attached files (ritningar): PDF/JPEG/PNG per article ---

  app.get<{ Params: { id: string } }>("/articles/:id/files", { config: { access: OVERVIEW_READ } }, async (req, reply) => {
    try {
      return await service.listFiles(req.params.id);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/articles/:id/files", async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_FILE_BYTES } });
    if (!file) return reply.code(400).send({ error: "No file provided" });
    const data = await file.toBuffer();
    // fastify-multipart truncates instead of throwing once the limit is hit.
    if (file.file.truncated) {
      return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    }
    try {
      const row = await service.addFile(req.params.id, {
        filename: file.filename,
        contentType: file.mimetype,
        data,
      });
      return reply.code(201).send(row);
    } catch (err) {
      if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
      if (err instanceof InvalidFileTypeError) return reply.code(400).send(errorBody(err));
      throw err;
    }
  });

  app.get<{ Params: { id: string; fileId: string } }>("/articles/:id/files/:fileId", { config: { access: OVERVIEW_READ } }, async (req, reply) => {
    try {
      const file = await service.downloadFile(req.params.id, req.params.fileId);
      reply.header("Content-Type", file.contentType);
      // inline: drawings open straight in the browser's viewer.
      reply.header("Content-Disposition", contentDisposition(file.filename, "inline"));
      return reply.send(file.data);
    } catch (err) {
      if (err instanceof ArticleFileNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  app.delete<{ Params: { id: string; fileId: string } }>("/articles/:id/files/:fileId", async (req, reply) => {
    try {
      await service.deleteFile(req.params.id, req.params.fileId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ArticleFileNotFoundError) return reply.code(404).send(errorBody(err));
      throw err;
    }
  });

  // --- Artikelrevisioner ---

  const revisionErrors = (err: unknown, reply: import("fastify").FastifyReply) => {
    if (err instanceof ArticleNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof ArticleDrawingNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof ArticleRevisionNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof DuplicateRevisionError) return reply.code(409).send(errorBody(err));
    if (err instanceof DuplicateDrawingNumberError) return reply.code(409).send(errorBody(err));
    throw err;
  };

  app.get<{ Params: { id: string } }>("/articles/:id/revisions", async (req, reply) => {
    try {
      return await service.listRevisions(req.params.id);
    } catch (err) {
      return revisionErrors(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/articles/:id/revisions", async (req, reply) => {
    const input = createArticleRevisionSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createRevision(req.params.id, input));
    } catch (err) {
      return revisionErrors(err, reply);
    }
  });

  app.patch<{ Params: { id: string; revisionId: string } }>(
    "/articles/:id/revisions/:revisionId",
    async (req, reply) => {
      const input = updateArticleRevisionSchema.parse(req.body);
      try {
        return await service.updateRevision(req.params.id, req.params.revisionId, input);
      } catch (err) {
        return revisionErrors(err, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; revisionId: string } }>(
    "/articles/:id/revisions/:revisionId",
    async (req, reply) => {
      try {
        await service.deleteRevision(req.params.id, req.params.revisionId);
        return reply.code(204).send();
      } catch (err) {
        return revisionErrors(err, reply);
      }
    }
  );

  // --- Ritningsnummer & ritningsrevisioner ---

  app.get<{ Params: { id: string } }>("/articles/:id/drawings", async (req, reply) => {
    try {
      return await service.listDrawings(req.params.id);
    } catch (err) {
      return revisionErrors(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/articles/:id/drawings", async (req, reply) => {
    const input = createArticleDrawingSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createDrawing(req.params.id, input));
    } catch (err) {
      return revisionErrors(err, reply);
    }
  });

  app.patch<{ Params: { id: string; drawingId: string } }>(
    "/articles/:id/drawings/:drawingId",
    async (req, reply) => {
      const input = updateArticleDrawingSchema.parse(req.body);
      try {
        return await service.updateDrawing(req.params.id, req.params.drawingId, input);
      } catch (err) {
        return revisionErrors(err, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; drawingId: string } }>(
    "/articles/:id/drawings/:drawingId",
    async (req, reply) => {
      try {
        await service.deleteDrawing(req.params.id, req.params.drawingId);
        return reply.code(204).send();
      } catch (err) {
        return revisionErrors(err, reply);
      }
    }
  );

  app.post<{ Params: { id: string; drawingId: string } }>(
    "/articles/:id/drawings/:drawingId/revisions",
    async (req, reply) => {
      const input = createDrawingRevisionSchema.parse(req.body);
      try {
        return reply.code(201).send(await service.createDrawingRevision(req.params.id, req.params.drawingId, input));
      } catch (err) {
        return revisionErrors(err, reply);
      }
    }
  );

  app.patch<{ Params: { id: string; drawingId: string; revisionId: string } }>(
    "/articles/:id/drawings/:drawingId/revisions/:revisionId",
    async (req, reply) => {
      const input = updateDrawingRevisionSchema.parse(req.body);
      try {
        return await service.updateDrawingRevision(req.params.id, req.params.drawingId, req.params.revisionId, input);
      } catch (err) {
        return revisionErrors(err, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; drawingId: string; revisionId: string } }>(
    "/articles/:id/drawings/:drawingId/revisions/:revisionId",
    async (req, reply) => {
      try {
        await service.deleteDrawingRevision(req.params.id, req.params.drawingId, req.params.revisionId);
        return reply.code(204).send();
      } catch (err) {
        return revisionErrors(err, reply);
      }
    }
  );
}
