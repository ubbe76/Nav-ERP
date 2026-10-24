import type { FastifyInstance } from "fastify";
import {
  createAccountSchema,
  createFiscalYearSchema,
  createPostingRuleSchema,
  createVerificationSchema,
  createVerificationSeriesSchema,
  balanceSheetQuerySchema,
  generalLedgerQuerySchema,
  incomeStatementQuerySchema,
  verificationListReportQuerySchema,
  sieExportQuerySchema,
  sieImportQuerySchema,
  ledgerQuerySchema,
  listAccountsQuerySchema,
  listVerificationsQuerySchema,
  settleVatReportSchema,
  unlockPeriodSchema,
  updateAccountSchema,
  updatePostingRuleSchema,
  updateVerificationSchema,
  updateVerificationSeriesSchema,
  updateVatCodeSchema,
  updateVatReportingSettingsSchema,
  importVatSchema,
  periodicSummaryQuerySchema,
  vatReportQuerySchema,
  verificationRowInputSchema,
} from "@navet/shared";
import { requirePermission } from "../../auth/middleware/permission.middleware.js";
import { registerListCsvRoute } from "../../system/routes/csv-export.js";
import { accountExportColumns, verificationExportColumns } from "../service/export-columns.js";
import type { EconomyService } from "../service/economy.service.js";
import {
  AccountNotFoundError,
  AccountingPeriodLockedError,
  AccountingPeriodNotFoundError,
  AlreadyReversedError,
  ArticleGroupNotFoundError,
  DuplicateAccountNumberError,
  DuplicateFiscalYearLabelError,
  DuplicatePostingRuleError,
  DuplicateVerificationSeriesError,
  FiscalYearClosedError,
  FiscalYearNotFoundError,
  FixedAssetVerificationError,
  InactiveAccountError,
  InvalidVerificationStateError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  OverlappingFiscalYearError,
  FiscalYearBeforeClosedYearError,
  PeriodAlreadyLockedError,
  PeriodNotLockedError,
  PostingRuleNoAccountsError,
  PostingRuleNotFoundError,
  PostingRuleVatCodeError,
  VatCodeNotFoundError,
  SeriesCodeLockedError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationNotFoundError,
  VerificationFileNotFoundError,
  VerificationFileLockedError,
  InvalidVerificationFileTypeError,
  MAX_VERIFICATION_FILE_BYTES,
  VerificationRowNotFoundError,
  VerificationSeriesNotFoundError,
  YearEndClosingVerificationError,
} from "../service/economy.service.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
  VatCodeAccountConflictError,
  VatCodeNotApplicableError,
  ZeroAmountPostingError,
} from "../service/verification-poster.js";
import {
  VatAccountsNotDistinctError,
  VatFileOrgNumberMissingError,
  VatPeriodAlreadySettledError,
  VatPeriodNotCoveredError,
  type VatReportService,
} from "../service/vat-report.service.js";
import {
  ImportVatCodeError,
  VatCodeAccountInvalidError,
  VatCodeSlotNotUsedError,
  type VatCodeService,
} from "../service/vat-code.service.js";
import {
  ReportFiscalYearNotFoundError,
  type FinancialReportsService,
} from "../service/financial-reports.service.js";
import {
  SieAlreadyImportedError,
  SieFiscalYearMismatchError,
  SieFiscalYearNotFoundError,
  SiePriorBookkeepingError,
  SieUnbalancedError,
  type SieService,
} from "../service/sie.service.js";
import { SieParseError } from "../service/sie-parse.js";
import {
  PeriodicSummaryEmptyError,
  PeriodicSummaryReporterIncompleteError,
  type PeriodicSummaryService,
} from "../service/periodic-summary.service.js";
import { PeriodicSummaryPeriodInvalidError } from "../service/periodic-summary.js";
import { PeriodicSummaryAmountTooLargeError } from "../service/periodic-summary-file.js";
import { contentDisposition } from "../../system/service/content-disposition.js";
import { errorBody } from "../../system/service/error-body.js";

