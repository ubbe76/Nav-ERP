import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createAllocationSchema,
  createRecurringVerificationSchema,
  createVerificationTemplateSchema,
  listVerificationTemplatesQuerySchema,
  replaceVerificationRowsSchema,
  saveVerificationTemplateSchema,
  sieVerificationImportFieldsSchema,
  updateRecurringVerificationSchema,
  updateVerificationTemplateSchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  AccountNotFoundError,
  AccountingPeriodLockedError,
  InactiveAccountError,
  InvalidVerificationStateError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationNotFoundError,
  VerificationSeriesNotFoundError,
  type EconomyService,
} from "../service/economy.service.js";
import {
  RecurringTemplateIncompleteError,
  RecurringVerificationNotFoundError,
  type RecurringVerificationService,
} from "../service/recurring-verification.service.js";
import { SieParseError } from "../service/sie-parse.js";
import {
  SieFileAlreadyImportedError,
  SieVerificationImportBlockedError,
  type SieVerificationImportService,
} from "../service/sie-verification-import.service.js";
import {
  VerificationTemplateAccountMissingError,
  VerificationTemplateInUseError,
  VerificationTemplateNameTakenError,
  VerificationTemplateNotFoundError,
  type VerificationTemplateService,
} from "../service/verification-template.service.js";

// Snabbare manuell bokföring (etapp 3): the row editor's save, Kopiera,
// verifikatmallar, återkommande verifikat with fördelning över perioder, and
// the SIE verification import. Registered with registerModule({ ekonomi })
// in app.ts; each route keeps its own requirePermission("ekonomi") like
// economy.routes.ts so the guard also holds in mini-app tests.

// 20 MB like every other upload; multipart truncates instead of throwing.
const MAX_SIE_FILE_BYTES = 20 * 1024 * 1024;

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

