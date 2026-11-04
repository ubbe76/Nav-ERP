import type {
  ApplyDeliveryTimeInput,
  CapacityQuery,
  ConfiguratorSelection,
  CreatePlanningOrdersInput,
  DeliveryTimeCheckRequest,
  ListRequirementsQuery,
  MoveOperationInput,
  Paged,
} from "@navet/shared";
import type { Tx } from "@navet/db";
import { roundUpToMultiple } from "@navet/shared";
import type { PlanningRepository } from "../repository/planning.repository.js";
import {
  DEMAND_SALES_STATUSES,
  computeLowLevelCodes,
  computeRequirements,
  latestStartFor,
  proposalSummary,
  type ConfiguredRowNeed,
  type LegoOperationRow,
  type DerivedDemand,
  type RequirementProposal,
  type RequirementRow,
  type RequirementsInput,
} from "./requirements-calc.js";
import {
  buildLeadTimeContext,
  computeLegoOperationDates,
  computeMoStartDates,
  configuredLeadDays,
  type LeadTimeContext,
} from "./requirements-dating.js";
import { legoReturnDate, NO_LEAD_TIME_DEFAULTS } from "./manufacturing-lead-time.js";
import {
  buildScheduleLookups,
  mondayOf,
  capacityHorizon,
  computeCapacity,
  orderPlanStatus,
  remainingOperationMinutes,
  type CapacityInput,
  type CapacityOperationRow,
  type CapacityResult,
  type PlannedWeek,
} from "./capacity-calc.js";
import { buildArticleOverview, type ArticleOverview, type ArticleOverviewInput, type ArticleOverviewLoad } from "./article-overview.js";
import { MIN_PLAN_MINUTES, PLAN_HORIZON_WEEKS, type PlanWorkCenter } from "./capacity-book.js";
import { longOperationWarnings, planProduction, type OperationPlan, type PlanOperation, type PlanOrder, type PlanWarning } from "./production-plan.js";
import { lockProductionPlan } from "../repository/plan-lock.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import {
  checkDeliveryTime,
  type DeliveryTimeCheckResult,
  type DtcArticle,
  type DtcOperation,
  type DtcRowInput,
  type DtcWorkCenter,
} from "./delivery-time-check.js";
import {
  findFirmDemand,
  holidayLookbackStart,
  suggestDueDate,
  type DueDateSuggestion,
  type FirmDemand,
} from "./due-date-suggestion.js";
import { uncoveredConfiguredQuantity } from "./configured-coverage.js";
import {
  deliveryHolidayWindow,
  effectiveDeliverySettings,
  shipDateFor,
  suggestPurchaseDeliveryDate,
  // Anchored in Europe/Stockholm — a UTC date would be yesterday's for the
  // first hours after midnight (summer time).
  stockholmToday,
  type DeliveryDefaults,
  type PartnerDeliveryFields,
} from "../../system/service/delivery-days.js";
import { resolveSupplierPrice } from "../../purchase/service/supplier-price.js";
import { configurationLines } from "../../configurator/service/configuration-lines.js";
import { selectionFromEntries } from "../../configurator/service/variant-identity.js";
import { addDays, previousWorkingDay } from "../../system/service/delivery-days.js";
import type { ConfiguredStructureReader } from "../../configurator/service/configurator.service.js";

// Own copy rather than importing the article module's class — planning
// stays a leaf that only knows its repository (same as costing.service.ts).
export class ArticleNotFoundError extends Error {
  constructor(id: string) {
    super(`Article ${id} not found`);
    this.name = "ArticleNotFoundError";
  }
}

// Leveranstidskontroll's own lookups — planning stays a leaf, so these are
// its own classes; the derived codes match the sales module's
// (customer-not-found, sales-order-not-found, configuration-required).
export class CustomerNotFoundError extends Error {
  constructor(id: string) {
    super(`Customer ${id} not found`);
    this.name = "CustomerNotFoundError";
  }
}

