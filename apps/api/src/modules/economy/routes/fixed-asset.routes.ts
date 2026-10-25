import type { FastifyInstance } from "fastify";
import {
  createFixedAssetCategorySchema,
  createFixedAssetSchema,
  depreciationRunQuerySchema,
  disposeFixedAssetSchema,
  fixedAssetPlanQuerySchema,
  listDepreciationRunsQuerySchema,
  listFixedAssetsQuerySchema,
  updateFixedAssetCategorySchema,
  updateFixedAssetSchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { AccountingPeriodLockedError } from "../service/accounting-period-lock.js";
import { AccountNotFoundError, AlreadyReversedError, InactiveAccountError } from "../service/economy.service.js";
import { CostCenterInactiveError, CostCenterNotFoundError } from "../service/dimension-check.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  ZeroAmountPostingError,
} from "../service/verification-poster.js";
import {
  DepreciationMonthInFutureError,
  DepreciationRunNotFoundError,
  DepreciationRunNotLatestError,
  DisposalRunNotUndoableError,
  DuplicateFixedAssetCategoryNameError,
  FixedAssetBasAccountMissingError,
  FixedAssetCategoryAccountsLockedError,
  FixedAssetCategoryAccountsNotDistinctError,
  FixedAssetCategoryInUseError,
  FixedAssetCategoryNotFoundError,
  FixedAssetFieldLockedError,
  FixedAssetHasDepreciationError,
  FixedAssetLifeTooShortError,
  FixedAssetNotActiveError,
  FixedAssetNotFoundError,
  FixedAssetPlanYearNotFoundError,
  InvalidDisposalDateError,
  InvalidFixedAssetValuesError,
  InvalidOpeningDepreciationError,
  NothingToDepreciateError,
  RunPrecedesDisposalError,
  SupplierInvoiceNotFoundError,
  type FixedAssetService,
} from "../service/fixed-asset.service.js";

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