export async function manualBookkeepingRoutes(
  app: FastifyInstance,
  opts: {
    economy: EconomyService;
    templates: VerificationTemplateService;
    recurring: RecurringVerificationService;
    sieImport: SieVerificationImportService;
  }
) {
  const { economy, templates, recurring, sieImport } = opts;
  const ekonomi = { preHandler: requirePermission("ekonomi") };

  // Same mapping as economy.routes.ts's verificationError for the routes
  // that touch a verification.
  function verificationError(err: unknown, reply: Reply) {
    if (err instanceof VerificationNotFoundError || err instanceof AccountNotFoundError || err instanceof VerificationSeriesNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (
      err instanceof InvalidVerificationStateError ||
      err instanceof TooFewVerificationRowsError ||
      err instanceof UnbalancedVerificationError ||
      err instanceof AccountingPeriodLockedError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    if (err instanceof NoFiscalYearForDateError || err instanceof InactiveAccountError || err instanceof NoAccountingPeriodError) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  function templateError(err: unknown, reply: Reply) {
    if (err instanceof VerificationTemplateNotFoundError || err instanceof VerificationSeriesNotFoundError || err instanceof VerificationNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof VerificationTemplateNameTakenError || err instanceof VerificationTemplateInUseError) {
      return reply.code(409).send(errorBody(err));
    }
    if (err instanceof VerificationTemplateAccountMissingError) {
      return reply.code(400).send({ ...errorBody(err), accounts: err.accounts });
    }
    throw err;
  }

  function recurringError(err: unknown, reply: Reply) {
    if (
      err instanceof RecurringVerificationNotFoundError ||
      err instanceof VerificationTemplateNotFoundError ||
      err instanceof VerificationSeriesNotFoundError ||
      err instanceof VerificationNotFoundError
    ) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof RecurringTemplateIncompleteError || err instanceof InactiveAccountError) {
      return reply.code(400).send({ ...errorBody(err), reason: err.message });
    }
    if (err instanceof VerificationTemplateAccountMissingError) {
      return reply.code(400).send({ ...errorBody(err), accounts: err.accounts });
    }
    throw err;
  }

  // --- Verifikatrader i ett anrop, Kopiera, Spara som mall ---

  app.put<{ Params: { id: string } }>("/verifications/:id/rows", ekonomi, async (req, reply) => {
    const input = replaceVerificationRowsSchema.parse(req.body);
    try {
      return await economy.replaceRows(req.params.id, input.rows);
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/verifications/:id/copy", ekonomi, async (req, reply) => {
    try {
      return reply.code(201).send(await economy.copy(req.params.id, req.user!.id));
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/verifications/:id/template", ekonomi, async (req, reply) => {
    const input = saveVerificationTemplateSchema.parse(req.body);
    try {
      return reply.code(201).send(await templates.saveFromVerification(req.params.id, input.name, req.user!.id));
    } catch (err) {
      return templateError(err, reply);
    }
  });

  // --- Verifikatmallar ---

  app.get("/verification-templates", ekonomi, async (req) => {
    const query = listVerificationTemplatesQuerySchema.parse(req.query);
    return templates.list(query.includeInactive);
  });

  app.get<{ Params: { id: string } }>("/verification-templates/:id", ekonomi, async (req, reply) => {
    try {
      return await templates.findById(req.params.id);
    } catch (err) {
      return templateError(err, reply);
    }
  });

  app.post("/verification-templates", ekonomi, async (req, reply) => {
    const input = createVerificationTemplateSchema.parse(req.body);
    try {
      return reply.code(201).send(await templates.create(input, req.user!.id));
    } catch (err) {
      return templateError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/verification-templates/:id", ekonomi, async (req, reply) => {
    const input = updateVerificationTemplateSchema.parse(req.body);
    try {
      return await templates.update(req.params.id, input, req.user!.id);
    } catch (err) {
      return templateError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/verification-templates/:id", ekonomi, async (req, reply) => {
    try {
      await templates.delete(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return templateError(err, reply);
    }
  });

  // --- Återkommande verifikat ---

  app.get("/recurring-verifications", ekonomi, async () => recurring.list());

  // Before /:id so the literal path wins.
  app.post("/recurring-verifications/allocation", ekonomi, async (req, reply) => {
    const input = createAllocationSchema.parse(req.body);
    try {
      return reply.code(201).send(await recurring.createAllocation(input, req.user!.id));
    } catch (err) {
      return recurringError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/recurring-verifications/:id", ekonomi, async (req, reply) => {
    try {
      return await recurring.findById(req.params.id);
    } catch (err) {
      return recurringError(err, reply);
    }
  });

  app.post("/recurring-verifications", ekonomi, async (req, reply) => {
    const input = createRecurringVerificationSchema.parse(req.body);
    try {
      return reply.code(201).send(await recurring.create(input, req.user!.id));
    } catch (err) {
      return recurringError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/recurring-verifications/:id", ekonomi, async (req, reply) => {
    const input = updateRecurringVerificationSchema.parse(req.body);
    try {
      return await recurring.update(req.params.id, input, req.user!.id);
    } catch (err) {
      return recurringError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/recurring-verifications/:id", ekonomi, async (req, reply) => {
    try {
      await recurring.delete(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return recurringError(err, reply);
    }
  });

  // Kör nu — the same path as the job, this post only, failed months included.
  app.post<{ Params: { id: string } }>("/recurring-verifications/:id/run", ekonomi, async (req, reply) => {
    try {
      return await recurring.run(req.params.id, req.user!.id);
    } catch (err) {
      return recurringError(err, reply);
    }
  });

  // --- SIE-import av verifikat ---

  function sieError(err: unknown, reply: Reply) {
    if (err instanceof SieParseError) return reply.code(400).send(errorBody(err));
    if (err instanceof VerificationSeriesNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof SieFileAlreadyImportedError) {
      return reply.code(409).send({ ...errorBody(err), importedAt: err.importedAt, importedBy: err.importedBy });
    }
    if (err instanceof SieVerificationImportBlockedError) {
      return reply.code(409).send({ ...errorBody(err), blockers: err.blockers });
    }
    // A booking refusal the pre-checks did not foresee (a lock landing
    // mid-import) — the whole import rolled back.
    if (err instanceof AccountingPeriodLockedError || err instanceof UnbalancedVerificationError || err instanceof TooFewVerificationRowsError) {
      return reply.code(409).send({ ...errorBody(err), blockers: [err.message] });
    }
    if (err instanceof InactiveAccountError || err instanceof NoFiscalYearForDateError || err instanceof NoAccountingPeriodError) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  // The whole multipart body, in order: the file (`file`) and the text
  // fields beside it, whichever came first. req.parts() reads to the end,
  // unlike req.file(), whose `fields` only holds what preceded the file.
  async function readMultipart(req: FastifyRequest) {
    let file: { filename: string; data: Buffer; truncated: boolean } | null = null;
    const fields: Record<string, string> = {};
    for await (const part of req.parts({ limits: { fileSize: MAX_SIE_FILE_BYTES } })) {
      if (part.type === "file") {
        if (part.fieldname === "file" && file === null) {
          const data = await part.toBuffer();
          file = { filename: part.filename, data, truncated: part.file.truncated };
        } else {
          // Drain anything unexpected so the stream finishes.
          await part.toBuffer();
        }
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }
    return { file, fields };
  }

  app.post("/sie/verifications/preview", ekonomi, async (req, reply) => {
    const { file } = await readMultipart(req);
    if (!file) return reply.code(400).send({ error: "Ingen fil bifogad" });
    if (file.truncated) return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    try {
      return await sieImport.preview(file.data, file.filename);
    } catch (err) {
      return sieError(err, reply);
    }
  });

  app.post("/sie/verifications/import", ekonomi, async (req, reply) => {
    const { file, fields } = await readMultipart(req);
    if (!file) return reply.code(400).send({ error: "Ingen fil bifogad" });
    if (file.truncated) return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    // The options may also travel in the query string (seriesId, mode,
    // createMissingAccounts); a form field wins.
    const options = sieVerificationImportFieldsSchema.parse({ ...(req.query as Record<string, unknown>), ...fields });
    try {
      return reply.code(201).send(await sieImport.import(file.data, file.filename, options, req.user!.id));
    } catch (err) {
      return sieError(err, reply);
    }
  });
}