export class SalesOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Sales order ${id} not found`);
    this.name = "SalesOrderNotFoundError";
  }
}

// Leveranstidskontroll on an order that is no longer open (delivered,
// invoiced, cancelled): there is nothing left to promise a date for. 409.
// The reservation ("reserve") is stricter — its TOs are linked to the rows
// like Skapa TO, which needs a confirmed order, so a quote is refused too.
export class SalesOrderNotOpenError extends Error {
  constructor(public status: string, action: "check" | "reserve" = "check") {
    super(
      action === "reserve"
        ? `Kundordern är inte bekräftad (status ${status}) — tillverkningsordrar kan bara skapas för en bekräftad order eller en order under tillverkning`
        : `Kundordern är inte öppen (status ${status}) — leveranstiden kan bara kontrolleras för offert, bekräftad eller under tillverkning`
    );
    this.name = "SalesOrderNotOpenError";
  }
}

// The statuses Leveranstidskontroll accepts — the same set the order card's
// header edits allow (quote/confirmed/in_production).
const OPEN_SALES_ORDER_STATUSES: ReadonlySet<string> = new Set(["quote", "confirmed", "in_production"]);
// The statuses the reservation accepts — a linked TO needs a confirmed order
// (prepareCreate's LinkedOrderStatusError), so the guard sits up front.
const RESERVABLE_SALES_ORDER_STATUSES: ReadonlySet<string> = new Set(["confirmed", "in_production"]);

// Reservationen: the check run under the lock gave another delivery date
// than the one the client was shown. 409 — the body carries the new result
// so the dialog can show it and offer the button again. Nothing is written.
export class DeliveryTimeChangedError extends Error {
  constructor(
    public deliveryDate: string | null,
    public result: DeliveryTimeCheckResult,
    // The date held but the number of TOs to create did not (expectedOrders).
    public orders?: { expected: number; actual: number }
  ) {
    super(
      deliveryDate === null
        ? "Läget har ändrats sedan kontrollen — det går inte längre att lova ett datum"
        : orders
          ? `Läget har ändrats sedan kontrollen — det skapas nu ${orders.actual} tillverkningsordrar i stället för ${orders.expected}`
          : `Läget har ändrats sedan kontrollen — det nya datumet är ${deliveryDate}`
    );
    this.name = "DeliveryTimeChangedError";
  }
}

// Reservationen: the check found no shortage batch on a manufactured
// article — nothing to make a TO for (what is missing is bought, or already
// on its way). 409.
export class NothingToReserveError extends Error {
  constructor() {
    super("Kontrollen fann inget att tillverka — det som saknas köps in eller finns redan på väg");
    this.name = "NothingToReserveError";
  }
}

// Produktionsplanering: Flytta / Lås upp on an operation that does not exist.
export class OperationNotFoundError extends Error {
  constructor(id: string) {
    super(`Operation ${id} not found`);
    this.name = "OperationNotFoundError";
  }
}

// Flytta on an operation the plan cannot place: done, lego, 0 minutes, or
// its order is not released/in progress. 409.
export class OperationNotPlannableError extends Error {
  constructor(public reason: "done" | "subcontract" | "no_time" | "order_not_open") {
    super(
      reason === "done"
        ? "Operationen är klar och kan inte flyttas"
        : reason === "subcontract"
          ? "En legooperation planeras inte på egen kapacitet"
          : reason === "no_time"
            ? "Operationen har ingen återstående tid att planera"
            : "Tillverkningsordern är inte frisläppt eller pågående"
    );
    this.name = "OperationNotPlannableError";
  }
}

// Flytta to a week before the current one: the work cannot happen in the
// past (the engine would clamp it to the current week silently). 400.
export class PlanWeekInPastError extends Error {
  constructor(public weekMonday: string, public currentWeekMonday: string) {
    super(`Veckan som börjar ${weekMonday} har passerat — en operation kan inte flyttas till en vecka före innevarande (${currentWeekMonday})`);
    this.name = "PlanWeekInPastError";
  }
}

// What Planera, Flytta and the planning of a new TO answer with.
export interface PlanRunResult {
  plannedAt: string;
  orders: number;
  operations: number;
  warnings: PlanWarning[];
}

export interface PlannedOperationWeeks {
  plannedStartWeek: string | null;
  plannedEndWeek: string | null;
  planLocked: boolean;
}

export interface MoveOperationResult {
  operation: PlannedOperationWeeks;
  following: { moOperationId: string; sequenceNo: number; plannedStartWeek: string | null; plannedEndWeek: string | null }[];
  warnings: PlanWarning[];
}

// The TO list's plan summary per order (min/max over the pending
// operations' planned weeks, Sen from the plan walk).
export interface OrderPlanSummary {
  plannedStartWeek: string | null;
  plannedEndWeek: string | null;
  late: boolean;
}

// What the manufacturing module needs from the plan (bound late in app.ts,
// like the configurator's readers): a new TO's operations planned inside
// its own create transaction, and the list's summaries.
export interface ManufacturingPlanReader {
  planNewOrderInTx(tx: Tx, manufacturingOrderId: string, given?: { sequenceNo: number; weeks: PlannedWeek[] }[]): Promise<string[]>;
  // Ändra operationer: the order's operations replanned inside the edit's
  // transaction (Planera's rules for one order), the warnings as texts.
  replanOrderInTx(tx: Tx, manufacturingOrderId: string): Promise<string[]>;
  orderPlanSummaries(orderIds: string[]): Promise<Map<string, OrderPlanSummary>>;
}

const OPEN_MO_STATUSES: ReadonlySet<string> = new Set(["released", "in_progress"]);
const hasPlan = (op: CapacityOperationRow) => !!op.plannedWeeks && op.plannedWeeks.length > 0;

export class ConfigurationRequiredError extends Error {
  constructor(public articleNumber: string) {
    super(`${articleNumber} är en mall i konfiguratorn — konfigurera den`);
    this.name = "ConfigurationRequiredError";
  }
}

export class ConfigurationNotAllowedError extends Error {
  constructor(public articleNumber: string) {
    super(`${articleNumber} är ingen mall i konfiguratorn`);
    this.name = "ConfigurationNotAllowedError";
  }
}

// Narrow creator interfaces declared consumer-side (the StockBalanceReader
// pattern): satisfied structurally by purchaseService/manufacturingService.
// Order creation goes through the existing services' own creation paths so
// number series, validation and transactions stay in one place.
export interface PurchaseOrderCreator {
  createPurchaseOrder(
    input: { supplierId: string; exchangeRate: number; expectedDeliveryDate?: string },
    createdBy: string
  ): Promise<{ id: string; orderNumber: string }>;
  addRow(
    purchaseOrderId: string,
    input: {
      articleId: string;
      quantity: number;
      unitPrice: number;
      // Lego rows: the MO operation the row buys + the one-off ställpris.
      moOperationId?: string;
      setupPrice?: number;
      // Önskat leveransdatum when it differs from the order's.
      expectedDeliveryDate?: string;
    }
  ): Promise<unknown>;
  cancel(purchaseOrderId: string): Promise<unknown>;
}

export interface ManufacturingOrderCreator {
  createManufacturingOrder(
    input: { articleId: string; quantity: number; note?: string; dueDate?: string },
    createdBy: string | null
  ): Promise<{ id: string; orderNumber: string }>;
  // Konfigurator 4c: a configured proposal's TO is made FROM its KO row — the
  // row owns the choices (and the manufacturing service derives the
  // structure, re-checking the row's key under the row lock).
  createFromSalesOrderRow(
    rowId: string,
    input: { quantity?: number; dueDate?: string | null; onlyUncovered?: boolean },
    createdBy: string | null
  ): Promise<{ id: string; orderNumber: string }>;
  // Reservationen: the same create inside the caller's transaction (the
  // whole tree of TOs, all or nothing), with the weeks the check booked
  // written as the plan (by sequence number). With a salesOrderRowId the TO
  // is linked to the row and the KO flips to in_production, exactly like
  // Skapa TO; a configured row's structure is derived from the row.
  createManufacturingOrderInTx(
    tx: Tx,
    input: { articleId?: string; salesOrderRowId?: string; quantity: number; note?: string; dueDate?: string | null },
    createdBy: string | null,
    opts?: { plannedWeeks?: { sequenceNo: number; weeks: PlannedWeek[] }[] }
  ): Promise<{ id: string; orderNumber: string; quantity: string | number; releaseWarnings: string[] }>;
}

// Reservationen's sales-side writes: the KO rows locked up front (the lock
// order advisory → rows → header, see applyDeliveryTime) and, last, the
// KO's Förväntat leveransdatum, set by the sales service inside the
// planning transaction with the header PATCH's status guard (declared
// consumer-side like the creators above; app.ts passes salesService).
export interface SalesOrderDateWriter {
  lockRowsInTx(tx: Tx, rowIds: string[]): Promise<void>;
  setExpectedDeliveryDateInTx(tx: Tx, salesOrderId: string, date: string): Promise<{ orderNumber: string; previous: string | null }>;
}

// What POST /delivery-time-check/apply answers with.
export interface ApplyDeliveryTimeResult {
  deliveryDate: string;
  shipDate: string;
  // In creation order: children before their parents; level 1 = the KO
  // row's own article (linked to the row), 2+ = semi-finished parts.
  manufacturingOrders: {
    id: string;
    orderNumber: string;
    articleNumber: string;
    quantity: number;
    level: number;
    salesOrderRowId: string | null;
  }[];
  // The TOs' releaseWarnings (material shortage, a plan the engine had to
  // make), prefixed with the TO number. Never a refusal.
  warnings: string[];
}


export interface CreatedOrdersResult {
  // supplierId travels with the order so the caller can look the supplier's
  // email up — the behovsberäkning offers to mail the draft straight away.
  purchaseOrders: { id: string; orderNumber: string; supplierId: string; supplierName: string; rowCount: number }[];
  manufacturingOrders: { id: string; orderNumber: string; articleNumber: string }[];
  errors: { articleId: string; articleNumber: string; message: string }[];
  // Fasta leveransdagar: an IO row whose earliest possible arrival (lead
  // time, the supplier's days, transit) comes after the demand — and, since
  // tidsfasade förslag (#13), a TO whose earliest possible finish (today plus
  // the lead time) comes after the working day before the need. Never stops
  // the order — always present, empty when nothing is late.
  warnings: { orderNumber: string; articleNumber: string; demandDate: string; deliveryDate: string; message: string }[];
}

// Tidsfasade förslag: the CSV export has one line per proposal — the article
// row repeated with each of its proposals (`proposal` null for a row without
// any, shown with showAll).
export type RequirementExportRow = RequirementRow & { proposal: RequirementProposal | null };

// The horizon filter's last day: the Sunday of the current week, of the next,
// or of the fourth week counted from the current one. "late" has no end —
// it is strictly before today.
function latestHorizonEnd(latest: NonNullable<ListRequirementsQuery["latest"]>, today: string): string | null {
  const thisMonday = mondayOf(today);
  switch (latest) {
    case "late":
      return null;
    case "this_week":
      return addDays(thisMonday, 6);
    case "next_week":
      return addDays(thisMonday, 13);
    case "four_weeks":
      return addDays(thisMonday, 27);
  }
}

// Same scale as the calc (numeric(14,4)).
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

// The rows with only the proposals inside the horizon (a passed latest date
// is inside every horizon); a row left without proposals is dropped. The
// cached rows are never mutated — copies all the way.
function filterByLatest(rows: RequirementRow[], latest: NonNullable<ListRequirementsQuery["latest"]>, today: string): RequirementRow[] {
  const end = latestHorizonEnd(latest, today);
  // Passerat is part of every horizon — including a dated purchase with no
  // possible arrival at all (late, latestDate null).
  const inside = (p: RequirementProposal) => p.late || (end !== null && p.latestDate !== null && p.latestDate <= end);
  const out: RequirementRow[] = [];
  for (const row of rows) {
    const proposals = row.proposals.filter(inside);
    if (proposals.length === 0) continue;
    out.push({
      ...row,
      proposals,
      proposalQuantity: round4(proposals.reduce((sum, p) => sum + p.quantity, 0)),
      ...proposalSummary(proposals),
    });
  }
  return out;
}

// Sortering Senaste datum: the earliest latest date first, undated last,
// article number as the tie-break so two loads render identically.
function compareByLatest(a: RequirementRow, b: RequirementRow): number {
  if (a.earliestLatestDate !== b.earliestLatestDate) {
    if (a.earliestLatestDate === null) return 1;
    if (b.earliestLatestDate === null) return -1;
    return a.earliestLatestDate < b.earliestLatestDate ? -1 : 1;
  }
  return a.articleNumber < b.articleNumber ? -1 : a.articleNumber > b.articleNumber ? 1 : 0;
}

// Domain errors carry user-readable messages and pass through; anything that
// smells like an internal error (Drizzle's "Failed query: <full SQL>", or
// oversized technical dumps) is replaced — SQL must never reach the client.
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message && !err.message.includes("Failed query") && err.message.length <= 200) {
    return err.message;
  }
  return "Kunde inte skapa order";
}

// How long one behovsberäkning result is reused. The netting covers the
// whole dataset (the cascade needs every article) while the list pages,
// searches and filters the RESULT — so without the cache every page change
// re-ran everything. A minute of staleness is the accepted price; Uppdatera
// (refresh) and Skapa ordrar recompute at once.
export const REQUIREMENTS_CACHE_MS = 60_000;

// A lego IO row's dating: the Önskat leveransdatum, whether it comes after
// the operation's finish date, and that finish date (null = undated TO).
type LegoReturn = { date: string; late: boolean; finishDate: string | null };

export function createPlanningService(
  repo: PlanningRepository,
  deps: {
    purchase: PurchaseOrderCreator;
    manufacturing: ManufacturingOrderCreator;
    // Konfigurator 4c: derives a configured KO row's material for the
    // cascade (bound late in app.ts). Optional so the unit tests' fakes need
    // not wire it; a configured row without a reader gets an error row.
    configuredStructure?: ConfiguredStructureReader;
    // 0 = no caching (the integration tests change data between calls).
    requirementsCacheMs?: number;
    now?: () => number;
    // Today as a Stockholm day; the unit tests pin it.
    today?: () => string;
    // Produktionsplanering's händelselogg (Planera, Flytta, Lås upp) —
    // optional for the fixtures, app.ts passes the real one.
    audit?: AuditWriter;
    // Reservationen's KO date write (app.ts passes salesService). Optional
    // so the fixtures that never reserve need not wire it.
    salesOrderDates?: SalesOrderDateWriter;
  }
) {
  const cacheMs = deps.requirementsCacheMs ?? REQUIREMENTS_CACHE_MS;
  const audit: AuditWriter = deps.audit ?? { async log() {} };
  const now = deps.now ?? Date.now;
  const todayFn = deps.today ?? stockholmToday;
  // Shared by every user — the result doesn't depend on who asks. The
  // PROMISE is cached so concurrent requests share one computation; a failed
  // one is dropped so the next request retries.
  let cache: { at: number; rows: Promise<RequirementRow[]> } | null = null;

  // Fasta leveransdagar: a sales order's date is the day the customer gets
  // the goods; what we must have ready is the SHIP date (transit days and the
  // customer's dispatch days back). Every place that plans by a KO date goes
  // through here, so the pure builders keep reading expectedDeliveryDate.
  // A row without customer fields (test fakes) follows the system defaults.
  const NO_PARTNER_SETTINGS: PartnerDeliveryFields = { deliveryWeekdays: [], deliveryDayMode: null, transitDays: null };
  type DeliveryContext = { defaults: DeliveryDefaults; offDays: ReadonlySet<string> };
  function shiftToShipDates<T extends { expectedDeliveryDate: string | null; customerDelivery?: PartnerDeliveryFields }>(
    rows: T[],
    ctx: DeliveryContext
  ): T[] {
    return rows.map((r) =>
      r.expectedDeliveryDate
        ? {
            ...r,
            expectedDeliveryDate: shipDateFor(
              r.expectedDeliveryDate,
              effectiveDeliverySettings(r.customerDelivery ?? NO_PARTNER_SETTINGS, "customer", ctx.defaults),
              ctx.offDays
            ),
          }
        : r
    );
  }
  async function toShipDates<T extends { expectedDeliveryDate: string | null; customerDelivery?: PartnerDeliveryFields }>(
    rows: T[],
    dbc?: Tx
  ): Promise<T[]> {
    const dates = rows.flatMap((r) => (r.expectedDeliveryDate ? [r.expectedDeliveryDate] : []));
    if (dates.length === 0) return rows;
    // Transit days are at most 60 working days.
    return shiftToShipDates(rows, await repo.deliveryContext(deliveryHolidayWindow(dates, 60), dbc));
  }

  // The lead-time rules for a set of articles (field, routing, resources).
  // Optional on the repo for the unit tests' fakes ⇒ lead time 0 everywhere.
  async function leadTimeInputsFor(filter: { orderIds: string[]; articleIds: string[] }, dbc?: Tx) {
    const inputs = (await repo.loadMoDatingInputs?.(filter, dbc)) ?? {
      operations: [],
      routings: [],
      workCenters: [],
      articleLeadTimes: new Map<string, number | null>(),
      orderQuantities: new Map<string, number>(),
      defaults: NO_LEAD_TIME_DEFAULTS,
    };
    return { ...inputs, context: buildLeadTimeContext(inputs) };
  }

  // The holiday window the dating needs: the dates themselves, the transit
  // search (60 working days) and the longest Ledtid (dagar) field — a
  // routing-derived lead time beyond 60 working days is not realistic, and
  // beyond the window the holidays simply are not subtracted.
  function datingWindow(dates: string[], articleLeadTimes: ReadonlyMap<string, number | null>) {
    const maxField = Math.max(0, ...[...articleLeadTimes.values()].map((d) => d ?? 0));
    return deliveryHolidayWindow(dates, 60 + maxField);
  }

  // Tidsfasade förslag (#13): the artikelöversikt's material rows and planned
  // TOs are dated with the TO's START (moStartDate), not its due date — the
  // material must be there when the work begins. One dating load and ONE
  // delivery context for the whole set (KO ship dates and TO starts share
  // the holiday register); nothing is loaded for a set without dates or TOs.
  async function dateOverviewLoads(loads: ArticleOverviewLoad[], dbc?: Tx): Promise<ArticleOverviewInput[]> {
    const dates: string[] = [];
    const moIds = new Set<string>();
    const parentIds = new Set<string>();
    for (const l of loads) {
      for (const r of l.salesRows) if (r.expectedDeliveryDate) dates.push(r.expectedDeliveryDate);
      for (const m of [...l.materialRows, ...l.plannedMos]) {
        moIds.add(m.moId);
        parentIds.add(m.parentArticleId);
        if (m.dueDate) dates.push(m.dueDate);
      }
    }
    const dating = moIds.size > 0 ? await leadTimeInputsFor({ orderIds: [...moIds], articleIds: [...parentIds] }, dbc) : null;
    const ctx: DeliveryContext | null =
      dates.length > 0 ? await repo.deliveryContext(datingWindow(dates, dating?.articleLeadTimes ?? new Map()), dbc) : null;
    const starts = dating
      ? computeMoStartDates({
          orders: [
            ...new Map(
              loads
                .flatMap((l) => [
                  // The TO's remaining quantity, as the behovsberäkning dates
                  // it — matters only for a TO without operations (timed on
                  // the article's routing for that quantity).
                  ...l.materialRows.map((m) => ({
                    manufacturingOrderId: m.moId,
                    articleId: m.parentArticleId,
                    quantity: dating.orderQuantities.get(m.moId) ?? 0,
                    dueDate: m.dueDate,
                  })),
                  ...l.plannedMos.map((m) => ({ manufacturingOrderId: m.moId, articleId: m.parentArticleId, quantity: m.quantity, dueDate: m.dueDate })),
                ])
                .map((o) => [o.manufacturingOrderId, o] as const)
            ).values(),
          ],
          operations: dating.operations,
          articleLeadTimes: dating.articleLeadTimes,
          context: dating.context,
          offDays: ctx?.offDays ?? new Set<string>(),
        })
      : new Map<string, string | null>();
    return loads.map((l) => ({
      ...l,
      salesRows: ctx ? shiftToShipDates(l.salesRows, ctx) : l.salesRows,
      materialRows: l.materialRows.map((m) => ({ ...m, needDate: starts.get(m.moId) ?? null })),
      plannedMos: l.plannedMos.map((m) => ({ ...m, needDate: starts.get(m.moId) ?? null })),
    }));
  }

  async function loadOverviewInput(articleId: string): Promise<ArticleOverviewInput> {
    const input = await repo.loadArticleOverviewInput(articleId);
    if (!input) throw new ArticleNotFoundError(articleId);
    return (await dateOverviewLoads([input]))[0]!;
  }

  // The same for a set of articles (Leveranstidskontroll's whole tree): one
  // batch load and ONE delivery context for every KO row and TO across the
  // set. Unknown ids are absent, never an error. `dbc`: the reservation
  // reads inside its own transaction (undefined = the plain db, as every
  // other read).
  async function loadOverviewInputs(articleIds: string[], dbc?: Tx) {
    const inputs = await repo.loadArticleOverviewInputs(articleIds, dbc);
    const dated = await dateOverviewLoads([...inputs.values()], dbc);
    return new Map<string, ArticleOverviewInput>(dated.map((input) => [input.article.articleId, input]));
  }

  // The lego IO rows' Önskat leveransdatum for Skapa ordrar: each
  // operation's finish date (computeLegoOperationDates — the same backward
  // dating as the behovsberäkning's lego rows) floored at the earliest
  // return when ordered today (legoReturnDate). One dating load and one
  // delivery context for the whole batch.
  async function legoReturnDates(
    ops: (LegoOperationRow & { workCenterId: string; dueDate: string | null })[]
  ): Promise<Map<string, LegoReturn>> {
    if (ops.length === 0) return new Map();
    const today = todayFn();
    const inputs = await leadTimeInputsFor({
      orderIds: [...new Set(ops.map((o) => o.manufacturingOrderId))],
      articleIds: [...new Set(ops.map((o) => o.articleId))],
    });
    const dueDates = ops.flatMap((o) => (o.dueDate ? [o.dueDate] : []));
    const { offDays } = await repo.deliveryContext(datingWindow([today, ...dueDates], inputs.articleLeadTimes));
    const orders = [
      ...new Map(
        ops.map((o) => [
          o.manufacturingOrderId,
          {
            manufacturingOrderId: o.manufacturingOrderId,
            articleId: o.articleId,
            quantity: inputs.orderQuantities.get(o.manufacturingOrderId) ?? o.orderQuantity,
            dueDate: o.dueDate,
          },
        ])
      ).values(),
    ];
    const starts = computeMoStartDates({
      orders,
      operations: inputs.operations,
      articleLeadTimes: inputs.articleLeadTimes,
      context: inputs.context,
      offDays,
    });
    const dates = computeLegoOperationDates({
      legoOperationIds: ops.map((o) => o.moOperationId),
      orders,
      operations: inputs.operations,
      starts,
      context: inputs.context,
      offDays,
    });
    return new Map(
      ops.map((o) => {
        const finishDate = dates.get(o.moOperationId)?.finishDate ?? null;
        const r = legoReturnDate({
          finishDate,
          today,
          lego: inputs.context.resourceOf(o.workCenterId),
          orderLeadTimeDays: inputs.context.orderLeadTimeDaysOf(o.workCenterId),
          offDays,
        });
        return [o.moOperationId, { ...r, finishDate }];
      })
    );
  }

  // The behovsberäkning's input, dated (tidsfasade förslag #13): the KO rows
  // on their ship dates, every open TO's start date (its material's need
  // date), the lego operations' dates and the lead-time rules — ONE
  // delivery context and ONE dating load for the whole run, never per
  // article. Konfigurator 4c: the configured rows and their cascade are
  // derived here too, once per distinct (template, configuration) per run,
  // so the pure calc never calls the configurator. An invalid configuration
  // keeps its row (with the engine's message) but cascades nothing.
  async function loadDatedInput(): Promise<RequirementsInput> {
    const [load, loadedConfigured] = await Promise.all([repo.loadRequirementsInput(), repo.loadConfiguredSalesRows()]);
    const today = todayFn();
    const dating = load.dating;
    const leadTime = buildLeadTimeContext(dating);
    const dates = [
      today,
      ...load.salesRows.flatMap((r) => (r.expectedDeliveryDate ? [r.expectedDeliveryDate] : [])),
      ...loadedConfigured.flatMap((r) => (r.expectedDeliveryDate ? [r.expectedDeliveryDate] : [])),
      ...load.manufacturingOrders.flatMap((o) => (o.dueDate ? [o.dueDate] : [])),
    ];
    const delivery = await repo.deliveryContext(datingWindow(dates, dating.articleLeadTimes));
    const offDays: ReadonlySet<string> = delivery.offDays;

    const starts = computeMoStartDates({
      orders: load.manufacturingOrders,
      operations: dating.operations,
      articleLeadTimes: dating.articleLeadTimes,
      context: leadTime,
      offDays,
    });
    const salesRows = shiftToShipDates(load.salesRows, delivery);
    const manufacturingOrders = load.manufacturingOrders.map((o) => ({ ...o, startDate: starts.get(o.manufacturingOrderId) ?? null }));
    const moMaterialRows = load.moMaterialRows.map((r) => ({ ...r, needDate: starts.get(r.manufacturingOrderId) ?? null }));
    // A lego operation is needed at the supplier on its start date —
    // backward from the TO's färdigdatum through the operations after it
    // (computeLegoOperationDates; Planera never plans a lego operation, so
    // there is no planned week to read). Ledtid beställning is the resource's.
    const legoDates = computeLegoOperationDates({
      legoOperationIds: load.legoOperationRows.map((op) => op.moOperationId),
      orders: load.manufacturingOrders,
      operations: dating.operations,
      starts,
      context: leadTime,
      offDays,
    });
    const legoOperationRows = load.legoOperationRows.map((op) => ({
      ...op,
      needDate: legoDates.get(op.moOperationId)?.startDate ?? null,
      orderLeadTimeDays: leadTime.orderLeadTimeDaysOf(op.workCenterId),
    }));

    // The proposal row shows the date its TO is planned by (the ship date).
    const configured = shiftToShipDates(loadedConfigured, delivery);
    const roundingOf = new Map(load.articles.map((a) => [a.articleId, a.rounding]));
    // An inactive template is treated as an inactive ordinary article: its
    // rows are shown (Inaktiv) but get no proposal (the calc) and cascade no
    // material (here) — the TO cannot be made before the template is active.
    const inactiveTemplates = new Set(load.articles.filter((a) => !a.active).map((a) => a.articleId));
    const needs: ConfiguredRowNeed[] = configured.map((r) => ({
      salesOrderRowId: r.rowId,
      salesOrderId: r.salesOrderId,
      orderNumber: r.orderNumber,
      customerName: r.customerName,
      templateArticleId: r.articleId,
      templateActive: !inactiveTemplates.has(r.articleId),
      expectedDeliveryDate: r.expectedDeliveryDate,
      summary: configurationLines(r.configuration.selection).join(" · "),
      // Avrundning: the TO Skapa ordrar makes is rounded up to the template's
      // step (createManufacturingOrder) — the proposal, and so the summed
      // derivation the cascade is built from, use the same rounded quantity.
      uncoveredQuantity: roundUpToMultiple(
        uncoveredConfiguredQuantity({
          quantityOrdered: r.quantityOrdered,
          quantityDelivered: r.quantityDelivered,
          linkedOrders: r.linkedOrders,
        }),
        roundingOf.get(r.articleId) ?? null
      ),
      error: null,
      // Set below once the structure is derived: the template's field, else
      // the derived operations for the row's quantity.
      leadDays: dating.articleLeadTimes.get(r.articleId) ?? 0,
    }));
    // Group the uncovered rows per (template, key): the derivation is linear
    // in quantity, so one call at the summed quantity equals the sum of the
    // per-row calls — each row then gets its share, dated with its own TO's
    // latest start (the component must be there when that TO begins).
    const groups = new Map<
      string,
      { templateId: string; selection: ConfiguratorSelection; quantity: number; needs: ConfiguredRowNeed[] }
    >();
    configured.forEach((r, i) => {
      const need = needs[i]!;
      if (need.uncoveredQuantity <= 0 || !need.templateActive) return;
      const key = `${r.articleId}:${r.configuration.key}`;
      const g = groups.get(key) ?? {
        templateId: r.articleId,
        selection: selectionFromEntries(r.configuration.selection),
        quantity: 0,
        needs: [],
      };
      g.quantity += need.uncoveredQuantity;
      g.needs.push(need);
      groups.set(key, g);
    });
    const derivedDemands: DerivedDemand[] = [];
    for (const g of groups.values()) {
      try {
        if (!deps.configuredStructure) throw new Error("ConfiguredStructureReader not wired");
        // Avvikelse 5: material only — the förkalkyl is not needed here.
        const s = await deps.configuredStructure(g.templateId, g.selection, g.quantity, { withCost: false });
        if (!s.valid) {
          for (const n of g.needs) n.error = s.errors[0] ?? "Konfigurationen är inte giltig";
          continue;
        }
        const operations = s.operations.map((o) => ({
          workCenterId: o.workCenterId,
          setupTime: Number(o.setupTime),
          runTimePerUnit: Number(o.runTimePerUnit),
        }));
        for (const n of g.needs) {
          n.leadDays = configuredLeadDays(dating.articleLeadTimes.get(g.templateId), operations, n.uncoveredQuantity, leadTime);
          const needDate = n.expectedDeliveryDate === null ? null : latestStartFor(n.expectedDeliveryDate, n.leadDays, offDays);
          const share = n.uncoveredQuantity / g.quantity;
          for (const m of s.materials) {
            derivedDemands.push({ articleId: m.componentArticleId, quantity: m.totalQuantity * share, needDate });
          }
        }
      } catch (err) {
        for (const n of g.needs) n.error = errorMessage(err);
      }
    }
    return {
      ...load,
      salesRows,
      manufacturingOrders,
      moMaterialRows,
      legoOperationRows,
      configuredRows: needs,
      configuredCascade: new Map(),
      derivedDemands,
      today,
      offDays,
      deliveryDefaults: delivery.defaults,
      leadDaysFor: leadTime.leadDaysFor,
    };
  }

  // The firm demand a new TO is dated from. Konfigurator 4c: a CONFIGURED
  // (beställningsvara) KO row is its own firm demand — the template's stock
  // and other rows' TOs are other configurations' units, so the pooled
  // coverage in findFirmDemand must not cover it (row B would otherwise be
  // dated from row A's TO, or left undated by a free unit in stock). No date
  // on the row, or nothing left to deliver on it (ordered − delivered ≤ 0,
  // the same delivered clamp as uncoveredConfiguredQuantity — the row's own
  // TOs are deliberately NOT netted: an extra TO is the operator's decision)
  // ⇒ nothing to plan by. Ordinary rows and calls without a row keep the
  // pooled rule, whose overview demand is the remaining quantity already.
  type ConfiguredRowRef = { configuration: ConfiguratorSelection };
  async function firmDemandFor(
    articleId: string,
    today: string,
    salesOrderRowId: string | undefined
  ): Promise<{ demand: FirmDemand | null; configuredRow: ConfiguredRowRef | null }> {
    if (salesOrderRowId) {
      const loaded = await repo.salesOrderRowForDueDate(salesOrderRowId);
      if (loaded?.configured && loaded.articleId === articleId) {
        const configuredRow: ConfiguredRowRef | null = loaded.configuration
          ? { configuration: selectionFromEntries(loaded.configuration.selection) }
          : null;
        if (loaded.quantityOrdered - loaded.quantityDelivered <= 0) return { demand: null, configuredRow };
        const [row] = await toShipDates([loaded]);
        if (!DEMAND_SALES_STATUSES.has(row!.orderStatus) || !row!.expectedDeliveryDate) return { demand: null, configuredRow };
        const demand: FirmDemand = {
          date: row!.expectedDeliveryDate,
          source: "sales_order_row",
          documentType: "sales_order",
          documentId: row!.salesOrderId,
          documentNumber: row!.orderNumber,
        };
        return { demand, configuredRow };
      }
    }
    const demand = findFirmDemand(buildArticleOverview(await loadOverviewInput(articleId)), { today, salesOrderRowId });
    return { demand, configuredRow: null };
  }

  // The lead time a new TO is dated with: the article's field, else its
  // routing for the quantity — or, for a configured (beställningsvara) row,
  // the template's field, else the derived structure's operations. A failed
  // derivation falls back to the template's routing: the date is a
  // suggestion, the create itself refuses an invalid configuration.
  async function leadDaysForNewOrder(articleId: string, quantity: number, configuredRow: ConfiguredRowRef | null): Promise<number> {
    const { context, articleLeadTimes } = await leadTimeInputsFor({ orderIds: [], articleIds: [articleId] });
    if (configuredRow && deps.configuredStructure) {
      try {
        const s = await deps.configuredStructure(articleId, configuredRow.configuration, quantity, { withCost: false });
        if (s.valid) {
          return configuredLeadDays(
            articleLeadTimes.get(articleId),
            s.operations.map((o) => ({ workCenterId: o.workCenterId, setupTime: Number(o.setupTime), runTimePerUnit: Number(o.runTimePerUnit) })),
            quantity,
            context
          );
        }
      } catch {
        // Fall through to the template's own routing.
      }
    }
    return context.leadDaysFor(articleId, quantity);
  }

  // The holidays suggestDueDate can reach: back from the demand (the working
  // day before) and forward from today over the lead time (the floor).
  async function dueDateOffDays(demandDate: string, today: string, leadDays: number): Promise<Set<string>> {
    const from = holidayLookbackStart(demandDate) < today ? holidayLookbackStart(demandDate) : today;
    const floorEnd = addDays(today, 2 * leadDays + 14);
    const to = demandDate > floorEnd ? demandDate : floorEnd;
    return new Set(await repo.fullDayHolidaysBetween(from, to));
  }

  // The färdigdatum for a TO of `quantity` dated from a KNOWN need (a
  // proposal's needDate): the working day before it, floored at today plus
  // the lead time (late ⇒ the floor). The source is "shortage" — Skapa
  // ordrar reads only dueDate/demandDate/late from it.
  async function dueDateForNeed(
    articleId: string,
    needDate: string,
    quantity: number,
    configuredRow: ConfiguredRowRef | null
  ): Promise<DueDateSuggestion> {
    const today = todayFn();
    const leadDays = await leadDaysForNewOrder(articleId, quantity, configuredRow);
    const demand: FirmDemand = { date: needDate, source: "shortage", documentType: null, documentId: null, documentNumber: null };
    return suggestDueDate(demand, { today, offDays: await dueDateOffDays(needDate, today, leadDays), leadDays });
  }

  function computedRequirements(refresh: boolean): { at: number; rows: Promise<RequirementRow[]> } {
    const t = now();
    if (refresh || !cache || t - cache.at >= cacheMs) {
      const rows = loadDatedInput().then(computeRequirements);
      const entry = { at: t, rows };
      cache = entry;
      rows.catch(() => {
        if (cache === entry) cache = null;
      });
    }
    return cache!;
  }

  // --- Produktionsplanering ----------------------------------------------
  // The plan's world: every open operation with its allocation, the
  // resources as the book sees them (lead time included), the calendars and
  // the full-day holidays out to the horizon. Read through `dbc` so a run
  // reads AFTER the production_plan lock in its own transaction.
  async function loadPlanWorld(dbc?: Tx) {
    const today = todayFn();
    const horizonTo = addDays(today, PLAN_HORIZON_WEEKS * 7 + 14);
    const capacity = await repo.loadCapacityInput(addDays(today, -7), horizonTo, dbc);
    // Optional on the repo for the unit tests' fakes ⇒ the default limit.
    const longOperationWeeks = await repo.longOperationWeeks?.(dbc);
    return { ...planWorldOf(capacity, today), longOperationWeeks };
  }
  function planWorldOf(capacity: CapacityInput, today: string) {
    const workCenters = new Map<string, PlanWorkCenter>(
      capacity.workCenters.map((w) => [
        w.workCenterId,
        {
          workCenterId: w.workCenterId,
          code: w.code,
          name: w.name,
          type: w.type,
          weekScheduleId: w.weekScheduleId,
          hoursPerDay: w.hoursPerDay,
          capacityFactor: w.capacityFactor,
          leadTimeDays: w.leadTimeDays ?? null,
        },
      ])
    );
    return {
      today,
      offDays: new Set(capacity.holidays.filter((h) => h.dayScheduleId === null).map((h) => h.date)) as ReadonlySet<string>,
      workCenters,
      schedule: { weekScheduleDays: capacity.weekScheduleDays, daySchedules: capacity.daySchedules, holidays: capacity.holidays },
      operations: capacity.operations,
    };
  }
  // Påbörjad: something reported, or an open/paused stamp session.
  const startedOf = (op: CapacityOperationRow, stamped: ReadonlySet<string>) =>
    (op.quantityCompleted ?? 0) > 0 || op.quantityScrapped > 0 || stamped.has(op.moOperationId);
  function groupOrders(operations: CapacityOperationRow[], stamped: ReadonlySet<string>): PlanOrder[] {
    const byOrder = new Map<string, PlanOrder>();
    for (const op of operations) {
      const order = byOrder.get(op.manufacturingOrderId) ?? {
        id: op.manufacturingOrderId,
        orderNumber: op.orderNumber,
        dueDate: op.dueDate,
        operations: [],
      };
      order.operations.push({ ...op, started: startedOf(op, stamped) });
      byOrder.set(op.manufacturingOrderId, order);
    }
    return [...byOrder.values()];
  }

  // A new TO's operations planned in its own create transaction (the caller
  // — createManufacturingOrderInTx — already holds the production_plan
  // lock; the advisory lock is reentrant, so taking it again is harmless and
  // keeps this safe to call on its own). Every other open operation is
  // existing load. With `given` (the reservation) the allocations are
  // written as they are, keyed by sequence number — no engine run. Returns
  // the warnings as texts for releaseWarnings: the horizon ("not planned")
  // and Sen, never a refusal.
  async function planNewOrderInTx(
    tx: Tx,
    manufacturingOrderId: string,
    given?: { sequenceNo: number; weeks: PlannedWeek[] }[]
  ): Promise<string[]> {
    await lockProductionPlan(tx);
    const world = await loadPlanWorld(tx);
    const own = world.operations.filter((o) => o.manufacturingOrderId === manufacturingOrderId);
    if (own.length === 0) return [];
    const plannedAt = new Date();
    // The reservation's weeks are keyed by sequence number: when the TO's
    // operations are not the ones the check planned (a configured row whose
    // template changed in between), the engine plans it instead and says so.
    const ownOrder: PlanOrder = {
      id: manufacturingOrderId,
      orderNumber: own[0]!.orderNumber,
      dueDate: own[0]!.dueDate,
      operations: own.map((o) => ({ ...o, started: false })),
    };
    const givenMatches =
      given !== undefined &&
      given.length === own.length &&
      given.every((g) => own.some((o) => o.sequenceNo === g.sequenceNo));
    const warnings: string[] = [];
    if (given && !givenMatches) {
      warnings.push("Operationerna stämmer inte med leveranstidskontrollens — ordern planerades på ledig kapacitet i stället");
      given = undefined;
    }
    if (given) {
      const bySeq = new Map(own.map((o) => [o.sequenceNo, o]));
      const plans: OperationPlan[] = [];
      const clear: string[] = [];
      for (const g of given) {
        const op = bySeq.get(g.sequenceNo);
        if (!op) continue;
        const weeks = [...g.weeks].sort((a, b) => (a.monday < b.monday ? -1 : a.monday > b.monday ? 1 : 0));
        if (weeks.length === 0) clear.push(op.moOperationId);
        else {
          plans.push({
            operationId: op.moOperationId,
            manufacturingOrderId,
            weeks,
            startWeek: weeks[0]!.monday,
            endWeek: weeks[weeks.length - 1]!.monday,
          });
        }
      }
      await repo.writeOperationPlans(tx, { plans, clear, plannedAt });
      return longOperationWarnings({
        today: world.today,
        offDays: world.offDays,
        workCenters: world.workCenters,
        schedule: world.schedule,
        orders: [ownOrder],
        longOperationWeeks: world.longOperationWeeks,
      }).map((w) => w.message);
    }
    const others = world.operations.filter((o) => o.manufacturingOrderId !== manufacturingOrderId);
    const result = planProduction({
      today: world.today,
      offDays: world.offDays,
      workCenters: world.workCenters,
      schedule: world.schedule,
      orders: [ownOrder],
      existingOperations: others,
      longOperationWeeks: world.longOperationWeeks,
    });
    await repo.writeOperationPlans(tx, { plans: result.plans, clear: result.clear, plannedAt });
    // Orimligt mycket tid is the one to catch here — the TO was just made
    // from the routing. A sequence break cannot happen on a fresh TO, and an
    // unscheduled resource is the matrix's business.
    const shown = new Set<PlanWarning["kind"]>(["long_operation", "horizon", "late"]);
    return [...warnings, ...result.warnings.filter((w) => shown.has(w.kind)).map((w) => w.message)];
  }

  // Ändra operationer: one order replanned with exactly Planera's rules —
  // påbörjad via reported quantities or an open stamp, locked operations
  // stay as fixed load, every other open operation is existing load — in
  // the edit's own transaction (the caller holds the production_plan lock;
  // the advisory lock is reentrant). Returns the warnings that concern the
  // edited order as texts: orimligt mycket tid, the horizon, Sen and a
  // sequence break.
  async function replanOrderInTx(tx: Tx, manufacturingOrderId: string): Promise<string[]> {
    await lockProductionPlan(tx);
    const [world, stamped] = [await loadPlanWorld(tx), await repo.stampedOperationIds(tx)];
    const own = world.operations.filter((o) => o.manufacturingOrderId === manufacturingOrderId);
    if (own.length === 0) return [];
    const others = world.operations.filter((o) => o.manufacturingOrderId !== manufacturingOrderId);
    const result = planProduction({
      today: world.today,
      offDays: world.offDays,
      workCenters: world.workCenters,
      schedule: world.schedule,
      orders: groupOrders(own, stamped),
      existingOperations: others,
      longOperationWeeks: world.longOperationWeeks,
    });
    await repo.writeOperationPlans(tx, { plans: result.plans, clear: result.clear, plannedAt: new Date() });
    const shown = new Set<PlanWarning["kind"]>(["long_operation", "horizon", "late", "sequence"]);
    return result.warnings.filter((w) => shown.has(w.kind)).map((w) => w.message);
  }

  async function orderPlanSummaries(orderIds: string[]): Promise<Map<string, OrderPlanSummary>> {
    const summaries = new Map<string, OrderPlanSummary>();
    if (orderIds.length === 0) return summaries;
    const today = todayFn();
    const horizonTo = addDays(today, PLAN_HORIZON_WEEKS * 7 + 14);
    const capacity = await repo.loadCapacityInput(addDays(today, -7), horizonTo, undefined, { orderIds });
    const world = planWorldOf(capacity, today);
    const lookups = buildScheduleLookups(capacity.weekScheduleDays, capacity.daySchedules, capacity.holidays);
    const byOrder = new Map<string, CapacityOperationRow[]>();
    for (const op of capacity.operations) byOrder.set(op.manufacturingOrderId, [...(byOrder.get(op.manufacturingOrderId) ?? []), op]);
    for (const [orderId, ops] of byOrder) {
      const status = orderPlanStatus(ops, { today, offDays: world.offDays, lookups, workCenters: world.workCenters });
      const mondays = ops
        .filter((op) => op.operationStatus === "pending" && hasPlan(op))
        .flatMap((op) => op.plannedWeeks!.map((w) => w.monday))
        .sort();
      summaries.set(orderId, {
        plannedStartWeek: mondays[0] ?? null,
        plannedEndWeek: mondays[mondays.length - 1] ?? null,
        late: status.late,
      });
    }
    return summaries;
  }

  // Promise.all, or one load at a time: a transaction has one connection,
  // which cannot run statements concurrently.
  async function loadAll<T extends readonly unknown[] | []>(
    sequential: boolean,
    thunks: { [K in keyof T]: () => Promise<T[K]> }
  ): Promise<T> {
    const list = thunks as readonly (() => Promise<unknown>)[];
    if (!sequential) return (await Promise.all(list.map((load) => load()))) as unknown as T;
    const out: unknown[] = [];
    for (const load of list) out.push(await load());
    return out as unknown as T;
  }

  // Leveranstidskontroll — the earliest ship/delivery date for a set of
  // rows from stock, open orders, material lead times and free capacity.
  // The pure rules are in delivery-time-check.ts; this loads the rows. With
  // `dbc` every read is bound to the reservation's transaction (the
  // configurator's derivation is a plain committed read, like
  // prepareCreate's); `action: "reserve"` also requires a confirmed order.
  async function runDeliveryTimeCheck(
    request: DeliveryTimeCheckRequest,
    opts: { dbc?: Tx; action: "check" | "reserve" } = { action: "check" }
  ): Promise<DeliveryTimeCheckResult & { order: { id: string; orderNumber: string } | null }> {
    const dbc = opts.dbc;
    const today = todayFn();
    let customerId = request.customerId ?? null;
    let checkedOrder: { id: string; orderNumber: string } | null = null;
    // coverage: an order row's linked TOs (a configured row's own TOs are
    // netted by uncoveredConfiguredQuantity below — the one implementation
    // behovsberäkningen uses — so a row that already has its TO is never
    // made twice; an ordinary row's linked TO is supply in the overview).
    type RequestRow = {
      key: string;
      articleId: string;
      quantity: number;
      selection: ConfiguratorSelection | null;
      coverage?: {
        quantityOrdered: number;
        quantityDelivered: number;
        linkedOrders: { id: string; orderNumber: string; status: string; quantity: number; dueDate: string | null }[];
      };
    };
    let requestRows: RequestRow[] = (request.rows ?? []).map((r, i) => ({
      key: String(i),
      articleId: r.articleId,
      quantity: r.quantity,
      selection: r.configuration ? r.configuration.selection : null,
    }));
    if (request.salesOrderId) {
      const order = await repo.deliveryCheckOrder(request.salesOrderId, dbc);
      if (!order) throw new SalesOrderNotFoundError(request.salesOrderId);
      if (!OPEN_SALES_ORDER_STATUSES.has(order.status)) throw new SalesOrderNotOpenError(order.status);
      if (opts.action === "reserve" && !RESERVABLE_SALES_ORDER_STATUSES.has(order.status)) {
        throw new SalesOrderNotOpenError(order.status, "reserve");
      }
      checkedOrder = { id: order.id, orderNumber: order.orderNumber };
      customerId ??= order.customerId;
      if (!request.rows) {
        requestRows = order.rows
          .filter((r) => r.rest > 0)
          .map((r) => ({
            key: r.rowId,
            articleId: r.articleId,
            quantity: r.rest,
            selection: r.configuration ? selectionFromEntries(r.configuration.selection) : null,
            coverage: { quantityOrdered: r.quantityOrdered, quantityDelivered: r.quantityDelivered, linkedOrders: r.linkedOrders },
          }));
      }
    }

    const rowArticles = new Map(
      (await repo.deliveryCheckArticles([...new Set(requestRows.map((r) => r.articleId))], dbc)).map((a) => [a.articleId, a])
    );
    // Configured rows: derived structure, or an existing variant as a
    // plain article. The check never creates a variant.
    const dtcRows: DtcRowInput[] = [];
    for (const r of requestRows) {
      const a = rowArticles.get(r.articleId);
      if (!a) throw new ArticleNotFoundError(r.articleId);
      if (a.configuratorMode === null) {
        if (r.selection) throw new ConfigurationNotAllowedError(a.articleNumber);
        dtcRows.push({ key: r.key, articleId: r.articleId, quantity: r.quantity });
        continue;
      }
      if (!r.selection) throw new ConfigurationRequiredError(a.articleNumber);
      if (!deps.configuredStructure) throw new Error("ConfiguredStructureReader not wired");
      // The batch: what the row's linked TOs do not already make, rounded
      // up to the article's step like an ordinary row's shortage — and the
      // structure is derived at THAT quantity, since the TO (prepareCreate
      // rounds the same way) carries the material totals for it.
      const uncovered = r.coverage
        ? uncoveredConfiguredQuantity({
            quantityOrdered: r.coverage.quantityOrdered,
            quantityDelivered: r.coverage.quantityDelivered,
            linkedOrders: r.coverage.linkedOrders,
          })
        : r.quantity;
      const batchQuantity = uncovered > 0 ? roundUpToMultiple(uncovered, a.rounding) : 0;
      const covered = {
        quantity: Math.max(0, Number((r.quantity - uncovered).toFixed(4))),
        orders: (r.coverage?.linkedOrders ?? []).map((o) => ({
          manufacturingOrderId: o.id,
          orderNumber: o.orderNumber,
          quantity: o.quantity,
          dueDate: o.dueDate,
          done: o.status === "done" || o.status === "closed",
        })),
      };
      const s = await deps.configuredStructure(r.articleId, r.selection, batchQuantity > 0 ? batchQuantity : r.quantity, {
        withCost: false,
        allowVariants: true,
      });
      if (!s.valid) {
        dtcRows.push({ key: r.key, articleId: r.articleId, quantity: r.quantity, error: s.errors[0] ?? "Konfigurationen är inte giltig" });
        continue;
      }
      const variantId = a.configuratorMode === "variants" && s.key ? await repo.findVariantByKey(r.articleId, s.key, dbc) : null;
      if (variantId) {
        dtcRows.push({ key: r.key, articleId: variantId, quantity: r.quantity });
        continue;
      }
      dtcRows.push({
        key: r.key,
        articleId: r.articleId,
        quantity: r.quantity,
        structure: {
          quantity: batchQuantity,
          operations:
            batchQuantity > 0
              ? s.operations.map((o) => ({
                  sequenceNo: o.sequenceNo,
                  workCenterId: o.workCenterId,
                  description: o.description,
                  setupTime: Number(o.setupTime),
                  runTimePerUnit: Number(o.runTimePerUnit),
                }))
              : [],
          materials: batchQuantity > 0 ? s.materials.map((m) => ({ articleId: m.componentArticleId, quantity: m.totalQuantity })) : [],
          covered,
        },
      });
    }

    // The whole tree: every article reachable through the BOM (phantoms
    // included) from the rows and the configured rows' material.
    const bomEdges = await repo.loadBomEdges(dbc);
    const childrenOf = new Map<string, string[]>();
    for (const e of bomEdges) childrenOf.set(e.parentArticleId, [...(childrenOf.get(e.parentArticleId) ?? []), e.componentArticleId]);
    const treeIds = new Set<string>();
    const queue = dtcRows.flatMap((r) => (r.structure ? r.structure.materials.map((m) => m.articleId) : [r.articleId]));
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (treeIds.has(id)) continue;
      treeIds.add(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
    for (const r of dtcRows) treeIds.add(r.articleId);
    const ids = [...treeIds];

    const horizonTo = addDays(today, PLAN_HORIZON_WEEKS * 7 + 14);
    // Sequential inside a transaction (one connection, no concurrent
    // statements on it); parallel on the plain db as before.
    const [treeArticles, routingRows, leadTimes, capacity, suppliers, delivery, customerFields] = await loadAll(dbc !== undefined, [
      () => repo.deliveryCheckArticles(ids, dbc),
      () => repo.routingsForArticles(ids, dbc),
      () => repo.workCenterLeadTimes(dbc),
      () => repo.loadCapacityInput(addDays(today, -7), horizonTo, dbc),
      () => repo.primarySuppliersForArticles(ids, dbc),
      () => repo.deliveryContext({ from: addDays(today, -200), to: horizonTo }, dbc),
      () => (customerId ? repo.customerDeliveryFields(customerId, dbc) : Promise.resolve(null)),
    ]);
    if (customerId && !customerFields) throw new CustomerNotFoundError(customerId);

    const articles = new Map<string, DtcArticle>(
      treeArticles.map((a) => [
        a.articleId,
        { articleId: a.articleId, articleNumber: a.articleNumber, name: a.name, type: a.type, rounding: a.rounding },
      ])
    );
    // Overviews (on ship dates) for everything with a pool — not the
    // configured templates themselves. One batch load for the whole tree.
    const overviews = new Map<string, { onHand: number; rows: ArticleOverview["rows"] }>();
    const configuredTemplates = new Set(dtcRows.filter((r) => r.structure).map((r) => r.articleId));
    const poolIds = treeArticles
      .filter((a) => !(a.type === "service" || a.isPhantom || configuredTemplates.has(a.articleId)))
      .map((a) => a.articleId);
    for (const [articleId, input] of await loadOverviewInputs(poolIds, dbc)) {
      const overview = buildArticleOverview(input);
      overviews.set(articleId, { onHand: overview.onHand, rows: overview.rows });
    }
    const routings = new Map<string, DtcOperation[]>();
    for (const r of routingRows) {
      routings.set(r.articleId, [
        ...(routings.get(r.articleId) ?? []),
        { sequenceNo: r.sequenceNo, workCenterId: r.workCenterId, description: r.description, setupTime: r.setupTime, runTimePerUnit: r.runTimePerUnit },
      ]);
    }
    const leadTimeOf = new Map(leadTimes.map((l) => [l.workCenterId, l.leadTimeDays]));
    const workCenters = new Map<string, DtcWorkCenter>(
      capacity.workCenters.map((w) => [
        w.workCenterId,
        {
          workCenterId: w.workCenterId,
          code: w.code,
          name: w.name,
          type: w.type,
          weekScheduleId: w.weekScheduleId,
          hoursPerDay: w.hoursPerDay,
          capacityFactor: w.capacityFactor,
          leadTimeDays: leadTimeOf.get(w.workCenterId) ?? null,
        },
      ])
    );

    const result = checkDeliveryTime({
      today,
      offDays: delivery.offDays,
      articles,
      overviews,
      excludeSalesOrderId: request.salesOrderId ?? null,
      bomEdges,
      phantomIds: new Set(treeArticles.filter((a) => a.isPhantom).map((a) => a.articleId)),
      routings,
      workCenters,
      schedule: { weekScheduleDays: capacity.weekScheduleDays, daySchedules: capacity.daySchedules, holidays: capacity.holidays },
      existingOperations: capacity.operations,
      suppliers: new Map(
        suppliers.map((s) => [
          s.articleId,
          {
            supplierName: s.supplierName,
            leadTimeDays: s.leadTimeDays,
            settings: effectiveDeliverySettings(s.supplierDelivery ?? NO_PARTNER_SETTINGS, "supplier", delivery.defaults),
          },
        ])
      ),
      customer: customerFields ? effectiveDeliverySettings(customerFields, "customer", delivery.defaults) : null,
      rows: dtcRows,
    });
    return { ...result, order: checkedOrder };
  }

  return {
    // Derived at read time, cached briefly (see REQUIREMENTS_CACHE_MS);
    // filters/paging apply to the cached result and never mutate it.
    async listRequirements(
      query: ListRequirementsQuery
    ): Promise<Paged<RequirementRow> & { computedAt: string }> {
      const entry = computedRequirements(query.refresh);
      let rows = await entry.rows;

      if (!query.showAll) rows = rows.filter((r) => r.proposalQuantity > 0);
      // Configured rows are typed "manufactured" by the calc, so the type
      // filter treats them as such without a special case.
      if (query.type) rows = rows.filter((r) => r.type === query.type);
      if (query.groupId) rows = rows.filter((r) => r.groupId === query.groupId);
      if (query.search) {
        const term = query.search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.articleNumber.toLowerCase().includes(term) ||
            r.articleName.toLowerCase().includes(term) ||
            // Konfigurator 4c: a configured row is also found by its KO
            // number and its choices ("Lås B").
            (r.salesOrderNumber?.toLowerCase().includes(term) ?? false) ||
            (r.configurationSummary?.toLowerCase().includes(term) ?? false)
        );
      }
      // Tidsfasade förslag: the horizon filter trims the proposals (and
      // drops rows left without any) BEFORE paging, so total counts what is
      // shown; the sort by latest date is a copy — the cache stays as is.
      if (query.latest) rows = filterByLatest(rows, query.latest, todayFn());
      if (query.sort === "latest") rows = [...rows].sort(compareByLatest);

      return {
        rows: rows.slice(query.offset, query.offset + query.limit),
        total: rows.length,
        computedAt: new Date(entry.at).toISOString(),
      };
    },

    // The CSV export's rows: the same filters, then one line per proposal (a
    // row without proposals — showAll — is one line with `proposal` null).
    // Paging applies to the flattened lines, so the export cap counts them.
    async listRequirementsForExport(query: ListRequirementsQuery): Promise<Paged<RequirementExportRow>> {
      const { rows } = await this.listRequirements({ ...query, offset: 0, limit: Number.MAX_SAFE_INTEGER });
      const lines: RequirementExportRow[] = rows.flatMap((row): RequirementExportRow[] =>
        row.proposals.length === 0 ? [{ ...row, proposal: null }] : row.proposals.map((proposal) => ({ ...row, proposal }))
      );
      return { rows: lines.slice(query.offset, query.offset + query.limit), total: lines.length };
    },

    // Aviseringar (Behöver beställas / Behöver tillverkas): the rows with a
    // proposal, read through the same cache as the list — never a recompute
    // and never a mutation of the cached rows (filter copies).
    async requirementProposals(): Promise<RequirementRow[]> {
      const rows = await computedRequirements(false).rows;
      return rows.filter((r) => r.proposalQuantity > 0);
    },

    // Artikelöversikt (planeringsbild) — one article's open rows in date
    // order with a running balance. Derived at read time like the MRP.
    async getArticleOverview(articleId: string): Promise<ArticleOverview> {
      return buildArticleOverview(await loadOverviewInput(articleId));
    },

    // The same for a set of articles in one batch (Leveranstidskontroll's
    // tree) — identical to getArticleOverview per article; unknown ids are
    // left out instead of failing the set.
    async getArticleOverviews(articleIds: string[]): Promise<Map<string, ArticleOverview>> {
      const inputs = await loadOverviewInputs(articleIds);
      return new Map([...inputs].map(([articleId, input]) => [articleId, buildArticleOverview(input)]));
    },

    // Färdigdatumsförslag for a new TO on the article — one working day
    // before its first firm demand not already covered by stock or open
    // IO/TO (or before the linked KO row's delivery date, if that row is
    // uncovered), today at the earliest. null = no uncovered dated demand.
    // Never before the earliest possible finish: today plus the article's
    // lead time (the field Ledtid (dagar), else the routing for `quantity`,
    // 1 when not given) — below that floor the floor is suggested with
    // `late`.
    async suggestManufacturingDueDate(
      articleId: string,
      opts: { salesOrderRowId?: string; quantity?: number } = {}
    ): Promise<DueDateSuggestion | null> {
      const today = todayFn();
      const { demand, configuredRow } = await firmDemandFor(articleId, today, opts.salesOrderRowId);
      if (!demand) return null;
      const leadDays = await leadDaysForNewOrder(articleId, opts.quantity ?? 1, configuredRow);
      return suggestDueDate(demand, { today, offDays: await dueDateOffDays(demand.date, today, leadDays), leadDays });
    },

    // Leveranstidskontroll — reads only (nothing is booked).
    async checkDeliveryTime(request: DeliveryTimeCheckRequest): Promise<DeliveryTimeCheckResult> {
      const { order: _order, ...result } = await runDeliveryTimeCheck(request);
      return result;
    },

    // Reservationen (Skapa tillverkningsordrar för det som saknas): ONE
    // transaction under the production_plan lock — the check is run again
    // with every read bound to the transaction, its delivery date must be
    // the one the client was shown, then a TO per shortage batch (children
    // before parents, planned in exactly the weeks the check booked; level
    // 1 linked to the KO row like Skapa TO, lower levels with a note), and
    // last the KO's Förväntat leveransdatum. Any error rolls everything
    // back — no half trees. Logged after the commit: "released" per TO and
    // delivery_time_applied on the KO.
    async applyDeliveryTime(input: ApplyDeliveryTimeInput, userId: string | null): Promise<ApplyDeliveryTimeResult> {
      const dates = deps.salesOrderDates;
      if (!dates) throw new Error("SalesOrderDateWriter not wired");
      const applied = await repo.transaction(async (tx) => {
        // The lock FIRST, before the check reads: what it sees is what the
        // TOs are planned against (same order as every other plan write).
        await lockProductionPlan(tx);
        const { order, ...result } = await runDeliveryTimeCheck({ salesOrderId: input.salesOrderId }, { dbc: tx, action: "reserve" });
        if (result.deliveryDate !== input.deliveryDate || result.shipDate === null) {
          throw new DeliveryTimeChangedError(result.deliveryDate, result);
        }
        // The client showed N TOs: a different count now (a TO created in
        // between covers a row, a template changed) is a changed outcome too.
        if (input.expectedOrders !== undefined && input.expectedOrders !== result.batches.length) {
          throw new DeliveryTimeChangedError(result.deliveryDate, result, { expected: input.expectedOrders, actual: result.batches.length });
        }
        if (result.batches.length === 0) throw new NothingToReserveError();
        const orderNumber = order!.orderNumber;
        // Lock order: advisory → the KO rows (sorted) → the order header.
        // Every row that gets a TO is locked here, before the first create —
        // the create takes the configured row's lock and then the header
        // (markInProduction), so without this a second row would be locked
        // AFTER the header, the reverse of updateRow/replaceRowConfiguration.
        await dates.lockRowsInTx(
          tx,
          result.batches.filter((b) => b.level === 1).map((b) => b.rowKey)
        );
        const manufacturingOrders: ApplyDeliveryTimeResult["manufacturingOrders"] = [];
        const warnings: string[] = [];
        // batches is already children-before-parents.
        for (const batch of result.batches) {
          const linked = batch.level === 1;
          const created = await deps.manufacturing.createManufacturingOrderInTx(
            tx,
            linked
              ? { salesOrderRowId: batch.rowKey, quantity: batch.quantity, dueDate: batch.readyDate }
              : {
                  articleId: batch.articleId,
                  quantity: batch.quantity,
                  dueDate: batch.readyDate,
                  note: `Skapad från leveranstidskontroll för ${orderNumber}`,
                },
            userId,
            { plannedWeeks: batch.operations.map((o) => ({ sequenceNo: o.sequenceNo, weeks: o.weeks })) }
          );
          // The promised weeks are locked: Planera keeps them until Lås upp
          // (operations without a plan — lego, 0 minutes, beyond the
          // horizon — have nothing to lock).
          await repo.lockOrderPlans(tx, created.id);
          manufacturingOrders.push({
            id: created.id,
            orderNumber: created.orderNumber,
            articleNumber: batch.articleNumber,
            // The TO's own quantity (prepareCreate rounds to the article's
            // step — the check rounds the same way, this is the authority).
            quantity: Number(created.quantity),
            level: batch.level,
            salesOrderRowId: linked ? batch.rowKey : null,
          });
          warnings.push(...created.releaseWarnings.map((w) => `${created.orderNumber}: ${w}`));
        }
        const dateWrite = await dates.setExpectedDeliveryDateInTx(tx, input.salesOrderId, input.deliveryDate);
        return {
          orderNumber,
          previousDeliveryDate: dateWrite.previous,
          result: { deliveryDate: input.deliveryDate, shipDate: result.shipDate, manufacturingOrders, warnings },
        };
      });
      for (const mo of applied.result.manufacturingOrders) {
        await audit.log({ entityType: "manufacturing_order", entityId: mo.orderNumber, action: "released", userId });
      }
      await audit.log({
        entityType: "sales_order",
        entityId: applied.orderNumber,
        action: "delivery_time_applied",
        detail: {
          deliveryDate: applied.result.deliveryDate,
          shipDate: applied.result.shipDate,
          previousDeliveryDate: applied.previousDeliveryDate,
          manufacturingOrders: applied.result.manufacturingOrders.map((mo) => ({
            orderNumber: mo.orderNumber,
            articleNumber: mo.articleNumber,
            quantity: mo.quantity,
            level: mo.level,
          })),
          warnings: applied.result.warnings,
        },
        userId,
      });
      return applied.result;
    },

    // Beläggning (E2) — fully derived at read time, like listRequirements.
    async getCapacity(query: CapacityQuery): Promise<CapacityResult> {
      // Anchor "today" in Europe/Stockholm — a UTC date would flip the week
      // column on Sunday evenings (winter time). sv-SE formats as YYYY-MM-DD.
      const today = todayFn();
      // Same horizon authority as the calc itself — the holiday query bounds
      // can never drift from the week columns.
      const { firstMonday } = capacityHorizon(today, query.weeks);
      // Holidays out to the plan horizon, not just the visible weeks: Sen
      // walks a planned operation's finish day (and a lego lead time) past
      // the matrix's last column.
      const input = await repo.loadCapacityInput(firstMonday, addDays(today, PLAN_HORIZON_WEEKS * 7 + 14));
      const offDays = new Set(input.holidays.filter((h) => h.dayScheduleId === null).map((h) => h.date));
      const result = computeCapacity(input, { today, weeks: query.weeks, offDays });
      if (query.productionGroupId) {
        result.groups = result.groups.filter((g) => g.productionGroupId === query.productionGroupId);
      }
      return result;
    },

    // Planera — every open TO's pending operations placed on free capacity
    // in priority order (production-plan.ts). One transaction under the
    // production_plan lock; the load is read after it.
    async planProductionRun(userId: string | null): Promise<PlanRunResult> {
      const run = await repo.transaction(async (tx) => {
        await lockProductionPlan(tx);
        const [world, stamped] = [await loadPlanWorld(tx), await repo.stampedOperationIds(tx)];
        const orders = groupOrders(world.operations, stamped);
        const result = planProduction({
          today: world.today,
          offDays: world.offDays,
          workCenters: world.workCenters,
          schedule: world.schedule,
          orders,
          longOperationWeeks: world.longOperationWeeks,
        });
        const plannedAt = new Date();
        await repo.writeOperationPlans(tx, { plans: result.plans, clear: result.clear, plannedAt });
        return { plannedAt: plannedAt.toISOString(), orders: orders.length, operations: result.plans.length, warnings: result.warnings };
      });
      await audit.log({
        entityType: "production_plan",
        entityId: null,
        action: "planned",
        detail: { orders: run.orders, operations: run.operations, warnings: run.warnings },
        userId,
      });
      return run;
    },

    // Flytta — the operation starts in weekMonday (whole-week capacity,
    // overload allowed) and is locked. The TO's earlier operations and, without
    // moveFollowing, its later ones keep their weeks (fixed load, like a
    // lock); with moveFollowing the later unlocked ones are replanned from
    // the new finish week. Everything else is existing load.
    async moveOperation(opId: string, input: MoveOperationInput, userId: string | null): Promise<MoveOperationResult> {
      const moved = await repo.transaction(async (tx) => {
        await lockProductionPlan(tx);
        const op = await repo.planOperation(opId, tx);
        if (!op) throw new OperationNotFoundError(opId);
        const currentWeek = mondayOf(todayFn());
        if (input.weekMonday < currentWeek) throw new PlanWeekInPastError(input.weekMonday, currentWeek);
        if (op.operationStatus === "done") throw new OperationNotPlannableError("done");
        if (op.workCenterType === "subcontract") throw new OperationNotPlannableError("subcontract");
        if (!OPEN_MO_STATUSES.has(op.orderStatus)) throw new OperationNotPlannableError("order_not_open");
        const world = await loadPlanWorld(tx);
        const target = world.operations.find((o) => o.moOperationId === opId);
        if (!target) throw new OperationNotPlannableError("order_not_open");
        // Under the book's threshold nothing would be written (roundPlanWeeks).
        if (remainingOperationMinutes(target) < MIN_PLAN_MINUTES) throw new OperationNotPlannableError("no_time");
        const stamped = await repo.stampedOperationIds(tx);

        const orderOps: PlanOperation[] = [];
        const fixed: CapacityOperationRow[] = [];
        for (const o of world.operations.filter((o) => o.manufacturingOrderId === op.manufacturingOrderId)) {
          const started = startedOf(o, stamped);
          const replan =
            o.moOperationId === opId ||
            o.operationStatus === "done" ||
            (o.sequenceNo > op.sequenceNo && input.moveFollowing && !o.planLocked);
          if (replan) orderOps.push({ ...o, started });
          // Kept as it is: planned ⇒ fixed load and the sequence floor, like a
          // lock but reported as "ligger fast" rather than "låst"; unplanned
          // ⇒ its due-date bucket, untouched.
          else if (hasPlan(o)) orderOps.push({ ...o, started, fixed: true });
          else fixed.push(o);
        }
        const result = planProduction({
          today: world.today,
          offDays: world.offDays,
          workCenters: world.workCenters,
          schedule: world.schedule,
          orders: [{ id: op.manufacturingOrderId, orderNumber: op.orderNumber, dueDate: target.dueDate, operations: orderOps }],
          existingOperations: [...world.operations.filter((o) => o.manufacturingOrderId !== op.manufacturingOrderId), ...fixed],
          forceStart: { operationId: opId, weekMonday: input.weekMonday },
          longOperationWeeks: world.longOperationWeeks,
        });
        await repo.writeOperationPlans(tx, { plans: result.plans, clear: result.clear, plannedAt: new Date() });
        // Locked only when it got a plan — beyond the horizon it is cleared
        // (the CHECK forbids a lock without weeks) and the warning says so.
        const placed = result.plans.some((p) => p.operationId === opId);
        const row = placed
          ? (await repo.setOperationLock(tx, opId, true))!
          : { plannedStartWeek: null, plannedEndWeek: null, planLocked: false };
        const seqOf = new Map(orderOps.map((o) => [o.moOperationId, o.sequenceNo]));
        const following = [
          ...result.plans
            .filter((p) => p.operationId !== opId)
            .map((p) => ({ moOperationId: p.operationId, sequenceNo: seqOf.get(p.operationId)!, plannedStartWeek: p.startWeek, plannedEndWeek: p.endWeek })),
          ...result.clear
            .filter((id) => id !== opId && (seqOf.get(id) ?? 0) > op.sequenceNo)
            .map((id) => ({ moOperationId: id, sequenceNo: seqOf.get(id)!, plannedStartWeek: null, plannedEndWeek: null })),
        ].sort((a, b) => a.sequenceNo - b.sequenceNo);
        return { op, operation: row, following, warnings: result.warnings };
      });
      await audit.log({
        entityType: "manufacturing_order",
        entityId: moved.op.orderNumber,
        action: "operation_moved",
        detail: {
          moOperationId: opId,
          sequenceNo: moved.op.sequenceNo,
          workCenterCode: moved.op.workCenterCode,
          fromWeek: moved.op.plannedStartWeek,
          toWeek: input.weekMonday,
          plannedStartWeek: moved.operation.plannedStartWeek,
          plannedEndWeek: moved.operation.plannedEndWeek,
          moveFollowing: input.moveFollowing,
          warnings: moved.warnings,
        },
        userId,
      });
      return { operation: moved.operation, following: moved.following, warnings: moved.warnings };
    },

    // Lås upp — the allocation stays until the next Planera. Idempotent.
    async unlockOperation(opId: string, userId: string | null): Promise<{ operation: PlannedOperationWeeks }> {
      const unlocked = await repo.transaction(async (tx) => {
        await lockProductionPlan(tx);
        const op = await repo.planOperation(opId, tx);
        if (!op) throw new OperationNotFoundError(opId);
        const row = (await repo.setOperationLock(tx, opId, false))!;
        return { op, row };
      });
      if (unlocked.op.planLocked) {
        await audit.log({
          entityType: "manufacturing_order",
          entityId: unlocked.op.orderNumber,
          action: "operation_unlocked",
          detail: { moOperationId: opId, sequenceNo: unlocked.op.sequenceNo, workCenterCode: unlocked.op.workCenterCode },
          userId,
        });
      }
      return { operation: unlocked.row };
    },

    planNewOrderInTx,
    replanOrderInTx,
    orderPlanSummaries,

    // One draft IO per primary supplier (Monitor-style grouping) plus one
    // planned TO per manufactured article. No batch transaction on purpose:
    // each order is created through its own service's transaction, partial
    // success keeps the created orders and reports the failures per article.
    async createOrdersFromProposals(
      input: CreatePlanningOrdersInput,
      createdBy: string
    ): Promise<CreatedOrdersResult> {
      const result: CreatedOrdersResult = { purchaseOrders: [], manufacturingOrders: [], errors: [], warnings: [] };

      const articleNumbers = new Map(
        (await repo.articleInfoForIds(input.proposals.map((p) => p.articleId))).map((a) => [
          a.articleId,
          a.articleNumber,
        ])
      );
      const numberFor = (articleId: string) => articleNumbers.get(articleId) ?? "";
      const pushError = (articleId: string, message: string) =>
        result.errors.push({ articleId, articleNumber: numberFor(articleId), message });

      const purchaseProposals = input.proposals.filter((p) => p.kind === "purchase");
      const manufactureProposals = input.proposals.filter((p) => p.kind === "manufacture");
      const subcontractProposals = input.proposals.filter((p) => p.kind === "subcontract");
      const configuredProposals = input.proposals.filter((p) => p.kind === "configured");

      // Tidsfasade förslag (#13): a proposal that carries its needDate is
      // dated from it (the TO's färdigdatum, the IO row's önskade
      // leveransdatum); one without (integrations) from the article's first
      // firm demand, as before. A TO whose earliest possible finish comes
      // after the need is created anyway and reported in `warnings`, exactly
      // like a late IO row — except a reorder-point proposal: it is dated
      // today for no deadline (the list never marks it Passerat), so its
      // floor date is simply "as soon as possible".
      const today = todayFn();
      const pushLateManufacturing = (
        orderNumber: string,
        articleId: string,
        s: DueDateSuggestion | null,
        reason: CreatePlanningOrdersInput["proposals"][number]["reason"]
      ) => {
        if (!s?.late || reason === "reorder_point") return;
        result.warnings.push({
          orderNumber,
          articleNumber: numberFor(articleId),
          demandDate: s.demandDate,
          deliveryDate: s.dueDate,
          message: `Färdigdatumet (${s.dueDate}) hinner inte före behovet (${s.demandDate})`,
        });
      };

      // Konfigurator 4c: configured rows first — they are parents (their TO's
      // material is what the component proposals below were netted against).
      // The manufacturing service derives the structure from the row's own
      // choices and refuses a row whose configuration is no longer valid.
      for (const proposal of configuredProposals) {
        try {
          // The TO is made from the row, so the row must be the configured
          // row OF this proposal's article — the article id is otherwise
          // only used for the result's labels, and a stale or mismatched
          // pair would silently make another article's TO.
          const linked = await repo.salesOrderRowForDueDate(proposal.salesOrderRowId!);
          if (!linked || !linked.configured || linked.articleId !== proposal.articleId) {
            pushError(proposal.articleId, "Kundorderraden hör inte till artikeln eller är inte konfigurerad");
            continue;
          }
          const suggestion = proposal.needDate
            ? await dueDateForNeed(
                proposal.articleId,
                proposal.needDate,
                proposal.quantity,
                linked.configuration ? { configuration: selectionFromEntries(linked.configuration.selection) } : null
              )
            : await this.suggestManufacturingDueDate(proposal.articleId, {
                salesOrderRowId: proposal.salesOrderRowId,
                quantity: proposal.quantity,
              });
          // onlyUncovered: the proposal may come from a cached list (up to
          // REQUIREMENTS_CACHE_MS old) or a second click — the row's TO is
          // only created for what it still lacks, checked under its lock.
          const mo = await deps.manufacturing.createFromSalesOrderRow(
            proposal.salesOrderRowId!,
            { quantity: proposal.quantity, onlyUncovered: true, ...(suggestion ? { dueDate: suggestion.dueDate } : {}) },
            createdBy
          );
          result.manufacturingOrders.push({
            id: mo.id,
            orderNumber: mo.orderNumber,
            articleNumber: numberFor(proposal.articleId),
          });
          pushLateManufacturing(mo.orderNumber, proposal.articleId, suggestion, proposal.reason);
        } catch (err) {
          pushError(proposal.articleId, errorMessage(err));
        }
      }

      // TOs FIRST, parents before components (low-level code order, like the
      // MRP's own netting): a new planned TO is material demand in its
      // components' overview, so both a component TO's färdigdatum and a
      // purchased component's önskade leveransdatum (below) land before it.
      // Within a level the proposals keep their order (stable sort) — two
      // week proposals of one article become two TOs.
      if (manufactureProposals.length > 1) {
        const levels = computeLowLevelCodes(await repo.loadBomEdges());
        manufactureProposals.sort((a, b) => (levels.get(a.articleId) ?? 0) - (levels.get(b.articleId) ?? 0));
      }

      for (const proposal of manufactureProposals) {
        try {
          const suggestion = proposal.needDate
            ? await dueDateForNeed(proposal.articleId, proposal.needDate, proposal.quantity, null)
            : await this.suggestManufacturingDueDate(proposal.articleId, { quantity: proposal.quantity });
          const mo = await deps.manufacturing.createManufacturingOrder(
            {
              articleId: proposal.articleId,
              quantity: proposal.quantity,
              note: "Skapad från behovsberäkning",
              ...(suggestion ? { dueDate: suggestion.dueDate } : {}),
            },
            createdBy
          );
          result.manufacturingOrders.push({
            id: mo.id,
            orderNumber: mo.orderNumber,
            articleNumber: numberFor(proposal.articleId),
          });
          pushLateManufacturing(mo.orderNumber, proposal.articleId, suggestion, proposal.reason);
        } catch (err) {
          pushError(proposal.articleId, errorMessage(err));
        }
      }

      const supplierByArticle = new Map(
        (await repo.primarySuppliersForArticles(purchaseProposals.map((p) => p.articleId))).map((s) => [
          s.articleId,
          s,
        ])
      );

      // The raw demand date per purchase proposal: its own needDate, else the
      // article's first firm demand (the TO färdigdatum rule's demand — a
      // KO's ship date or a TO's start), looked up once per article. A failed
      // suggestion is just no date — it must not stop the order (a real
      // problem fails addRow).
      const firstDemandByArticle = new Map<string, Promise<DueDateSuggestion | null>>();
      const firstDemandFor = (articleId: string) => {
        let pending = firstDemandByArticle.get(articleId);
        if (!pending) {
          pending = this.suggestManufacturingDueDate(articleId).catch(() => null);
          firstDemandByArticle.set(articleId, pending);
        }
        return pending;
      };

      type PurchaseRow = {
        articleId: string;
        quantity: number;
        unitPrice: number;
        demandDate: string | null;
        // A reorder-point proposal: dated, but never reported late.
        reorderPoint: boolean;
        // The fallback date when the delivery context cannot be loaded (the
        // working day before the demand, today at the earliest — the TO
        // färdigdatum rule, exactly as before fasta leveransdagar).
        fallbackDate: string | null;
      };
      const bySupplier = new Map<string, { supplierName: string; rows: PurchaseRow[] }>();
      for (const proposal of purchaseProposals) {
        const supplier = supplierByArticle.get(proposal.articleId);
        if (!supplier) {
          pushError(proposal.articleId, "Artikeln saknar huvudleverantör");
          continue;
        }
        let demandDate: string | null;
        let fallbackDate: string | null;
        if (proposal.needDate) {
          demandDate = proposal.needDate;
          // The working day before the need, today at the earliest (no
          // holidays without the context).
          const before = previousWorkingDay(demandDate, new Set<string>());
          fallbackDate = before < today ? today : before;
        } else {
          const first = await firstDemandFor(proposal.articleId);
          demandDate = first?.demandDate ?? null;
          fallbackDate = first?.dueDate ?? null;
        }
        const group = bySupplier.get(supplier.supplierId) ?? { supplierName: supplier.supplierName, rows: [] };
        group.rows.push({
          articleId: proposal.articleId,
          quantity: proposal.quantity,
          // Stafflat: the break for the proposal quantity, else grundpriset.
          unitPrice: resolveSupplierPrice(supplier, proposal.quantity).price ?? 0,
          demandDate,
          reorderPoint: proposal.reason === "reorder_point",
          fallbackDate,
        });
        bySupplier.set(supplier.supplierId, group);
      }

      // Önskat leveransdatum: the raw demand date per row, then the latest
      // arrival before it that the supplier's days allow, never earlier than
      // the earliest possible arrival with lead time and transit (late ⇒ a
      // warning). Without settings: the working day before the demand,
      // exactly as before.
      const knownDemands = [...bySupplier.values()].flatMap((g) => g.rows.flatMap((r) => (r.demandDate ? [r.demandDate] : [])));
      const maxLead = Math.max(0, ...[...supplierByArticle.values()].map((s) => s.leadTimeDays ?? 0));
      // The delivery context (defaults + holidays) is a convenience for the
      // dates, never a reason to fail — the TOs above already exist. Without
      // it the rows are dated as before fasta leveransdagar: the TO
      // färdigdatum rule's own date (the working day before the demand).
      const delivery =
        bySupplier.size > 0
          ? await repo.deliveryContext(deliveryHolidayWindow([today, ...knownDemands], maxLead + 60)).catch(() => null)
          : null;

      for (const [supplierId, group] of bySupplier) {
        // Tidsfasade förslag: ONE draft IO per supplier with the rows in
        // need-date order (undated last). An article with proposals in two
        // weeks gets two rows on it, each with its own date — the same
        // article may sit on several rows of an order.
        const bucket = [...group.rows].sort((a, b) =>
          a.demandDate === b.demandDate ? 0 : a.demandDate === null ? 1 : b.demandDate === null ? -1 : a.demandDate < b.demandDate ? -1 : 1
        );
        // The order gets the earliest date; a row whose own date is later
        // keeps it on the row (null = follows the order).
        const dates = bucket.map((row) => {
          const supplier = supplierByArticle.get(row.articleId)!;
          return delivery
            ? suggestPurchaseDeliveryDate({
                demandDate: row.demandDate,
                today,
                leadTimeDays: supplier.leadTimeDays,
                settings: effectiveDeliverySettings(supplier.supplierDelivery ?? NO_PARTNER_SETTINGS, "supplier", delivery.defaults),
                offDays: delivery.offDays,
              })
            : { date: row.fallbackDate, late: false };
        });
        const orderDate = dates
          .map((d) => d.date)
          .filter((d): d is string => d !== null)
          .sort()[0];

        let order: { id: string; orderNumber: string };
        try {
          order = await deps.purchase.createPurchaseOrder(
            { supplierId, exchangeRate: 1, ...(orderDate ? { expectedDeliveryDate: orderDate } : {}) },
            createdBy
          );
        } catch (err) {
          for (const row of bucket) pushError(row.articleId, errorMessage(err));
          continue;
        }
        let rowCount = 0;
        for (const [i, row] of bucket.entries()) {
          const { date: rowDate, late } = dates[i]!;
          try {
            await deps.purchase.addRow(order.id, {
              articleId: row.articleId,
              quantity: row.quantity,
              unitPrice: row.unitPrice,
              ...(rowDate && rowDate !== orderDate ? { expectedDeliveryDate: rowDate } : {}),
            });
            rowCount += 1;
            if (late && rowDate && row.demandDate && !row.reorderPoint) {
              result.warnings.push({
                orderNumber: order.orderNumber,
                articleNumber: numberFor(row.articleId),
                demandDate: row.demandDate,
                deliveryDate: rowDate,
                message: `Leveransen (${rowDate}) kommer efter behovet (${row.demandDate})`,
              });
            }
          } catch (err) {
            pushError(row.articleId, errorMessage(err));
          }
        }
        if (rowCount === 0) {
          // Every row failed — don't leave a rowless draft IO in the register
          // and don't report it as created. Best-effort cancel; the row
          // failures above are already reported per article.
          try {
            await deps.purchase.cancel(order.id);
          } catch {
            // The empty draft survives as junk, but the user already gets one
            // error per row; a cancel failure has nothing actionable to add.
          }
          continue;
        }
        result.purchaseOrders.push({
          id: order.id,
          orderNumber: order.orderNumber,
          supplierId,
          supplierName: group.supplierName,
          rowCount,
        });
      }

      // --- Subcontract (lego) proposals: grouped per supplier into ONE
      // draft IO like the purchase proposals, but keyed per MO OPERATION.
      // Supplier and prices are reloaded server-side from the operation
      // snapshot — the client only carries ids and quantities.
      if (subcontractProposals.length > 0) {
        const operationById = new Map(
          (await repo.legoOperationsForIds(subcontractProposals.map((p) => p.moOperationId!))).map((op) => [
            op.moOperationId,
            op,
          ])
        );

        type LegoRow = {
          articleId: string;
          quantity: number;
          unitPrice: number;
          setupPrice?: number;
          moOperationId: string;
        };
        // One draft IO per supplier; two lego operations on the same article
        // become two rows on it.
        const rowsBySupplier = new Map<string, { supplierName: string; rows: LegoRow[] }>();

        for (const proposal of subcontractProposals) {
          const operation = operationById.get(proposal.moOperationId!);
          if (!operation) {
            pushError(proposal.articleId, "Legooperationen finns inte längre eller är redan klar");
            continue;
          }
          if (!operation.supplierId) {
            pushError(
              proposal.articleId,
              `Legooperationen saknar leverantör (${operation.orderNumber} · Op ${operation.sequenceNo})`
            );
            continue;
          }
          const group = rowsBySupplier.get(operation.supplierId) ?? {
            supplierName: operation.supplierName ?? operation.supplierId,
            rows: [],
          };
          const row: LegoRow = {
            articleId: operation.articleId,
            quantity: proposal.quantity,
            unitPrice: operation.unitPrice ?? 0,
            setupPrice: operation.setupPrice ?? undefined,
            moOperationId: operation.moOperationId,
          };
          group.rows.push(row);
          rowsBySupplier.set(operation.supplierId, group);
        }

        // Önskat leveransdatum (user decision 2026-11-04): when the
        // operation must be back from the supplier — backward from the TO's
        // färdigdatum, never before the earliest return when ordered today
        // (legoReturnDates). The dating never fails the call: without it
        // the rows stay undated, as before the rule.
        const returns = await legoReturnDates([...operationById.values()]).catch(() => new Map<string, LegoReturn>());

        for (const [supplierId, group] of rowsBySupplier) {
          // Same shape as the purchase branch: rows in date order (undated
          // last), the order gets the earliest date and a row with a later
          // one keeps its own.
          const bucket = [...group.rows].sort((a, b) => {
            const dateA = returns.get(a.moOperationId)?.date ?? null;
            const dateB = returns.get(b.moOperationId)?.date ?? null;
            return dateA === dateB ? 0 : dateA === null ? 1 : dateB === null ? -1 : dateA < dateB ? -1 : 1;
          });
          const orderDate = bucket
            .map((row) => returns.get(row.moOperationId)?.date ?? null)
            .filter((d): d is string => d !== null)
            .sort()[0];
          let order: { id: string; orderNumber: string };
          try {
            order = await deps.purchase.createPurchaseOrder(
              { supplierId, exchangeRate: 1, ...(orderDate ? { expectedDeliveryDate: orderDate } : {}) },
              createdBy
            );
          } catch (err) {
            for (const row of bucket) pushError(row.articleId, errorMessage(err));
            continue;
          }
          let rowCount = 0;
          for (const row of bucket) {
            const dated = returns.get(row.moOperationId);
            try {
              await deps.purchase.addRow(order.id, {
                ...row,
                ...(dated && dated.date !== orderDate ? { expectedDeliveryDate: dated.date } : {}),
              });
              rowCount += 1;
              if (dated?.late && dated.finishDate) {
                result.warnings.push({
                  orderNumber: order.orderNumber,
                  articleNumber: numberFor(row.articleId),
                  demandDate: dated.finishDate,
                  deliveryDate: dated.date,
                  message: `Leveransen (${dated.date}) kommer efter behovet (${dated.finishDate})`,
                });
              }
            } catch (err) {
              pushError(row.articleId, errorMessage(err));
            }
          }
          if (rowCount === 0) {
            // Same best-effort cleanup as the purchase branch above.
            try {
              await deps.purchase.cancel(order.id);
            } catch {
              // The empty draft survives as junk; each row already
              // reported its own error.
            }
            continue;
          }
          result.purchaseOrders.push({
            id: order.id,
            orderNumber: order.orderNumber,
            supplierId,
            supplierName: group.supplierName,
            rowCount,
          });
        }
      }

      // The new orders cover the proposals — drop the cached result AFTER
      // they exist, so a read racing the creation can't re-cache the old one.
      cache = null;
      return result;
    },
  };
}

export type PlanningService = ReturnType<typeof createPlanningService>;
