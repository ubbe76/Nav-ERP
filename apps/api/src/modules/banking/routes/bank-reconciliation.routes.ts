import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  autoMatchSchema,
  bankReconciliationQuerySchema,
  bankStatementImportFieldsSchema,
  bankStatementPreviewFieldsSchema,
  bookBankEntriesByRuleSchema,
  bookBankEntrySchema,
  createBankAccountSchema,
  createBankMatchSchema,
  createBankOpeningSchema,
  createBankReconciliationSchema,
  createBankRuleSchema,
  listBankAccountsQuerySchema,
  updateBankAccountSchema,
  updateBankRuleSchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { AccountingPeriodLockedError } from "../../economy/service/accounting-period-lock.js";
import { CostCenterInactiveError, CostCenterNotFoundError, ProjectClosedError, ProjectNotFoundError } from "../../economy/service/dimension-check.js";
import {
  AccountNotFoundError,
  InactiveAccountError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationSeriesNotFoundError,
} from "../../economy/service/economy.service.js";
import { errorBody } from "../../system/service/error-body.js";
import {
  BankAccountIdentifierLockedError,
  BankAccountIdentifierTakenError,
  BankAccountInUseError,
  BankAccountLedgerMissingError,
  BankAccountNotFoundError,
  BankAccountRequiredError,
  BankEntryBookMismatchError,
  BankFileParseError,
  BankMatchAlreadyMatchedError,
  BankMatchAlreadyUndoneError,
  BankMatchNotFoundError,
  BankMatchSumMismatchError,
  BankMatchWrongAccountError,
  BankOpeningBalanceMismatchError,
  BankOpeningNotAllowedError,
  BankReconciliationIncompleteError,
  BankRuleAccountMissingError,
  BankRuleAmbiguousError,
  BankRuleMissingError,
  BankRuleNotFoundError,
  BankStatementAccountMismatchError,
  BankStatementAccountUnknownError,
  BankStatementCsvMappingError,
  BankStatementCurrencyError,
  BankStatementEntryNotFoundError,
  BankStatementFormatError,
} from "../service/banking.errors.js";
import type { BankReconciliationService } from "../service/bank-reconciliation.service.js";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_TOO_LARGE = "Filen är större än 20 MB";

type Reply = { code: (n: number) => { send: (b: unknown) => unknown } };

function bankError(err: unknown, reply: Reply) {
  if (
    err instanceof BankAccountNotFoundError ||
    err instanceof BankStatementEntryNotFoundError ||
    err instanceof BankMatchNotFoundError ||
    err instanceof BankRuleNotFoundError ||
    err instanceof AccountNotFoundError ||
    err instanceof VerificationSeriesNotFoundError ||
    err instanceof CostCenterNotFoundError ||
    err instanceof ProjectNotFoundError
  ) {
    return reply.code(404).send(errorBody(err));
  }
  // Kostnadsställen och projekt: an inactive/closed object on a rule or a Bokför row.
  if (err instanceof CostCenterInactiveError || err instanceof ProjectClosedError) return reply.code(400).send(errorBody(err));
  if (
    err instanceof BankAccountIdentifierTakenError ||
    err instanceof BankMatchAlreadyMatchedError ||
    err instanceof BankMatchAlreadyUndoneError ||
    err instanceof BankRuleMissingError ||
    err instanceof AccountingPeriodLockedError ||
    err instanceof UnbalancedVerificationError ||
    err instanceof TooFewVerificationRowsError
  ) {
    return reply.code(409).send(errorBody(err));
  }
  if (err instanceof BankMatchSumMismatchError) return reply.code(409).send({ ...errorBody(err), entriesSum: err.entriesSum, rowsSum: err.rowsSum });
  if (err instanceof BankRuleAmbiguousError) return reply.code(409).send({ ...errorBody(err), ruleIds: err.ruleIds });
  if (err instanceof BankReconciliationIncompleteError) return reply.code(409).send({ ...errorBody(err), reason: err.reason, ...err.detail });
  if (err instanceof BankOpeningBalanceMismatchError) return reply.code(409).send({ ...errorBody(err), statementBalance: err.statementBalance, ledgerBalance: err.ledgerBalance });
  if (err instanceof BankOpeningNotAllowedError) return reply.code(409).send({ ...errorBody(err), reason: err.reason });
  if (err instanceof BankAccountInUseError) return reply.code(409).send({ ...errorBody(err), field: err.field });
  if (err instanceof BankAccountIdentifierLockedError) {
    return reply.code(409).send({ ...errorBody(err), accountName: err.accountName, identifier: err.identifier, fileIdentifier: err.fileIdentifier });
  }
  if (
    err instanceof BankAccountLedgerMissingError ||
    err instanceof BankAccountRequiredError ||
    err instanceof BankStatementFormatError ||
    err instanceof BankStatementCsvMappingError ||
    err instanceof BankStatementAccountUnknownError ||
    err instanceof BankStatementAccountMismatchError ||
    err instanceof BankStatementCurrencyError ||
    err instanceof BankMatchWrongAccountError ||
    err instanceof BankEntryBookMismatchError ||
    err instanceof BankRuleAccountMissingError ||
    err instanceof BankFileParseError ||
    err instanceof InactiveAccountError ||
    err instanceof NoFiscalYearForDateError ||
    err instanceof NoAccountingPeriodError
  ) {
    return reply.code(400).send(errorBody(err));
  }
  throw err;
}

