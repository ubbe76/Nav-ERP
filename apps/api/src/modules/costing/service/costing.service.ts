import {
  SEK,
  type CostCalculationType,
  type CostingMaterialSource,
  type CostingSupplierPriceTier,
  type CostVarianceAnalysis,
  type DerivedCosting,
} from "@navet/shared";
import type {
  CostCalculationWrite,
  CostingRepository,
  MaterialRowWrite,
  OperationRowWrite,
} from "../repository/costing.repository.js";
import { applyMarkups, type CostingMarkups, type MarkedUpCosts } from "./markup.js";
import {
  buildMaterialRow,
  buildOperationRow,
  buildOperationRows,
  buildSubcontractOperationRow,
  directCosts,
  type RoutingRow,
} from "./level-costing.js";
import { costMultiLevel, type SubAssemblyPort } from "./sub-assembly.js";
import { explodeDerivedMaterials } from "../../configurator/service/configurator-explode.js";
import { manufacturingCost, perUnit, selfCost } from "./cost-figures.js";
import { ExchangeRateUnavailableError, type ExchangeRateReader } from "../../system/service/exchange-rates.js";
import { stockholmDateOf, stockholmToday } from "../../system/service/delivery-days.js";
import { pricedAtWithdrawal, type PriceHistories, type WithdrawalPriceBasis } from "./price-at.js";
import {
  costVarianceAnalysis,
  isPreliminaryStatus,
  materialOutput,
  materialScrap,
  oneOffCounts,
  operationOutput,
  operationWorked,
  plannedShare,
  roundAsNumeric,
  storedVarianceAnalysis,
  type OutputContext,
  type VarianceMaterialInput,
  type VarianceOperationInput,
} from "./cost-variance.js";

export class ArticleNotFoundError extends Error {
  constructor(id: string) {
    super(`Article ${id} not found`);
    this.name = "ArticleNotFoundError";
  }
}