// Anläggningsregister. Registered through registerModule with the Ekonomi
// rule in app.ts; every route ALSO carries requirePermission("ekonomi") so
// the guard holds in mini-app tests that register this plugin directly
// (same convention as economy.routes.ts).
export async function fixedAssetRoutes(app: FastifyInstance, opts: { service: FixedAssetService }) {
  const { service } = opts;
  const ekonomi = { preHandler: requirePermission("ekonomi") };

  function categoryError(err: unknown, reply: Reply) {
    if (err instanceof FixedAssetCategoryNotFoundError || err instanceof AccountNotFoundError || err instanceof CostCenterNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof InactiveAccountError || err instanceof FixedAssetCategoryAccountsNotDistinctError || err instanceof CostCenterInactiveError) {
      return reply.code(400).send(errorBody(err));
    }
    if (
      err instanceof DuplicateFixedAssetCategoryNameError ||
      err instanceof FixedAssetCategoryInUseError ||
      err instanceof FixedAssetCategoryAccountsLockedError ||
      err instanceof FixedAssetBasAccountMissingError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    throw err;
  }

  app.get("/fixed-asset-categories", ekonomi, async () => service.listCategories());

  app.post("/fixed-asset-categories", ekonomi, async (req, reply) => {
    const input = createFixedAssetCategorySchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createCategory(input));
    } catch (err) {
      return categoryError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/fixed-asset-categories/:id", ekonomi, async (req, reply) => {
    const input = updateFixedAssetCategorySchema.parse(req.body);
    try {
      return await service.updateCategory(req.params.id, input);
    } catch (err) {
      return categoryError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/fixed-asset-categories/:id", ekonomi, async (req, reply) => {
    try {
      await service.deleteCategory(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return categoryError(err, reply);
    }
  });

  app.post("/fixed-asset-categories/generate-bas", ekonomi, async (_req, reply) => {
    try {
      return await service.seedBasCategories();
    } catch (err) {
      return categoryError(err, reply);
    }
  });

  function assetError(err: unknown, reply: Reply) {
    if (
      err instanceof FixedAssetNotFoundError ||
      err instanceof FixedAssetCategoryNotFoundError ||
      err instanceof SupplierInvoiceNotFoundError ||
      err instanceof AccountNotFoundError
    ) {
      return reply.code(404).send(errorBody(err));
    }
    if (
      err instanceof InvalidFixedAssetValuesError ||
      err instanceof InvalidOpeningDepreciationError ||
      err instanceof InvalidDisposalDateError ||
      err instanceof InactiveAccountError
    ) {
      return reply.code(400).send(errorBody(err));
    }
    if (
      err instanceof FixedAssetFieldLockedError ||
      err instanceof FixedAssetLifeTooShortError ||
      err instanceof FixedAssetNotActiveError ||
      err instanceof FixedAssetHasDepreciationError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    throw err;
  }

  app.get("/fixed-assets", ekonomi, async (req) => service.listAssets(listFixedAssetsQuerySchema.parse(req.query)));

  app.post("/fixed-assets", ekonomi, async (req, reply) => {
    const input = createFixedAssetSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createAsset(input, req.user!.id));
    } catch (err) {
      return assetError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/fixed-assets/:id", ekonomi, async (req, reply) => {
    try {
      return await service.getAsset(req.params.id);
    } catch (err) {
      return assetError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/fixed-assets/:id", ekonomi, async (req, reply) => {
    const input = updateFixedAssetSchema.parse(req.body);
    try {
      return await service.updateAsset(req.params.id, input, req.user!.id);
    } catch (err) {
      return assetError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/fixed-assets/:id", ekonomi, async (req, reply) => {
    try {
      await service.deleteAsset(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return assetError(err, reply);
    }
  });

  // --- Avskrivningskörningar ---

  function runError(err: unknown, reply: Reply) {
    if (err instanceof DepreciationRunNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof DepreciationMonthInFutureError || err instanceof NoAccountingPeriodForPostingError) {
      return reply.code(400).send(errorBody(err));
    }
    if (
      err instanceof NothingToDepreciateError ||
      err instanceof AccountingPeriodLockedError ||
      err instanceof MissingPostingAccountError ||
      err instanceof ZeroAmountPostingError ||
      err instanceof DepreciationRunNotLatestError ||
      err instanceof DisposalRunNotUndoableError ||
      err instanceof RunPrecedesDisposalError ||
      err instanceof AlreadyReversedError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    throw err;
  }

  app.get("/fixed-asset-depreciation-runs", ekonomi, async (req) =>
    service.listRuns(listDepreciationRunsQuerySchema.parse(req.query))
  );

  app.get("/fixed-asset-depreciation-runs/preview", ekonomi, async (req) =>
    service.previewDepreciation(depreciationRunQuerySchema.parse(req.query))
  );

  app.post("/fixed-asset-depreciation-runs", ekonomi, async (req, reply) => {
    const input = depreciationRunQuerySchema.parse(req.body);
    try {
      return reply.code(201).send(await service.bookDepreciation(input, req.user!.id));
    } catch (err) {
      return runError(err, reply);
    }
  });

  app.post<{ Params: { runId: string } }>("/fixed-asset-depreciation-runs/:runId/undo", ekonomi, async (req, reply) => {
    try {
      return await service.undoRun(req.params.runId, req.user!.id);
    } catch (err) {
      return runError(err, reply);
    }
  });

  // --- Avyttring ---

  // A disposal is an asset transition AND a (catch-up) run, so it can raise
  // either family of errors.
  function disposalError(err: unknown, reply: Reply) {
    try {
      return assetError(err, reply);
    } catch (unhandled) {
      return runError(unhandled, reply);
    }
  }

  app.get<{ Params: { id: string } }>("/fixed-assets/:id/disposal-preview", ekonomi, async (req, reply) => {
    const input = disposeFixedAssetSchema.parse(req.query);
    try {
      return await service.disposalPreview(req.params.id, input);
    } catch (err) {
      return disposalError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/fixed-assets/:id/dispose", ekonomi, async (req, reply) => {
    const input = disposeFixedAssetSchema.parse(req.body);
    try {
      return await service.disposeAsset(req.params.id, input, req.user!.id);
    } catch (err) {
      return disposalError(err, reply);
    }
  });

  // --- Avskrivningsplan ---

  function planError(err: unknown, reply: Reply) {
    if (err instanceof FixedAssetPlanYearNotFoundError) return reply.code(404).send(errorBody(err));
    throw err;
  }

  app.get("/fixed-asset-plan", ekonomi, async (req, reply) => {
    const query = fixedAssetPlanQuerySchema.parse(req.query);
    try {
      return await service.getPlan(query);
    } catch (err) {
      return planError(err, reply);
    }
  });

  app.get("/fixed-asset-plan/pdf", ekonomi, async (req, reply) => {
    const query = fixedAssetPlanQuerySchema.parse(req.query);
    try {
      const { filename, content } = await service.getPlanPdf(query);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return planError(err, reply);
    }
  });

  app.get("/fixed-asset-plan/csv", ekonomi, async (req, reply) => {
    const query = fixedAssetPlanQuerySchema.parse(req.query);
    try {
      const { filename, content } = await service.getPlanCsv(query);
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return planError(err, reply);
    }
  });
}