function isFileTooLarge(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE";
}

// The whole multipart body: the file (`file`) and the text fields beside it
// in any order (req.parts() reads to the end — the manual bookkeeping
// routes' pattern).
async function readMultipart(req: FastifyRequest) {
  let file: { filename: string; contentType: string; data: Buffer; truncated: boolean } | null = null;
  const fields: Record<string, string> = {};
  try {
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE_BYTES } })) {
      if (part.type === "file") {
        if (part.fieldname === "file" && file === null) {
          const data = await part.toBuffer();
          file = { filename: part.filename, contentType: part.mimetype, data, truncated: part.file.truncated };
        } else {
          await part.toBuffer();
        }
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }
  } catch (err) {
    if (isFileTooLarge(err)) return { file: null, fields, tooLarge: true as const };
    throw err;
  }
  return { file, fields, tooLarge: file?.truncated === true };
}

// registerModule({ read: ["ekonomi"], write: ["ekonomi"] }) in app.ts — the
// whole reconciliation is the bookkeeper's (spec §5).
export async function bankReconciliationRoutes(app: FastifyInstance, opts: { service: BankReconciliationService }) {
  const { service } = opts;
  const ekonomi = { preHandler: requirePermission("ekonomi") };

  // --- Bankkonton ---
  // The first GET may seed the company account (and /bank-rules the
  // suggested rules) — not for an Endast läsning user, who writes nothing.
  const seeds = (req: FastifyRequest) => ({ seed: req.user?.readOnly !== true });
  app.get("/bank-accounts", ekonomi, async (req) => service.listAccounts(listBankAccountsQuerySchema.parse(req.query).includeInactive, seeds(req)));

  app.post("/bank-accounts", ekonomi, async (req, reply) => {
    const input = createBankAccountSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createAccount(input, req.user!.id));
    } catch (err) {
      return bankError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/bank-accounts/:id", ekonomi, async (req, reply) => {
    const input = updateBankAccountSchema.parse(req.body);
    try {
      return await service.updateAccount(req.params.id, input, req.user!.id);
    } catch (err) {
      return bankError(err, reply);
    }
  });

  // Startpunkt för avstämningen: the opening matching + the first mark.
  app.post<{ Params: { id: string } }>("/bank-accounts/:id/opening", ekonomi, async (req, reply) => {
    const input = createBankOpeningSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createOpening(req.params.id, input, req.user!.id));
    } catch (err) {
      return bankError(err, reply);
    }
  });

  // --- Kontoutdrag ---
  app.post("/bank-statements/preview", ekonomi, async (req, reply) => {
    const { file, fields, tooLarge } = await readMultipart(req);
    if (tooLarge) return reply.code(400).send(errorBody(new BankFileParseError(FILE_TOO_LARGE)));
    if (!file) return reply.code(400).send(errorBody(new BankFileParseError("Ingen fil bifogad")));
    const parsedFields = bankStatementPreviewFieldsSchema.parse(fields);
    try {
      return await service.preview({ data: file.data }, parsedFields);
    } catch (err) {
      return bankError(err, reply);
    }
  });

  app.post("/bank-statements/import", ekonomi, async (req, reply) => {
    const { file, fields, tooLarge } = await readMultipart(req);
    if (tooLarge) return reply.code(400).send(errorBody(new BankFileParseError(FILE_TOO_LARGE)));
    if (!file) return reply.code(400).send(errorBody(new BankFileParseError("Ingen fil bifogad")));
    const parsedFields = bankStatementImportFieldsSchema.parse(fields);
    try {
      return reply.code(201).send(await service.import({ filename: file.filename, contentType: file.contentType, data: file.data }, parsedFields, req.user!.id));
    } catch (err) {
      return bankError(err, reply);
    }
  });

  // --- Avstämningsvyn ---
  app.get("/bank-reconciliation", ekonomi, async (req, reply) => {
    const query = bankReconciliationQuerySchema.parse(req.query);
    try {
      return await service.reconciliationView(query);
    } catch (err) {
      return bankError(err, reply);
    }
  });

  // --- Matchning ---
  app.post("/bank-matches", ekonomi, async (req, reply) => {
    const input = createBankMatchSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createMatch(input, req.user!.id));
    } catch (err) {
      return bankError(err, reply);
    }
  });

  app.post("/bank-matches/auto", ekonomi, async (req, reply) => {
    const input = autoMatchSchema.parse(req.body);
    try {
      return await service.autoMatch(input, req.user!.id);
    } catch (err) {
      return bankError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/bank-matches/:id/undo", ekonomi, async (req, reply) => {
    try {
      return await service.undoMatch(req.params.id, req.user!.id);
    } catch (err) {
      return bankError(err, reply);
    }
  });

  // --- Bokföra en post ---
  app.post("/bank-statement-entries/book-by-rule", ekonomi, async (req, reply) => {
    const input = bookBankEntriesByRuleSchema.parse(req.body);
    try {
      return await service.bookByRule(input, req.user!.id);
    } catch (err) {
      return bankError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/bank-statement-entries/:id/book", ekonomi, async (req, reply) => {
    const input = bookBankEntrySchema.parse(req.body);
    try {
      return reply.code(201).send(await service.bookEntry(req.params.id, input, req.user!.id));
    } catch (err) {
      return bankError(err, reply);
    }
  });

  // --- Bankregler ---
  app.get("/bank-rules", ekonomi, async (req) => service.listRules(seeds(req)));

  app.post("/bank-rules", ekonomi, async (req, reply) => {
    const input = createBankRuleSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createRule(input, req.user!.id));
    } catch (err) {
      return bankError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/bank-rules/:id", ekonomi, async (req, reply) => {
    const input = updateBankRuleSchema.parse(req.body);
    try {
      return await service.updateRule(req.params.id, input, req.user!.id);
    } catch (err) {
      return bankError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/bank-rules/:id", ekonomi, async (req, reply) => {
    try {
      await service.deleteRule(req.params.id, req.user!.id);
      return reply.code(204).send();
    } catch (err) {
      return bankError(err, reply);
    }
  });

  // --- Avstämd t.o.m. ---
  app.post("/bank-reconciliations", ekonomi, async (req, reply) => {
    const input = createBankReconciliationSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createReconciliation(input, req.user!.id));
    } catch (err) {
      return bankError(err, reply);
    }
  });
}
