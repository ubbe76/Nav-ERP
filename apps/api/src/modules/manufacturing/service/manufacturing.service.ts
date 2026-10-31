import type {
  CompleteManufacturingOrderInput,
  CompleteOperationInput,
  ConsumeMaterialInput,
  CreateManufacturingOrderInput,
  CreateMoMaterialInput,
  CreateMoOperationInput,
  UpdateMoMaterialInput,
  UpdateMoOperationInput,
  ManufacturingOrderConfiguration,
  OrderRowConfiguration,
  UpdateManufacturingOrderInput,
  CreateProductionGroupInput,
  CreateRoutingOperationInput,
  CreateWorkCenterInput,
  ExtraDescriptionDocument,
  ListManufacturingOrdersQuery,
  ListWorkCentersQuery,
  SetProductionGroupWorkCentersInput,
  UpdateProductionGroupInput,
  UpdateRoutingOperationInput,
  UpdateWorkCenterInput,
} from "@navet/shared";
import { linkDeviationInTx } from "../../quality/repository/deviation-link-tx.js";
import { roundUpToMultiple, toUnitQuantity } from "@navet/shared";
import type { ManufacturingMaterialShortage, PalletCardCode } from "@navet/shared";
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
import { extraDescriptionFor } from "../../mail/service/document-pdf.js";
import { appendFilesToPdf, mergePdfs } from "../../mail/service/pdf-merge.js";
import { ArticleNotFoundError, assertOrderableArticle, type ArticleFileReader, type ArticleUnitReader } from "../../article/service/article.service.js";
import type { MaterialRow, OperationRowView } from "../repository/order-edit.js";
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
    // Pallkort: the customer's Kod på pallkort (null = system setting) and
    // the order's chosen delivery address, for the final card.
    customerPalletCardCode: PalletCardCode | null;
    deliveryAddress: { address: string; postalCode: string | null; city: string | null; country: string | null } | null;
  } | null>;
  // Konfigurator 4c: locks the row FOR UPDATE inside the TO's create-tx and
  // returns the key stored at that moment — compared against the key the
  // derivation ran on, so a row reconfigured in between is refused.
  lockRowForManufacturing(
    tx: Tx,
    rowId: string
  ): Promise<{ configurationKey: string | null; quantityOrdered: number; quantityDelivered: number } | null>;
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

// Kassation (Kvalitet): the register has active scrap reasons, so one must be
// chosen (400 scrap-reason-required); without any, a free-text reason.
export class ScrapReasonRequiredError extends Error {
  constructor(registerInUse: boolean) {
    super(registerInUse ? "Välj en kassationsorsak" : "Ange en kassationsorsak när kasserat antal är större än 0");
    this.name = "ScrapReasonRequiredError";
  }
}

