import type { FastifyInstance } from "fastify";
import {
  bookAccrualsSchema,
  bookFxRevaluationSchema,
  bookInventorySchema,
  fxRevaluationPreviewQuerySchema,
  inventoryPreviewQuerySchema,
  listYearEndClosingsQuerySchema,
  profitDispositionSchema,
  reopenYearEndClosingSchema,
  startYearEndClosingSchema,
  updateYearEndClosingSchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { errorBody } from "../../system/service/error-body.js";
import { AccountingPeriodLockedError } from "../service/accounting-period-lock.js";
import { AccountNotFoundError, FiscalYearNotFoundError, InactiveAccountError } from "../service/economy.service.js";
import { DepreciationMonthInFutureError } from "../service/fixed-asset.service.js";
import { MissingPostingAccountError, NoAccountingPeriodForPostingError, ZeroAmountPostingError } from "../service/verification-poster.js";
import {
  ClosingDateLockedError,
  FxRevaluationRateMissingError,
  InvalidAccrualAccountError,
  InvalidAgmDateError,
  InvalidClosingDateError,
  InventoryAccountConflictError,
  NextFiscalYearClosedError,
  NextFiscalYearMissingError,
  NothingToDisposeError,
  ProfitDispositionActiveError,
  ProfitDispositionExistsError,
  ProfitDispositionNotFoundError,
  YearEndBlockedError,
  YearEndClosingClosedError,
  YearEndClosingExistsError,
  YearEndClosingNotClosedError,
  YearEndClosingNotFoundError,
  YearEndStepOrderError,
  type YearEndClosingService,
} from "../service/year-end-closing.service.js";

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };
type ErrorClass = new (...args: never[]) => Error;

// One mapping for every route; later tasks add their error classes here.
const NOT_FOUND: ErrorClass[] = [ProfitDispositionNotFoundError, YearEndClosingNotFoundError, FiscalYearNotFoundError, AccountNotFoundError];
const BAD_REQUEST: ErrorClass[] = [
  InvalidAgmDateError,
  InvalidClosingDateError,
  InactiveAccountError,
  NoAccountingPeriodForPostingError,
  InvalidAccrualAccountError,
  DepreciationMonthInFutureError,
];
const CONFLICT: ErrorClass[] = [
  YearEndClosingExistsError,
  ClosingDateLockedError,
  YearEndClosingClosedError,
  YearEndBlockedError,
  AccountingPeriodLockedError,
  MissingPostingAccountError,
  ZeroAmountPostingError,
  InventoryAccountConflictError,
  NextFiscalYearMissingError,
  YearEndStepOrderError,
  YearEndClosingNotClosedError,
  NextFiscalYearClosedError,
  ProfitDispositionActiveError,
  ProfitDispositionExistsError,
  NothingToDisposeError,
];

function closingError(err: unknown, reply: Reply) {
  if (!(err instanceof Error)) throw err;
  // Valutaomvärdering: which currencies need a rate, for which day.
  if (err instanceof FxRevaluationRateMissingError) {
    return reply.code(409).send({ ...errorBody(err), currencies: err.currencies, date: err.date });
  }
  if (NOT_FOUND.some((type) => err instanceof type)) return reply.code(404).send(errorBody(err));
  if (BAD_REQUEST.some((type) => err instanceof type)) return reply.code(400).send(errorBody(err));
  if (CONFLICT.some((type) => err instanceof type)) return reply.code(409).send(errorBody(err));
  throw err;
}

// Årsbokslut. Registered through registerModule with the Ekonomi rule in
// app.ts; every route ALSO carries requirePermission("ekonomi") so the guard
// holds in mini-app tests (economy.routes.ts convention).
export async function yearEndRoutes(app: FastifyInstance, opts: { service: YearEndClosingService }) {
  const { service } = opts;
  const ekonomi = { preHandler: requirePermission("ekonomi") };

  app.get("/year-end-closings", ekonomi, async (req) => service.listClosings(listYearEndClosingsQuerySchema.parse(req.query)));

  app.post("/year-end-closings", ekonomi, async (req, reply) => {
    const input = startYearEndClosingSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.startClosing(input, req.user!.id));
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/year-end-closings/:id", ekonomi, async (req, reply) => {
    try {
      return await service.getClosing(req.params.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/year-end-closings/:id", ekonomi, async (req, reply) => {
    const { closingDate } = updateYearEndClosingSchema.parse(req.body);
    try {
      return await service.updateClosingDate(req.params.id, closingDate, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/year-end-closings/:id/inventory-preview", ekonomi, async (req, reply) => {
    const { method } = inventoryPreviewQuerySchema.parse(req.query);
    try {
      return await service.previewInventory(req.params.id, method);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/year-end-closings/:id/inventory", ekonomi, async (req, reply) => {
    const input = bookInventorySchema.parse(req.body);
    try {
      return await service.bookInventory(req.params.id, input, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/year-end-closings/:id/depreciation", ekonomi, async (req, reply) => {
    try {
      return await service.bookDepreciation(req.params.id, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.put<{ Params: { id: string } }>("/year-end-closings/:id/accruals", ekonomi, async (req, reply) => {
    const input = bookAccrualsSchema.parse(req.body);
    try {
      return await service.bookAccruals(req.params.id, input, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  // Valutaomvärdering: the preview at ?rates=EUR:11.2,USD:10.15 (default: the
  // live booking's rate, else Valutakurser for the closing date) and the
  // booking with `rates` in the body winning the same way.
  app.get<{ Params: { id: string } }>("/year-end-closings/:id/fx-revaluation-preview", ekonomi, async (req, reply) => {
    const { rates } = fxRevaluationPreviewQuerySchema.parse(req.query);
    try {
      return await service.previewFxRevaluation(req.params.id, rates);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/year-end-closings/:id/fx-revaluation", ekonomi, async (req, reply) => {
    const input = bookFxRevaluationSchema.parse(req.body ?? {});
    try {
      return await service.bookFxRevaluation(req.params.id, input, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/year-end-closings/:id/result-transfer-preview", ekonomi, async (req, reply) => {
    try {
      return await service.previewResultTransfer(req.params.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/year-end-closings/:id/result-transfer", ekonomi, async (req, reply) => {
    try {
      return await service.bookResultTransfer(req.params.id, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  // FiscalYearClosedError (the year closed outside the guide) is an
  // AccountingPeriodLockedError and already maps to 409 above.
  app.post<{ Params: { id: string } }>("/year-end-closings/:id/close", ekonomi, async (req, reply) => {
    try {
      return await service.closeYear(req.params.id, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/year-end-closings/:id/reopen", ekonomi, async (req, reply) => {
    const { reason } = reopenYearEndClosingSchema.parse(req.body);
    try {
      return await service.reopenYear(req.params.id, reason, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/year-end-closings/:id/profit-disposition-preview", ekonomi, async (req, reply) => {
    const input = profitDispositionSchema.parse(req.query);
    try {
      return await service.previewProfitDisposition(req.params.id, input);
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/year-end-closings/:id/profit-disposition", ekonomi, async (req, reply) => {
    const input = profitDispositionSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.bookProfitDisposition(req.params.id, input, req.user!.id));
    } catch (err) {
      return closingError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/year-end-closings/:id/profit-disposition/undo", ekonomi, async (req, reply) => {
    try {
      return await service.undoProfitDisposition(req.params.id, req.user!.id);
    } catch (err) {
      return closingError(err, reply);
    }
  });
}