export class ManufacturingOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Manufacturing order ${id} not found`);
    this.name = "ManufacturingOrderNotFoundError";
  }
}

export class CostCalculationNotFoundError extends Error {
  constructor(id: string) {
    super(`Cost calculation ${id} not found`);
    this.name = "CostCalculationNotFoundError";
  }
}

// A post-calculation is the record of what a manufacturing order actually
// cost, so the product deliberately cannot remove one. Pre-calculations are
// provisional by nature and delete freely.
export class PostCalculationLockedError extends Error {
  constructor(id: string) {
    super(`Cost calculation ${id} is a post-calculation and cannot be deleted`);
    this.name = "PostCalculationLockedError";
  }
}

// A calculation whose quantity cannot carry a per-unit figure. Nothing is
// written — a standard cost derived by dividing by zero would be worse than
// the stale one it replaced.
export class InvalidCalculationQuantityError extends Error {
  constructor(id: string) {
    super(`Cost calculation ${id} has no usable quantity`);
    this.name = "InvalidCalculationQuantityError";
  }
}

// Narrow slice of the article service — writing a calculated figure back onto
// the article. Injected rather than imported so the standard cost travels the
// SAME path the article card uses, and its history row is written inside
// updateStandardCost's own transaction.
export interface ArticlePriceWriter {
  updateStandardCost(id: string, standardCost: number): Promise<unknown>;
  updateSalesPrice(id: string, salesPrice: number): Promise<unknown>;
}

// Narrow reader for the costing settings owned by the system module (System →
// Kalkyler) — same pattern as AtfSettingsReader in atf.service.ts.
export interface CostingSettingsReader {
  getSettings(): Promise<{
    // Förkalkylens materialkälla (and the configurator's preview).
    costingMaterialSource: CostingMaterialSource;
    // Efterkalkylens. Optional so stubs that predate the split still satisfy
    // the interface; absent = the förkalkyl's, the pre-split behaviour.
    costingPostMaterialSource?: CostingMaterialSource;
    // Optional so test stubs that predate the staffel still satisfy the
    // interface; absent = "base" (grundpriset), the pre-staffel behaviour.
    costingSupplierPriceTier?: CostingSupplierPriceTier;
    costingMoPercent: number;
    costingLoPercent: number;
    costingAffoPercent: number;
    costingGeneralMarkupPercent: number;
    // Optional for the same reason; absent = 0, no materialpåslag.
    costingMaterialMarkupPercent?: number;
  }>;
}

// The same article can produce several material lines — drawn at different
// operations, or reached through a phantom as well as directly — and a warning
// names only the article, so those lines repeat the identical text. Repeating
// it tells the user nothing, so each distinct message is reported once.
function distinct(warnings: string[]) {
  return [...new Set(warnings)];
}

// Leverantörspris i valuta: the rate for every currency a calculation run
// meets — today's, or the day the basis was priced as of (the efterkalkyl's
// priceDate) — looked up once per currency and day and BEFORE any arithmetic:
// getRate may call Riksbanken, and resolveUnitCost stays pure. Only the
// "supplier" source reads supplier prices, so the other sources never trigger
// a lookup. A currency without a rate gets null and resolveUnitCost falls back
// with a warning; any other error is a real failure and propagates. Exported
// for Produkter i arbete, which prices its withdrawals the same way.
export function createRateAttacher(rates: Pick<ExchangeRateReader, "getRate">, source: CostingMaterialSource, today: string) {
  const byCurrencyAndDay = new Map<string, Promise<number | null>>();
  function rateFor(currency: string, day: string) {
    const key = `${currency}|${day}`;
    let rate = byCurrencyAndDay.get(key);
    if (!rate) {
      rate = rates.getRate(currency, day).then(
        (lookup) => lookup.rate,
        (err: unknown) => {
          if (err instanceof ExchangeRateUnavailableError) return null;
          throw err;
        }
      );
      byCurrencyAndDay.set(key, rate);
    }
    return rate;
  }
  return async function attachRates<T extends { supplierCurrency?: string | null; priceDate?: string | null }>(
    bases: T[]
  ): Promise<(T & { supplierExchangeRate: number | null })[]> {
    return Promise.all(
      bases.map(async (basis) => {
        const currency = basis.supplierCurrency ?? SEK;
        return {
          ...basis,
          supplierExchangeRate:
            source === "supplier" && currency !== SEK ? await rateFor(currency, basis.priceDate ?? today) : null,
        };
      })
    );
  };
}

export interface CostingConfig {
  source: CostingMaterialSource;
  postSource: CostingMaterialSource;
  supplierPriceTier: CostingSupplierPriceTier;
  markups: CostingMarkups;
}

// System → Kalkyler as the calculations read it. Exported for Produkter i
// arbete, which uses the efterkalkyl's material source and today's MO/LO.
export async function loadCostingConfig(settings: CostingSettingsReader): Promise<CostingConfig> {
  const s = await settings.getSettings();
  return {
    source: s.costingMaterialSource,
    postSource: s.costingPostMaterialSource ?? s.costingMaterialSource,
    supplierPriceTier: s.costingSupplierPriceTier ?? "base",
    markups: {
      moPercent: s.costingMoPercent,
      loPercent: s.costingLoPercent,
      affoPercent: s.costingAffoPercent,
      generalMarkupPercent: s.costingGeneralMarkupPercent,
      materialMarkupPercent: s.costingMaterialMarkupPercent ?? 0,
    },
  };
}

// A calculation that was computed but not written. Same field names as the
// saved header and the same string scale the numeric columns hand back
// ("100.0000", "10.00"), with id/calculatedAt null because nothing was stored
// — so the web renders a preview and a saved calculation with one code path.
export interface CostCalculationDraft {
  id: null;
  articleId: string;
  manufacturingOrderId: string | null;
  quantity: string;
  materialCost: string;
  materialOverhead: string;
  laborCost: string;
  overhead: string;
  subcontractCost: string;
  subcontractOverhead: string;
  semiFinishedCost: string;
  businessOverhead: string;
  generalMarkup: string;
  materialMarkup: string;
  salesPrice: string;
  materialSource: CostingMaterialSource;
  multiLevel: boolean;
  moPercent: string;
  loPercent: string;
  affoPercent: string;
  generalMarkupPercent: string;
  materialMarkupPercent: string;
  type: CostCalculationType;
  calculatedAt: null;
  // Avvikelseanalys (#14) — null on a förkalkyl.
  outputQuantity: string | null;
  preliminary: boolean | null;
  basePricedAt: Date | null;
  baseMaterialSource: CostingMaterialSource | null;
}

// The saved header exactly as the repository returns it. Named so the
// save-aware overloads below can say which of the two shapes a call yields.
export type SavedCostCalculation = Awaited<ReturnType<CostingRepository["createCostCalculation"]>>;

// Money columns are numeric(14,4), percent columns numeric(6,2). Two
// different paths turn a header number into the stored/displayed text: the
// draft's toFixed rounds the exact binary float, while the repository's
// String() is rounded a second time by Postgres, on write to the numeric
// column. At a halfway value (e.g. 50.00125) those two roundings can disagree
// on the last digit — toFixed truncates the float's actual (slightly-under)
// binary value to "50.0012", while Postgres rounds the decimal text
// "50.00125" up to "50.0013". Rounding once here, in toHeader, before either
// path sees the number, means both consume an already-decided value and can
// no longer disagree.
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// The draft's string form of an already-rounded header number — just format,
// not round again.
function money(value: number): string {
  return value.toFixed(4);
}

function percent(value: number): string {
  return value.toFixed(2);
}

// Everything the calculation is, before it is (maybe) written. TVK and SVK from
// applyMarkups are derived and never stored, so they are deliberately dropped
// here; the System → Kalkyler configuration is snapshotted onto the header so
// an old calculation stays explainable after the settings change. Every field
// is rounded to its column's scale here — the one and only rounding — so the
// draft and the saved row can never diverge on it (see `round` above).
function toHeader(
  identity: {
    articleId: string;
    manufacturingOrderId: string | null;
    quantity: number;
    type: CostCalculationType;
    multiLevel: boolean;
  },
  costs: MarkedUpCosts,
  source: CostingMaterialSource,
  markups: CostingMarkups,
  // The avvikelseanalys's header inputs — efterkalkyl only.
  variance: { outputQuantity: number; preliminary: boolean; basePricedAt: Date; baseMaterialSource: CostingMaterialSource } | null = null
): CostCalculationWrite {
  return {
    articleId: identity.articleId,
    manufacturingOrderId: identity.manufacturingOrderId,
    quantity: round(identity.quantity, 4),
    type: identity.type,
    materialCost: round(costs.materialCost, 4),
    materialOverhead: round(costs.materialOverhead, 4),
    laborCost: round(costs.laborCost, 4),
    overhead: round(costs.overhead, 4),
    subcontractCost: round(costs.subcontractCost, 4),
    subcontractOverhead: round(costs.subcontractOverhead, 4),
    semiFinishedCost: round(costs.semiFinishedCost, 4),
    businessOverhead: round(costs.businessOverhead, 4),
    generalMarkup: round(costs.generalMarkup, 4),
    materialMarkup: round(costs.materialMarkup, 4),
    salesPrice: round(costs.salesPrice, 4),
    materialSource: source,
    multiLevel: identity.multiLevel,
    moPercent: round(markups.moPercent, 2),
    loPercent: round(markups.loPercent, 2),
    affoPercent: round(markups.affoPercent, 2),
    generalMarkupPercent: round(markups.generalMarkupPercent, 2),
    materialMarkupPercent: round(markups.materialMarkupPercent, 2),
    outputQuantity: variance ? round(variance.outputQuantity, 4) : null,
    preliminary: variance?.preliminary ?? null,
    basePricedAt: variance?.basePricedAt ?? null,
    baseMaterialSource: variance?.baseMaterialSource ?? null,
  };
}

function toDraft(header: CostCalculationWrite): CostCalculationDraft {
  return {
    id: null,
    articleId: header.articleId,
    manufacturingOrderId: header.manufacturingOrderId,
    quantity: money(header.quantity),
    materialCost: money(header.materialCost),
    materialOverhead: money(header.materialOverhead),
    laborCost: money(header.laborCost),
    overhead: money(header.overhead),
    subcontractCost: money(header.subcontractCost),
    subcontractOverhead: money(header.subcontractOverhead),
    semiFinishedCost: money(header.semiFinishedCost),
    businessOverhead: money(header.businessOverhead),
    generalMarkup: money(header.generalMarkup),
    materialMarkup: money(header.materialMarkup),
    salesPrice: money(header.salesPrice),
    materialSource: header.materialSource,
    multiLevel: header.multiLevel,
    moPercent: percent(header.moPercent),
    loPercent: percent(header.loPercent),
    affoPercent: percent(header.affoPercent),
    generalMarkupPercent: percent(header.generalMarkupPercent),
    materialMarkupPercent: percent(header.materialMarkupPercent),
    type: header.type,
    calculatedAt: null,
    outputQuantity: header.outputQuantity === null ? null : money(header.outputQuantity),
    preliminary: header.preliminary,
    basePricedAt: header.basePricedAt,
    baseMaterialSource: header.baseMaterialSource,
  };
}

// Labels for the analysis's rows in a preview — index-aligned with the
// computed specification rows (a saved calculation reads them from its rows).
interface VarianceLabels {
  material: { articleNumber: string; articleName: string }[];
  operations: { workCenterCode: string; workCenterName: string }[];
}

// The avvikelseanalys of a computed, unsaved efterkalkyl: the in-memory rows
// at their columns' scale (roundAsNumeric), so a preview reads exactly what
// the saved calculation will read back.
function draftVarianceAnalysis(
  header: CostCalculationWrite,
  materialRows: MaterialRowWrite[],
  operationRows: OperationRowWrite[],
  labels: VarianceLabels
): CostVarianceAnalysis | null {
  const n = (value: number | null | undefined, scale: number) =>
    value === null || value === undefined ? null : roundAsNumeric(value, scale);
  const material: VarianceMaterialInput[] = materialRows.map((r, i) => ({
    id: null,
    componentArticleId: r.componentArticleId,
    articleNumber: labels.material[i]?.articleNumber ?? "?",
    articleName: labels.material[i]?.articleName ?? "?",
    kind: r.kind,
    quantity: roundAsNumeric(r.quantity, 4),
    unitCost: roundAsNumeric(r.unitCost, 4),
    amount: roundAsNumeric(r.amount, 4),
    baseQuantity: n(r.baseQuantity, 4),
    baseUnitCost: n(r.baseUnitCost, 4),
    basePriceSource: r.basePriceSource ?? null,
    scrapQuantity: n(r.scrapQuantity, 4),
  }));
  const operations: VarianceOperationInput[] = operationRows.map((r, i) => ({
    id: null,
    sequenceNo: r.sequenceNo,
    workCenterId: r.workCenterId,
    workCenterCode: labels.operations[i]?.workCenterCode ?? "?",
    workCenterName: labels.operations[i]?.workCenterName ?? "?",
    hours: roundAsNumeric(r.hours, 4),
    setupHours: n(r.setupHours, 4),
    runHours: n(r.runHours, 4),
    hourlyRate: roundAsNumeric(r.hourlyRate, 2),
    laborAmount: roundAsNumeric(r.laborAmount, 4),
    subcontractAmount: n(r.subcontractAmount, 4),
    baseSetupHours: n(r.baseSetupHours, 8),
    baseRunHours: n(r.baseRunHours, 8),
    baseHourlyRate: n(r.baseHourlyRate, 2),
    baseQuantity: n(r.baseQuantity, 4),
    subcontractQuantity: n(r.subcontractQuantity, 4),
    baseUnitPrice: n(r.baseUnitPrice, 4),
    baseOneOff: n(r.baseOneOff, 2),
  }));
  return costVarianceAnalysis({ ...header, manufacturingCost: manufacturingCost(header) }, material, operations);
}

// The avvikelseanalys of a saved calculation, from its stored inputs — null
// on a förkalkyl and on an efterkalkyl saved before the analysis. The mapping
// is cost-variance.ts's, shared with Kalkylutfall.
function savedVarianceAnalysis(
  calculation: SavedCostCalculation,
  materialRows: Awaited<ReturnType<CostingRepository["listMaterialRows"]>>,
  operationRows: Awaited<ReturnType<CostingRepository["listOperationRows"]>>
): CostVarianceAnalysis | null {
  return storedVarianceAnalysis(calculation, materialRows, operationRows);
}

// A pre-calculation has no consumptions, so there is no actual cost to read —
// it prices material at the standard cost and says so. The header still
// snapshots "actual": the column records what the calculation was TOLD to read
// from, while each row's priceSource records what it actually used, so the
// specification shows the fallback per row. Shared by the Kalkyl tab's
// pre-calculation and the configurator's preview so the label cannot drift.
function preCalculationSource(configured: CostingMaterialSource, warnings: string[]): Exclude<CostingMaterialSource, "actual"> {
  if (configured !== "actual") return configured;
  warnings.push("Verklig kostnad gäller bara efterkalkylen — förkalkylen använder standardpris");
  return "standard";
}

// A structure that is not stored in bom_components/routing_operations — what
// the configurator derives for one configuration. Quantities are per unit.
export interface PreviewStructure {
  // `operationId` = the routing/configurator operation that consumes the row (merge key, as in bom-explosion.ts).
  components: { componentArticleId: string; quantity: number; unitId: string | null; unitFactor: string | null; operationId?: string | null }[];
  operations: {
    sequenceNo: number; workCenterId: string; setupTime: number; runTimePerUnit: number; setupPrice?: number | null; unitPrice?: number | null;
  }[];
}

export function createCostingService(
  repo: CostingRepository,
  settings: CostingSettingsReader,
  // Optional so the many test files that construct this service with two
  // arguments keep compiling; app.ts always wires the real writer. The stub is
  // loud rather than silent — a missing writer is a wiring bug, not a mode.
  articles: ArticlePriceWriter = {
    updateStandardCost: async () => {
      throw new Error("ArticlePriceWriter not wired");
    },
    updateSalesPrice: async () => {
      throw new Error("ArticlePriceWriter not wired");
    },
  },
  // Today's rate for a supplier price in another currency. Optional for the
  // same reason as the writer, and just as loud: it is only asked when a
  // calculation actually meets a foreign supplier price.
  rates: Pick<ExchangeRateReader, "getRate"> = {
    getRate: async () => {
      throw new Error("ExchangeRateReader not wired");
    },
  },
  today: () => string = stockholmToday
) {
  // The repository's cost basis with today's rates attached — the one port
  // every pre-calculation path costs through, multi-level sub-levels and the
  // configurator's derived structure included.
  function ratedPort(port: SubAssemblyPort, attachRates: ReturnType<typeof createRateAttacher>): SubAssemblyPort {
    return {
      ...port,
      getComponentCostBasis: async (articleIds) => attachRates(await port.getComponentCostBasis(articleIds)),
    };
  }


  // No MO required — direct BOM components x their unit cost + Routing x work
  // center hourly rate, for a hypothetical quantity, then the markups from
  // System → Kalkyler. Phantom BOM components are resolved past into their
  // own components (see bom-explosion.ts) so a phantom's own (nonexistent)
  // standardCost is never costed directly. Read and arithmetic only — the
  // preview and the saving call run this exact same code.
  //
  // `multiLevel` (Räkna om underliggande nivåer) additionally resolves each
  // MANUFACTURED component into its own structure and routing instead of
  // reading its standard cost; see sub-assembly.ts. Off by default, and with
  // it off this produces exactly the numbers it always has.
  async function computePreCalculation(articleId: string, quantity: number, multiLevel: boolean) {
    const article = await repo.findArticleById(articleId);
    if (!article) throw new ArticleNotFoundError(articleId);

    const warnings: string[] = [];
    const { source: configured, supplierPriceTier, markups } = await loadCostingConfig(settings);
    const source = preCalculationSource(configured, warnings);
    const port = ratedPort(repo, createRateAttacher(rates, source, today()));

    let materialRows: MaterialRowWrite[];
    let operationRows: OperationRowWrite[];

    if (multiLevel) {
      const level = await costMultiLevel(port, articleId, quantity, source, markups, supplierPriceTier);
      materialRows = level.materialRows;
      operationRows = level.operationRows;
      warnings.push(...level.warnings);
    } else {
      const components = await repo.explodeBom(articleId, quantity);
      const basisById = new Map(
        (await port.getComponentCostBasis(components.map((c) => c.componentArticleId))).map((b) => [b.id, b])
      );

      materialRows = [];
      for (const c of components) {
        const { row, warning } = buildMaterialRow(
          { componentArticleId: c.componentArticleId, quantity: c.totalQuantity, unitId: c.unitId, unitFactor: c.unitFactor },
          basisById.get(c.componentArticleId),
          source,
          supplierPriceTier
        );
        if (warning) warnings.push(`${c.componentName}: ${warning}`);
        materialRows.push(row);
      }

      const operations = await repo.getRoutingWithWorkCenters(articleId);
      operationRows = buildOperationRows(operations, quantity, warnings);
    }

    const costs = applyMarkups(directCosts(materialRows, operationRows), markups);
    const header = toHeader(
      { articleId, manufacturingOrderId: null, quantity, type: "pre", multiLevel },
      costs,
      configured,
      markups
    );
    return { header, materialRows, operationRows, warnings };
  }

  // Efterkalkylen prissätter vid uttaget: with source standard or supplier,
  // each component is priced as of its latest withdrawal on the order — the
  // standard cost from its history (D1), the primary supplier's catalog row
  // from its snapshots (migration 0169), and (via priceDate) the rate of that
  // day. The calculation then gives the same answer when it is re-run later.
  // A component never drawn is priced as of now. Verklig kostnad is already
  // per withdrawal and untouched. The rule itself is price-at.ts's
  // pricedAtWithdrawal, shared with Produkter i arbete.
  async function withdrawalPrices<T extends WithdrawalPriceBasis>(
    manufacturingOrderId: string,
    consumptions: T[],
    source: CostingMaterialSource,
    histories: PriceHistories
  ): Promise<(T & { priceDate: string | null })[]> {
    if (source === "actual" || consumptions.length === 0) return consumptions.map((c) => ({ ...c, priceDate: null }));
    return pricedAtWithdrawal(consumptions, await repo.getLatestConsumptionTimes(manufacturingOrderId), histories, new Date());
  }

  // Requires an existing MO — actual material consumption x unit cost, actual
  // reported hours per operation x work center hourly rate, then the same
  // markups as the pre-calculation. Read and arithmetic only, as above.
  //
  // Avvikelseanalys (#14): alongside, the base every row is compared with —
  // the order's OWN rows (an Ändrad TO is the new plan, a konfigurerad TO's
  // rows are its configuration) for the produced quantity N, material priced
  // with the förkalkyl's rules as of T₀ = the order's created_at. The rules
  // are cost-variance.ts's; the base rides on the specification rows and is
  // saved with them. Nothing here changes the efterkalkyl's own figures.
  async function computePostCalculation(manufacturingOrderId: string) {
    const order = await repo.findManufacturingOrderById(manufacturingOrderId);
    if (!order) throw new ManufacturingOrderNotFoundError(manufacturingOrderId);

    const warnings: string[] = [];
    const { source: preSource, postSource: source, supplierPriceTier, markups } = await loadCostingConfig(settings);

    const rawConsumptions = await repo.getMaterialConsumptionsWithCost(manufacturingOrderId);
    // One load of the price histories serves both sides: the efterkalkyl's
    // prices at the withdrawal and the base's at T₀.
    const histories = await repo.getPriceHistories([...new Set(rawConsumptions.map((c) => c.componentArticleId))]);
    const consumptions = await createRateAttacher(rates, source, today())(
      await withdrawalPrices(manufacturingOrderId, rawConsumptions, source, histories)
    );
    // Only asked for when the configured source needs it — deriving the moving
    // average costs two queries and a replay, and the other two sources have
    // no use for the answer.
    const actualCosts =
      source === "actual" ? await repo.getConsumptionMovingAverageCosts(manufacturingOrderId) : null;
    const materialRows: MaterialRowWrite[] = [];
    for (const c of consumptions) {
      const { row, warning } = buildMaterialRow(
        { componentArticleId: c.componentArticleId, quantity: Number(c.quantityConsumed), unitId: c.unitId, unitFactor: c.unitFactor },
        { ...c, actualCost: actualCosts?.get(c.componentArticleId) ?? null },
        source,
        supplierPriceTier
      );
      if (warning) warnings.push(`${c.name}: ${warning}`);
      materialRows.push(row);
    }

    const [operations, actualSubcontractCosts] = await Promise.all([
      repo.getOperationsWithReportedHours(manufacturingOrderId),
      repo.getSubcontractActualCosts(manufacturingOrderId),
    ]);

    // N: the received quantity on a Klar/Stängd order; otherwise preliminary.
    const output: OutputContext = { preliminary: isPreliminaryStatus(order.status), received: Number(order.quantityReceived) };

    const operationRows: OperationRowWrite[] = [];
    for (const op of operations) {
      const completed = Number(op.quantityCompleted ?? 0);
      const scrapped = Number(op.quantityScrapped);
      const hours = Number(op.reportedHours);
      if (op.workCenterType === "subcontract") {
        // Actual cost from the linked lego IO rows (received quantity ×
        // à-pris + ställpris, in SEK) when any receipt exists; otherwise the
        // release snapshot's prices × reported OK quantity — the same
        // standard the pre-calculation used. The reserve takes the one-off
        // F (ställpris + transport) only once it counts by the ställregel
        // (worked, or a final order with N > 0): an unworked operation on a
        // Makulerad or nollstängd order never cost it.
        const actual = actualSubcontractCosts.get(op.operationId);
        const worked = operationWorked({ hours, completed, scrapped, received: actual !== undefined });
        const oneOff = oneOffCounts(output, worked) ? Number(op.setupPrice ?? 0) : 0;
        let row: OperationRowWrite;
        if (actual !== undefined) {
          row = buildSubcontractOperationRow(op, actual.amount);
        } else {
          if (completed === 0) {
            warnings.push(`Operation ${op.sequenceNo} (${op.workCenterName}): ingen inlevererad legoorder`);
          }
          row = buildSubcontractOperationRow(op, oneOff + Number(op.unitPrice ?? 0) * completed);
        }
        // Base: F₀ + P₀ × N, the one-off by the same rule — the reserve's F
        // is therefore never a deviation. Qa = what A was taken for.
        operationRows.push({
          ...row,
          baseQuantity: operationOutput(output, completed),
          subcontractQuantity: actual?.quantity ?? completed,
          baseUnitPrice: Number(op.unitPrice ?? 0),
          baseOneOff: oneOff,
        });
        continue;
      }
      if (hours === 0) warnings.push(`Operation ${op.sequenceNo} (${op.workCenterName}): ingen rapporterad tid`);
      // Base: setup (minutes, once it counts) + run time per unit × N, at the
      // efterkalkyl's own rate (R₀ = R until the rate has a history). The
      // reported time has no ställ/produktion split yet: runHours null.
      const worked = operationWorked({ hours, completed, scrapped });
      operationRows.push({
        ...buildOperationRow({ ...op, hours, setupHours: null }),
        baseSetupHours: oneOffCounts(output, worked) ? Number(op.setupTime) / 60 : 0,
        baseRunHours: (Number(op.runTimePerUnit) / 60) * operationOutput(output, completed),
        runHours: null,
        baseHourlyRate: Number(op.hourlyRate),
      });
    }

    // The base's material: the förkalkyl's source (never "actual") as of T₀
    // — an empty withdrawal map puts every row at T₀ — the rate of T₀'s
    // Stockholm day, and the staffel matched on the row's PLANNED quantity.
    // Rates are looked up before any arithmetic, as everywhere.
    const basePricedAt = order.createdAt;
    const baseWarnings: string[] = [];
    const baseSource = preCalculationSource(preSource, baseWarnings);
    const basePriced = await createRateAttacher(rates, baseSource, stockholmDateOf(basePricedAt))(
      pricedAtWithdrawal(rawConsumptions, new Map(), histories, basePricedAt)
    );
    const orderQuantity = Number(order.quantity);
    const operationQuantities = new Map(
      operations.map((op) => [
        op.operationId,
        { sequenceNo: op.sequenceNo, completed: Number(op.quantityCompleted ?? 0), scrapped: Number(op.quantityScrapped) },
      ])
    );
    const allOperations = [...operationQuantities.values()];
    basePriced.forEach((c, i) => {
      const planned = Number(c.quantityPlanned);
      const { row: baseRow, warning } = buildMaterialRow(
        { componentArticleId: c.componentArticleId, quantity: planned, unitId: c.unitId, unitFactor: c.unitFactor },
        c,
        baseSource,
        supplierPriceTier
      );
      if (warning) baseWarnings.push(`${c.name}: ${warning}`);
      const linked = c.moOperationId ? (operationQuantities.get(c.moOperationId) ?? null) : null;
      materialRows[i] = {
        ...materialRows[i]!,
        baseQuantity: plannedShare(planned, orderQuantity, materialOutput(output, linked)),
        baseUnitCost: baseRow.unitCost,
        basePriceSource: baseRow.priceSource,
        scrapQuantity: plannedShare(planned, orderQuantity, materialScrap(output, linked, allOperations)),
      };
    });
    warnings.push(...baseWarnings.map((w) => `Kalkylerat: ${w}`));

    const costs = applyMarkups(directCosts(materialRows, operationRows), markups);
    const header = toHeader(
      // A post-calculation is never multi-level: a consumed sub-assembly is a
      // real stocked article that was received at a price, and the actual-cost
      // material source is this calculation's answer to that same question.
      { articleId: order.articleId, manufacturingOrderId, quantity: Number(order.quantity), type: "post", multiLevel: false },
      costs,
      source,
      markups,
      { outputQuantity: output.received, preliminary: output.preliminary, basePricedAt, baseMaterialSource: baseSource }
    );
    const labels: VarianceLabels = {
      material: rawConsumptions.map((c) => ({ articleNumber: c.articleNumber, articleName: c.name })),
      operations: operations.map((op) => ({ workCenterCode: op.workCenterCode, workCenterName: op.workCenterName })),
    };
    return { header, materialRows, operationRows, warnings, labels };
  }

  // `save` decides whether the computed calculation is written. Default is a
  // preview: same numbers, nothing stored, id/calculatedAt null. Saving
  // recomputes from scratch — the client never sends figures back.
  async function preCalculate(
    articleId: string,
    quantity: number,
    save: true,
    multiLevel?: boolean
  ): Promise<{ calculation: SavedCostCalculation; warnings: string[] }>;
  async function preCalculate(
    articleId: string,
    quantity: number,
    save?: false,
    multiLevel?: boolean
  ): Promise<{ calculation: CostCalculationDraft; warnings: string[] }>;
  // multiLevel is the FOURTH parameter, deliberately after `save`: callers
  // already pass `true` in third position to mean "save", and moving that
  // meaning would silently turn every one of them into a multi-level preview.
  async function preCalculate(articleId: string, quantity: number, save = false, multiLevel = false) {
    const { header, materialRows, operationRows, warnings } = await computePreCalculation(articleId, quantity, multiLevel);
    const calculation = save ? await repo.createCostCalculation(header, materialRows, operationRows) : toDraft(header);
    return { calculation, warnings: distinct(warnings) };
  }

  // `analysis` (avvikelseanalysen) comes along either way: a preview derives
  // it from the computed rows, a save from the rows as stored — the same
  // answer GET /cost-calculations/:id gives.
  async function postCalculate(
    manufacturingOrderId: string,
    save: true
  ): Promise<{ calculation: SavedCostCalculation; warnings: string[]; analysis: CostVarianceAnalysis | null }>;
  async function postCalculate(
    manufacturingOrderId: string,
    save?: false
  ): Promise<{ calculation: CostCalculationDraft; warnings: string[]; analysis: CostVarianceAnalysis | null }>;
  async function postCalculate(manufacturingOrderId: string, save = false) {
    const { header, materialRows, operationRows, warnings, labels } = await computePostCalculation(manufacturingOrderId);
    if (save) {
      const calculation = await repo.createCostCalculation(header, materialRows, operationRows);
      return { calculation, warnings: distinct(warnings), analysis: (await getCostCalculation(calculation.id))!.analysis };
    }
    return {
      calculation: toDraft(header),
      warnings: distinct(warnings),
      analysis: draftVarianceAnalysis(header, materialRows, operationRows, labels),
    };
  }

  // Header plus its specification rows, the shape the detail view needs, and
  // the avvikelseanalys derived from the stored rows (null on a förkalkyl and
  // on an efterkalkyl saved before it). Calculations saved before the row
  // tables existed simply have no rows.
  async function getCostCalculation(id: string) {
    const calculation = await repo.findCostCalculationById(id);
    if (!calculation) return null;
    const [materialRows, operationRows] = await Promise.all([repo.listMaterialRows(id), repo.listOperationRows(id)]);
    return { ...calculation, materialRows, operationRows, analysis: savedVarianceAnalysis(calculation, materialRows, operationRows) };
  }

  // Förkalkyl for a derived structure (configurator): the SAME multi-level
  // calculation as the Kalkyl tab, with the template's own explodeBom/routing
  // swapped for the derived ones through a SubAssemblyPort. Every other article
  // (halvfabrikat) delegates to the repository, so sub-levels are costed with
  // the same markups, material source and supplier tier. Nothing is saved.
  async function previewStructure(articleId: string, quantity: number, structure: PreviewStructure): Promise<DerivedCosting> {
    const warnings: string[] = [];
    const { source: configured, supplierPriceTier, markups } = await loadCostingConfig(settings);
    const source = preCalculationSource(configured, warnings);

    const labels = new Map(
      (await repo.getArticleLabels([...new Set(structure.components.map((c) => c.componentArticleId))])).map((a) => [a.id, a])
    );
    const workCenterById = new Map(
      (await repo.getWorkCentersForCosting([...new Set(structure.operations.map((o) => o.workCenterId))])).map((w) => [w.id, w])
    );

    const port: SubAssemblyPort = {
      ...ratedPort(repo, createRateAttacher(rates, source, today())),
      explodeBom: async (id, q) => {
        if (id !== articleId) return repo.explodeBom(id, q);
        // Phantoms dissolved, merged per (article, operation) — the configurator module's pure helper.
        return explodeDerivedMaterials(
          structure.components.map((c) => {
            const label = labels.get(c.componentArticleId);
            return {
              componentArticleId: c.componentArticleId, componentName: label?.name ?? c.componentArticleId, totalQuantity: c.quantity * q,
              unitId: c.unitId, unitFactor: c.unitFactor, operationId: c.operationId ?? null, isPhantom: label?.isPhantom ?? false,
            };
          }),
          (phantomId, phantomQuantity) => repo.explodeBom(phantomId, phantomQuantity)
        );
      },
      getRoutingWithWorkCenters: async (id): Promise<RoutingRow[]> => {
        if (id !== articleId) return repo.getRoutingWithWorkCenters(id);
        return [...structure.operations]
          .sort((a, b) => a.sequenceNo - b.sequenceNo)
          .flatMap((o) => {
            const w = workCenterById.get(o.workCenterId);
            if (!w) return []; // the route was validated against existing resources
            return [{
              sequenceNo: o.sequenceNo, setupTime: String(o.setupTime), runTimePerUnit: String(o.runTimePerUnit), workCenterId: w.id,
              workCenterName: w.name, workCenterType: w.type, hourlyRate: w.hourlyRate, overheadPercent: w.overheadPercent,
              setupPrice: o.setupPrice == null ? null : String(o.setupPrice), unitPrice: o.unitPrice == null ? null : String(o.unitPrice),
            }];
          });
      },
    };

    const level = await costMultiLevel(port, articleId, quantity, source, markups, supplierPriceTier);
    warnings.push(...level.warnings);
    const costs = applyMarkups(directCosts(level.materialRows, level.operationRows), markups);

    // Enrichment: number and name for every material row (the exploded components, sub-assemblies included).
    const rowIds = level.materialRows.map((r) => r.componentArticleId).filter((id) => !labels.has(id));
    for (const l of await repo.getArticleLabels([...new Set(rowIds)])) labels.set(l.id, l);

    const manufacturing = costs.manufacturingCost;
    return {
      quantity,
      materialRows: level.materialRows.map((r) => ({
        articleNumber: labels.get(r.componentArticleId)?.articleNumber ?? "?",
        name: labels.get(r.componentArticleId)?.name ?? "?",
        quantity: r.quantity,
        unitCost: r.unitCost,
        total: r.amount,
      })),
      // Per operation: lön + lego, WITHOUT TO — TO is outside TVK (markup.ts)
      // and is reported once, as `overhead`, so Material + Operationer +
      // Påslag = Tillverkningskostnad holds in the panel.
      operationRows: level.operationRows.map((r) => ({
        sequenceNo: r.sequenceNo,
        workCenterName: workCenterById.get(r.workCenterId)?.name ?? "?",
        hours: r.hours,
        total: r.laborAmount + (r.subcontractAmount ?? 0),
      })),
      materialCost: level.materialRows.reduce((t, r) => t + r.amount, 0),
      operationCost: level.operationRows.reduce((t, r) => t + r.laborAmount + (r.subcontractAmount ?? 0), 0),
      markups: costs.materialOverhead + costs.subcontractOverhead,
      overhead: costs.overhead,
      materialMarkup: costs.materialMarkup,
      manufacturingCost: manufacturing,
      manufacturingCostPerUnit: perUnit(manufacturing, quantity) ?? 0,
      selfCost: costs.selfCost,
      selfCostPerUnit: perUnit(costs.selfCost, quantity) ?? 0,
      warnings: distinct(warnings),
    };
  }

  return {
    preCalculate,
    postCalculate,
    previewStructure,

    getCostCalculation,

    // The specification rows go with it (cascade). No role gate: calculations
    // are decision support, not bookkeeping — same as revisions and structure
    // rows elsewhere in the house.
    async deleteCostCalculation(id: string) {
      const calculation = await repo.findCostCalculationById(id);
      if (!calculation) throw new CostCalculationNotFoundError(id);
      if (calculation.type === "post") throw new PostCalculationLockedError(id);
      await repo.deleteCostCalculation(id);
    },

    // Prisåterföring: write a saved calculation's figures back onto the
    // article. The server re-derives from the stored calculation — the browser
    // never sends a figure, the same rule the save path already follows.
    //
    // Both round to the column's four decimals BEFORE writing, and that is not
    // cosmetic: updateStandardCost decides whether to write a history row by
    // comparing Number(previousCost) against the new value, and previousCost
    // comes back from Postgres as a 4-decimal string. An unrounded float would
    // always compare as changed, so every click would append another
    // to-all-appearances-identical history row.
    async applyStandardCostFromCalculation(id: string) {
      const calculation = await repo.findCostCalculationById(id);
      if (!calculation) throw new CostCalculationNotFoundError(id);
      // TVK per unit: what it costs to MAKE the article — material, labor and
      // lego, without TO, without business overhead and without profit. That
      // is what the field is already used for elsewhere: stock valuation and
      // the value of a manufacturing receipt. Affo and TO are period costs
      // and do not belong in a stock value.
      const perUnitCost = perUnit(manufacturingCost(calculation), calculation.quantity);
      if (perUnitCost === null) throw new InvalidCalculationQuantityError(id);
      return articles.updateStandardCost(calculation.articleId, round(perUnitCost, 4));
    },

    async applySalesPriceFromCalculation(id: string) {
      const calculation = await repo.findCostCalculationById(id);
      if (!calculation) throw new CostCalculationNotFoundError(id);
      const perUnitPrice = perUnit(Number(calculation.salesPrice), calculation.quantity);
      if (perUnitPrice === null) throw new InvalidCalculationQuantityError(id);
      return articles.updateSalesPrice(calculation.articleId, round(perUnitPrice, 4));
    },

    // Self cost per unit from each article's latest saved pre-calculation —
    // the basis for täckningsbidrag wherever a price is set or reviewed.
    // Articles without a usable calculation are simply absent from the map:
    // "no calculation" is not a cost of 0, and every consumer must be able to
    // tell the two apart (see margin.ts).
    async latestPreCalculationSelfCost(articleIds: string[]) {
      const rows = await repo.findLatestPreCalculationsByArticles(articleIds);
      const map = new Map<
        string,
        { selfCostPerUnit: number; calculationId: string; calculatedAt: string; quantity: number }
      >();
      for (const row of rows) {
        const perUnitCost = perUnit(selfCost(row), row.quantity);
        if (perUnitCost === null) continue;
        map.set(row.articleId, {
          selfCostPerUnit: perUnitCost,
          calculationId: row.id,
          calculatedAt: new Date(row.calculatedAt).toISOString(),
          quantity: Number(row.quantity),
        });
      }
      return map;
    },

    async listCostCalculations(articleId: string) {
      return repo.listCostCalculationsByArticle(articleId);
    },

    async listCostCalculationsForOrder(manufacturingOrderId: string) {
      return repo.listCostCalculationsByManufacturingOrder(manufacturingOrderId);
    },
  };
}

export type CostingService = ReturnType<typeof createCostingService>;
