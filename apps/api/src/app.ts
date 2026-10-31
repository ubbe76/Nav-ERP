import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import Fastify from "fastify";
import { ZodError } from "zod";
import { eq } from "drizzle-orm";
import { customers, db, type Db } from "@navet/db";
import type { PriceQuoteQuery } from "@navet/shared";
import { createArticleRepository, insertArticle } from "./modules/article/repository/article.repository.js";
import { insertBomRows } from "./modules/article/repository/bom-write.js";
import { createArticleService } from "./modules/article/service/article.service.js";
import { articleRoutes } from "./modules/article/routes/article.routes.js";
import { createAuthRepository } from "./modules/auth/repository/auth.repository.js";
import { createAuthService } from "./modules/auth/service/auth.service.js";
import { createUserSettingsRepository } from "./modules/auth/repository/user-settings.repository.js";
import { createUserSettingsService } from "./modules/auth/service/user-settings.service.js";
import { authRoutes, type CredentialThrottles } from "./modules/auth/routes/auth.routes.js";
import { createLoginThrottle } from "./modules/auth/service/login-throttle.js";
import { createSetupCode } from "./modules/auth/service/setup-code.js";
import { createPermissionGroupRepository } from "./modules/auth/repository/permission-group.repository.js";
import { createPermissionGroupService } from "./modules/auth/service/permission-group.service.js";
import { permissionGroupRoutes } from "./modules/auth/routes/permission-group.routes.js";
import { requireAuth } from "./modules/auth/middleware/auth.middleware.js";
import { rejectMalformedIds } from "./modules/system/middleware/reject-malformed-ids.js";
import {
  enforceAccess,
  registerModule,
  type ModuleAccess,
} from "./modules/auth/middleware/permission.middleware.js";
import { createCostingRepository } from "./modules/costing/repository/costing.repository.js";
import { createCostingService } from "./modules/costing/service/costing.service.js";
import { costingRoutes } from "./modules/costing/routes/costing.routes.js";
import { createImportRepository } from "./modules/import/repository/import.repository.js";
import { createImportService } from "./modules/import/service/import.service.js";
import { importRoutes } from "./modules/import/routes/import.routes.js";
import { createEconomyRepository } from "./modules/economy/repository/economy.repository.js";
import { createEconomyService } from "./modules/economy/service/economy.service.js";
import { createVerificationPoster } from "./modules/economy/service/verification-poster.js";
import { createVatReportService } from "./modules/economy/service/vat-report.service.js";
import { createPeriodicSummaryService } from "./modules/economy/service/periodic-summary.service.js";
import { createVatCodeService } from "./modules/economy/service/vat-code.service.js";
import { createFinancialReportsService } from "./modules/economy/service/financial-reports.service.js";
import { createSieService } from "./modules/economy/service/sie.service.js";
import { createVerificationTemplateRepository } from "./modules/economy/repository/verification-template.repository.js";
import { createVerificationTemplateService } from "./modules/economy/service/verification-template.service.js";
import { createRecurringVerificationRepository } from "./modules/economy/repository/recurring-verification.repository.js";
import { createRecurringVerificationService } from "./modules/economy/service/recurring-verification.service.js";
import { createSieVerificationImportService } from "./modules/economy/service/sie-verification-import.service.js";
import { manualBookkeepingRoutes } from "./modules/economy/routes/manual-bookkeeping.routes.js";
import { economyRoutes } from "./modules/economy/routes/economy.routes.js";
import { createDimensionRepository } from "./modules/economy/repository/dimension.repository.js";
import { createDimensionService } from "./modules/economy/service/dimension.service.js";
import { dimensionRoutes } from "./modules/economy/routes/dimension.routes.js";
import { createBudgetRepository } from "./modules/economy/repository/budget.repository.js";
import { createBudgetService } from "./modules/economy/service/budget.service.js";
import { budgetRoutes } from "./modules/economy/routes/budget.routes.js";
import { createProjectReportRepository } from "./modules/reports/repository/project-report.repository.js";
import { createProjectReportService } from "./modules/reports/service/project-report.service.js";
import { createFixedAssetService } from "./modules/economy/service/fixed-asset.service.js";
import { createYearEndClosingService } from "./modules/economy/service/year-end-closing.service.js";
import { fixedAssetRoutes } from "./modules/economy/routes/fixed-asset.routes.js";
import { yearEndRoutes } from "./modules/economy/routes/year-end.routes.js";
import { createMailRepository } from "./modules/mail/repository/mail.repository.js";
import { createMailService } from "./modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "./modules/mail/service/document-pdf.js";
import { mailRoutes } from "./modules/mail/routes/mail.routes.js";
import { createManufacturingRepository } from "./modules/manufacturing/repository/manufacturing.repository.js";
import { insertRoutingOperations } from "./modules/manufacturing/repository/routing-write.js";
import { createManufacturingService } from "./modules/manufacturing/service/manufacturing.service.js";
import { manufacturingRoutes } from "./modules/manufacturing/routes/manufacturing.routes.js";
import { createOAuthRepository } from "./modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "./modules/oauth/service/oauth.service.js";
import { requireAuthOrClient } from "./modules/oauth/middleware/oauth.middleware.js";
import { oauthRoutes } from "./modules/oauth/routes/oauth.routes.js";
import { apiClientRoutes } from "./modules/oauth/routes/api-client.routes.js";
import { configuratorRoutes } from "./modules/oauth/routes/configurator.routes.js";
import {
  createPayrollRepository,
  upsertOvertimeDispositionInTx,
} from "./modules/payroll/repository/payroll.repository.js";
import { createPlanningRepository } from "./modules/planning/repository/planning.repository.js";
import { createReportsRepository } from "./modules/reports/repository/reports.repository.js";
import { createReportsService } from "./modules/reports/service/reports.service.js";
import { reportsRoutes } from "./modules/reports/routes/reports.routes.js";
import { createOrderRegisterService } from "./modules/reports/service/order-register.service.js";
import { createOrderRegisterRepository } from "./modules/reports/repository/order-register.repository.js";
import { createQuoteFollowupService } from "./modules/reports/service/quote-followup.service.js";
import { createQuoteFollowupRepository } from "./modules/reports/repository/quote-followup.repository.js";
import { createPlanningService, type ManufacturingPlanReader } from "./modules/planning/service/planning.service.js";
import { planningRoutes } from "./modules/planning/routes/planning.routes.js";
import { createPayrollService } from "./modules/payroll/service/payroll.service.js";
import { createPeriodLockChecker } from "./modules/payroll/service/period-lock.js";
import { payrollRoutes } from "./modules/payroll/routes/payroll.routes.js";
import { createPurchaseRepository } from "./modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "./modules/purchase/service/purchase.service.js";
import { purchaseRoutes } from "./modules/purchase/routes/purchase.routes.js";
import { createSupplierInvoiceRepository } from "./modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "./modules/purchase/service/supplier-invoice.service.js";
import { supplierInvoiceRoutes } from "./modules/purchase/routes/supplier-invoice.routes.js";
import { createInvoiceScanRepository } from "./modules/purchase/repository/invoice-scan.repository.js";
import { createInvoiceScanService } from "./modules/purchase/service/invoice-scan.service.js";
import { createInvoiceScanSettingsService } from "./modules/purchase/service/invoice-scan-settings.service.js";
import { createInvoiceScanMailService } from "./modules/purchase/service/invoice-scan-mail.service.js";
import { invoiceScanRoutes } from "./modules/purchase/routes/invoice-scan.routes.js";
import type { InvoiceInterpreterFactory } from "./modules/purchase/service/invoice-scan/invoice-interpreter.js";
import type { InvoiceMailboxFactory } from "./modules/purchase/service/invoice-scan/invoice-mailbox.js";
import { createSupplierPaymentRepository } from "./modules/purchase/repository/supplier-payment.repository.js";
import { payableForeignItemsAsOf, payablesTotalAsOf } from "./modules/purchase/repository/open-amounts.js";
import { createSupplierPaymentService } from "./modules/purchase/service/supplier-payment.service.js";
import { createBankSettingsRepository } from "./modules/banking/repository/bank-settings.repository.js";
import { bankSettingsRoutes } from "./modules/banking/routes/bank-settings.routes.js";
import { createBankSettingsService } from "./modules/banking/service/bank-settings.service.js";
import { createPaymentBatchRepository } from "./modules/banking/repository/payment-batch.repository.js";
import { paymentBatchRoutes } from "./modules/banking/routes/payment-batch.routes.js";
import { createPaymentBatchService } from "./modules/banking/service/payment-batch.service.js";
import { createBankFileRepository } from "./modules/banking/repository/bank-file.repository.js";
import { bankFileRoutes } from "./modules/banking/routes/bank-file.routes.js";
import { createBankFileService } from "./modules/banking/service/bank-file.service.js";
import { createBankReconciliationRepository } from "./modules/banking/repository/bank-reconciliation.repository.js";
import { bankReconciliationRoutes } from "./modules/banking/routes/bank-reconciliation.routes.js";
import { createBankReconciliationService } from "./modules/banking/service/bank-reconciliation.service.js";
import { supplierPaymentRoutes } from "./modules/purchase/routes/supplier-payment.routes.js";
import { createRegisterRepository } from "./modules/register/repository/register.repository.js";
import { createRegisterService } from "./modules/register/service/register.service.js";
import { registerRoutes } from "./modules/register/routes/register.routes.js";
import { createSalesRepository } from "./modules/sales/repository/sales.repository.js";
import { createSalesService, type RowConfigurationReader } from "./modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "./modules/sales/service/production-transition.js";
import { salesRoutes } from "./modules/sales/routes/sales.routes.js";
import { resolvePrice, type VariantPriceReader } from "./modules/sales/service/price-resolver.js";
import { configuratorRoutes as templateConfiguratorRoutes } from "./modules/configurator/routes/configurator.routes.js";
import { publicConfiguratorRoutes } from "./modules/configurator/routes/public-configurator.routes.js";
import { createConfiguratorService, type ConfiguredStructureReader } from "./modules/configurator/service/configurator.service.js";
import { createInvoiceRepository } from "./modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "./modules/sales/service/invoice.service.js";
import { invoiceRoutes } from "./modules/sales/routes/invoice.routes.js";
import { createLateInterestService } from "./modules/sales/service/late-interest.service.js";
import { lateInterestRoutes } from "./modules/sales/routes/late-interest.routes.js";
import { createPaymentRepository } from "./modules/sales/repository/payment.repository.js";
import { receivableForeignItemsAsOf, receivablesTotalAsOf } from "./modules/sales/repository/open-amounts.js";
import { createPaymentService } from "./modules/sales/service/payment.service.js";
import { paymentRoutes } from "./modules/sales/routes/payment.routes.js";
import { createShippingRepository } from "./modules/shipping/repository/shipping.repository.js";
import { createFreightQuoteService } from "./modules/shipping/service/freight-quote.service.js";
import { createFreightSettingsService } from "./modules/shipping/service/freight-settings.service.js";
import { createShippingService } from "./modules/shipping/service/shipping.service.js";
import { createTrackingService } from "./modules/shipping/service/tracking.service.js";
import { shippingRoutes } from "./modules/shipping/routes/shipping.routes.js";
import { createEinvoiceRepository } from "./modules/einvoice/repository/einvoice.repository.js";
import { createEinvoiceSettingsService } from "./modules/einvoice/service/einvoice-settings.service.js";
import { createEinvoiceService } from "./modules/einvoice/service/einvoice.service.js";
import { createEinvoiceStatusService } from "./modules/einvoice/service/einvoice-status.service.js";
import { einvoiceRoutes } from "./modules/einvoice/routes/einvoice.routes.js";
import { createStockRepository } from "./modules/stock/repository/stock.repository.js";
import { createStockService } from "./modules/stock/service/stock.service.js";
import { createValuationService } from "./modules/stock/service/valuation.service.js";
import { createStockCountRepository } from "./modules/stock/repository/stock-count.repository.js";
import { createStockCountService } from "./modules/stock/service/stock-count.service.js";
import { stockRoutes } from "./modules/stock/routes/stock.routes.js";
import { scanRoutes } from "./modules/scan/routes/scan.routes.js";
import { createScanRepository } from "./modules/scan/repository/scan.repository.js";
import { createScanService } from "./modules/scan/service/scan.service.js";
import { createAuditRepository } from "./modules/system/repository/audit.repository.js";
import { createSystemRepository } from "./modules/system/repository/system.repository.js";
import { createSystemService } from "./modules/system/service/system.service.js";
import { readPostingSettings } from "./modules/system/service/posting-settings.js";
import { systemRoutes } from "./modules/system/routes/system.routes.js";
import { createExchangeRateService } from "./modules/system/service/exchange-rates.js";
import { exchangeRateRoutes } from "./modules/system/routes/exchange-rates.routes.js";
import { referenceRateRoutes } from "./modules/system/routes/reference-rates.routes.js";
import { auditLogRoutes } from "./modules/system/routes/audit-log.routes.js";
import { createTimeReportRepository } from "./modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "./modules/timereport/service/timereport.service.js";
import { timeReportRoutes } from "./modules/timereport/routes/timereport.routes.js";
import { createScheduleRepository } from "./modules/timereport/repository/schedule.repository.js";
import { createScheduleService } from "./modules/timereport/service/schedule.service.js";
import { scheduleRoutes } from "./modules/timereport/routes/schedule.routes.js";
import { createAtfRepository } from "./modules/timereport/repository/atf.repository.js";
import { createAtfService } from "./modules/timereport/service/atf.service.js";
import { atfRoutes } from "./modules/timereport/routes/atf.routes.js";
import { createDemoDataService } from "./modules/demo/service/demo-data.service.js";
import { demoDataRoutes } from "./modules/demo/routes/demo-data.routes.js";
import { createOnboardingService } from "./modules/system/service/onboarding.service.js";
import { onboardingRoutes } from "./modules/system/routes/onboarding.routes.js";
import { createThemesRepository } from "./modules/system/repository/themes.repository.js";
import { createThemesService } from "./modules/system/service/themes.service.js";
import { themeBootRoutes, themeRoutes } from "./modules/system/routes/themes.routes.js";
import { createPluginsRepository } from "./modules/system/repository/plugins.repository.js";
import { createPluginDispatcher } from "./modules/system/service/plugin-dispatcher.js";
import { createPluginsService } from "./modules/system/service/plugins.service.js";
import { pluginKitRoutes, pluginRoutes } from "./modules/system/routes/plugins.routes.js";
import { createAlertsRepository } from "./modules/alerts/repository/alerts.repository.js";
import { createAlertsService } from "./modules/alerts/service/alerts.service.js";
import { createAlertDigestRepository } from "./modules/alerts/repository/alert-digest.repository.js";
import { createAlertDigestService } from "./modules/alerts/service/alert-digest.service.js";
import { alertsRoutes } from "./modules/alerts/routes/alerts.routes.js";
import { isBookkeepingLockViolation, isEmployeeAnonymizedViolation } from "./modules/system/service/db-errors.js";
import { createQualityRepository } from "./modules/quality/repository/quality.repository.js";
import { createQualityService } from "./modules/quality/service/quality.service.js";
import { qualityRoutes } from "./modules/quality/routes/quality.routes.js";

