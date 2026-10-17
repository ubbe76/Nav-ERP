import type {
  CompleteManufacturingOrderInput,
  CompleteOperationInput,
  ConsumeMaterialInput,
  CreateManufacturingOrderInput,
  ManufacturingOrderConfiguration,
  OrderRowConfiguration,
  UpdateManufacturingOrderInput,
  CreateProductionGroupInput,
  CreateRoutingOperationInput,
  CreateWorkCenterInput,
  ListManufacturingOrdersQuery,
  ListWorkCentersQuery,
  SetProductionGroupWorkCentersInput,
  UpdateProductionGroupInput,
  UpdateRoutingOperationInput,
  UpdateWorkCenterInput,
} from "@navet/shared";
import { roundUpToMultiple, toUnitQuantity } from "@navet/shared";
import type { ManufacturingMaterialShortage } from "@navet/shared";
import type {
  ManufacturingRepository,
  ReportOperationQuantitiesInput,
  ReportSource,
  UndoReportResult,
} from "../repository/manufacturing.repository.js";
// Materialbrist vid rapportering: the check itself is a leaf the repository
// runs inside the report transactions; the mode is read here, outside them.
import { MaterialShortageError, type MaterialShortageCheck } from "./material-shortage.js";
import { computeReadiness, type Readiness, type ReadinessResult } from "./terminal-readiness.js";
import type { ManufacturingPlanReader } from "../../planning/service/planning.service.js";
import type { PlannedWeek } from "../../planning/service/capacity-calc.js";
export { MaterialShortageError, type MaterialShortage } from "./material-shortage.js";
import type { PeriodLockChecker } from "../../payroll/service/period-lock.js";
import type { DocumentPdfService, PalletCardPdfInput } from "../../mail/service/document-pdf.js";
import { appendFilesToPdf, mergePdfs } from "../../mail/service/pdf-merge.js";
import { assertOrderableArticle, type ArticleFileReader } from "../../article/service/article.service.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import type { Tx } from "@navet/db";
// G1: append-only audit trail (see audit.repository.ts). Status transitions
// and the header PATCH are logged; completeOperation/the stamp-terminal path
// is deliberately NOT logged (shop-floor noise — the quantities already live
// on the operation itself, see reportOperationQuantities below).
import type { AuditWriter } from "../../system/repository/audit.repository.js";
// Konfigurator 4c: a beställningsvara's TO carries its derived structure from
// creation. The derivation itself is the configurator's (injected as a reader,
// bound late in app.ts like VariantPriceReader); the errors are the sales
// module's row-configuration errors so the three TO paths and the order row
// answer alike.
import type { ConfiguredStructureReader } from "../../configurator/service/configurator.service.js";
import { ConfiguratorInvalidConfigurationError, ConfiguratorNotToOrderModeError } from "../../configurator/service/configurator.errors.js";
import { configurationLines } from "../../configurator/service/configuration-lines.js";
import { selectionFromEntries } from "../../configurator/service/variant-identity.js";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  RowConfigurationChangedError,
} from "../../sales/service/sales.errors.js";

// E3 (KO→TO-koppling): the narrow slice of the sales module manufacturing
// depends on — injected via the factory (never a direct cross-module import
// in the service, same cross-module-dependency style as ArticleFileReader/
// StockBalanceReader/RegisterReferenceReader elsewhere in the codebase).
// findRowForManufacturing reads committed data ahead of the MO's own
// transaction; markInProduction is Tx-composable and gets threaded into the
// repo's create-tx call (the VerificationPoster-as-call-parameter pattern).
export interface SalesOrderLinkReader {
  findRowForManufacturing(rowId: string): Promise<{
    id: string;
    salesOrderId: string;
    orderNumber: string;
    orderStatus: string;
    customerName: string;
    // Kundens ordernummer — printed on the pallet card (Etapp F).
    customerOrderNumber: string | null;
    articleId: string;
    articleType: string;
    quantityOrdered: number;
    // Konfigurator 4c: the row's stored configuration — the TO of a
    // beställningsvara is derived from it; null on a plain row.
    configuration: OrderRowConfiguration | null;
  } | null>;
  // Konfigurator 4c: locks the row FOR UPDATE inside the TO's create-tx and
  // returns the key stored at that moment — compared against the key the
  // derivation ran on, so a row reconfigured in between is refused.
  lockRowForManufacturing(tx: Tx, rowId: string): Promise<{ configurationKey: string | null } | null>;
  markInProduction(tx: Tx, salesOrderId: string): Promise<void>;
}

// Legoförfrågan: one entry in the inquiry row form's Legooperation select —
// either the article's own routing operation (beredning, no TO yet) or a
// pending lego operation on one of the article's open TOs. `key` is the
// <select> value; routingOperationId is set on both kinds so the row can
// always link back to the operation even when it came from an MO.
export interface LegoOperationOption {
  key: string; // "routing:<routingOperationId>" | "mo:<moOperationId>"
  kind: "routing" | "mo";
  routingOperationId: string | null;
  moOperationId: string | null;
  label: string;
  supplierId: string | null;
  setupPrice: string | null;
  unitPrice: string | null;
}

export class WorkCenterNotFoundError extends Error {
  constructor(id: string) {
    super(`Work center ${id} not found`);
    this.name = "WorkCenterNotFoundError";
  }
}

// E2: an unknown week schedule on a work center — caught via the hand-added
// FK constraint rather than a pre-check (atomic, no extra dependency).
export class WeekScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Week schedule ${id} not found`);
    this.name = "WeekScheduleNotFoundError";
  }
}

// Lego: an unknown default supplier on a legoresurs, or an unknown supplier
// on a lego operation — caught via the FK constraints (atomic, no
// cross-module reader dependency, same idiom as WeekScheduleNotFoundError).
export class WorkCenterSupplierNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier ${id} not found`);
    this.name = "WorkCenterSupplierNotFoundError";
  }
}

// Lego pricing/supplier/drawing fields belong to operations on a legoresurs
// (work center type "subcontract") — on any other resource they are refused
// rather than silently stored.
export class NotSubcontractOperationError extends Error {
  constructor() {
    super("Lego fields require a resource of type legoresurs (subcontract)");
    this.name = "NotSubcontractOperationError";
  }
}

// The lego drawing subresource exists only on subcontract operations.
export class OperationFileNotFoundError extends Error {
  constructor(operationId: string) {
    super(`Routing operation ${operationId} has no drawing`);
    this.name = "OperationFileNotFoundError";
  }
}

// Same set as the article drawings (article.service.ts ALLOWED_FILE_TYPES) —
// duplicated rather than imported so the two modules stay decoupled.
export const ALLOWED_OPERATION_FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

export class InvalidOperationFileTypeError extends Error {
  constructor(contentType: string) {
    super(`File type "${contentType}" is not allowed — only PDF, JPEG and PNG`);
    this.name = "InvalidOperationFileTypeError";
  }
}

// "Kalkyl" (costingOnly) means the operation is priced but never released, so
// material hung off it would quietly fall through to final completion. The
// combination is refused instead — the article side refuses the other
// direction (CostingOnlyOperationLinkError in article.service.ts).
export class OperationHasLinkedMaterialError extends Error {
  constructor() {
    super("The operation has BOM rows linked to it and cannot be marked as a Kalkyl operation");
    this.name = "OperationHasLinkedMaterialError";
  }
}

export class RoutingOperationNotFoundError extends Error {
  constructor(id: string) {
    super(`Routing operation ${id} not found`);
    this.name = "RoutingOperationNotFoundError";
  }
}

export class DuplicateSequenceNoError extends Error {
  constructor() {
    super("The article's routing already has an operation with this sequence number");
    this.name = "DuplicateSequenceNoError";
  }
}

