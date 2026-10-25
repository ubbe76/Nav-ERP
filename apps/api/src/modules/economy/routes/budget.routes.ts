import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  budgetActualsQuerySchema,
  budgetCsvQuerySchema,
  copyBudgetSchema,
  createBudgetSchema,
  listBudgetsQuerySchema,
  replaceBudgetLinesSchema,
  updateBudgetSchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { ImportFileError } from "../../import/service/csv.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";
import { CostCenterNotFoundError } from "../service/dimension-check.js";
import { FiscalYearNotFoundError } from "../service/economy.service.js";
import {
  BudgetAccountInvalidError,
  BudgetDuplicateAccountError,
  BudgetMonthInvalidError,
  BudgetNameTakenError,
  BudgetNoPreviousYearError,
  BudgetNotFoundError,
  type BudgetService,
} from "../service/budget.service.js";

// Budget (bokföringsgranskningen etapp 5 del B). Registered with
// registerModule({ read: ekonomi, write: ekonomi }) in app.ts — the budget
// is management's planning data, not office data, so even the reads need
// Ekonomi. Each route keeps its own requirePermission("ekonomi") like
// economy.routes.ts so the guard also holds in mini-app tests.

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

// The CSV import: 20 MB like every other upload (see manual-bookkeeping
// routes for the FST_REQ_FILE_TOO_LARGE pitfall).
const MAX_CSV_BYTES = 20 * 1024 * 1024;

function isFileTooLarge(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE";
}

export async function budgetRoutes(app: FastifyInstance, opts: { service: BudgetService }) {
  const { service } = opts;
  const ekonomi = { preHandler: requirePermission("ekonomi") };

  function budgetError(err: unknown, reply: Reply) {
    if (err instanceof BudgetNotFoundError || err instanceof FiscalYearNotFoundError || err instanceof CostCenterNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof BudgetNameTakenError) return reply.code(409).send(errorBody(err));
    if (err instanceof BudgetAccountInvalidError) return reply.code(400).send({ ...errorBody(err), accounts: err.accounts });
    if (err instanceof BudgetMonthInvalidError || err instanceof BudgetDuplicateAccountError || err instanceof BudgetNoPreviousYearError) {
      return reply.code(400).send(errorBody(err));
    }
    if (err instanceof ImportFileError) return reply.code(400).send(errorBody(err));
    throw err;
  }

  app.get("/budgets", ekonomi, async (req) => service.list(listBudgetsQuerySchema.parse(req.query)));

  app.post("/budgets", ekonomi, async (req, reply) => {
    const input = createBudgetSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.create(input, req.user!.id));
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/budgets/:id", ekonomi, async (req, reply) => {
    try {
      return await service.get(req.params.id);
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/budgets/:id", ekonomi, async (req, reply) => {
    const input = updateBudgetSchema.parse(req.body);
    try {
      return await service.update(req.params.id, input, req.user!.id);
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/budgets/:id", ekonomi, async (req, reply) => {
    try {
      await service.delete(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  app.put<{ Params: { id: string } }>("/budgets/:id/lines", ekonomi, async (req, reply) => {
    const input = replaceBudgetLinesSchema.parse(req.body);
    try {
      return await service.replaceLines(req.params.id, input, req.user!.id);
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/budgets/:id/copy", ekonomi, async (req, reply) => {
    const input = copyBudgetSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.copy(req.params.id, input, req.user!.id));
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/budgets/:id/actuals", ekonomi, async (req, reply) => {
    const query = budgetActualsQuerySchema.parse(req.query);
    try {
      return await service.actuals(req.params.id, query);
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/budgets/:id/csv", ekonomi, async (req, reply) => {
    const query = budgetCsvQuerySchema.parse(req.query);
    try {
      const { filename, content } = await service.csv(req.params.id, query);
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return budgetError(err, reply);
    }
  });

  // Reads the multipart body's `file` part (the same loop as the SIE import).
  async function readFile(req: FastifyRequest): Promise<{ data: Buffer | null; tooLarge: boolean }> {
    let data: Buffer | null = null;
    let truncated = false;
    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_CSV_BYTES } })) {
        if (part.type !== "file") continue;
        const buffer = await part.toBuffer();
        if (part.fieldname === "file" && data === null) {
          data = buffer;
          truncated = part.file.truncated;
        }
      }
    } catch (err) {
      if (isFileTooLarge(err)) return { data: null, tooLarge: true };
      throw err;
    }
    return { data, tooLarge: truncated };
  }

  // Importera CSV — parses and answers, saves nothing; the web fills the
  // grid and Spara is the write. Deliberately NOT readOnlySafe: a read-only
  // account cannot save the result anyway.
  app.post<{ Params: { id: string } }>("/budgets/:id/csv/parse", ekonomi, async (req, reply) => {
    const { data, tooLarge } = await readFile(req);
    if (tooLarge) return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    if (!data) return reply.code(400).send({ error: "Ingen fil bifogad" });
    try {
      return await service.parseCsv(req.params.id, data);
    } catch (err) {
      return budgetError(err, reply);
    }
  });
}