// TRUST_PROXY → Fastify's trustProxy: "true", a hop count ("1") or a
// comma-separated list of proxy addresses/CIDRs. Unset = req.ip is the socket
// peer (the web container), and the per-IP credential throttle stays off.
function trustProxyFromEnv(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === "false") return false;
  if (raw === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

// External seams a test can replace without touching the network: the
// Fakturainkorg's AI interpretation (Claude by default) and its e-mail box.
export interface BuildAppOptions {
  invoiceInterpreters?: InvoiceInterpreterFactory;
  // The Fakturainkorg's e-mail box (imapflow by default).
  invoiceMailboxes?: InvoiceMailboxFactory;
}

export function buildApp(database: Db = db, options: BuildAppOptions = {}) {
  const trustProxy = trustProxyFromEnv();
  const app = Fastify({ logger: true, trustProxy });
  const credentialThrottles: CredentialThrottles = {
    account: createLoginThrottle({ maxFailures: 10 }),
    // Higher: several people behind one office NAT share the address.
    ip: trustProxy === false ? null : createLoginThrottle({ maxFailures: 30 }),
  };

  app.register(fastifyCookie);
  app.register(fastifyCors, {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  });
  // 20MB covers article drawings (PDF/JPEG/PNG); the logo route caps itself
  // at 2MB per request.
  app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    // Fastify's own client faults — empty JSON body (FST_ERR_CTP_*) and
    // malformed JSON (a SyntaxError stamped with statusCode 400) — are 4xx,
    // not the 500 they used to fall through to. Domain errors never carry a
    // statusCode (they're mapped per route), so this only catches framework
    // request-parsing failures.
    const fastifyCode = (err as { code?: unknown }).code;
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (
      (typeof fastifyCode === "string" && fastifyCode.startsWith("FST_ERR_CTP_")) ||
      (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500)
    ) {
      return reply
        .code(typeof statusCode === "number" ? statusCode : 400)
        .send({ error: err.message, code: "invalid-request-body" });
    }
    // Databasspärren (migration 0095): a write against booked
    // räkenskapsinformation that slipped past the services' own guards.
    if (isBookkeepingLockViolation(err)) {
      app.log.error(err);
      return reply.code(409).send({
        error: "Bokförd räkenskapsinformation kan inte ändras eller raderas",
        code: "bookkeeping-record-locked",
      });
    }
    // GDPR (#2): the anonymized-employee guard (migration 0170).
    if (isEmployeeAnonymizedViolation(err)) {
      return reply.code(409).send({
        error: "The employee is anonymized and cannot change",
        code: "employee-anonymized",
      });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "Internal server error", code: "internal-server-error" });
  });

  // Dev-only fallback, same pattern as @navet/db's local DATABASE_URL default —
  // production deployments must set a real JWT_SECRET.
  const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";

  // Append-only audit trail (G1). Constructed first — payroll/timereport
  // (below) and auth/stock-count/manufacturing/system (block G1) all need
  // it, and it only depends on `database`.
  const auditRepository = createAuditRepository(database);

  const setupCode = createSetupCode();
  const authService = createAuthService(createAuthRepository(database), jwtSecret, auditRepository, setupCode);
  const permissionGroupService = createPermissionGroupService(createPermissionGroupRepository(database));
  const userSettingsService = createUserSettingsService(createUserSettingsRepository(database));
  const articleService = createArticleService(createArticleRepository(database));
  // CSV import (Monitor G5): articles now; customers/suppliers reuse the
  // same module later. Admin-only routes.
  const importService = createImportService(createImportRepository(database));
  const stockService = createStockService(createStockRepository(database));
  // Shared base data (leveransvillkor/betalningsvillkor/speditörer) —
  // referenced from both customers and suppliers.
  const registerService = createRegisterService(createRegisterRepository(database));
  const systemService = createSystemService(createSystemRepository(database), auditRepository);
  // Egna teman: holds the custom themes' CSS in memory (one cache per app).
  const themesService = createThemesService({ repo: createThemesRepository(database), audit: auditRepository, settings: systemService });
  // Tillägg: installed plugins, their technical users and the webhook
  // outbox. The dispatcher is decorated for server.ts's own 15-second job
  // (never run from buildApp); the services emit into the outbox through
  // the pluginEvents leaf inside their own transactions.
  const pluginsRepository = createPluginsRepository(database);
  const pluginDispatcher = createPluginDispatcher({
    repo: pluginsRepository,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  app.decorate("pluginDispatcher", pluginDispatcher);
  const pluginsService = createPluginsService({
    repo: pluginsRepository,
    audit: auditRepository,
    dispatcher: pluginDispatcher,
    webOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:3000"],
    settings: {
      publicBaseUrl: async () => (await systemService.getSettings()).publicBaseUrl,
      themeFor: async (userId) => {
        const boot = await themesService.boot((await userSettingsService.getSettings(userId)).theme);
        return boot.userTheme ?? boot.defaultTheme;
      },
    },
  });
  // Automatkontering (B2) — wired into the sales/purchase services that post
  // invoices; readPostingSettings (system module leaf) supplies the 9
  // standard posting accounts, read through the poster's own transaction
  // (the revenue/VAT accounts come with each row's momskod).
  const verificationPoster = createVerificationPoster({ read: readPostingSettings });
  // Valutakurser (Valuta): Riksbanken lookups cached in exchange_rates, plus
  // the manual rates. Read by the supplier invoice (steg 1) for its rate.
  const exchangeRateService = createExchangeRateService({
    db: database,
    audit: auditRepository,
    log: (entry) => app.log.warn(entry, "Riksbanken request failed"),
  });
  // Outgoing email + printable PDFs (SMTP config and company header both
  // live in the system module).
  const mailService = createMailService(createMailRepository(database), systemService);
  const documentPdfService = createDocumentPdfService(systemService);
  // Lagervärdering (D1) — read-only report over stock_transactions +
  // article_standard_cost_history, PDF drawn in the shared A4 template like
  // B6a's reports.
  const valuationService = createValuationService({ db: database, pdf: documentPdfService });
  // Inventering (D2) — räknelistan (renderStockCountSheet) is the shared A4
  // template's PDF, wired in the same way as valuationService above.
  const stockCountService = createStockCountService({
    repo: createStockCountRepository(database),
    pdf: documentPdfService,
    audit: auditRepository,
  });
  // Hoisted (rather than inlined into createSalesService below) so E3's
  // manufacturing↔sales link can reuse findRowForManufacturing without a
  // second repository instance.
  const salesRepository = createSalesRepository(database);
  // Frakt (Sendify) — constructed ahead of salesService, which reads the
  // shipments of its deliveries (ShipmentReader) for the order card and the
  // följesedel PDF. The provider factory defaults to Sendify; tests inject a fake.
  const shippingRepository = createShippingRepository(database);
  // Bankfiler (ISO 20022): bank profile and ids (bank_* settings), read live
  // with the company's own accounts by every payment-file path.
  const bankSettingsRepository = createBankSettingsRepository(database);
  const bankSettingsService = createBankSettingsService({ repo: bankSettingsRepository, audit: auditRepository });
  const freightSettingsService = createFreightSettingsService({ repo: shippingRepository, audit: auditRepository });
  const shippingService = createShippingService({
    repo: shippingRepository,
    settings: freightSettingsService,
    audit: auditRepository,
  });
  // Frakt etapp 2 — tracking, shared by "Uppdatera spårning" and the
  // in-process scheduler (started from server.ts only, never in tests).
  const trackingService = createTrackingService({
    repo: shippingRepository,
    settings: freightSettingsService,
    audit: auditRepository,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  app.decorate("freightTracking", trackingService);
  app.decorate("setup", { code: setupCode, needsSetup: () => authService.needsSetup() });
  // E3 (Task 5): manufacturingService is constructed here, ahead of
  // salesService, so its coverageForSalesOrderRows can be fed straight into
  // salesService's optional manufacturingCoverage dependency below — and
  // ahead of purchaseService, whose lego goods receipt auto-reports MO
  // operations through it (SubcontractOperationReporter). This isn't
  // actually a cycle despite appearances — manufacturingService only needs
  // salesRepository's findRowForManufacturing (a plain committed read) and
  // the standalone markSalesOrderInProduction transition function, never the
  // constructed salesService itself — so moving the construction order up is
  // the clean fix (no lambda/forward-reference indirection needed).
  // The TO printout renders through the shared PDF service and appends the
  // article's drawings.
  // Konfigurator 4c: the configured TO's structure — manufacturing (TO
  // creation) and planning (the configured rows' cascade) read it, and both
  // are built before the configurator. Bound late like variantPriceRef
  // (declared ahead of manufacturingService, which takes it).
  const configuredStructureRef: { current: ConfiguredStructureReader | null } = { current: null };
  const configuredStructureReader: ConfiguredStructureReader = (t, s, q, o) => configuredStructureRef.current!(t, s, q, o);
  // Every write that feeds the payroll basis (time reports, ATF, schedule
  // overrides/holidays, absences) is guarded by the same payroll_periods-backed
  // lock checker, so the payroll repository is built first — ahead of
  // manufacturing too, whose Ångra rapportering removes a stamp's time report.
  const payrollRepository = createPayrollRepository(database);
  const periodLockChecker = createPeriodLockChecker(payrollRepository);
  // Produktionsplanering: a new TO is planned inside its create transaction
  // by the planning service, which is built after manufacturing — bound
  // late like configuredStructureRef.
  const planReaderRef: { current: ManufacturingPlanReader | null } = { current: null };
  const planReader: ManufacturingPlanReader = {
    planNewOrderInTx: (tx, moId, given) => planReaderRef.current!.planNewOrderInTx(tx, moId, given),
    replanOrderInTx: (tx, moId) => planReaderRef.current!.replanOrderInTx(tx, moId),
    orderPlanSummaries: (ids) => planReaderRef.current!.orderPlanSummaries(ids),
  };
  const manufacturingService = createManufacturingService(
    createManufacturingRepository(database),
    documentPdfService,
    articleService,
    {
      findRowForManufacturing: salesRepository.findRowForManufacturing,
      lockRowForManufacturing: salesRepository.lockRowForManufacturing,
      markInProduction: markSalesOrderInProduction,
    },
    auditRepository,
    // Konfigurator 4c: the configurator's derivation for a beställningsvara's
    // TO — bound late (configuredStructureRef) like variantPriceReader.
    configuredStructureReader,
    periodLockChecker,
    // Materialbrist vid rapportering (manufacturing_material_shortage).
    systemService,
    planReader
  );
  const purchaseService = createPurchaseService(
    createPurchaseRepository(database),
    registerService,
    mailService,
    documentPdfService,
    articleService,
    systemService,
    manufacturingService,
    auditRepository
  );
  // Leverantörsfaktura (AP) — its own service in the purchase module, coupled
  // to suppliers/POs/number-series. verificationPoster books the L
  // verification at attest and its omföring at makulering (B2).
  const supplierInvoiceService = createSupplierInvoiceService(
    createSupplierInvoiceRepository(database),
    verificationPoster,
    auditRepository,
    exchangeRateService
  );
  // Fakturaskanning: the Fakturainkorg turns a received file into a supplier
  // invoice draft through supplierInvoiceService's own createInTx (one
  // transaction); the company's identifiers are filtered out of the rules.
  const invoiceScanRepository = createInvoiceScanRepository(database);
  const invoiceScanSettingsService = createInvoiceScanSettingsService({
    repo: invoiceScanRepository,
    audit: auditRepository,
    interpreters: options.invoiceInterpreters,
  });
  const invoiceScanService = createInvoiceScanService({
    repo: invoiceScanRepository,
    supplierInvoices: supplierInvoiceService,
    company: systemService,
    settings: invoiceScanSettingsService,
    audit: auditRepository,
    interpreters: options.invoiceInterpreters,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  // Fakturaskanning: the e-mail box. Decorated for server.ts's scheduler like
  // einvoiceStatus — never run from buildApp.
  const invoiceScanMailService = createInvoiceScanMailService({
    repo: invoiceScanRepository,
    settings: invoiceScanSettingsService,
    scans: invoiceScanService,
    mailboxes: options.invoiceMailboxes,
    audit: auditRepository,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  app.decorate("invoiceScanMail", invoiceScanMailService);
  // articleService is the price writer for "Sätt standardpris"/"Sätt
  // försäljningspris" on a saved calculation — injected so the standard cost
  // travels the same path the article card uses and gets its history row.
  // exchangeRateService converts a supplier price in another currency to SEK.
  const costingService = createCostingService(
    createCostingRepository(database),
    systemService,
    articleService,
    exchangeRateService
  );
  // stockService also feeds the pick list (where each article can be
  // picked); manufacturingService feeds listRows' per-row "I tillverkning"
  // coverage + linked TO list (E3); costingService feeds each row's self cost
  // so the card can show täckningsbidrag.
  // Konfigurator 4a: the variant step of the sales price chain is bound late —
  // configuratorService is built after salesService and itself reads the sales
  // chain for the template's base price (its own binding below has no reader,
  // which ends the recursion).
  const variantPriceRef: { current: VariantPriceReader | null } = { current: null };
  const salesPriceChain = (query: PriceQuoteQuery) =>
    resolvePrice(database, query, { variantPrice: (q) => (variantPriceRef.current ? variantPriceRef.current(q) : Promise.resolve(undefined)) });
  // Konfigurator 4b: the row-configuration reader is bound late for the same
  // reason as variantPriceRef.
  const rowConfigurationRef: { current: RowConfigurationReader | null } = { current: null };
  const rowConfigurationReader: RowConfigurationReader = {
    evaluate: (t, s, o) => rowConfigurationRef.current!.evaluate(t, s, o),
    variantOf: (id) => rowConfigurationRef.current!.variantOf(id),
    resolveVariant: (t, s, u) => rowConfigurationRef.current!.resolveVariant(t, s, u),
  };
  const salesService = createSalesService(
    salesRepository,
    registerService,
    mailService,
    documentPdfService,
    stockService,
    articleService,
    systemService,
    salesPriceChain,
    auditRepository,
    manufacturingService,
    // C-margin: the order card's täckningsbidrag per row. costingService is
    // constructed just above for this — it depends only on its own repository,
    // systemService and articleService, all of which exist by then.
    costingService,
    // Frakt: the order card's delivery list and the följesedel PDF show the
    // live shipment of each delivery.
    shippingService,
    rowConfigurationReader,
    // Momskoder: the quote/order confirmation counts the freight article as
    // goods when deriving a row's momskod.
    { freightArticleId: async () => (await freightSettingsService.read()).freightArticleId },
    // Valuta: today's rate for an order in another currency.
    exchangeRateService
  );
  // Frakt på offert: prices for an order and its freight row — built after
  // salesService, which owns the row rules (setFreightRow).
  const freightQuoteService = createFreightQuoteService({
    repo: shippingRepository,
    settings: freightSettingsService,
    sales: salesService,
    audit: auditRepository,
  });
  // Kundfakturor (C1) — its own module, replacing the old order-stamp
  // invoicing. mail/pdf are the same shared services, satisfied structurally
  // by the invoice service's narrow InvoiceMailSender/InvoicePdfRenderer;
  // verificationPoster books the F verification at issue (B2).
  const invoiceRepository = createInvoiceRepository(database);
  const invoiceService = createInvoiceService(
    invoiceRepository,
    mailService,
    documentPdfService,
    verificationPoster,
    auditRepository,
    articleService,
    // Frakt etapp 2: the freight article the shipment rows bill.
    { freightArticleId: async () => (await freightSettingsService.read()).freightArticleId },
    // Valuta: the invoice date's rate at Utfärda, today's rate for a freight
    // row on a foreign invoice without an order to take it from.
    exchangeRateService,
    // Dröjsmålsränta: the referensräntor for the reminder's accrued interest.
    exchangeRateService,
    // Extra benämning on the invoice (System → Inställningar).
    systemService
  );
  // Räntefakturering: one invoice per customer with the interest/fee rows,
  // issued through the ordinary path; referensräntor via the same service
  // that knows Riksbanken.
  const lateInterestService = createLateInterestService({
    db: database,
    invoiceRepo: invoiceRepository,
    invoices: { issue: (id, userId) => invoiceService.issue(id, userId) },
    referenceRates: exchangeRateService,
    audit: auditRepository,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  // E-faktura via Peppol (B2Brouter): reads the issued invoice, its archived
  // PDF and the customer through narrow readers into sales, and the company
  // data through the system service. The provider factory defaults to
  // B2Brouter; tests inject a fake. The status job is decorated on the app
  // for server.ts's scheduler, like freightTracking.
  const einvoiceRepository = createEinvoiceRepository(database);
  const einvoiceSettingsService = createEinvoiceSettingsService({
    repo: einvoiceRepository,
    company: systemService,
    audit: auditRepository,
  });
  const einvoiceService = createEinvoiceService({
    repo: einvoiceRepository,
    settings: einvoiceSettingsService,
    invoices: {
      getInvoice: (id) => invoiceService.getInvoice(id),
      archivedInvoicePdf: (id) => invoiceService.renderPdf(id),
      findCustomerById: (id) => salesService.getCustomer(id),
    },
    company: systemService,
    audit: auditRepository,
  });
  const einvoiceStatusService = createEinvoiceStatusService({
    repo: einvoiceRepository,
    settings: einvoiceSettingsService,
    audit: auditRepository,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  app.decorate("einvoiceStatus", einvoiceStatusService);
  // Kundreskontra (B3) — open items, payment registration and cancellation.
  // The same poster books the K verification inside the payment's own
  // transaction and reverses it when the payment is cancelled.
  const paymentRepository = createPaymentRepository(database);
  const paymentService = createPaymentService(paymentRepository, verificationPoster, auditRepository);
  // Leverantörsreskontra (B4) — the payables mirror: open items, outgoing
  // payment registration and cancellation. The same poster books the U
  // verification inside the payment's own transaction and reverses it when the
  // payment is cancelled.
  const supplierPaymentService = createSupplierPaymentService(
    createSupplierPaymentRepository(database),
    verificationPoster,
    auditRepository
  );
  // Betalningsomgångar (pain.001) — declared after the payment services (C3):
  // a confirmation books through the supplier payment registration's Tx seam
  // (createInTx/cancelInTx), so the batch row, the UTB and the U verification
  // commit together.
  const paymentBatchService = createPaymentBatchService({
    db: database,
    repo: createPaymentBatchRepository(database),
    bankSettings: bankSettingsService,
    supplierPayments: supplierPaymentService,
    // KU81: today's rate for the 150 000 kr threshold of a payment abroad.
    exchangeRates: exchangeRateService,
  });
  // Bankfiler (camt.054) — declared after the payment services (C3): incoming
  // payments book through the customer payment registration's Tx seam,
  // debits/returns through the batch service, each with its bank entry link
  // in the same transaction.
  const bankFileService = createBankFileService({
    db: database,
    repo: createBankFileRepository(database),
    batches: paymentBatchService,
    customerPayments: paymentService,
    receivables: paymentRepository,
    company: bankSettingsRepository,
  });
  // Produktkonfigurator: templates, groups, rules, conditional structure lines
  // and operations, the shared evaluate/derive engine and stocked variants.
  // Customer prices come from the sales price chain; the article module
  // answers whether a component would put the template inside its own
  // structure (isDescendant). Variants are written through the owning
  // modules' Tx leaves (article, structure, route) inside the configurator's
  // transaction, and the list reads stock through the stock service.
  const configuratorService = createConfiguratorService({
    db: database,
    prices: (q) => resolvePrice(database, q),
    customerExists: async (id) => (await database.select({ id: customers.id }).from(customers).where(eq(customers.id, id))).length > 0,
    articles: {
      exists: async (id) => (await articleService.getArticle(id)) != null,
      isDescendant: (articleId, ancestorId) => articleService.isDescendant(articleId, ancestorId),
      find: (id) => articleService.getArticle(id),
    },
    costing: costingService,
    writers: { insertArticle, insertBomRows, insertRoutingOperations },
    stock: { balancesForArticles: (ids) => stockService.balancesForArticles(ids) },
    // Valuta: evaluate/derive default to the customer's currency at today's rate.
    customerCurrency: async (id) =>
      (await database.select({ currency: customers.currency }).from(customers).where(eq(customers.id, id)))[0]?.currency ?? null,
    rates: exchangeRateService,
  });
  variantPriceRef.current = (q) => configuratorService.variantPrice(q);
  configuredStructureRef.current = (t, s, q, o) => configuratorService.deriveForManufacturing(t, s, q, o);
  rowConfigurationRef.current = {
    evaluate: (t, s, o) => configuratorService.evaluateRowConfiguration(t, s, o),
    variantOf: (id) => configuratorService.findVariantOf(id),
    resolveVariant: (t, s, u) => configuratorService.resolveVariant(t, s, u),
  };
  // Behovsberäkning (E1) — reads across four modules but only ever creates
  // orders through the purchase/manufacturing services' own creation paths
  // (narrow creator interfaces, satisfied structurally).
  const planningService = createPlanningService(createPlanningRepository(database), {
    purchase: purchaseService,
    manufacturing: manufacturingService,
    // Konfigurator 4c: the configured KO rows' material cascade — the same
    // late-bound reader the manufacturing service derives TO structure with.
    configuredStructure: configuredStructureReader,
    audit: auditRepository,
    // Reservationen: the KO's Förväntat leveransdatum is set by the sales
    // service inside the planning transaction (SalesOrderDateWriter).
    salesOrderDates: salesService,
  });
  planReaderRef.current = planningService;
  // Aviseringar — derived at every read. The behovsberäkning (through its
  // cache) and the TO list's Sen come from the planning service; the
  // "due within N days" window from the system settings.
  const alertsService = createAlertsService({
    repo: createAlertsRepository(database),
    planning: planningService,
    settings: {
      supplierInvoiceDays: async () => (await systemService.getSettings()).alertSupplierInvoiceDays,
      quoteFollowupDays: async () => (await systemService.getSettings()).alertQuoteFollowupDays,
    },
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  app.decorate("alerts", alertsService);
  // Den dagliga sammanställningen: decorated for server.ts's scheduler like
  // freightTracking/einvoiceStatus — never run from buildApp.
  const alertDigestService = createAlertDigestService({
    repo: createAlertDigestRepository(database),
    alerts: alertsService,
    mail: mailService,
    settings: {
      smtpConfigured: async () => (await systemService.getSmtpConfig()) !== null,
      digestSettings: async () => {
        const s = await systemService.getSettings();
        return { digestTime: s.alertDigestTime, publicBaseUrl: s.publicBaseUrl };
      },
    },
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  app.decorate("alertDigest", alertDigestService);
  // Reklamationer och avvikelser (Kvalitet): documents only — the shortcuts
  // link their documents through the quality leaf linkDeviationInTx inside
  // their own create transactions; the PDF and the mail are the shared ones.
  const qualityService = createQualityService({
    repo: createQualityRepository(database),
    pdf: documentPdfService,
    mail: mailService,
  });
  // Rapporter (F1) — read-only derived reports, admin-only in the routes.
  // costingService supplies the self cost the margin report measures against;
  // the quality service the leveransprecision's kvalitetsdel.
  const reportsService = createReportsService(createReportsRepository(database), costingService, qualityService);
  const orderRegisterService = createOrderRegisterService(createOrderRegisterRepository(database), documentPdfService);
  const quoteFollowupService = createQuoteFollowupService(createQuoteFollowupRepository(database));
  // Projektrapport (kostnadsställen och projekt): one project's result out
  // of the booked rows carrying it, plus its customer orders.
  const projectReportService = createProjectReportService(createProjectReportRepository(database));
  const oauthService = createOAuthService(createOAuthRepository(database), jwtSecret);
  // auditRepository is constructed earlier (ahead of purchase/sales) — see
  // that declaration's comment. Payroll/timereport reuse the same instance.
  const timeReportRepository = createTimeReportRepository(database);
  // Schedules and ATF share the employee register with the timereport
  // service; ATF also reads the system-wide accrual setting. Utjämning on the
  // week schedule reads its system setting and the absences that earn no ATF
  // (the payroll repository — built above, so no late binding is needed).
  const scheduleService = createScheduleService(
    createScheduleRepository(database),
    timeReportRepository,
    periodLockChecker,
    { settings: systemService, absences: payrollRepository }
  );
  const atfRepository = createAtfRepository(database);
  const atfService = createAtfService(atfRepository, timeReportRepository, systemService, periodLockChecker);
  // Löneunderlag: base-data registers (frånvarokoder/OB-regler), absence
  // bookings, the period summary, attestation and period locking. Reuses
  // timeReportRepository as both the employee reader (existence checks +
  // listEmployees) and the attendance range reader, scheduleService for
  // calendar/holiday resolution, the ATF repository for withdrawal ranges,
  // systemService for the overtime-threshold setting/company header, and the
  // shared documentPdfService for the printable PDF report.
  const payrollService = createPayrollService(
    payrollRepository,
    timeReportRepository,
    periodLockChecker,
    scheduleService,
    timeReportRepository,
    atfRepository,
    systemService,
    auditRepository,
    systemService,
    documentPdfService
  );
  // Stamp in/out needs MO status transitions (auto-start, complete operation).
  // Built after payroll (which never needs it) so Närvaroavvikelser can read
  // the schedule and payroll's own day directly: the terminal's reason and
  // overtime questions, and the overtime choice written in Gå hem's
  // transaction.
  const timeReportService = createTimeReportService(
    timeReportRepository,
    manufacturingService,
    periodLockChecker,
    auditRepository,
    {
      settings: systemService,
      calendar: scheduleService,
      previewDay: (employeeId, date, opts) => payrollService.previewDay(employeeId, date, opts),
      dispositionWriter: { upsert: upsertOvertimeDispositionInTx },
      log: (msg, extra) => app.log.error(extra ?? {}, msg),
    }
  );
  // Grundbokföring (B1): kontoplan, seeded from BAS. Reuses the same audit
  // repository instance as payroll (not used by the account CRUD in this
  // task — Task 4's fiscal years/verifications are the first writer).
  const economyRepository = createEconomyRepository(database);
  const economyService = createEconomyService(economyRepository, auditRepository);
  // Kostnadsställen och projekt (etapp 5 del A): the two dimension registers.
  const dimensionService = createDimensionService(createDimensionRepository(database), auditRepository);
  // Momsrapport (B5): deklarationsrutor per period + momsomföringen (series
  // M via the shared poster).
  const vatReportService = createVatReportService({
    db: database,
    poster: verificationPoster,
    settings: { read: readPostingSettings },
    company: { orgNumber: async () => (await systemService.getCompanyInfo())?.orgNumber ?? null },
    audit: auditRepository,
  });
  // Periodisk sammanställning: the issued invoices' EU sales per buyer,
  // reconciled against the booked ruta 35/39, and Skatteverket's file.
  const periodicSummaryService = createPeriodicSummaryService({
    db: database,
    company: { vatNumber: async () => (await systemService.getCompanyInfo())?.vatNumber ?? null },
  });
  // Momskoder: the catalog's per-company settings and the importmoms posting
  // (series IM via the shared poster).
  const vatCodeService = createVatCodeService({ db: database, poster: verificationPoster, audit: auditRepository });
  // Ekonomirapporter (B6a): balans-/resultaträkning, flerkontoshuvudbok och
  // verifikatlista — read-only, with PDF drawn in the shared A4 template.
  // Budget (etapp 5 del B): budgets per räkenskapsår; the reports read the
  // budget through the repository's report slice.
  const budgetRepository = createBudgetRepository(database);
  const budgetService = createBudgetService({ repo: budgetRepository, audit: auditRepository });
  const financialReportsService = createFinancialReportsService({
    db: database,
    repo: economyRepository,
    pdf: documentPdfService,
    budgets: budgetRepository,
  });
  // SIE (B6b): SIETYP 4-export per räkenskapsår och import av ingående
  // balanser som ett bokfört verifikat i serie I.
  const sieService = createSieService({
    db: database,
    repo: economyRepository,
    system: systemService,
    poster: verificationPoster,
    programVersion: "1.0",
  });
  // Snabbare manuell bokföring (etapp 3): verifikatmallar, återkommande
  // verifikat (the hourly job runs from server.ts, never from here) and the
  // SIE verification import.
  const verificationTemplateRepository = createVerificationTemplateRepository(database);
  const verificationTemplateService = createVerificationTemplateService({
    repo: verificationTemplateRepository,
    economy: economyRepository,
    audit: auditRepository,
  });
  const recurringVerificationService = createRecurringVerificationService({
    repo: createRecurringVerificationRepository(database),
    templates: verificationTemplateRepository,
    economy: economyRepository,
    economyService,
    audit: auditRepository,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  app.decorate("recurringVerifications", recurringVerificationService);
  const sieVerificationImportService = createSieVerificationImportService({
    db: database,
    repo: economyRepository,
    economy: economyService,
    audit: auditRepository,
  });
  // Bankavstämning (etapp 4): kontoutdrag (camt.053/CSV), matchning mot
  // bankkontots verifikatrader, bokföring av saknade poster i serie B genom
  // economy's createVerificationInTx, bankregler och Avstämd t.o.m.
  const bankReconciliationService = createBankReconciliationService({
    db: database,
    repo: createBankReconciliationRepository(database),
    economy: economyService,
    settings: { read: readPostingSettings },
    company: bankSettingsRepository,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });
  // Anläggningsregister (ekonomi etapp 2, delprojekt 2): tillgångsgrupper,
  // anläggningar, avskrivningskörningar (serie AV via the shared poster),
  // avyttring and the avskrivningsplan PDF/CSV.
  const fixedAssetService = createFixedAssetService({
    db: database,
    poster: verificationPoster,
    audit: auditRepository,
    pdf: documentPdfService,
  });
  // Årsbokslut (ekonomi etapp 2, delprojekt 3): the closing guide — steps in
  // series BS via the shared poster, close/reopen behind the closed-year
  // triggers of migration 0105, the valutaomvärdering (valuta steg 4).
  const yearEndClosingService = createYearEndClosingService({
    db: database,
    poster: verificationPoster,
    settings: { read: readPostingSettings },
    receivables: { totalAsOf: receivablesTotalAsOf, foreignItemsAsOf: receivableForeignItemsAsOf },
    payables: { totalAsOf: payablesTotalAsOf, foreignItemsAsOf: payableForeignItemsAsOf },
    // Valutaomvärderingen: the closing date's rate per currency.
    exchangeRates: exchangeRateService,
    fixedAssets: fixedAssetService,
    inventory: valuationService,
    fiscalYears: economyService,
    log: (msg, extra) => app.log.error(extra ?? {}, msg),
  });

  app.register(
    async (v1) => {
      // Public: register (bootstrap-only)/login/logout, plus /auth/me,
      // /auth/users and /me/settings which apply their own requireAuth
      // preHandler individually.
      await v1.register(authRoutes, { service: authService, settings: userSettingsService, throttles: credentialThrottles });
      // Public: this route IS the OAuth2 client-credentials authentication mechanism.
      await v1.register(oauthRoutes, { service: oauthService, throttles: credentialThrottles });
      // Public: the theme CSS and picker data every page (login and the stamp
      // terminal included) reads before first paint; reads the session
      // cookie itself, only to add the user's own choice.
      await v1.register(themeBootRoutes, { service: themesService, auth: authService, userSettings: userSettingsService });
      // Public: the plugin kit (theme tokens + base style) an embedded plugin
      // page links from its own origin.
      await v1.register(pluginKitRoutes, { themes: themesService });

      // Behörighetsgrupper: enforceAccess runs after authentication and
      // resolves each route's rule — its own config.access, else the module
      // default registerModule stamped on it. No rule = 403 (fail closed).
      const office = ["office"] as const;
      const adminOnly = { read: ["admin"], write: ["admin"] } as const satisfies ModuleAccess;

      await v1.register(async (protectedRoutes) => {
        protectedRoutes.addHook("preHandler", requireAuth(authService));
        protectedRoutes.addHook("preHandler", enforceAccess());
        protectedRoutes.addHook("preHandler", rejectMalformedIds());
        await registerModule(protectedRoutes, articleRoutes, { service: articleService }, { read: office, write: ["artiklar"] });
        await registerModule(protectedRoutes, templateConfiguratorRoutes, { service: configuratorService }, { read: office, write: ["artiklar"] });
        await registerModule(protectedRoutes, importRoutes, { service: importService }, adminOnly);
        await registerModule(
          protectedRoutes,
          stockRoutes,
          { service: stockService, valuation: valuationService, counts: stockCountService },
          { read: office, write: ["lager"] }
        );
        await registerModule(protectedRoutes, purchaseRoutes, { service: purchaseService }, { read: office, write: ["inkop"] });
        await registerModule(protectedRoutes, supplierInvoiceRoutes, { service: supplierInvoiceService }, { read: office, write: ["inkop"] });
        await registerModule(
          protectedRoutes,
          invoiceScanRoutes,
          { service: invoiceScanService, settings: invoiceScanSettingsService, mail: invoiceScanMailService },
          { read: office, write: ["inkop"] }
        );
        await registerModule(protectedRoutes, supplierPaymentRoutes, { service: supplierPaymentService }, { read: office, write: ["inkop"] });
        await registerModule(protectedRoutes, bankSettingsRoutes, { service: bankSettingsService }, { read: ["inkop", "forsaljning", "ekonomi"], write: ["admin"] });
        await registerModule(protectedRoutes, paymentBatchRoutes, { service: paymentBatchService }, { read: ["inkop", "ekonomi"], write: ["inkop"] });
        await registerModule(protectedRoutes, bankFileRoutes, { service: bankFileService }, { read: ["inkop", "forsaljning", "ekonomi"], write: ["inkop", "forsaljning"] });
        await registerModule(protectedRoutes, bankReconciliationRoutes, { service: bankReconciliationService }, { read: ["ekonomi"], write: ["ekonomi"] });
        await registerModule(protectedRoutes, salesRoutes, { service: salesService }, { read: office, write: ["forsaljning"] });
        await registerModule(protectedRoutes, invoiceRoutes, { service: invoiceService }, { read: office, write: ["forsaljning"] });
        await registerModule(protectedRoutes, lateInterestRoutes, { service: lateInterestService }, { read: office, write: ["forsaljning"] });
        // Referensränta follows the customer invoices' rule (the routine
        // fetches and adds rates), unlike the exchange rates (ekonomi).
        await registerModule(protectedRoutes, referenceRateRoutes, { service: exchangeRateService }, { read: office, write: ["forsaljning"] });
        await registerModule(protectedRoutes, paymentRoutes, { service: paymentService }, { read: office, write: ["forsaljning"] });
        await registerModule(
          protectedRoutes,
          shippingRoutes,
          { settings: freightSettingsService, service: shippingService, quotes: freightQuoteService, tracking: trackingService },
          { read: office, write: ["forsaljning"] }
        );
        await registerModule(
          protectedRoutes,
          einvoiceRoutes,
          { settings: einvoiceSettingsService, service: einvoiceService, status: einvoiceStatusService },
          { read: office, write: ["forsaljning"] }
        );
        await registerModule(
          protectedRoutes,
          registerRoutes,
          { service: registerService },
          { read: office, write: ["artiklar", "inkop", "forsaljning"] }
        );
        await registerModule(protectedRoutes, manufacturingRoutes, { service: manufacturingService }, { read: office, write: ["tillverkning"] });
        // Skanning (#4): read-only "what is this code?" — no writes.
        await registerModule(protectedRoutes, scanRoutes, { service: createScanService(createScanRepository(database)) }, { read: office, write: ["admin"] });
        await registerModule(protectedRoutes, planningRoutes, { service: planningService }, { read: office, write: ["tillverkning"] });
        // Aviseringar: one read, every office user; the kinds are filtered per
        // user in the service (admin-only Utskick som misslyckades included).
        await registerModule(protectedRoutes, alertsRoutes, { service: alertsService }, { read: office, write: ["admin"] });
        // Kvalitet → Avvikelser: every office user reads (the order cards
        // list their cases), Kvalitet writes.
        await registerModule(protectedRoutes, qualityRoutes, { service: qualityService }, { read: office, write: ["kvalitet"] });
        await registerModule(
          protectedRoutes,
          reportsRoutes,
          { service: reportsService, orderRegister: orderRegisterService, quoteFollowup: quoteFollowupService, projectReport: projectReportService },
          { read: ["rapporter"], write: ["rapporter"] }
        );
        await registerModule(protectedRoutes, timeReportRoutes, { service: timeReportService }, { read: office, write: ["tillverkning"] });
        await registerModule(protectedRoutes, scheduleRoutes, { service: scheduleService }, { read: office, write: ["tillverkning"] });
        await registerModule(protectedRoutes, atfRoutes, { service: atfService }, { read: office, write: ["tillverkning"] });
        // Personal & lön: the whole payroll module (lönekoder, frånvaro,
        // övertidsval, löneperiod, attest, export) is the personal menu, reads
        // included; GET /attendance-deviation-reasons keeps its terminal rule.
        await registerModule(protectedRoutes, payrollRoutes, { service: payrollService }, { read: ["personal"], write: ["personal"] });
        await registerModule(
          protectedRoutes,
          economyRoutes,
          {
            service: economyService,
            vatReport: vatReportService,
            reports: financialReportsService,
            sie: sieService,
            vatCodes: vatCodeService,
            periodicSummary: periodicSummaryService,
          },
          { read: ["ekonomi"], write: ["ekonomi"] }
        );
        await registerModule(
          protectedRoutes,
          manualBookkeepingRoutes,
          {
            economy: economyService,
            templates: verificationTemplateService,
            recurring: recurringVerificationService,
            sieImport: sieVerificationImportService,
          },
          { read: ["ekonomi"], write: ["ekonomi"] }
        );
        // Kostnadsställen och projekt: every office user reads the registers
        // (the pickers on orders, invoices and article groups), Ekonomi writes.
        await registerModule(protectedRoutes, dimensionRoutes, { service: dimensionService }, { read: office, write: ["ekonomi"] });
        // Budget: management's planning data — Ekonomi reads and writes.
        await registerModule(protectedRoutes, budgetRoutes, { service: budgetService }, { read: ["ekonomi"], write: ["ekonomi"] });
        await registerModule(protectedRoutes, fixedAssetRoutes, { service: fixedAssetService }, { read: ["ekonomi"], write: ["ekonomi"] });
        await registerModule(protectedRoutes, yearEndRoutes, { service: yearEndClosingService }, { read: ["ekonomi"], write: ["ekonomi"] });
        await registerModule(protectedRoutes, costingRoutes, { service: costingService }, { read: office, write: ["tillverkning"] });
        await registerModule(protectedRoutes, apiClientRoutes, { service: oauthService }, adminOnly);
        await registerModule(protectedRoutes, systemRoutes, { service: systemService }, { read: office, write: ["admin"] });
        await registerModule(protectedRoutes, exchangeRateRoutes, { service: exchangeRateService }, { read: office, write: ["ekonomi"] });
        await registerModule(protectedRoutes, permissionGroupRoutes, { service: permissionGroupService }, adminOnly);
        await registerModule(protectedRoutes, auditLogRoutes, { repo: auditRepository }, adminOnly);
        // System → Exempeldata: the made-up demo company, admin only.
        await registerModule(protectedRoutes, demoDataRoutes, { service: createDemoDataService(database) }, adminOnly);
        // System → Kom igång: the setup checklist on Översikten, admin only.
        await registerModule(protectedRoutes, onboardingRoutes, { service: createOnboardingService(database) }, adminOnly);
        // System → Teman: install, edit and export colour themes, admin only.
        await registerModule(protectedRoutes, themeRoutes, { service: themesService }, adminOnly);
        // System → Tillägg: admin only, except GET /plugin-ui and POST
        // /plugins/:id/context (office, set on the routes).
        await registerModule(protectedRoutes, pluginRoutes, { service: pluginsService }, adminOnly);
        await registerModule(
          protectedRoutes,
          mailRoutes,
          { service: mailService, purchaseService, salesService, invoiceService, qualityService },
          // Skicka om narrows per document type (resendAccessRule).
          { read: office, write: ["inkop", "forsaljning", "kvalitet"] }
        );
      });

      // Reachable by either a human session or a scoped OAuth2 client-credentials
      // token (external configurator) — the endpoints architecture.md §5
      // names plus the configurator's public read side (delprojekt 5:
      // templates, template, evaluate), nothing more. enforceAccess lets a client
      // (no req.user) through; a human session is held to the module rule.
      await v1.register(async (configuratorScope) => {
        configuratorScope.addHook("preHandler", requireAuthOrClient(authService, oauthService));
        configuratorScope.addHook("preHandler", enforceAccess());
        configuratorScope.addHook("preHandler", rejectMalformedIds());
        await registerModule(
          configuratorScope,
          configuratorRoutes,
          // Delprojekt 5: the publishing check (unpublishedTemplates) in POST /quotes.
          { salesService, articleService, configuratorService },
          { read: office, write: ["forsaljning"] }
        );
        // Delprojekt 5: templates, template and evaluate — public shapes only.
        await registerModule(configuratorScope, publicConfiguratorRoutes, { service: configuratorService }, { read: office, write: ["forsaljning"] });
      });
    },
    { prefix: "/api/v1" }
  );

  // version: baked in by build.mjs in the image; npm sets
  // npm_package_version when the API runs with `npm run dev`.
  app.get("/health", async () => ({
    status: "ok",
    version: process.env.APP_VERSION ?? process.env.npm_package_version ?? null,
  }));

  return app;
}