export class DuplicateWorkCenterCodeError extends Error {
  constructor(code: string) {
    super(`A work center with number ${code} already exists`);
    this.name = "DuplicateWorkCenterCodeError";
  }
}

export class ProductionGroupNotFoundError extends Error {
  constructor(id: string) {
    super(`Production group ${id} not found`);
    this.name = "ProductionGroupNotFoundError";
  }
}

export class DuplicateProductionGroupCodeError extends Error {
  constructor(code: string) {
    super(`A production group with code ${code} already exists`);
    this.name = "DuplicateProductionGroupCodeError";
  }
}

export class ManufacturingOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Manufacturing order ${id} not found`);
    this.name = "ManufacturingOrderNotFoundError";
  }
}

export class MOMaterialConsumptionNotFoundError extends Error {
  constructor(id: string) {
    super(`Material consumption row ${id} not found`);
    this.name = "MOMaterialConsumptionNotFoundError";
  }
}

export class MOOperationNotFoundError extends Error {
  constructor(id: string) {
    super(`Operation ${id} not found`);
    this.name = "MOOperationNotFoundError";
  }
}

export class InvalidStatusTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStatusTransitionError";
  }
}

export class OverConsumptionError extends Error {
  constructor() {
    super("Consumed quantity would exceed the planned quantity for this material");
    this.name = "OverConsumptionError";
  }
}

// Ångra rapportering (mo_reports).
export class MoReportNotFoundError extends Error {
  constructor(id: string) {
    super(`Report ${id} not found`);
    this.name = "MoReportNotFoundError";
  }
}

export class MoReportAlreadyUndoneError extends Error {
  constructor() {
    super("The report has already been undone");
    this.name = "MoReportAlreadyUndoneError";
  }
}

// A lego receipt reported the operation — it belongs to the IO.
export class MoReportFromPurchaseReceiptError extends Error {
  constructor() {
    super("The report came from a purchase receipt and is undone on the purchase order");
    this.name = "MoReportFromPurchaseReceiptError";
  }
}

// The finished goods the report received are no longer on the location.
export class MoReportStockMissingError extends Error {
  constructor(
    readonly available: number,
    readonly required: number
  ) {
    super(
      `Rapporteringen lade ${required.toLocaleString("sv-SE")} st i lager men bara ${available.toLocaleString("sv-SE")} st finns kvar på lagerplatsen`
    );
    this.name = "MoReportStockMissingError";
  }
}

// The stamp's time report lies in a locked payroll period.
export class MoReportTimeLockedError extends Error {
  constructor(date: string) {
    super(`The report's time on ${date} lies in a locked payroll period`);
    this.name = "MoReportTimeLockedError";
  }
}

// Makulera order: something is still booked against the order.
export class ManufacturingOrderHasReportsError extends Error {
  constructor() {
    super("The order has reports that must be undone before it can be cancelled");
    this.name = "ManufacturingOrderHasReportsError";
  }
}

export class ManufacturingOrderStampedInError extends Error {
  constructor() {
    super("Someone is stamped in on the order");
    this.name = "ManufacturingOrderStampedInError";
  }
}

// E3 (KO→TO-koppling): validation errors for createManufacturingOrder's
// optional salesOrderRowId link.
export class LinkedRowNotFoundError extends Error {
  constructor(id: string) {
    super(`Sales order row ${id} not found`);
    this.name = "LinkedRowNotFoundError";
  }
}

export class LinkedRowArticleMismatchError extends Error {
  constructor() {
    super("The supplied articleId does not match the linked sales order row's article");
    this.name = "LinkedRowArticleMismatchError";
  }
}

export class LinkedRowNotManufacturedError extends Error {
  constructor() {
    super("The linked sales order row's article is not a manufactured article");
    this.name = "LinkedRowNotManufacturedError";
  }
}

export class LinkedOrderStatusError extends Error {
  constructor(status: string) {
    super(`Cannot create a linked manufacturing order for a sales order in status "${status}"`);
    this.name = "LinkedOrderStatusError";
  }
}

// E3 (KO→TO-koppling): thrown by createFromSalesOrderRow when the row's
// default quantity (quantityOrdered − coverage) is ≤ 0 — nothing left of the
// row to put into production. Only applies to the derived default; an
// explicit quantity bypasses this check.
export class NothingLeftToManufactureError extends Error {
  constructor(rowId: string) {
    super(`Nothing left to manufacture for sales order row ${rowId}`);
    this.name = "NothingLeftToManufactureError";
  }
}

// Materialbrist vid rapportering: the slice of the system settings the
// manufacturing service reads (app.ts passes systemService). Read outside
// every transaction, like purchaseOverReceiptPercent — a settings change
// racing a report may go either way.
export interface MaterialShortageSettingsReader {
  getSettings(): Promise<{ manufacturingMaterialShortage: ManufacturingMaterialShortage }>;
}

// Swedish labels for the printout — the UI's status pills use the same words.
const MO_STATUS_LABELS: Record<string, string> = {
  planned: "Planerad",
  released: "Frisläppt",
  in_progress: "Pågår",
  completed: "Klar",
  closed: "Stängd",
  cancelled: "Makulerad",
};

// createManufacturingService is constructed in well over a dozen unrelated
// test files across payroll/timereport/planning/reports/purchase (it's the
// order-lifecycle service every cross-module fixture needs a working
// release() from) — most have no reason to wire up a real AuditWriter just
// to release an order in passing. `audit` therefore defaults to a no-op
// rather than being a hard requirement; app.ts always passes the real
// auditRepository, and manufacturing.service.test.ts wires it for real too.
const NOOP_AUDIT: AuditWriter = { async log() {} };

// Stämpelterminalens operationslista (GET /terminal/operations). No prices —
// the terminal is a shop-floor profile.
export interface TerminalMaterial {
  articleId: string;
  articleNumber: string;
  articleName: string;
}
export interface TerminalOperation {
  operationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  sequenceNo: number;
  description: string | null;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  orderQuantity: string;
  quantityCompleted: string | null;
  quantityScrapped: string;
  dueDate: string | null;
  // Produktionsplanering: the operation's planned weeks (Mondays), null when
  // unplanned — the terminal sorts on the start week.
  plannedStartWeek: string | null;
  plannedEndWeek: string | null;
  readiness: Readiness;
  // What can be worked on per the readiness rule (terminal-readiness.ts).
  available: string;
  // Linked materials (mo_material_consumptions.mo_operation_id), sorted by
  // article number.
  materials: TerminalMaterial[];
  packingInstructions: string | null;
}