// Registered inside app.ts's protected route scope, so requireAuth has
// already run. Unlike the payroll/register modules' GETs, EVERY route here —
// including reads — requires the Ekonomi permission (behörighetsgrupper; the
// admin role always has it): the kontoplan is accounting configuration, not a
// day-to-day operational register. Each route keeps its own
// requirePermission("ekonomi") on top of app.ts's module rule so the guard
// also holds in mini-app tests that register this plugin directly.
export async function economyRoutes(
  app: FastifyInstance,
  opts: {
    service: EconomyService;
    vatReport: VatReportService;
    reports: FinancialReportsService;
    sie: SieService;
    vatCodes: VatCodeService;
    periodicSummary: PeriodicSummaryService;
  }
) {
  const { service, vatReport, reports, sie, vatCodes, periodicSummary } = opts;

  // Shared error mapper: 404 for a missing account, 409 for a duplicate
  // number (same shape as supplier-invoice.routes.ts's invoiceError).
  function accountError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof AccountNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof DuplicateAccountNumberError) return reply.code(409).send(errorBody(err));
    throw err;
  }

  app.get("/accounts", { preHandler: requirePermission("ekonomi") }, async (req) =>
    service.listAccounts(listAccountsQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/accounts/csv",
    preHandler: requirePermission("ekonomi"),
    querySchema: listAccountsQuerySchema,
    filenameBase: "kontoplan",
    columns: accountExportColumns,
    fetch: (query) => service.listAccounts(query),
  });

  // DELIBERATE EXCEPTION to this module's Ekonomi-only rule, and the only one:
  // B3's payment form needs a betalkonto dropdown, and the payment routes are
  // open to office users (Försäljning/Inköp register payments). What leaks is the number and
  // name of the ACTIVE accounts — the kontoplan's labels, which are BAS
  // standard and carry no amounts, no balances and no configuration. Every
  // other read here still requires Ekonomi, and nothing about this endpoint
  // lets a non-admin change an account. Takes no parameters, so there is no
  // shared zod schema for it. config.access overrides app.ts's Ekonomi module
  // rule with the office read every other module's GETs have.
  app.get("/account-options", { config: { access: ["office"] } }, async () => service.listAccountOptions());

  app.post("/accounts", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = createAccountSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createAccount(input));
    } catch (err) {
      return accountError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/accounts/:id",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      const input = updateAccountSchema.parse(req.body);
      try {
        return await service.updateAccount(req.params.id, input);
      } catch (err) {
        return accountError(err, reply);
      }
    }
  );

  // Idempotent pre-fill with the BAS standard chart of accounts.
  app.post("/accounts/generate-bas", { preHandler: requirePermission("ekonomi") }, async () => service.seedBasAccounts());

  // Räkenskapsår & periods — same admin-only audience as the kontoplan.
  // Shared error mapper: 404 for a missing year/period, 409 for an
  // overlapping year, a reused label, or a lock/unlock that fails its
  // repo-level status guard.
  function fiscalYearError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof FiscalYearNotFoundError || err instanceof AccountingPeriodNotFoundError) {
      return reply.code(404).send(errorBody(err));
    }
    if (
      err instanceof FiscalYearClosedError ||
      err instanceof OverlappingFiscalYearError ||
      err instanceof FiscalYearBeforeClosedYearError ||
      err instanceof DuplicateFiscalYearLabelError ||
      err instanceof PeriodAlreadyLockedError ||
      err instanceof PeriodNotLockedError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    throw err;
  }

  app.get("/fiscal-years", { preHandler: requirePermission("ekonomi") }, async () => service.listFiscalYears());

  app.post("/fiscal-years", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = createFiscalYearSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createFiscalYear(input));
    } catch (err) {
      return fiscalYearError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/fiscal-years/:id", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    try {
      return await service.findFiscalYearById(req.params.id);
    } catch (err) {
      return fiscalYearError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/accounting-periods/:id/lock",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      try {
        return await service.lockPeriod(req.params.id, req.user!.id);
      } catch (err) {
        return fiscalYearError(err, reply);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/accounting-periods/:id/unlock",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      const { reason } = unlockPeriodSchema.parse(req.body);
      try {
        return await service.unlockPeriod(req.params.id, reason, req.user!.id);
      } catch (err) {
        return fiscalYearError(err, reply);
      }
    }
  );

  // Verifikatserier — same admin-only audience as the kontoplan. Shared
  // error mapper: 404 for a missing series, 409 for a duplicate code or a
  // code change attempted on a series that already has verifications.
  function seriesError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof VerificationSeriesNotFoundError) return reply.code(404).send(errorBody(err));
    if (err instanceof DuplicateVerificationSeriesError || err instanceof SeriesCodeLockedError) {
      return reply.code(409).send(errorBody(err));
    }
    throw err;
  }

  app.get("/verification-series", { preHandler: requirePermission("ekonomi") }, async () => service.listSeries());

  app.post("/verification-series", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = createVerificationSeriesSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createSeries(input));
    } catch (err) {
      return seriesError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/verification-series/:id",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      const input = updateVerificationSeriesSchema.parse(req.body);
      try {
        return await service.updateSeries(req.params.id, input);
      } catch (err) {
        return seriesError(err, reply);
      }
    }
  );

  // Verifikat — same admin-only audience as the kontoplan. Shared error
  // mapper: 404 for a missing verification/row/account/series, 409 for a
  // draft-status violation or a booking guard on the verification's own
  // state (too few rows, unbalanced, locked period, already reversed —
  // same "can't complete this transition" bucket as the invoice module's
  // EmptyInvoiceError/OverInvoicingError), 400 for a date with no covering
  // fiscal year/accounting period or an inactive account (zod's own XOR
  // refine is caught by the global ZodError handler in app.ts, also 400).
  function verificationError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof VerificationNotFoundError ||
      err instanceof VerificationFileNotFoundError ||
      err instanceof VerificationRowNotFoundError ||
      err instanceof AccountNotFoundError ||
      err instanceof VerificationSeriesNotFoundError
    ) {
      return reply.code(404).send(errorBody(err));
    }
    if (
      err instanceof InvalidVerificationStateError ||
      err instanceof TooFewVerificationRowsError ||
      err instanceof UnbalancedVerificationError ||
      err instanceof AccountingPeriodLockedError ||
      err instanceof AlreadyReversedError ||
      err instanceof FixedAssetVerificationError ||
      err instanceof YearEndClosingVerificationError ||
      err instanceof VerificationFileLockedError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    if (err instanceof InvalidVerificationFileTypeError) {
      return reply.code(400).send(errorBody(err));
    }
    if (
      err instanceof NoFiscalYearForDateError ||
      err instanceof InactiveAccountError ||
      err instanceof NoAccountingPeriodError
    ) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  app.get("/verifications", { preHandler: requirePermission("ekonomi") }, async (req) =>
    service.listVerifications(listVerificationsQuerySchema.parse(req.query))
  );

  registerListCsvRoute(app, {
    path: "/verifications/csv",
    preHandler: requirePermission("ekonomi"),
    querySchema: listVerificationsQuerySchema,
    filenameBase: "verifikat",
    columns: verificationExportColumns,
    fetch: (query) => service.listVerifications(query),
  });

  app.post("/verifications", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = createVerificationSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createVerification(input, req.user!.id));
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.get<{ Params: { id: string } }>("/verifications/:id", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    try {
      return await service.findVerificationById(req.params.id);
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/verifications/:id", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = updateVerificationSchema.parse(req.body);
    try {
      return await service.updateVerificationHeader(req.params.id, input);
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>("/verifications/:id", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    try {
      await service.deleteVerification(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/verifications/:id/rows",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      const input = verificationRowInputSchema.parse(req.body);
      try {
        return reply.code(201).send(await service.addRow(req.params.id, input));
      } catch (err) {
        return verificationError(err, reply);
      }
    }
  );

  app.patch<{ Params: { id: string; rowId: string } }>(
    "/verifications/:id/rows/:rowId",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      const input = verificationRowInputSchema.parse(req.body);
      try {
        return await service.updateRow(req.params.id, req.params.rowId, input);
      } catch (err) {
        return verificationError(err, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; rowId: string } }>(
    "/verifications/:id/rows/:rowId",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      try {
        await service.deleteRow(req.params.id, req.params.rowId);
        return reply.code(204).send();
      } catch (err) {
        return verificationError(err, reply);
      }
    }
  );

  // --- Underlag (kvitto, kontoutdrag, avtal): PDF/JPEG/PNG per verifikat ---

  app.get<{ Params: { id: string } }>("/verifications/:id/files", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    try {
      return await service.listFiles(req.params.id);
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.post<{ Params: { id: string } }>("/verifications/:id/files", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const file = await req.file({ limits: { fileSize: MAX_VERIFICATION_FILE_BYTES } });
    if (!file) return reply.code(400).send({ error: "No file provided" });
    const data = await file.toBuffer();
    // fastify-multipart truncates instead of throwing once the limit is hit.
    if (file.file.truncated) return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    try {
      const row = await service.addFile(
        req.params.id,
        { filename: file.filename, contentType: file.mimetype, data },
        req.user!.id
      );
      return reply.code(201).send(row);
    } catch (err) {
      return verificationError(err, reply);
    }
  });

  app.get<{ Params: { id: string; fileId: string } }>(
    "/verifications/:id/files/:fileId",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      try {
        const file = await service.downloadFile(req.params.id, req.params.fileId);
        reply.header("Content-Type", file.contentType);
        reply.header("Content-Disposition", contentDisposition(file.filename, "inline"));
        return reply.send(file.data);
      } catch (err) {
        return verificationError(err, reply);
      }
    }
  );

  app.delete<{ Params: { id: string; fileId: string } }>(
    "/verifications/:id/files/:fileId",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      try {
        await service.deleteFile(req.params.id, req.params.fileId, req.user!.id);
        return reply.code(204).send();
      } catch (err) {
        return verificationError(err, reply);
      }
    }
  );

  // draft -> booked, the commitment point (Bokför).
  app.post<{ Params: { id: string } }>(
    "/verifications/:id/book",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      try {
        return await service.book(req.params.id, req.user!.id);
      } catch (err) {
        return verificationError(err, reply);
      }
    }
  );

  // booked -> new mirrored draft (Omför) — 201, same convention as the
  // other verification-creating route above.
  app.post<{ Params: { id: string } }>(
    "/verifications/:id/reverse",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      try {
        return reply.code(201).send(await service.reverse(req.params.id, req.user!.id));
      } catch (err) {
        return verificationError(err, reply);
      }
    }
  );

  // Huvudbok (general ledger) — pure aggregation over booked verifications,
  // never stored. A missing account maps to 404 through the same
  // accountError mapper used by the kontoplan routes above.
  app.get("/ledger", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = ledgerQuerySchema.parse(req.query);
    try {
      return await service.getLedger(query);
    } catch (err) {
      return accountError(err, reply);
    }
  });

  // Konteringsregler (B2 automatkontering) — same admin-only audience as the
  // rest of this module. Shared error mapper: 404 for a missing rule/group/
  // account, 409 for a duplicate (group, vatRate) combination, 400 for an
  // inactive account or a PATCH whose MERGED result would leave both
  // revenue/cost accounts unset (PostingRuleNoAccountsError — the zod
  // refine alone can't see the stored row, see economy.service.ts).
  function postingRuleError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (
      err instanceof PostingRuleNotFoundError ||
      err instanceof ArticleGroupNotFoundError ||
      err instanceof AccountNotFoundError ||
      err instanceof VatCodeNotFoundError
    ) {
      return reply.code(404).send(errorBody(err));
    }
    if (err instanceof DuplicatePostingRuleError) return reply.code(409).send(errorBody(err));
    if (
      err instanceof InactiveAccountError ||
      err instanceof PostingRuleNoAccountsError ||
      err instanceof PostingRuleVatCodeError
    ) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  app.get("/posting-rules", { preHandler: requirePermission("ekonomi") }, async () => service.listPostingRules());

  app.post("/posting-rules", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = createPostingRuleSchema.parse(req.body);
    try {
      return reply.code(201).send(await service.createPostingRule(input));
    } catch (err) {
      return postingRuleError(err, reply);
    }
  });

  app.patch<{ Params: { id: string } }>("/posting-rules/:id", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = updatePostingRuleSchema.parse(req.body);
    try {
      return await service.updatePostingRule(req.params.id, input);
    } catch (err) {
      return postingRuleError(err, reply);
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/posting-rules/:id",
    { preHandler: requirePermission("ekonomi") },
    async (req, reply) => {
      try {
        await service.deletePostingRule(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return postingRuleError(err, reply);
      }
    }
  );

  // --- Momskoder ---
  // The list is read by the invoice card and the supplier invoice dialog as
  // well, so it is open to every office user like /account-options (the
  // codes' account numbers are BAS labels, no amounts); editing and the
  // importmoms posting need Ekonomi.

  function vatCodeError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof VatCodeNotFoundError) return reply.code(404).send(errorBody(err));
    if (
      err instanceof VatCodeSlotNotUsedError ||
      err instanceof VatCodeAccountInvalidError ||
      err instanceof VatCodeAccountConflictError
    ) {
      return reply.code(400).send(errorBody(err));
    }
    throw err;
  }

  app.get("/vat-codes", { config: { access: ["office"] } }, async () => vatCodes.list());

  app.patch<{ Params: { id: string } }>("/vat-codes/:id", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = updateVatCodeSchema.parse(req.body);
    try {
      return await vatCodes.update(req.params.id, input, req.user!.id);
    } catch (err) {
      return vatCodeError(err, reply);
    }
  });

  // Importmoms (tullbeslutet) → one IM verification. 400 for a row whose
  // code is not an active import code or a date outside every period, 409
  // for a locked period/closed year, a missing account or two roles on one
  // account.
  app.post("/import-vat", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = importVatSchema.parse(req.body);
    try {
      return reply.code(201).send(await vatCodes.postImportVat(input, req.user!.id));
    } catch (err) {
      if (err instanceof ImportVatCodeError || err instanceof NoAccountingPeriodForPostingError) {
        return reply.code(400).send(errorBody(err as Error));
      }
      if (
        err instanceof AccountingPeriodLockedError ||
        err instanceof MissingPostingAccountError ||
        err instanceof VatCodeAccountConflictError ||
        err instanceof VatCodeNotApplicableError ||
        err instanceof ZeroAmountPostingError
      ) {
        return reply.code(409).send(errorBody(err));
      }
      throw err;
    }
  });

  // Redovisningsperiod för moms + the periodisk sammanställning's contact:
  // read by every office user (the report page's default period), written
  // with Ekonomi.
  app.get("/settings/vat-reporting", { config: { access: ["office"] } }, async () => vatReport.getReportingSettings());

  app.patch("/settings/vat-reporting", { preHandler: requirePermission("ekonomi") }, async (req) => {
    const input = updateVatReportingSettingsSchema.parse(req.body);
    return vatReport.updateReportingSettings(input, req.user!.id);
  });

  // --- Momsrapport (B5) ---

  // 400 for a range the periods don't cover (client sent a bad range), 409
  // for everything that is a state/configuration conflict: an active
  // momsomföring already covering the range, a settlement account carrying
  // an emptied box, a locked end month, an empty period, a missing/inactive
  // posting account, no organisationsnummer for the file.
  function vatReportError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof VatPeriodNotCoveredError || err instanceof NoAccountingPeriodForPostingError) {
      return reply.code(400).send(errorBody(err));
    }
    if (
      err instanceof VatPeriodAlreadySettledError ||
      err instanceof VatAccountsNotDistinctError ||
      err instanceof AccountingPeriodLockedError ||
      err instanceof ZeroAmountPostingError ||
      err instanceof MissingPostingAccountError ||
      err instanceof VatFileOrgNumberMissingError
    ) {
      return reply.code(409).send(errorBody(err));
    }
    throw err;
  }

  app.get("/vat-report", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = vatReportQuerySchema.parse(req.query);
    try {
      return await vatReport.getReport(query);
    } catch (err) {
      return vatReportError(err, reply);
    }
  });

  // Skatteverket's file (eSKDUpload 6.0) for exactly the range the report
  // shows, ISO-8859-1.
  app.get("/vat-report/file", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = vatReportQuerySchema.parse(req.query);
    try {
      const { filename, content } = await vatReport.getFile(query);
      reply.header("Content-Type", "application/xml; charset=ISO-8859-1");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return vatReportError(err, reply);
    }
  });

  app.post("/vat-report/settle", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const input = settleVatReportSchema.parse(req.body);
    try {
      return reply.code(201).send(await vatReport.settle(input, req.user!.id));
    } catch (err) {
      return vatReportError(err, reply);
    }
  });

  // --- Periodisk sammanställning (Momskoder steg 3) ---
  // 400 for a range that is not one calendar month or quarter and for an
  // amount the file cannot carry, 409 when there is nothing to submit or the
  // reporter's details are missing (body.missing lists them).
  function periodicSummaryError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof PeriodicSummaryPeriodInvalidError || err instanceof PeriodicSummaryAmountTooLargeError) {
      return reply.code(400).send(errorBody(err));
    }
    if (err instanceof PeriodicSummaryReporterIncompleteError) {
      return reply.code(409).send({ ...errorBody(err), missing: err.missing });
    }
    if (err instanceof PeriodicSummaryEmptyError) return reply.code(409).send(errorBody(err));
    throw err;
  }

  app.get("/periodic-summary", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = periodicSummaryQuerySchema.parse(req.query);
    try {
      return await periodicSummary.getSummary(query);
    } catch (err) {
      return periodicSummaryError(err, reply);
    }
  });

  // Skatteverket's file (SKV 574008), ISO-8859-1 with CRLF.
  app.get("/periodic-summary/file", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = periodicSummaryQuerySchema.parse(req.query);
    try {
      const { filename, content } = await periodicSummary.getFile(query);
      reply.header("Content-Type", "text/plain; charset=ISO-8859-1");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return periodicSummaryError(err, reply);
    }
  });

  // --- Ekonomirapporter (B6a) ---
  // These endpoints only read: there is no transaction, no posting and no
  // locking, so the only domain failure is a date outside every fiscal year.

  function reportError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof ReportFiscalYearNotFoundError) return reply.code(400).send(errorBody(err));
    throw err;
  }

  async function sendPdf(
    reply: Parameters<typeof reportError>[1] & {
      header: (k: string, v: string) => unknown;
      send: (b: unknown) => unknown;
    },
    produce: () => Promise<{ filename: string; content: Buffer }>
  ) {
    try {
      const { filename, content } = await produce();
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return reportError(err, reply);
    }
  }

  // F2: CSV sibling of sendPdf — same shape, text/csv instead of a PDF buffer.
  async function sendCsv(
    reply: Parameters<typeof reportError>[1] & {
      header: (k: string, v: string) => unknown;
      send: (b: unknown) => unknown;
    },
    produce: () => Promise<{ filename: string; content: string }>
  ) {
    try {
      const { filename, content } = await produce();
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return reportError(err, reply);
    }
  }

  app.get("/balance-sheet", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = balanceSheetQuerySchema.parse(req.query);
    try {
      return await reports.getBalanceSheet(query);
    } catch (err) {
      return reportError(err, reply);
    }
  });

  app.get("/balance-sheet/pdf", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = balanceSheetQuerySchema.parse(req.query);
    return sendPdf(reply, () => reports.getBalanceSheetPdf(query));
  });

  app.get("/balance-sheet/csv", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = balanceSheetQuerySchema.parse(req.query);
    return sendCsv(reply, () => reports.getBalanceSheetCsv(query));
  });

  app.get("/income-statement", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = incomeStatementQuerySchema.parse(req.query);
    try {
      return await reports.getIncomeStatement(query);
    } catch (err) {
      return reportError(err, reply);
    }
  });

  app.get("/income-statement/pdf", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = incomeStatementQuerySchema.parse(req.query);
    return sendPdf(reply, () => reports.getIncomeStatementPdf(query));
  });

  app.get("/income-statement/csv", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = incomeStatementQuerySchema.parse(req.query);
    return sendCsv(reply, () => reports.getIncomeStatementCsv(query));
  });

  app.get("/general-ledger", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = generalLedgerQuerySchema.parse(req.query);
    try {
      return await reports.getGeneralLedger(query);
    } catch (err) {
      return reportError(err, reply);
    }
  });

  app.get("/general-ledger/pdf", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = generalLedgerQuerySchema.parse(req.query);
    return sendPdf(reply, () => reports.getGeneralLedgerPdf(query));
  });

  app.get("/general-ledger/csv", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = generalLedgerQuerySchema.parse(req.query);
    return sendCsv(reply, () => reports.getGeneralLedgerCsv(query));
  });

  // Verifikatlista (B6a) — the JSON GET was missing; only the PDF was wired.
  // Mirrors the PDF route's query schema and admin guard exactly.
  app.get("/verification-list", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = verificationListReportQuerySchema.parse(req.query);
    try {
      return await reports.getVerificationList(query);
    } catch (err) {
      return reportError(err, reply);
    }
  });

  app.get("/verification-list/pdf", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = verificationListReportQuerySchema.parse(req.query);
    return sendPdf(reply, () => reports.getVerificationListPdf(query));
  });

  app.get("/verification-list/csv", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = verificationListReportQuerySchema.parse(req.query);
    return sendCsv(reply, () => reports.getVerificationListCsv(query));
  });

  // --- SIE (B6b) ---

  function sieError(err: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    if (err instanceof SieFiscalYearNotFoundError) return reply.code(404).send(errorBody(err));
    // Everything the user can fix by picking another file or another year.
    if (
      err instanceof SieParseError ||
      err instanceof SieFiscalYearMismatchError ||
      err instanceof SieUnbalancedError
    ) {
      return reply.code(400).send(errorBody(err));
    }
    // State conflicts: already imported, or the ledger already carries the
    // balances forward.
    if (err instanceof SieAlreadyImportedError || err instanceof SiePriorBookkeepingError) {
      return reply.code(409).send(errorBody(err));
    }
    if (err instanceof AccountingPeriodLockedError || err instanceof NoAccountingPeriodForPostingError) {
      return reply.code(409).send(errorBody(err));
    }
    throw err;
  }

  app.get("/sie/export", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = sieExportQuerySchema.parse(req.query);
    try {
      const { filename, content } = await sie.exportFiscalYear(query.fiscalYearId, req.user!.name);
      // SIE has no registered MIME type; octet-stream keeps browsers from
      // trying to render or re-encode it.
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", contentDisposition(filename));
      return reply.send(content);
    } catch (err) {
      return sieError(err, reply);
    }
  });

  app.post("/sie/opening-balances", { preHandler: requirePermission("ekonomi") }, async (req, reply) => {
    const query = sieImportQuerySchema.parse(req.query);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "Ingen fil bifogad" });
    const data = await file.toBuffer();
    // Multipart truncates rather than throwing at the app's 20 MB limit — a
    // half-read SIE file must never be imported.
    if (file.file.truncated) return reply.code(400).send({ error: "Filen är för stor — max 20 MB" });
    try {
      return reply.code(201).send(await sie.importOpeningBalances(query.fiscalYearId, data, req.user!.id));
    } catch (err) {
      return sieError(err, reply);
    }
  });
}