// The chosen reason is missing, inactive or not a scrap reason (400).
export class ScrapReasonInvalidError extends Error {
  constructor() {
    super("Kassationsorsaken finns inte, är inaktiv eller gäller inte kassation");
    this.name = "ScrapReasonInvalidError";
  }
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

// Pallkort per rapport: only a live operation report (kind "operation", not
// undone) has a card to print. The code is derived from `name`
// (error-body.ts), so the name carries the agreed code
// "report-has-no-pallet-card" rather than the class name.
export class MoReportNoPalletCardError extends Error {
  constructor() {
    super("Rapporten har inget pallkort — bara en operationsrapport som inte är ångrad kan skrivas ut");
    this.name = "ReportHasNoPalletCardError";
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

// --- Ändra material och operationer på en skapad TO ---------------------

// Only a Frisläppt/Pågår order has a snapshot to edit.
export class ManufacturingOrderNotEditableError extends Error {
  constructor(status: string) {
    super(`Material and operations can only be changed while the order is released or in progress (status "${status}")`);
    this.name = "ManufacturingOrderNotEditableError";
  }
}

// Component swap/removal on a row that has drawn material or report lines.
export class MoMaterialConsumedError extends Error {
  constructor() {
    super("The material row has consumption and can neither change component nor be removed");
    this.name = "MoMaterialConsumedError";
  }
}

export class MoMaterialDuplicateError extends Error {
  constructor() {
    super("The order already has this component on the same operation");
    this.name = "MoMaterialDuplicateError";
  }
}

export class MoMaterialOwnArticleError extends Error {
  constructor() {
    super("The order's own article cannot be its material");
    this.name = "MoMaterialOwnArticleError";
  }
}

export class MoMaterialPhantomError extends Error {
  constructor(articleNumber: string) {
    super(`${articleNumber} is a phantom article and is never stocked — add its components instead`);
    this.name = "MoMaterialPhantomError";
  }
}

export class MoOperationNotOnOrderError extends Error {
  constructor(opId: string) {
    super(`Operation ${opId} does not belong to the order`);
    this.name = "MoOperationNotOnOrderError";
  }
}

export class MoOperationSequenceTakenError extends Error {
  constructor(sequenceNo: number) {
    super(`The order already has an operation with sequence number ${sequenceNo}`);
    this.name = "MoOperationSequenceTakenError";
  }
}

export class MoOperationDoneError extends Error {
  constructor() {
    super("A completed operation cannot be changed");
    this.name = "MoOperationDoneError";
  }
}

export class MoOperationStampedError extends Error {
  constructor() {
    super("Someone is stamped in on the operation — the resource cannot be changed");
    this.name = "MoOperationStampedError";
  }
}

export class MoOperationLinkedPurchaseError extends Error {
  constructor() {
    super("A purchase order or inquiry row points at the operation");
    this.name = "MoOperationLinkedPurchaseError";
  }
}

export class MoOperationReportedError extends Error {
  constructor() {
    super("Something has already been reported on the operation");
    this.name = "MoOperationReportedError";
  }
}

// Finished goods have been received from the last operation: which
// operation is last cannot change any more.
export class LastOperationLockedError extends Error {
  constructor() {
    super("Finished goods have been received from the last operation — it cannot be changed, removed or followed by another");
    this.name = "LastOperationLockedError";
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
// Behovsberäkningens Skapa ordrar on a configured row that already has its
// TOs (a proposal from a list up to a minute old, or a second click) —
// Swedish, since planning shows it as is in its result.
export class ConfiguredRowAlreadyCoveredError extends Error {
  constructor(readonly uncovered: number) {
    super(
      uncovered > 0
        ? `Raden saknar bara ${uncovered} — uppdatera behovsberäkningen och skapa ordern igen`
        : "Raden har redan tillverkningsordrar för hela antalet — uppdatera behovsberäkningen"
    );
    this.name = "ConfiguredRowAlreadyCoveredError";
  }
}

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
  getSettings(): Promise<{
    manufacturingMaterialShortage: ManufacturingMaterialShortage;
    // Kod på pallkort — the default code type on the pallet cards (the
    // customer's own choice wins on the final card). Omitted reader ⇒ none.
    palletCardCode: PalletCardCode;
    // The documents that print Extra benämning (the TO is one of them).
    extraDescriptionDocuments?: ExtraDescriptionDocument[];
  }>;
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

// Lego fields belong to operations on a legoresurs (work center type
// "subcontract") — on any other resource they are refused rather than
// silently stored. ONE rule for the routing (beredning) and the TO's own
// operations (Ändra operationer): `hasLegoFields` says whether the input
// carries any, `clearedLegoFields` is the patch that empties them when an
// operation moves to an ordinary resource.
interface LegoFieldInput {
  subcontractSupplierId?: string | null;
  setupPrice?: number | null;
  transportPrice?: number | null;
  unitPrice?: number | null;
  showNetWeight?: boolean;
  useArticleDrawing?: boolean;
}
function hasLegoFields(input: LegoFieldInput): boolean {
  return (
    input.subcontractSupplierId != null ||
    input.setupPrice != null ||
    input.transportPrice != null ||
    input.unitPrice != null ||
    input.showNetWeight === true ||
    input.useArticleDrawing === false
  );
}
// Throws when the effective resource is not a legoresurs but lego fields
// are given. For a create on a legoresurs, the supplier defaults from the
// resource when not given (the returned object is the input to store).
function assertLegoFieldsForResource<T extends LegoFieldInput>(
  workCenter: { type: string; supplierId: string | null },
  input: T,
  mode: "create" | "update"
): T {
  if (workCenter.type !== "subcontract") {
    if (hasLegoFields(input)) throw new NotSubcontractOperationError();
    return input;
  }
  if (mode === "create" && input.subcontractSupplierId === undefined) {
    return { ...input, subcontractSupplierId: workCenter.supplierId };
  }
  return input;
}
const CLEARED_LEGO_FIELDS = {
  subcontractSupplierId: null,
  setupPrice: null,
  transportPrice: null,
  unitPrice: null,
  showNetWeight: false,
} as const;

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

// Händelseloggen for Ändra material/operationer: the warnings the change got,
// left out when there were none.
const auditWarnings = (warnings: string[]) => (warnings.length > 0 ? { warnings } : {});

export function createManufacturingService(
  repo: ManufacturingRepository,
  pdf: DocumentPdfService,
  articleFiles: ArticleFileReader &
    ArticleUnitReader & {
      // articles.rounding (Avrundning): the step the TO quantity is rounded up
      // to at creation — app.ts and every test pass the article service, which
      // implements this structurally (same inline extension as sales/purchase).
      // configuratorMode: a template in mode variants is refused as a new TO's
      // article (assertOrderableArticle in createManufacturingOrder).
      // isPhantom: a phantom is never a TO's material (Ändra material).
      // resolveUnitSelection (ArticleUnitReader): a material row's unit, the
      // same helper BOM rows use.
      getArticle(id: string): Promise<{
        id: string;
        articleNumber: string;
        rounding: string | null;
        configuratorMode: "variants" | "to_order" | null;
        isPhantom: boolean;
      } | null>;
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
  // Kassationsorsaken — the API decides the rule (it knows the register):
  // with an active Avvikelseorsak for kassation a reasonId is required and
  // the free text is an optional comment; without one the free text is the
  // reason, as before. Checked before anything is written (the terminal runs
  // it in its preflight, before the time report).
  async function assertScrapReason(input: { quantityScrapped: number; scrapReasonId?: string; scrapReason?: string }) {
    if (input.quantityScrapped <= 0) return;
    const rules = await repo.scrapReasonRules(input.scrapReasonId);
    if (input.scrapReasonId) {
      if (!rules.reason || !rules.reason.active || !rules.reason.appliesScrap) throw new ScrapReasonInvalidError();
      return;
    }
    if (rules.registerHasScrapReasons) throw new ScrapReasonRequiredError(true);
    if (!input.scrapReason?.trim()) throw new ScrapReasonRequiredError(false);
  }

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
  async function prepareCreate(input: CreateManufacturingOrderInput, opts: { onlyUncovered?: boolean } = {}) {
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
          ? {
              lockRow: {
                rowId: input.salesOrderRowId,
                expectedKey: structure.key,
                lock: salesOrders.lockRowForManufacturing,
                onlyUncovered: opts.onlyUncovered,
              },
            }
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

  // --- Ändra material och operationer: the helpers the six methods share.

  // A material component: never the order's own article, never a phantom
  // (not stocked — its components are), never a template in mode variants.
  async function assertMaterialComponent(orderArticleId: string, componentArticleId: string) {
    if (componentArticleId === orderArticleId) throw new MoMaterialOwnArticleError();
    const component = await articleFiles.getArticle(componentArticleId);
    if (!component) throw new ArticleNotFoundError(componentArticleId);
    if (component.isPhantom) throw new MoMaterialPhantomError(component.articleNumber);
    assertOrderableArticle(component);
    return component;
  }

  // The unique constraint (component once per operation) is the duplicate
  // guard; the throw rolls the edit's transaction back.
  async function catchMaterialDuplicate<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isUniqueViolation(err, "mo_material_unique_per_operation")) throw new MoMaterialDuplicateError();
      throw err;
    }
  }

  // An operation write's constraint errors: the (order, sequence) unique
  // index backs the pre-check, the supplier FK is the existence check.
  async function catchOperationWriteErrors<T>(input: { sequenceNo?: number; subcontractSupplierId?: string | null }, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (isUniqueViolation(err)) throw new MoOperationSequenceTakenError(input.sequenceNo ?? 0);
      if (isForeignKeyViolation(err, "mo_operations_subcontract_supplier_id_suppliers_id_fk")) {
        throw new WorkCenterSupplierNotFoundError(input.subcontractSupplierId ?? "");
      }
      throw err;
    }
  }

  function materialEditError(
    reason: "order_not_found" | "not_editable" | "row_not_found" | "operation_not_on_order" | "consumed",
    moId: string,
    status: string,
    moOperationId: string | null,
    rowId?: string
  ): Error {
    switch (reason) {
      case "order_not_found":
        return new ManufacturingOrderNotFoundError(moId);
      case "not_editable":
        return new ManufacturingOrderNotEditableError(status);
      case "row_not_found":
        return new MOMaterialConsumptionNotFoundError(rowId ?? "");
      case "operation_not_on_order":
        return new MoOperationNotOnOrderError(moOperationId ?? "");
      case "consumed":
        return new MoMaterialConsumedError();
    }
  }

  function assertMaterialEdited<T extends { ok: true }>(
    result: T | { ok: false; reason: Parameters<typeof materialEditError>[0] },
    moId: string,
    status: string,
    moOperationId: string | null,
    rowId?: string
  ): T {
    if (result.ok) return result;
    throw materialEditError(result.reason, moId, status, moOperationId, rowId);
  }

  function operationEditError(
    reason:
      | "order_not_found"
      | "not_editable"
      | "operation_not_found"
      | "sequence_taken"
      | "done"
      | "stamped"
      | "linked_purchase"
      | "reported"
      | "last_operation_locked",
    moId: string,
    status: string,
    sequenceNo: number,
    opId?: string
  ): Error {
    switch (reason) {
      case "order_not_found":
        return new ManufacturingOrderNotFoundError(moId);
      case "not_editable":
        return new ManufacturingOrderNotEditableError(status);
      case "operation_not_found":
        return new MOOperationNotFoundError(opId ?? "");
      case "sequence_taken":
        return new MoOperationSequenceTakenError(sequenceNo);
      case "done":
        return new MoOperationDoneError();
      case "stamped":
        return new MoOperationStampedError();
      case "linked_purchase":
        return new MoOperationLinkedPurchaseError();
      case "reported":
        return new MoOperationReportedError();
      case "last_operation_locked":
        return new LastOperationLockedError();
    }
  }

  // The order's operations are replanned inside the edit's transaction by
  // the planning service; without a plan reader (fixtures) nothing is.
  const replanner = () => (planning ? (tx: Tx, id: string) => planning.replanOrderInTx(tx, id) : undefined);

  async function operationSequences(moId: string): Promise<Map<string, number>> {
    return new Map((await repo.listOperations(moId)).map((op) => [op.id, op.sequenceNo]));
  }

  // The händelselogg's view of a material row / an operation, and the
  // before/after of the fields an edit changed (same shape as the order
  // rows' row_updated).
  function materialAuditView(row: MaterialRow, sequences: Map<string, number>) {
    return {
      articleNumber: row.componentArticleNumber,
      quantityPlanned: Number(row.quantityPlanned),
      unitCode: row.unitCode,
      operationSequenceNo: row.moOperationId ? sequences.get(row.moOperationId) ?? null : null,
    };
  }
  function operationAuditView(op: OperationRowView) {
    return {
      sequenceNo: op.sequenceNo,
      workCenterCode: op.workCenterCode,
      description: op.description,
      setupTime: Number(op.setupTime),
      runTimePerUnit: Number(op.runTimePerUnit),
      timeUnit: op.timeUnit,
      comment: op.comment,
      printOnWorkCard: op.printOnWorkCard,
      packingInstructions: op.packingInstructions,
      subcontractSupplierName: op.subcontractSupplierName,
      setupPrice: op.setupPrice === null ? null : Number(op.setupPrice),
      unitPrice: op.unitPrice === null ? null : Number(op.unitPrice),
      showNetWeight: op.showNetWeight,
    };
  }
  function changedFields<T extends Record<string, unknown>>(before: T, after: T): { before: Partial<T>; after: Partial<T> } {
    const diff = { before: {} as Partial<T>, after: {} as Partial<T> };
    for (const key of Object.keys(after) as (keyof T)[]) {
      if (before[key] !== after[key]) {
        diff.before[key] = before[key];
        diff.after[key] = after[key];
      }
    }
    return diff;
  }

  // Pallkort: the cards for one operation of a released order — shared by
  // the operation route (print time, no reporter) and the report route
  // (report time + reporter). Last operation of a KO-linked order → the
  // customer-facing "final" card with the customer's Kod på pallkort and the
  // order's delivery address; anything else → the "internal" card pointing
  // at the next operation, with the system's code type. Quantity: explicit
  // → the operation's accumulated OK quantity → the order quantity.
  async function buildOperationPalletCards(
    moId: string,
    operationId: string,
    extras: { quantities?: number[]; printedAt: Date; reportedBy: string | null }
  ) {
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

    const quantities = extras.quantities ?? [
      Number(operation.quantityCompleted ?? 0) > 0 ? Number(operation.quantityCompleted) : Number(order.quantity),
    ];

    const salesOrderRow =
      isLast && order.salesOrderRowId ? await salesOrders.findRowForManufacturing(order.salesOrderRowId) : null;

    // Kod på pallkort: the customer's choice on the final card, else the
    // system setting; an omitted settings reader means none (the plain card).
    const systemCode: PalletCardCode = settings ? (await settings.getSettings()).palletCardCode : "none";
    // One card per kolli, numbered Kolli n av m.
    const cards: PalletCardPdfInput[] = quantities.map((quantity, i) => {
      const common = {
        articleNumber: order.articleNumber,
        articleName: order.articleName,
        quantity,
        unit: order.articleUnitCode,
        parcel: { index: i + 1, count: quantities.length },
        printedAt: extras.printedAt,
        reportedBy: extras.reportedBy,
        reference: `${order.orderNumber} · op ${operation.sequenceNo}`,
      };
      return salesOrderRow
        ? {
            ...common,
            kind: "final",
            code: salesOrderRow.customerPalletCardCode ?? systemCode,
            customerName: salesOrderRow.customerName,
            customerOrderNumber: salesOrderRow.customerOrderNumber,
            orderNumber: salesOrderRow.orderNumber,
            deliveryAddress: salesOrderRow.deliveryAddress,
          }
        : {
            ...common,
            kind: "internal",
            code: systemCode,
            orderNumber: order.orderNumber,
            // Same description-over-resource fallback as every other surface
            // that names an operation.
            nextOperation: next ? `${next.sequenceNo} · ${next.description?.trim() || next.workCenterName}` : null,
          };
    });
    return { order, operation, cards };
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
      // Default the operation's supplier from the resource when not given.
      const withDefaults = assertLegoFieldsForResource(workCenter, input, "create");
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
      assertLegoFieldsForResource(workCenter, input, "update");
      if (workCenter.type !== "subcontract") {
        patch = { ...input, ...CLEARED_LEGO_FIELDS, useArticleDrawing: true };
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
    // onlyUncovered (behovsberäkningens Skapa ordrar): a configured row's TO
    // is refused when the row no longer lacks that much — see
    // ConfiguredCreateInput.lockRow.
    async createManufacturingOrder(
      input: CreateManufacturingOrderInput,
      createdBy: string | null,
      opts: { onlyUncovered?: boolean } = {}
    ) {
      const prepared = await prepareCreate(input, opts);
      // Avvikelser (Skapa tillverkningsorder): the case link is written in
      // the TO's create transaction, after the plan — the TO and its link
      // commit together or not at all.
      const plan = planning ? (tx: Tx, moId: string) => planning.planNewOrderInTx(tx, moId) : undefined;
      const deviationId = input.deviationId;
      const planAndLink = deviationId
        ? async (tx: Tx, moId: string) => {
            const warnings = plan ? await plan(tx, moId) : [];
            await linkDeviationInTx(tx, { deviationId, documentType: "manufacturing_order", documentId: moId, userId: createdBy });
            return warnings;
          }
        : plan;
      const result = await repo.createManufacturingOrder(
        { ...input, articleId: prepared.articleId, quantity: prepared.quantity },
        createdBy,
        prepared.linkedSalesOrder,
        prepared.configured,
        planAndLink
      );
      if (!result.ok) {
        if (result.reason === "already_covered") throw new ConfiguredRowAlreadyCoveredError(result.uncovered);
        throw new RowConfigurationChangedError();
      }
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
      if (!result.ok) {
        if (result.reason === "already_covered") throw new ConfiguredRowAlreadyCoveredError(result.uncovered);
        throw new RowConfigurationChangedError();
      }
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
      input: { quantity?: number; dueDate?: string | null; onlyUncovered?: boolean },
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
      return this.createManufacturingOrder(
        { salesOrderRowId: rowId, quantity, dueDate: input.dueDate },
        createdBy,
        { onlyUncovered: input.onlyUncovered }
      );
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
          throw new InvalidStatusTransitionError("Material can only be consumed while the order is released, in progress or done");
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
        // Kvalitet: the Avvikelseorsak (see assertScrapReason).
        scrapReasonId?: string;
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
      // The terminal's preflight (materialShortageChecked) already checked
      // the scrap reason before its time report was written — this report
      // must not be refused after that.
      if (!input.materialShortageChecked) await assertScrapReason(input);

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
            "Operations can only be reported while the order is released, in progress or done"
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
        scrapReasonId: input.scrapReasonId,
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
        scrapReasonId?: string;
        markDone: boolean;
        employeeId?: string;
        createdBy: string | null;
      },
      allow: boolean | undefined
    ) {
      // The scrap reason too, while nothing is written yet.
      await assertScrapReason(input);
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

    // --- Ändra material och operationer på en skapad TO ------------------
    // Edits the TO's own rows while the order is Frisläppt/Pågår; the
    // article's BOM/routing are never touched. The guards that need the
    // locks run in the repository transaction (order-edit.ts); what can be
    // validated on committed data (the component, its unit) runs here
    // first, like every other guard in this file. Each edit is logged on
    // the order after the commit, with changed fields as before/after.

    async addMaterial(moId: string, input: CreateMoMaterialInput, userId: string | null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      const component = await assertMaterialComponent(order.articleId, input.componentArticleId);
      const unit = await articleFiles.resolveUnitSelection(component.id, input.unitId);
      const result = await catchMaterialDuplicate(() =>
        repo.addMaterial(moId, {
          componentArticleId: component.id,
          quantity: input.quantity,
          unitId: unit.unitId,
          unitFactor: unit.unitFactor,
          moOperationId: input.moOperationId ?? null,
        })
      );
      const done = assertMaterialEdited(result, moId, order.status, input.moOperationId ?? null);
      const sequences = await operationSequences(moId);
      await audit.log({
        entityType: "manufacturing_order",
        entityId: done.order.orderNumber,
        action: "material_added",
        detail: { ...materialAuditView(done.material, sequences), ...auditWarnings(done.warnings) },
        userId,
      });
      return { material: done.material, warnings: done.warnings };
    },

    async updateMaterial(moId: string, rowId: string, input: UpdateMoMaterialInput, userId: string | null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      const existing = await repo.findMaterialConsumptionById(rowId);
      if (!existing || existing.manufacturingOrderId !== moId) throw new MOMaterialConsumptionNotFoundError(rowId);
      const componentChanged = input.componentArticleId !== undefined && input.componentArticleId !== existing.componentArticleId;
      const componentId = input.componentArticleId ?? existing.componentArticleId;
      if (componentChanged) await assertMaterialComponent(order.articleId, componentId);
      // A new unit, or a new component (whose base unit applies unless a
      // unit is given alongside) — resolved against the component's units
      // with the same helper as a BOM row.
      const unit =
        input.unitId !== undefined || componentChanged
          ? await articleFiles.resolveUnitSelection(componentId, input.unitId ?? null)
          : undefined;
      const result = await catchMaterialDuplicate(() =>
        repo.updateMaterial(moId, rowId, {
          componentArticleId: componentChanged ? componentId : undefined,
          quantity: input.quantity,
          unit,
          moOperationId: input.moOperationId,
        })
      );
      const done = assertMaterialEdited(result, moId, order.status, input.moOperationId ?? null, rowId);
      const sequences = await operationSequences(moId);
      const diff = changedFields(materialAuditView(done.before!, sequences), materialAuditView(done.material, sequences));
      await audit.log({
        entityType: "manufacturing_order",
        entityId: done.order.orderNumber,
        action: "material_changed",
        detail: { articleNumber: done.material.componentArticleNumber, ...diff, ...auditWarnings(done.warnings) },
        userId,
      });
      return { material: done.material, warnings: done.warnings };
    },

    async removeMaterial(moId: string, rowId: string, userId: string | null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      const result = await repo.removeMaterial(moId, rowId);
      if (!result.ok) throw materialEditError(result.reason, moId, order.status, null, rowId);
      const sequences = await operationSequences(moId);
      await audit.log({
        entityType: "manufacturing_order",
        entityId: result.order.orderNumber,
        action: "material_removed",
        detail: materialAuditView(result.before, sequences),
        userId,
      });
    },

    async addOperation(moId: string, input: CreateMoOperationInput, userId: string | null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      const workCenter = await repo.findWorkCenterById(input.workCenterId);
      if (!workCenter) throw new WorkCenterNotFoundError(input.workCenterId);
      // The beredning's lego rule, and the supplier defaulted from the resource.
      const withDefaults = assertLegoFieldsForResource(workCenter, input, "create");
      const result = await catchOperationWriteErrors(input, () => repo.addOperation(moId, withDefaults, replanner()));
      if (!result.ok) throw operationEditError(result.reason, moId, order.status, input.sequenceNo);
      await audit.log({
        entityType: "manufacturing_order",
        entityId: result.order.orderNumber,
        action: "operation_added",
        detail: { ...operationAuditView(result.operation), ...auditWarnings(result.warnings) },
        userId,
      });
      return { operation: result.operation, warnings: result.warnings };
    },

    async updateOperation(moId: string, opId: string, input: UpdateMoOperationInput, userId: string | null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      const existing = await repo.findOperationById(opId);
      if (!existing || existing.manufacturingOrderId !== moId) throw new MOOperationNotFoundError(opId);
      // The effective resource decides whether lego fields are legal —
      // same rule as updateRoutingOperation; moving to an ordinary resource
      // clears them.
      const workCenterId = input.workCenterId ?? existing.workCenterId;
      const workCenter = await repo.findWorkCenterById(workCenterId);
      if (!workCenter) throw new WorkCenterNotFoundError(workCenterId);
      assertLegoFieldsForResource(workCenter, input, "update");
      const patch: UpdateMoOperationInput = workCenter.type !== "subcontract" ? { ...input, ...CLEARED_LEGO_FIELDS } : input;
      const result = await catchOperationWriteErrors(input, () => repo.updateOperation(moId, opId, patch, replanner()));
      if (!result.ok) throw operationEditError(result.reason, moId, order.status, input.sequenceNo ?? existing.sequenceNo, opId);
      const diff = changedFields(operationAuditView(result.before!), operationAuditView(result.operation));
      await audit.log({
        entityType: "manufacturing_order",
        entityId: result.order.orderNumber,
        action: "operation_changed",
        detail: {
          sequenceNo: result.operation.sequenceNo,
          workCenterCode: result.operation.workCenterCode,
          ...diff,
          ...auditWarnings(result.warnings),
        },
        userId,
      });
      return { operation: result.operation, warnings: result.warnings };
    },

    async removeOperation(moId: string, opId: string, userId: string | null) {
      const order = await repo.findManufacturingOrderById(moId);
      if (!order) throw new ManufacturingOrderNotFoundError(moId);
      const result = await repo.removeOperation(moId, opId, replanner());
      if (!result.ok) throw operationEditError(result.reason, moId, order.status, 0, opId);
      await audit.log({
        entityType: "manufacturing_order",
        entityId: result.order.orderNumber,
        action: "operation_removed",
        detail: {
          ...operationAuditView(result.before),
          unlinkedMaterials: result.unlinkedMaterials,
          ...auditWarnings(result.warnings),
        },
        userId,
      });
      return { warnings: result.warnings, unlinkedMaterials: result.unlinkedMaterials };
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
      const extraDescription = extraDescriptionFor(
        settings ? await settings.getSettings() : {},
        "manufacturingOrder"
      )(order.articleExtraDescription);
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
        extraDescription,
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
    // pointing at the next operation. `quantities`: one card per kolli with
    // that quantity (Kolli n av m); omitted ⇒ one card with the operation's
    // accumulated OK quantity, then the order quantity. Datum = the print
    // time; no Rapporterad av (the accumulated quantity has no single
    // reporter).
    async getOperationPalletCardPdf(moId: string, operationId: string, quantities?: number[]) {
      const { order, operation, cards } = await buildOperationPalletCards(moId, operationId, {
        quantities,
        printedAt: new Date(),
        reportedBy: null,
      });
      const content = await pdf.renderPalletCard(cards);
      return { filename: `pallkort-${order.orderNumber}-op${operation.sequenceNo}.pdf`, content };
    },

    // Pallkort per rapport (omutskrift from the TO card's Rapporteringar):
    // the same card as the operation's, but dated on the report's created_at
    // with the reporter's name and the report's OK quantity as the default.
    // Only a live operation report has a card — Slutför order, manual draws
    // and undone reports are refused (409); a lego receipt's report is an
    // operation report and prints.
    async getReportPalletCardPdf(moId: string, reportId: string, quantities?: number[]) {
      const report = await repo.findReportForPalletCard(reportId);
      if (!report || report.manufacturingOrderId !== moId) throw new MoReportNotFoundError(reportId);
      if (report.kind !== "operation" || !report.moOperationId || report.undoneAt) throw new MoReportNoPalletCardError();

      const { order, operation, cards } = await buildOperationPalletCards(moId, report.moOperationId, {
        quantities: quantities ?? (Number(report.quantityOk) > 0 ? [Number(report.quantityOk)] : undefined),
        printedAt: report.createdAt,
        reportedBy: report.employeeName ?? report.userName ?? null,
      });
      const content = await pdf.renderPalletCard(cards);
      return { filename: `pallkort-${order.orderNumber}-op${operation.sequenceNo}.pdf`, content };
    },
  };
}

export type ManufacturingService = ReturnType<typeof createManufacturingService>;