export function createManufacturingService(
  repo: ManufacturingRepository,
  pdf: DocumentPdfService,
  articleFiles: ArticleFileReader & {
    // articles.rounding (Avrundning): the step the TO quantity is rounded up
    // to at creation — app.ts and every test pass the article service, which
    // implements this structurally (same inline extension as sales/purchase).
    // configuratorMode: a template in mode variants is refused as a new TO's
    // article (assertOrderableArticle in createManufacturingOrder).
    getArticle(
      id: string
    ): Promise<{ id: string; articleNumber: string; rounding: string | null; configuratorMode: "variants" | "to_order" | null } | null>;
  },
  salesOrders: SalesOrderLinkReader,
  audit: AuditWriter = NOOP_AUDIT,
  // Konfigurator 4c: optional so the many cross-module fixtures that only
  // need a working release() keep building the service with five arguments;
  // app.ts always wires the configurator's deriveForManufacturing.
  configuredStructure?: ConfiguredStructureReader,
  // Ångra rapportering removes a stamp's time report, which the payroll
  // period lock guards — optional for the same fixture reason as `audit`.
  periodLocks?: PeriodLockChecker,
  // Materialbrist vid rapportering — optional for the same reason: omitted
  // means mode "none", exactly what every report did before the setting.
  settings?: MaterialShortageSettingsReader,
  // Produktionsplanering: plans a new TO inside its create transaction and
  // summarises the plan for the list — bound late in app.ts (the planning
  // service is built after this one). Omitted: TOs are created unplanned and
  // the list carries nulls, exactly as before the plan existed.
  planning?: ManufacturingPlanReader
) {
  // The check every drawing report runs with: the configured mode and the
  // caller's override flag (meaningful in "warn" only).
  async function materialShortageCheck(allow: boolean | undefined): Promise<MaterialShortageCheck> {
    const mode = settings ? (await settings.getSettings()).manufacturingMaterialShortage : "none";
    return { mode, allow: allow === true };
  }

  // Dry-runs an operation report (see repo.dryRunOperationReport) and throws
  // the shortages it would run into, for the callers whose report cannot be
  // refused inside its own transaction. `preflightInBlockMode` says whether
  // "block" is checked up front too (the terminal) or left to the real
  // report's in-transaction refusal (the lego receipt).
  async function assertMaterialBeforeReport(
    operationId: string,
    input: ReportOperationQuantitiesInput,
    allow: boolean | undefined,
    preflightInBlockMode: boolean
  ) {
    const check = await materialShortageCheck(allow);
    if (check.mode === "none") return;
    if (check.mode === "warn" && check.allow) return;
    if (check.mode === "block" && !preflightInBlockMode) return;
    const shortages = await repo.dryRunOperationReport(operationId, input);
    if (shortages.length > 0) throw new MaterialShortageError(shortages, check.mode === "warn");
  }

  // Ångra rapportering's failure reasons as the domain errors the routes map.
  function assertReportUndone(result: UndoReportResult, reportId: string): Extract<UndoReportResult, { ok: true }> {
    if (result.ok) return result;
    switch (result.reason) {
      case "report_not_found":
        throw new MoReportNotFoundError(reportId);
      case "already_undone":
        throw new MoReportAlreadyUndoneError();
      case "from_purchase_receipt":
        throw new MoReportFromPurchaseReceiptError();
      case "invalid_status":
        throw new InvalidStatusTransitionError("Reports can only be undone while the order is open or done");
      case "insufficient_stock":
        throw new MoReportStockMissingError(result.available, result.required);
    }
  }

  async function logReportUndone(result: Extract<UndoReportResult, { ok: true }>, userId: string) {
    const { order, report: undone, timeReport, statusBefore } = result;
    await audit.log({
      entityType: "manufacturing_order",
      entityId: order.orderNumber,
      action: "report_undone",
      detail: {
        reportId: undone.id,
        kind: undone.kind,
        moOperationId: undone.moOperationId,
        quantityOk: Number(undone.quantityOk),
        quantityScrapped: Number(undone.quantityScrapped),
        quantityReceived: Number(undone.quantityReceived),
        hours: timeReport ? Number(timeReport.hours) : null,
        ...(statusBefore !== order.status ? { statusBefore, statusAfter: order.status } : {}),
      },
      userId,
    });
    if (timeReport) {
      await audit.log({
        entityType: "time_report",
        entityId: timeReport.id,
        action: "deleted",
        detail: {
          employeeId: timeReport.employeeId,
          moOperationId: timeReport.moOperationId,
          date: timeReport.date,
          hours: timeReport.hours,
          reason: "report_undone",
        },
        userId,
      });
    }
  }

  // What createManufacturingOrder validates and derives BEFORE the create
  // transaction (a plain committed read, not part of the transaction — same
  // "validate first" shape as every other guard in this file): the linked
  // KO row, the article's rounding/template mode and a beställningsvara's
  // derived structure. Shared by the Tx variant.
  async function prepareCreate(input: CreateManufacturingOrderInput) {
    let articleId = input.articleId;
    let linkedSalesOrderId: string | undefined;
    let linkedRow: Awaited<ReturnType<SalesOrderLinkReader["findRowForManufacturing"]>> = null;

    if (input.salesOrderRowId) {
      const row = await salesOrders.findRowForManufacturing(input.salesOrderRowId);
      if (!row) throw new LinkedRowNotFoundError(input.salesOrderRowId);
      if (input.articleId && input.articleId !== row.articleId) throw new LinkedRowArticleMismatchError();
      if (row.articleType !== "manufactured") throw new LinkedRowNotManufacturedError();
      if (row.orderStatus !== "confirmed" && row.orderStatus !== "in_production") {
        throw new LinkedOrderStatusError(row.orderStatus);
      }
      articleId = row.articleId;
      linkedSalesOrderId = row.salesOrderId;
      linkedRow = row;
    }

    // Avrundning: the TO quantity (always in the base unit) is rounded up
    // to the article's step — the same roundUpToMultiple behovsberäkningen
    // applies to its proposals, so a planned TO matches its proposal.
    // createFromSalesOrderRow delegates here and inherits it.
    const article = await articleFiles.getArticle(articleId!);
    // Produktkonfigurator: a template in mode variants never gets a TO —
    // also for the KO row's Skapa TO on a row that predates the mode.
    if (article) assertOrderableArticle(article);
    const quantity = roundUpToMultiple(input.quantity, article?.rounding);

    // Konfigurator 4c: a beställningsvara's TO carries its derived structure
    // from creation. With a sales order row the ROW owns the choices; without
    // one (Ny tillverkningsorder) the body does. The derivation runs here,
    // BEFORE the repo's transaction (never inside another module's tx) —
    // the tx only re-checks the row's key under the row lock.
    let configured: Parameters<ManufacturingRepository["createManufacturingOrder"]>[3];
    if (article?.configuratorMode === "to_order") {
      if (input.salesOrderRowId && input.configuration) throw new ConfigurationNotAllowedError(article.articleNumber);
      const rowConfiguration = linkedRow?.configuration ?? null;
      if (input.salesOrderRowId && !rowConfiguration) throw new ConfigurationRequiredError(article.articleNumber);
      if (!input.salesOrderRowId && !input.configuration) throw new ConfigurationRequiredError(article.articleNumber);
      if (!configuredStructure) throw new Error("ConfiguredStructureReader not wired");
      const selection = rowConfiguration ? selectionFromEntries(rowConfiguration.selection) : input.configuration!.selection;
      const structure = await configuredStructure(articleId!, selection, quantity);
      if (!structure.valid || structure.key === null) throw new ConfiguratorInvalidConfigurationError(structure.errors);
      configured = {
        configuration: {
          templateArticleId: articleId!,
          key: structure.key,
          // The row's entries are copied as stored (frozen labels, as on the
          // row's documents); a free TO takes the derivation's own.
          selection: rowConfiguration ? rowConfiguration.selection : structure.selection,
          cost: {
            manufacturingCostPerUnit: structure.cost?.manufacturingCostPerUnit ?? null,
            calculatedAt: new Date().toISOString(),
          },
        },
        operations: structure.operations,
        materials: structure.materials,
        // The key is canonical for the choices, so an unchanged row yields
        // the same key. A template change that alters the key for the same
        // choices (a new default, say) is refused the same way — the TO is
        // never built on other choices than the row's; the user runs Ändra
        // konfiguration.
        ...(rowConfiguration && input.salesOrderRowId
          ? { lockRow: { rowId: input.salesOrderRowId, expectedKey: structure.key, lock: salesOrders.lockRowForManufacturing } }
          : {}),
      };
    } else if (linkedRow?.configuration) {
      // The row was configured on a beställningsvara whose template has
      // since left the mode (or lost its template). An ordinary TO would
      // release on the template's own BOM and silently drop the row's
      // choices — refuse instead; the user re-plans the row.
      throw new ConfiguratorNotToOrderModeError();
    } else if (input.configuration) {
      throw new ConfigurationNotAllowedError(article?.articleNumber ?? articleId!);
    }

    return {
      articleId: articleId!,
      quantity,
      linkedSalesOrder: linkedSalesOrderId
        ? { salesOrderId: linkedSalesOrderId, markInProduction: salesOrders.markInProduction }
        : undefined,
      configured,
    };
  }

  return {
    async createWorkCenter(input: CreateWorkCenterInput) {
      if (await repo.findWorkCenterByCode(input.code)) throw new DuplicateWorkCenterCodeError(input.code);
      if (input.productionGroupId && !(await repo.findProductionGroupById(input.productionGroupId))) {
        throw new ProductionGroupNotFoundError(input.productionGroupId);
      }
      try {
        return await repo.createWorkCenter(input);
      } catch (err) {
        // The hand-added FK is the existence check (atomic, no extra reader
        // dependency — the E3 constraint-catch pattern).
        if (isForeignKeyViolation(err, "work_centers_week_schedule_id_week_schedules_id_fk")) {
          throw new WeekScheduleNotFoundError(input.weekScheduleId ?? "");
        }
        if (isForeignKeyViolation(err, "work_centers_supplier_id_suppliers_id_fk")) {
          throw new WorkCenterSupplierNotFoundError(input.supplierId ?? "");
        }
        throw err;
      }
    },

    async getWorkCenter(id: string) {
      return repo.findWorkCenterById(id);
    },

    // Terminalens operationslista — see terminal-readiness.ts for the rule.
    // The readiness is computed over ALL operations of each order, so a
    // station filter never hides the previous operation from the rule.
    async listTerminalOperations(q: {
      workCenterIds?: string[];
      materialArticleId?: string;
    }): Promise<{ rows: TerminalOperation[]; materials: TerminalMaterial[] }> {
      const { listed, siblings, materials } = await repo.terminalOperationRows(q.workCenterIds);
      const byOrder = new Map<string, typeof siblings>();
      for (const s of siblings) byOrder.set(s.manufacturingOrderId, [...(byOrder.get(s.manufacturingOrderId) ?? []), s]);
      const readiness = new Map<string, ReadinessResult>();
      for (const row of listed) {
        if (readiness.has(row.operationId)) continue;
        for (const [id, r] of computeReadiness(Number(row.orderQuantity), byOrder.get(row.manufacturingOrderId) ?? [])) {
          readiness.set(id, r);
        }
      }
      const byArticleNumber = (a: TerminalMaterial, b: TerminalMaterial) => a.articleNumber.localeCompare(b.articleNumber, "sv");
      const materialsByOp = new Map<string, TerminalMaterial[]>();
      for (const m of materials) {
        if (!m.moOperationId) continue;
        materialsByOp.set(m.moOperationId, [
          ...(materialsByOp.get(m.moOperationId) ?? []),
          { articleId: m.articleId, articleNumber: m.articleNumber, articleName: m.articleName },
        ]);
      }
      const rows: TerminalOperation[] = listed.map((row) => {
        const r = readiness.get(row.operationId)!;
        return {
          ...row,
          readiness: r.readiness,
          available: String(r.available),
          materials: (materialsByOp.get(row.operationId) ?? []).sort(byArticleNumber),
        };
      });
      // The picker lists the materials BEFORE the material filter, so
      // choosing one never empties the list of alternatives.
      const unique = new Map(rows.flatMap((r) => r.materials).map((m) => [m.articleId, m]));
      return {
        rows: q.materialArticleId ? rows.filter((r) => r.materials.some((m) => m.articleId === q.materialArticleId)) : rows,
        materials: [...unique.values()].sort(byArticleNumber),
      };
    },

    // Stations for the terminal in natural number order: purely numeric codes
    // numerically ("90" before "100"), other codes after them alphabetically.
    async listTerminalStations() {
      const isNumeric = (code: string) => /^\d+$/.test(code);
      return (await repo.terminalStations()).sort((a, b) => {
        if (isNumeric(a.code) && isNumeric(b.code)) return Number(a.code) - Number(b.code);
        if (isNumeric(a.code) !== isNumeric(b.code)) return isNumeric(a.code) ? -1 : 1;
        return a.code.localeCompare(b.code, "sv");
      });
    },

    async listWorkCenters(query?: ListWorkCentersQuery) {
      return repo.listWorkCenters(query);
    },

    async updateWorkCenter(id: string, input: UpdateWorkCenterInput) {
      // A work center may of course keep its own number, so a conflict only
      // counts when the code sits on a different row.
      if (input.code !== undefined) {
        const byCode = await repo.findWorkCenterByCode(input.code);
        if (byCode && byCode.id !== id) throw new DuplicateWorkCenterCodeError(input.code);
      }
      if (input.productionGroupId != null && !(await repo.findProductionGroupById(input.productionGroupId))) {
        throw new ProductionGroupNotFoundError(input.productionGroupId);
      }

      let row;
      try {
        row = await repo.updateWorkCenter(id, input);
      } catch (err) {
        if (isForeignKeyViolation(err, "work_centers_week_schedule_id_week_schedules_id_fk")) {
          throw new WeekScheduleNotFoundError(input.weekScheduleId ?? "");
        }
        if (isForeignKeyViolation(err, "work_centers_supplier_id_suppliers_id_fk")) {
          throw new WorkCenterSupplierNotFoundError(input.supplierId ?? "");
        }
        throw err;
      }
      if (!row) throw new WorkCenterNotFoundError(id);
      return row;
    },

    async createProductionGroup(input: CreateProductionGroupInput) {
      try {
        return await repo.createProductionGroup(input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateProductionGroupCodeError(input.code);
        throw err;
      }
    },

    async updateProductionGroup(id: string, input: UpdateProductionGroupInput) {
      try {
        const row = await repo.updateProductionGroup(id, input);
        if (!row) throw new ProductionGroupNotFoundError(id);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateProductionGroupCodeError(input.code ?? "");
        throw err;
      }
    },

    async listProductionGroups() {
      return repo.listProductionGroups();
    },

    async getProductionGroup(id: string) {
      const group = await repo.findProductionGroupById(id);
      if (!group) throw new ProductionGroupNotFoundError(id);
      const groupWorkCenters = await repo.listProductionGroupWorkCenters(id);
      return { ...group, workCenters: groupWorkCenters };
    },

    async setProductionGroupWorkCenters(id: string, input: SetProductionGroupWorkCentersInput) {
      const group = await repo.findProductionGroupById(id);
      if (!group) throw new ProductionGroupNotFoundError(id);
      await repo.setProductionGroupWorkCenters(id, input.workCenterIds);
      return repo.listProductionGroupWorkCenters(id);
    },

    async createRoutingOperation(articleId: string, input: CreateRoutingOperationInput) {
      // Lego fields only make sense on a legoresurs — refuse them elsewhere
      // rather than silently storing prices no calculation would ever read.
      const workCenter = await repo.findWorkCenterById(input.workCenterId);
      if (!workCenter) throw new WorkCenterNotFoundError(input.workCenterId);
      const hasLegoFields =
        input.subcontractSupplierId != null ||
        input.setupPrice != null ||
        input.unitPrice != null ||
        input.showNetWeight === true ||
        input.useArticleDrawing === false;
      if (workCenter.type !== "subcontract" && hasLegoFields) throw new NotSubcontractOperationError();
      // Default the operation's supplier from the resource when not given.
      const withDefaults =
        workCenter.type === "subcontract" && input.subcontractSupplierId === undefined
          ? { ...input, subcontractSupplierId: workCenter.supplierId }
          : input;
      try {
        return await repo.createRoutingOperation(articleId, withDefaults);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateSequenceNoError();
        if (isForeignKeyViolation(err, "routing_operations_subcontract_supplier_id_suppliers_id_fk")) {
          throw new WorkCenterSupplierNotFoundError(input.subcontractSupplierId ?? "");
        }
        throw err;
      }
    },

    async listRoutingOperations(articleId: string) {
      return repo.listRoutingOperationsByArticle(articleId);
    },

    // Never 404s (and never checks article existence) — an article with no
    // lego operations, or no operations at all, just yields [].
    async listLegoOperationOptions(articleId: string): Promise<LegoOperationOption[]> {
      const { routing, mo } = await repo.listLegoOperationOptions(articleId);
      const routingOptions: LegoOperationOption[] = routing.map((r) => ({
        key: `routing:${r.id}`,
        kind: "routing",
        routingOperationId: r.id,
        moOperationId: null,
        label: r.description ? `Op ${r.sequenceNo} · ${r.description} (beredning)` : `Op ${r.sequenceNo} (beredning)`,
        supplierId: r.supplierId,
        setupPrice: r.setupPrice,
        unitPrice: r.unitPrice,
      }));
      const moOptions: LegoOperationOption[] = mo.map((m) => ({
        key: `mo:${m.moOperationId}`,
        kind: "mo",
        routingOperationId: m.routingOperationId,
        moOperationId: m.moOperationId,
        label: m.description
          ? `${m.orderNumber} · Op ${m.sequenceNo} · ${m.description}`
          : `${m.orderNumber} · Op ${m.sequenceNo}`,
        supplierId: m.supplierId,
        setupPrice: m.setupPrice,
        unitPrice: m.unitPrice,
      }));
      return [...routingOptions, ...moOptions];
    },

    // Editing routing only affects future releases — released MOs keep their
    // mo_operations snapshot untouched.
    async updateRoutingOperation(articleId: string, operationId: string, input: UpdateRoutingOperationInput) {
      if (input.costingOnly === true && (await repo.countBomComponentsForOperation(operationId)) > 0) {
        throw new OperationHasLinkedMaterialError();
      }

      // Lego guard — the effective resource decides whether lego fields are
      // legal. Switching to a non-lego resource clears them (and any
      // incoming non-null lego value alongside such a switch is refused).
      let patch = input;
      const existing = await repo.findRoutingOperation(articleId, operationId);
      if (!existing) throw new RoutingOperationNotFoundError(operationId);
      const workCenterId = input.workCenterId ?? existing.workCenterId;
      const workCenter = await repo.findWorkCenterById(workCenterId);
      if (!workCenter) throw new WorkCenterNotFoundError(workCenterId);
      if (workCenter.type !== "subcontract") {
        const hasLegoFields =
          input.subcontractSupplierId != null ||
          input.setupPrice != null ||
          input.unitPrice != null ||
          input.showNetWeight === true ||
          input.useArticleDrawing === false;
        if (hasLegoFields) throw new NotSubcontractOperationError();
        patch = {
          ...input,
          subcontractSupplierId: null,
          setupPrice: null,
          unitPrice: null,
          showNetWeight: false,
          useArticleDrawing: true,
        };
      }

      try {
        const row = await repo.updateRoutingOperation(articleId, operationId, patch);
        if (!row) throw new RoutingOperationNotFoundError(operationId);
        return row;
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateSequenceNoError();
        if (isForeignKeyViolation(err, "routing_operations_subcontract_supplier_id_suppliers_id_fk")) {
          throw new WorkCenterSupplierNotFoundError(input.subcontractSupplierId ?? "");
        }
        throw err;
      }
    },

    // --- Lego operation drawing (one PDF/JPEG/PNG per operation) ---

    async getOperationFileMeta(articleId: string, operationId: string) {
      const operation = await repo.findRoutingOperation(articleId, operationId);
      if (!operation) throw new RoutingOperationNotFoundError(operationId);
      return repo.findOperationFileMeta(operationId);
    },

    async downloadOperationFile(articleId: string, operationId: string) {
      const operation = await repo.findRoutingOperation(articleId, operationId);
      if (!operation) throw new RoutingOperationNotFoundError(operationId);
      const file = await repo.getOperationFileWithData(operationId);
      if (!file) throw new OperationFileNotFoundError(operationId);
      return file;
    },

    async putOperationFile(
      articleId: string,
      operationId: string,
      file: { filename: string; contentType: string; data: Buffer }
    ) {
      const operation = await repo.findRoutingOperation(articleId, operationId);
      if (!operation) throw new RoutingOperationNotFoundError(operationId);
      if (!(ALLOWED_OPERATION_FILE_TYPES as readonly string[]).includes(file.contentType)) {
        throw new InvalidOperationFileTypeError(file.contentType);
      }
      return repo.upsertOperationFile(operationId, {
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.data.length,
        data: file.data,
      });
    },

    async deleteOperationFile(articleId: string, operationId: string) {
      const operation = await repo.findRoutingOperation(articleId, operationId);
      if (!operation) throw new RoutingOperationNotFoundError(operationId);
      const deleted = await repo.deleteOperationFile(operationId);
      if (!deleted) throw new OperationFileNotFoundError(operationId);
    },

    async removeRoutingOperation(articleId: string, operationId: string) {
      const row = await repo.deleteRoutingOperation(articleId, operationId);
      if (!row) throw new RoutingOperationNotFoundError(operationId);
    },

    // E3 (KO→TO-koppling): when salesOrderRowId is given, the row is read
    // and validated BEFORE the repo's create-tx starts (a plain committed
    // read, not part of the transaction — same "validate first" shape as
    // every other guard in this file). articleId may be omitted and is then
    // derived from the row; if both are given they must agree. On success,
    // the repo's create-tx stamps salesOrderRowId and flips the KO to
    // in_production as its last step, atomically with the MO insert.
    async createManufacturingOrder(input: CreateManufacturingOrderInput, createdBy: string | null) {
      const prepared = await prepareCreate(input);
      const result = await repo.createManufacturingOrder(
        { ...input, articleId: prepared.articleId, quantity: prepared.quantity },
        createdBy,
        prepared.linkedSalesOrder,
        prepared.configured,
        planning ? (tx, moId) => planning.planNewOrderInTx(tx, moId) : undefined
      );
      if (!result.ok) throw new RowConfigurationChangedError();
      await audit.log({ entityType: "manufacturing_order", entityId: result.order.orderNumber, action: "released", userId: createdBy });
      // releaseWarnings: the same shortage warnings Släpp returns, plus the
      // plan's (horizon, Sen).
      return { ...result.order, releaseWarnings: result.warnings };
    },

    // The same inside a caller's transaction (the reservation creates a
    // whole tree of TOs atomically). The validation and the configurator's
    // derivation read as plain committed reads, like createManufacturingOrder;
    // the repository body takes the production_plan lock first. With
    // `plannedWeeks` (by sequence number) the allocations are written as
    // given instead of planned by the engine. Logs nothing — the caller
    // writes its own händelselogg (and "released" per TO if it wants it).
    async createManufacturingOrderInTx(
      tx: Tx,
      input: CreateManufacturingOrderInput,
      createdBy: string | null,
      opts: { plannedWeeks?: { sequenceNo: number; weeks: PlannedWeek[] }[] } = {}
    ) {
      const prepared = await prepareCreate(input);
      const result = await repo.createManufacturingOrderInTx(
        tx,
        { ...input, articleId: prepared.articleId, quantity: prepared.quantity },
        createdBy,
        prepared.linkedSalesOrder,
        prepared.configured,
        planning ? (t, moId) => planning.planNewOrderInTx(t, moId, opts.plannedWeeks) : undefined
      );
      if (!result.ok) throw new RowConfigurationChangedError();
      return { ...result.order, releaseWarnings: result.warnings };
    },

    // E3 (KO→TO-koppling): thin passthrough used only by the route to
    // validate that a rowId belongs to the salesOrderId in the URL (404
    // otherwise) — same reader the createManufacturingOrder link path above
    // already depends on, just exposed for that one pre-check.
    async getLinkedSalesOrderRow(rowId: string) {
      return salesOrders.findRowForManufacturing(rowId);
    },

    // E3 (KO→TO-koppling, Task 5): thin pass-through exposing the repo's
    // coverage lookup as the manufacturingCoverage dependency sales' service
    // consumes (ManufacturingCoverageReader in sales.service.ts — keep the
    // two interfaces in sync by hand) to enrich listRows with per-row
    // "I tillverkning" quantity + the linked, non-cancelled TO list.
    async coverageForSalesOrderRows(rowIds: string[]) {
      return repo.coverageForSalesOrderRows(rowIds);
    },

    // E3 (KO→TO-koppling): "Skapa TO" from a KO row. Quantity defaults to
    // the row's remaining balance — quantityOrdered minus what's already
    // covered by non-cancelled linked MOs — so the button naturally proposes
    // "what's left" (create a TO on 4 of 10, next default offers 6).
    // Explicit quantity bypasses the coverage check entirely (a deliberate
    // manual override, same latitude createManufacturingOrder itself gives).
    // Delegates to createManufacturingOrder, which re-validates the row
    // (existence/article/order-status) and performs the actual insert +
    // autoflip.
    async createFromSalesOrderRow(
      rowId: string,
      input: { quantity?: number; dueDate?: string | null },
      createdBy: string | null
    ) {
      let quantity = input.quantity;
      if (quantity === undefined) {
        const row = await salesOrders.findRowForManufacturing(rowId);
        if (!row) throw new LinkedRowNotFoundError(rowId);
        const coverage = await repo.coverageForSalesOrderRows([rowId]);
        const covered = coverage.get(rowId)?.quantity ?? 0;
        // round4 before the guard: quantityOrdered/covered are numeric(14,4)
        // round-tripped through JS floats, so an exact-zero remainder (e.g.
        // 0.3 ordered, 0.1 + 0.2 already covered) can surface as a tiny
        // positive float (2e-15) that would slip past `<= 0` and create a
        // TO for a quantity numeric(14,4) rounds back down to 0.0000.
        // toUnitQuantity(x, null) is exactly round4(x) (factor null → ×1).
        quantity = toUnitQuantity(row.quantityOrdered - covered, null);
        if (quantity <= 0) throw new NothingLeftToManufactureError(rowId);
      }
      return this.createManufacturingOrder({ salesOrderRowId: rowId, quantity, dueDate: input.dueDate }, createdBy);
    },

    // E3 (KO→TO-koppling, Task 6): the detail card's "Kundorder" field —
    // looked up via the same findRowForManufacturing reader the create-link
    // path already depends on (radens id lever på TO:n som salesOrderRowId),
    // null for an unlinked order. No new dependency.
    async updateManufacturingOrder(id: string, input: UpdateManufacturingOrderInput, userId: string | null = null) {
      const order = await repo.findManufacturingOrderById(id);
      if (!order) throw new ManufacturingOrderNotFoundError(id);
      // The planned finish date is only meaningful while work can still
      // happen — done/closed/cancelled orders keep their history untouched.
      if (!["planned", "released", "in_progress"].includes(order.status)) {
        throw new InvalidStatusTransitionError(
          `Cannot update the planned finish date of a ${order.status} order`
        );
      }
      const updated = (await repo.updateManufacturingOrder(id, { dueDate: input.dueDate }))!;
      // Only the planned finish date is editable today (see
      // updateManufacturingOrderSchema) — only log when it actually moved.
      if (updated.dueDate !== order.dueDate) {
        await audit.log({
          entityType: "manufacturing_order",
          entityId: order.orderNumber,
          action: "updated",
          detail: { before: { dueDate: order.dueDate }, after: { dueDate: updated.dueDate } },
          userId,
        });
      }
      return updated;
    },

    async getManufacturingOrder(id: string) {
      const order = await repo.findManufacturingOrderById(id);
      if (!order) return null;
      let salesOrder: { id: string; orderNumber: string; customerName: string } | null = null;
      if (order.salesOrderRowId) {
        const row = await salesOrders.findRowForManufacturing(order.salesOrderRowId);
        if (row) salesOrder = { id: row.salesOrderId, orderNumber: row.orderNumber, customerName: row.customerName };
      }
      // Produktionsplanering: the same plan summary as the list rows.
      const summary = planning ? (await planning.orderPlanSummaries([order.id])).get(order.id) : undefined;
      return {
        ...order,
        salesOrder,
        plannedStartWeek: summary?.plannedStartWeek ?? null,
        plannedEndWeek: summary?.plannedEndWeek ?? null,
        late: summary?.late ?? false,
      };
    },

    // Produktionsplanering: each row carries plannedStartWeek/plannedEndWeek
    // (min/max over its pending operations' planned weeks) and late (Sen)
    // from the plan — nulls/false without a plan reader or a plan.
    async listManufacturingOrders(query: ListManufacturingOrdersQuery) {
      const result = await repo.listManufacturingOrders(query);
      const summaries = planning ? await planning.orderPlanSummaries(result.rows.map((row) => row.id)) : new Map();
      return {
        ...result,
        rows: result.rows.map((row) => {
          const summary = summaries.get(row.id);
          return {
            ...row,
            plannedStartWeek: summary?.plannedStartWeek ?? null,
            plannedEndWeek: summary?.plannedEndWeek ?? null,
            late: summary?.late ?? false,
          };
        }),
      };
    },

    async listMaterialConsumptions(moId: string) {
      return repo.listMaterialConsumptions(moId);
    },

    async listOperations(moId: string) {
      return repo.listOperations(moId);
    },

    async getOperation(operationId: string) {
      return repo.findOperationById(operationId);
    },

    async release(moId: string, userId: string | null = null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      if (order.status !== "planned") {
        throw new InvalidStatusTransitionError(`Cannot release an order in status "${order.status}"`);
      }
      const result = await repo.release(moId);
      await audit.log({ entityType: "manufacturing_order", entityId: order.orderNumber, action: "released", userId });
      return result!;
    },

    async start(moId: string, userId: string | null = null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      if (order.status !== "released") {
        throw new InvalidStatusTransitionError(`Cannot start an order in status "${order.status}"`);
      }
      const updated = await repo.updateStatus(moId, "in_progress");
      await audit.log({ entityType: "manufacturing_order", entityId: order.orderNumber, action: "started", userId });
      return updated;
    },

    // Makulera order: planned, released or under way, but only while
    // nothing is booked against it (see repo.cancel) — reports are undone
    // first, so no material or goods are left hanging on a cancelled order.
    async cancel(moId: string, userId: string | null = null) {
      const result = await repo.cancel(moId);
      if (!result.ok) {
        switch (result.reason) {
          case "order_not_found":
            throw new ManufacturingOrderNotFoundError(moId);
          case "invalid_status":
            throw new InvalidStatusTransitionError("Only a planned, released or in-progress order can be cancelled");
          case "has_reports":
            throw new ManufacturingOrderHasReportsError();
          case "open_stamps":
            throw new ManufacturingOrderStampedInError();
        }
      }
      await audit.log({ entityType: "manufacturing_order", entityId: result.order.orderNumber, action: "cancelled", userId });
      return result.order;
    },

    async listReports(moId: string) {
      return repo.listReports(moId);
    },

    // A stamp-out with nothing to report — see repo.logTimeOnlyReport.
    async logTimeOnlyReport(
      operationId: string,
      input: { timeReportId: string; employeeId: string; createdBy: string | null }
    ) {
      return repo.logTimeOnlyReport(operationId, input);
    },

    // Ångra rapportering: reverses exactly what one report booked (see
    // repo.undoReport). The stamp's time report goes too, so a locked
    // payroll period refuses the whole undo.
    async undoReport(moId: string, reportId: string, userId: string) {
      const report = await repo.findReportById(reportId);
      if (!report || report.manufacturingOrderId !== moId) throw new MoReportNotFoundError(reportId);
      if (report.timeReportId && periodLocks) {
        const timeReport = await repo.findTimeReportById(report.timeReportId);
        if (timeReport && (await periodLocks.isDateLocked(timeReport.date))) {
          throw new MoReportTimeLockedError(timeReport.date);
        }
      }

      const result = assertReportUndone(await repo.undoReport(reportId, { undoneBy: userId }), reportId);
      await logReportUndone(result, userId);
      return result.order;
    },

    // Ångra inleverans on the IO: undoes a lego receipt's report inside the
    // purchase undo's transaction. Throws the same domain errors as
    // undoReport — rolling the IO undo back with it — and returns the audit
    // write, to run once that transaction has committed.
    async undoPurchaseReceiptReportInTx(tx: Tx, reportId: string, userId: string): Promise<() => Promise<void>> {
      const result = assertReportUndone(
        await repo.undoPurchaseReceiptReportInTx(tx, reportId, { undoneBy: userId }),
        reportId
      );
      return () => logReportUndone(result, userId);
    },

    async close(moId: string, userId: string | null = null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      if (order.status !== "done") {
        throw new InvalidStatusTransitionError(`Cannot close an order in status "${order.status}"`);
      }
      const updated = await repo.updateStatus(moId, "closed");
      await audit.log({ entityType: "manufacturing_order", entityId: order.orderNumber, action: "closed", userId });
      return updated;
    },

    async consumeMaterial(moId: string, rowId: string, input: ConsumeMaterialInput, createdBy: string) {
      const result = await repo.consumeMaterial(moId, rowId, {
        locationId: input.locationId,
        quantity: input.quantity,
        createdBy,
        materialShortage: await materialShortageCheck(input.allowMaterialShortage),
      });
      if (result.ok) return result.row;

      switch (result.reason) {
        case "order_not_found":
          throw new ManufacturingOrderNotFoundError(moId);
        case "row_not_found":
          throw new MOMaterialConsumptionNotFoundError(rowId);
        case "invalid_status":
          throw new InvalidStatusTransitionError("Material can only be consumed once the order is released or in progress");
        case "over_consumption":
          throw new OverConsumptionError();
      }
    },

    // Incremental quantity report on an operation — shared by the stamp
    // terminal (every stamp-out) and the MO card. OK + scrapped accumulate,
    // scrap gets a mandatory-reason log row, and the operation's linked
    // material tops up to cover (total OK + total scrapped) units.
    // G1: deliberately NOT audit-logged — every stamp-out would otherwise
    // flood the trail with shop-floor noise, and the resulting quantities
    // already live on the operation (quantity_completed/quantity_scrapped)
    // and in mo_operation_scrap, which is its own read model. The one
    // exception is the order completing itself (delinleverans reached the
    // order quantity): that is the same event as Slutför and logged as such.
    async reportOperationQuantities(
      operationId: string,
      input: {
        quantityOk: number;
        quantityScrapped: number;
        scrapReason?: string;
        actualTime?: number;
        locationId?: string;
        markDone: boolean;
        // See manufacturing.repository.ts: when set, `markDone` is ignored
        // and the operation is marked done only once accumulated
        // quantity_completed reaches the MO's order quantity.
        markDoneWhenCovered?: boolean;
        employeeId?: string;
        createdBy: string | null;
        // Report log (mo_reports): defaults to the TO card.
        source?: ReportSource;
        timeReportId?: string;
        purchaseOrderId?: string;
        // Materialbrist: the client's "Rapportera ändå" after a 409 in mode
        // "warn" (ignored in "block").
        allowMaterialShortage?: boolean;
        // Materialbrist: the caller already ran the dry run
        // (assertMaterialBeforeOperationReport) and has since written
        // things that cannot be left behind — the terminal's time report
        // and closed session — so the real report must not be refused.
        // Skips the check regardless of mode.
        materialShortageChecked?: boolean;
      }
    ) {
      const operation = await repo.findOperationById(operationId);
      if (!operation) throw new MOOperationNotFoundError(operationId);

      const { allowMaterialShortage, materialShortageChecked, ...report } = input;
      const result = await repo.reportOperationQuantities(operationId, {
        ...report,
        source: input.source ?? "card",
        materialShortage: materialShortageChecked ? undefined : await materialShortageCheck(allowMaterialShortage),
      });
      if (result.ok) {
        if (result.receipt?.completed) {
          await audit.log({
            entityType: "manufacturing_order",
            entityId: result.receipt.order.orderNumber,
            action: "completed",
            detail: { quantity: Number(result.receipt.order.quantityReceived), automatic: true },
            userId: input.createdBy,
          });
        }
        return {
          operation: result.operation,
          consumed: result.consumed,
          // Delinleverans: what this report received into stock (0 when it
          // was not the last operation) and whether the order is now done.
          received: result.receipt?.received ?? 0,
          orderCompleted: result.receipt?.completed ?? false,
          // The report log row — a lego receipt links its IO receipt to it.
          reportId: result.reportId,
        };
      }

      switch (result.reason) {
        case "operation_not_found":
          throw new MOOperationNotFoundError(operationId);
        case "order_not_found":
          throw new ManufacturingOrderNotFoundError(operation.manufacturingOrderId);
        case "invalid_status":
          throw new InvalidStatusTransitionError(
            "Operations can only be completed while the order is released or in progress"
          );
      }
    },

    // The MO card's "Slutför operation": an incremental report that flips
    // the operation to done once its accumulated OK covers the order
    // quantity — a partial report leaves it pending, so it stays stampable in
    // the terminal (the same rule a lego receipt uses). Antal klart defaults
    // to what remains of the order quantity, so terminal partials aren't
    // double-counted.
    async completeOperation(operationId: string, input: CompleteOperationInput, createdBy: string) {
      const operation = await repo.findOperationById(operationId);
      if (!operation) throw new MOOperationNotFoundError(operationId);

      const order = await repo.findManufacturingOrderById(operation.manufacturingOrderId);
      if (!order) throw new ManufacturingOrderNotFoundError(operation.manufacturingOrderId);

      const remaining = Math.max(Number(order.quantity) - Number(operation.quantityCompleted ?? 0), 0);
      return this.reportOperationQuantities(operationId, {
        quantityOk: input.quantityCompleted ?? remaining,
        quantityScrapped: input.quantityScrapped ?? 0,
        scrapReason: input.scrapReason,
        actualTime: input.actualTime,
        locationId: input.locationId,
        markDone: true,
        markDoneWhenCovered: true,
        createdBy,
        allowMaterialShortage: input.allowMaterialShortage,
      });
    },

    // Materialbrist for the stamp terminal: the stamp-out writes the time
    // report and closes the session BEFORE the quantity report, as separate
    // operations, so a report refused in its own transaction would leave
    // the person stamped out with nothing reported. This dry-runs the exact
    // report first and throws MaterialShortageError (in "warn" without the
    // flag, and always in "block") while nothing is written yet; the real
    // report then runs with materialShortageChecked. Between the two, stock
    // can still go negative through a report that lands in the window —
    // accepted, the alternative was a stamp-out without a report.
    async assertMaterialBeforeOperationReport(
      operationId: string,
      input: {
        quantityOk: number;
        quantityScrapped: number;
        scrapReason?: string;
        markDone: boolean;
        employeeId?: string;
        createdBy: string | null;
      },
      allow: boolean | undefined
    ) {
      await assertMaterialBeforeReport(operationId, { ...input, source: "terminal" }, allow, true);
    },

    // Materialbrist for a lego receipt (SubcontractOperationReporter): the
    // IO row's receipt commits in its own transaction before the operation
    // report, so in "warn" the question has to come before the goods are
    // booked — a dry run of the receipt's report. In "block" there is no
    // preflight: the receipt stands and the report is refused inside its
    // own transaction, which the receipt surfaces as a warning. The purchase
    // module never sees the modes.
    async assertMaterialBeforeSubcontractReceipt(operationId: string, quantity: number, allow: boolean | undefined) {
      await assertMaterialBeforeReport(
        operationId,
        { quantityOk: quantity, quantityScrapped: 0, markDone: false, markDoneWhenCovered: true, createdBy: null, source: "purchase_receipt" },
        allow,
        false
      );
    },

    async listScrapForOrder(moId: string) {
      return repo.listScrapForOrder(moId);
    },

    async complete(moId: string, input: CompleteManufacturingOrderInput, createdBy: string) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);

      // quantity = what to receive NOW on top of any delinleverans; omitted,
      // the repository takes what remains of the order quantity.
      const result = await repo.complete(moId, {
        locationId: input.locationId,
        quantity: input.quantity,
        createdBy,
        materialShortage: await materialShortageCheck(input.allowMaterialShortage),
      });
      if (result.ok) {
        await audit.log({
          entityType: "manufacturing_order",
          entityId: order.orderNumber,
          action: "completed",
          detail: { quantity: result.received, locationId: input.locationId ?? null },
          userId: createdBy,
        });
        return result.order;
      }

      switch (result.reason) {
        case "order_not_found":
          throw new ManufacturingOrderNotFoundError(moId);
        case "invalid_status":
          throw new InvalidStatusTransitionError(`Cannot complete an order in status "${order.status}"`);
      }
    },

    // Several TO printouts as one document, in the order the ids were given
    // — the behovsberäkning prints every TO it just created in one go.
    // Drawings ride along per order exactly as in the single printout.
    async getManufacturingOrdersPdf(moIds: string[]) {
      const documents: Buffer[] = [];
      for (const moId of moIds) {
        documents.push((await this.getManufacturingOrderPdf(moId)).content);
      }
      return { filename: `tillverkningsordrar-${moIds.length}-st.pdf`, content: await mergePdfs(documents) };
    },

    // Shop-floor printout handed to the operator: order header, operations
    // and material, with the article's drawings appended as extra pages.
    async getManufacturingOrderPdf(moId: string) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);

      const [operations, materials, drawings, salesOrderRow] = await Promise.all([
        repo.listOperations(moId),
        repo.listMaterialConsumptions(moId),
        articleFiles.filesWithData([order.articleId]),
        order.salesOrderRowId ? salesOrders.findRowForManufacturing(order.salesOrderRowId) : Promise.resolve(null),
      ]);

      const quantity = Number(order.quantity);
      // Used to badge each material row with the operation it is consumed
      // at, mirroring the linked-material concept from mo_material_consumptions.
      const seqByOpId = new Map(operations.map((op) => [op.id, op.sequenceNo]));
      const base = await pdf.renderManufacturingOrder({
        orderNumber: order.orderNumber,
        printedAt: new Date(),
        articleNumber: order.articleNumber,
        articleName: order.articleName,
        quantity: order.quantity,
        statusLabel: MO_STATUS_LABELS[order.status] ?? order.status,
        note: order.note,
        salesOrderRef: salesOrderRow
          ? { orderNumber: salesOrderRow.orderNumber, customerName: salesOrderRow.customerName }
          : null,
        dueDate: order.dueDate,
        // Konfigurator 4c: the beställningsvara's choices under the article
        // line — no prices on the shop floor (configurationLines without
        // additions).
        configurationLines: order.configuration
          ? configurationLines((order.configuration as ManufacturingOrderConfiguration).selection)
          : undefined,
        operations: operations.map((op) => ({
          sequenceNo: op.sequenceNo,
          workCenterName: op.workCenterName,
          workCenterCode: op.workCenterCode,
          description: op.description,
          setupTime: op.setupTime,
          runTimePerUnit: op.runTimePerUnit,
          timeUnit: op.timeUnit,
          // MINUTES — setup + run × qty, same unit as the beredning input
          // (costing divides by 60; the PDF prints "min").
          estimatedTime: Number(op.setupTime) + Number(op.runTimePerUnit) * quantity,
          comment: op.comment,
          printOnWorkCard: op.printOnWorkCard,
          packingInstructions: op.packingInstructions,
        })),
        // Printed in the row's unit (quantities are stored in the base unit).
        // Grouped by the operation the material is consumed at (unlinked
        // materials — drawn at final reporting — sort last), then by
        // article number for stable ordering within a group.
        materials: materials
          .map((m) => ({
            articleNumber: m.componentArticleNumber,
            articleName: m.componentName,
            quantityPlanned: String(toUnitQuantity(Number(m.quantityPlanned), m.unitFactor)),
            quantityConsumed: String(toUnitQuantity(Number(m.quantityConsumed), m.unitFactor)),
            unit: m.unitCode,
            operationSequenceNo: m.moOperationId ? seqByOpId.get(m.moOperationId) ?? null : null,
          }))
          .sort((a, b) => {
            const seqA = a.operationSequenceNo ?? Infinity;
            const seqB = b.operationSequenceNo ?? Infinity;
            if (seqA !== seqB) return seqA - seqB;
            return a.articleNumber.localeCompare(b.articleNumber);
          }),
      });

      const content = await appendFilesToPdf(base, drawings);
      return { filename: `${order.orderNumber}.pdf`, content };
    },

    // Pallkort (Etapp F) — printed when an operation is reported and placed
    // on the pallet. Last operation of a KO-linked order → the
    // customer-facing "final" card; anything else → the "internal" card
    // pointing at the next operation. Quantity precedence: explicit
    // ?quantity → the operation's accumulated OK quantity → the order
    // quantity.
    async getOperationPalletCardPdf(moId: string, operationId: string, quantity?: number) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      // A planned order has no mo_operations yet (they are snapshotted at
      // release) — a clear 409 beats an unexplained operation-404.
      if (order.status === "planned") {
        throw new InvalidStatusTransitionError(
          "Pallet cards are only available once the order is released — release the order first"
        );
      }

      const operations = await repo.listOperations(moId);
      const operation = operations.find((op) => op.id === operationId);
      if (!operation) throw new MOOperationNotFoundError(operationId);

      // "Last" = the highest sequence number on the order; "next" = the
      // lowest sequence number after this one.
      const isLast = operations.every((op) => op.sequenceNo <= operation.sequenceNo);
      const next = operations
        .filter((op) => op.sequenceNo > operation.sequenceNo)
        .sort((a, b) => a.sequenceNo - b.sequenceNo)[0];

      const cardQuantity =
        quantity ??
        (Number(operation.quantityCompleted ?? 0) > 0 ? Number(operation.quantityCompleted) : Number(order.quantity));

      const salesOrderRow =
        isLast && order.salesOrderRowId ? await salesOrders.findRowForManufacturing(order.salesOrderRowId) : null;

      const card: PalletCardPdfInput = salesOrderRow
        ? {
            kind: "final",
            articleNumber: order.articleNumber,
            articleName: order.articleName,
            customerName: salesOrderRow.customerName,
            customerOrderNumber: salesOrderRow.customerOrderNumber,
            orderNumber: salesOrderRow.orderNumber,
            quantity: cardQuantity,
            unit: order.articleUnitCode,
          }
        : {
            kind: "internal",
            articleNumber: order.articleNumber,
            articleName: order.articleName,
            orderNumber: order.orderNumber,
            // Same description-over-resource fallback as every other surface
            // that names an operation.
            nextOperation: next ? `${next.sequenceNo} · ${next.description?.trim() || next.workCenterName}` : null,
            quantity: cardQuantity,
            unit: order.articleUnitCode,
          };

      const content = await pdf.renderPalletCard([card]);
      return { filename: `pallkort-${order.orderNumber}-op${operation.sequenceNo}.pdf`, content };
    },
  };
}

export type ManufacturingService = ReturnType<typeof createManufacturingService>;
