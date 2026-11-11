import {
  SEK,
  type CalculatedPriceDetail,
  type CalculatedPriceUnavailable,
  type CostCalculationMarkupLevel,
  type CostCalculationType,
  type CostingMaterialSource,
  type CostingSupplierPriceTier,
  type CostVarianceAnalysis,
  type DerivedCosting,
  type TrialMarkups,
  roundToDecimals,
} from "@navet/shared";
import type { Db, Tx } from "@navet/db";
import type {
  CostCalculationWrite,
  CostingRepository,
  MaterialRowWrite,
  OperationRowWrite,
} from "../repository/costing.repository.js";
import { applyMarkups, type CostingMarkups, type MarkedUpCosts } from "./markup.js";
import {
  calculatedUnitPrice,
  calculationMarkups,
  hasOwnMarkups,
  orderRowMarkups,
  percentOrNull,
  type LevelMarkups,
} from "./markup-levels.js";
import { readCalculatedPriceBasis } from "../repository/calculated-price.js";
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
import { manufacturingCost, perUnit, perUnitDivisor, selfCost, type PerUnitDivisorSource } from "./cost-figures.js";
import { ExchangeRateUnavailableError, type ExchangeRateReader } from "../../system/service/exchange-rates.js";
import { stockholmDateOf, stockholmToday } from "../../system/service/delivery-days.js";
import {
  hourlyRateAt,
  laborAtWorkDays,
  reportedTimeByResource,
  pricedAtWithdrawal,
  reportedTime,
  type PriceHistories,
  type WithdrawalPriceBasis,
} from "./price-at.js";
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

// Prisåterföring from an efterkalkyl that cannot carry a per-unit figure: the
// order is still open (a preliminary analysis — costs and received quantity
// are both moving) or nothing was received (N = 0). 400, and the article is
// left alone. The message is Swedish because the web shows it as it is.
export class CostCalculationNotFinalError extends Error {
  constructor(
    public readonly id: string,
    public readonly reason: "preliminary" | "no-output"
  ) {
    super(
      reason === "preliminary"
        ? "Efterkalkylen är preliminär — tillverkningsordern är inte klar, så kalkylen ger inget pris per styck. Gör en ny efterkalkyl när ordern är klar."
        : "Inget är inlevererat på tillverkningsordern, så efterkalkylen ger inget pris per styck."
    );
    this.name = "CostCalculationNotFinalError";
  }
}

// Sätt försäljningspris from a calculation saved with Pröva påslag, by a user
// who may not set the article's sales price directly (no Artiklar). The route
// answers 403 forbidden — the same refusal as the price field on the card.
export class TrialSalesPriceNotAllowedError extends Error {
  constructor(id: string) {
    super(`Cost calculation ${id} uses tried markups; setting the sales price from it requires the Artiklar permission`);
    this.name = "TrialSalesPriceNotAllowedError";
  }
}

// The divisor of the two write-backs, or the refusal — one place, so Sätt
// standardpris and Sätt försäljningspris can never divide by different things.
function writeBackDivisor(calculation: PerUnitDivisorSource & { id: string }): number {
  const resolved = perUnitDivisor(calculation);
  if (resolved.divisor !== null) return resolved.divisor;
  if (resolved.reason === "invalid-quantity") throw new InvalidCalculationQuantityError(calculation.id);
  throw new CostCalculationNotFinalError(calculation.id, resolved.reason);
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
  // Påslag per nivå (#16): where each price markup came from, and the base
  // the materialpåslag was taken on (always set on a new calculation; null
  // only on a multi-level calculation saved before 0194).
  generalMarkupLevel: CostCalculationMarkupLevel;
  materialMarkupLevel: CostCalculationMarkupLevel;
  materialMarkupBase: string | null;
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

// The level each price markup of a calculation was resolved on (#16).
interface MarkupLevelsOfHeader {
  generalMarkupLevel: CostCalculationMarkupLevel;
  materialMarkupLevel: CostCalculationMarkupLevel;
}

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
// an old calculation stays explainable after the settings change — with the
// level each price markup came from (#16). Every field is rounded to its
// column's scale here — the one and only rounding — so the draft and the
// saved row can never diverge on it (see the note above).
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
  levels: MarkupLevelsOfHeader,
  // The avvikelseanalys's header inputs — efterkalkyl only.
  variance: { outputQuantity: number; preliminary: boolean; basePricedAt: Date; baseMaterialSource: CostingMaterialSource } | null = null
): CostCalculationWrite {
  return {
    articleId: identity.articleId,
    manufacturingOrderId: identity.manufacturingOrderId,
    quantity: roundToDecimals(identity.quantity, 4),
    type: identity.type,
    materialCost: roundToDecimals(costs.materialCost, 4),
    materialOverhead: roundToDecimals(costs.materialOverhead, 4),
    laborCost: roundToDecimals(costs.laborCost, 4),
    overhead: roundToDecimals(costs.overhead, 4),
    subcontractCost: roundToDecimals(costs.subcontractCost, 4),
    subcontractOverhead: roundToDecimals(costs.subcontractOverhead, 4),
    semiFinishedCost: roundToDecimals(costs.semiFinishedCost, 4),
    businessOverhead: roundToDecimals(costs.businessOverhead, 4),
    generalMarkup: roundToDecimals(costs.generalMarkup, 4),
    materialMarkup: roundToDecimals(costs.materialMarkup, 4),
    salesPrice: roundToDecimals(costs.salesPrice, 4),
    materialSource: source,
    multiLevel: identity.multiLevel,
    moPercent: roundToDecimals(markups.moPercent, 2),
    loPercent: roundToDecimals(markups.loPercent, 2),
    affoPercent: roundToDecimals(markups.affoPercent, 2),
    generalMarkupPercent: roundToDecimals(markups.generalMarkupPercent, 2),
    materialMarkupPercent: roundToDecimals(markups.materialMarkupPercent, 2),
    generalMarkupLevel: levels.generalMarkupLevel,
    materialMarkupLevel: levels.materialMarkupLevel,
    materialMarkupBase: roundToDecimals(costs.materialMarkupBase, 4),
    outputQuantity: variance ? roundToDecimals(variance.outputQuantity, 4) : null,
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
    generalMarkupLevel: header.generalMarkupLevel,
    materialMarkupLevel: header.materialMarkupLevel,
    materialMarkupBase: money(header.materialMarkupBase),
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

  // Påslag per nivå (#16): System → Kalkyler's markups with the two PRICE
  // markups resolved for the costed (sold) article — Pröva påslag →
  // varugrupp → företaget, field by field (markup-levels.ts, the one rule).
  // MO, LO and Affo stay the company's, so TVK and SVK never move. The whole
  // run — multi-level sub-levels included — uses the result. The two price
  // percentages come back rounded to the header's two decimals
  // (effectiveMarkups → roundPercent), so the amounts are priced at exactly
  // the percentage the header stores — company, group and trial alike.
  async function articleMarkups(articleId: string, company: CostingMarkups, trial: TrialMarkups | null = null) {
    const group = await repo.getArticleGroupMarkups(articleId);
    const resolved = calculationMarkups(
      company,
      group && {
        generalMarkupPercent: percentOrNull(group.generalMarkupPercent),
        materialMarkupPercent: percentOrNull(group.materialMarkupPercent),
      },
      trial
    );
    const markups: CostingMarkups = {
      ...company,
      generalMarkupPercent: resolved.generalMarkup.percent,
      materialMarkupPercent: resolved.materialMarkup.percent,
    };
    const levels: MarkupLevelsOfHeader = {
      generalMarkupLevel: resolved.generalMarkup.level,
      materialMarkupLevel: resolved.materialMarkup.level,
    };
    return { markups, levels };
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
  //
  // `trial` (Pröva påslag, #16): price markups that override the article's
  // varugrupp → företaget for this run only; nothing in the settings or on
  // the group changes, and the header records level "trial" per tried field.
  async function computePreCalculation(articleId: string, quantity: number, multiLevel: boolean, trial: TrialMarkups | null) {
    const article = await repo.findArticleById(articleId);
    if (!article) throw new ArticleNotFoundError(articleId);

    const warnings: string[] = [];
    const { source: configured, supplierPriceTier, markups: company } = await loadCostingConfig(settings);
    const { markups, levels } = await articleMarkups(articleId, company, trial);
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
      markups,
      levels
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
  // reported hours per operation x the work center's hourly rate of each work
  // day (timkostnad per datum, #14 etapp 4), then the same markups as the
  // pre-calculation. Read and arithmetic only, as above.
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
    const { source: preSource, postSource: source, supplierPriceTier, markups: company } = await loadCostingConfig(settings);
    // The order's article's varugrupp → företaget (#16): only the sales price
    // moves — TVK and the variance analysis (MO/LO) are the company's.
    const { markups, levels } = await articleMarkups(order.articleId, company);

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

    // The reported time is ONE read (getReportedTime): H, Hs, Hr and the work
    // days all come from its rows (reportedTime), never from two queries a
    // time report's commit could fall between.
    const [operations, actualSubcontractCosts, reported] = await Promise.all([
      repo.getPostCalculationOperations(manufacturingOrderId),
      repo.getSubcontractActualCosts(manufacturingOrderId),
      repo.getReportedTime(manufacturingOrderId),
    ]);
    const timeByOperation = reported.byOperation;
    // Timkostnad per datum (#14 etapp 4): one load of the resources' rate
    // histories prices each work day's hours at that day's rate and the
    // base at T₀'s — the operations' resources and every resource time was
    // reported on (#15).
    const rateHistories = await repo.getWorkCenterRateHistories([
      ...new Set([
        ...operations.filter((op) => op.workCenterType !== "subcontract").map((op) => op.workCenterId),
        ...reported.resources.keys(),
      ]),
    ]);
    const basePricedAt = order.createdAt;

    // N: the received quantity on a Klar/Stängd order; otherwise preliminary.
    const output: OutputContext = { preliminary: isPreliminaryStatus(order.status), received: Number(order.quantityReceived) };

    const operationRows: OperationRowWrite[] = [];
    // Index-aligned with operationRows: an operation worked on several
    // resources has a row per resource (#15).
    const operationLabels: VarianceLabels["operations"] = [];
    for (const op of operations) {
      const completed = Number(op.quantityCompleted ?? 0);
      const scrapped = Number(op.quantityScrapped);
      const timeRows = timeByOperation.get(op.operationId) ?? [];
      const hours = reportedTime(timeRows).hours;
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
        operationLabels.push({ workCenterCode: op.workCenterCode, workCenterName: op.workCenterName });
        continue;
      }
      if (hours === 0) warnings.push(`Operation ${op.sequenceNo} (${op.workCenterName}): ingen rapporterad tid`);
      // A row per resource the time was worked on (#15, time_reports.
      // work_center_id; a report without one counts on the operation's
      // current resource): Lön per arbetsdag — each work day's hours at THAT
      // resource's hourly rate that day (the row shows their average; no
      // history ⇒ its current rate) — and TO at that resource's percentage,
      // so a Byt resurs never reprices time already reported. The base
      // stays the operation's: setup (minutes, once it counts) + run time per
      // unit × N, on the current resource's row, at the current resource's
      // rate as of T₀ (R₀) — the switch is a new plan. Every row of the
      // operation is valued at that R₀, so Timpris = Lön − R₀ × H also
      // carries the rate difference of time worked on another resource, and
      // the rows' parts sum to the operation's exactly. The actual side: of
      // the row's H, Hs reported as ställ (setup_hours) and Hr as produktion
      // (run_hours) — null while no report on the row has a type, so its
      // whole H is then Ej uppdelad (cost-variance.ts).
      const currentHistory = rateHistories.get(op.workCenterId) ?? [];
      const baseHourlyRate = Number(hourlyRateAt(currentHistory, basePricedAt) ?? op.hourlyRate);
      const worked = operationWorked({ hours, completed, scrapped });
      const resourceOf = (workCenterId: string) =>
        workCenterId === op.workCenterId ? op : reported.resources.get(workCenterId)!;
      // Byte order on the code — the order the saved rows are read in
      // (listOperationRows, COLLATE "C"), so a preview lists them as the
      // saved calculation does.
      const parts = reportedTimeByResource(timeRows, op.workCenterId).sort((a, b) => {
        const [x, y] = [resourceOf(a.workCenterId).workCenterCode, resourceOf(b.workCenterId).workCenterCode];
        return x < y ? -1 : x > y ? 1 : 0;
      });
      for (const part of parts) {
        const current = part.workCenterId === op.workCenterId;
        const resource = resourceOf(part.workCenterId);
        const labor = laborAtWorkDays(part.days, rateHistories.get(part.workCenterId) ?? [], Number(resource.hourlyRate));
        operationRows.push({
          ...buildOperationRow({
            sequenceNo: op.sequenceNo,
            workCenterId: part.workCenterId,
            overheadPercent: resource.overheadPercent,
            hours: part.hours,
            setupHours: part.setupHours,
            hourlyRate: String(labor.hourlyRate),
            laborAmount: labor.laborAmount,
          }),
          baseSetupHours: current && oneOffCounts(output, worked) ? Number(op.setupTime) / 60 : 0,
          baseRunHours: current ? (Number(op.runTimePerUnit) / 60) * operationOutput(output, completed) : 0,
          runHours: part.runHours,
          baseHourlyRate,
        });
        operationLabels.push({ workCenterCode: resource.workCenterCode, workCenterName: resource.workCenterName });
      }
    }

    // The base's material: the förkalkyl's source (never "actual") as of T₀
    // — an empty withdrawal map puts every row at T₀ — the rate of T₀'s
    // Stockholm day, and the staffel matched on the row's PLANNED quantity.
    // Rates are looked up before any arithmetic, as everywhere.
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
      levels,
      { outputQuantity: output.received, preliminary: output.preliminary, basePricedAt, baseMaterialSource: baseSource }
    );
    const labels: VarianceLabels = {
      material: rawConsumptions.map((c) => ({ articleNumber: c.articleNumber, articleName: c.name })),
      operations: operationLabels,
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
    multiLevel?: boolean,
    trial?: TrialMarkups | null
  ): Promise<{ calculation: SavedCostCalculation; warnings: string[] }>;
  async function preCalculate(
    articleId: string,
    quantity: number,
    save?: false,
    multiLevel?: boolean,
    trial?: TrialMarkups | null
  ): Promise<{ calculation: CostCalculationDraft; warnings: string[] }>;
  // multiLevel is the FOURTH parameter, deliberately after `save`: callers
  // already pass `true` in third position to mean "save", and moving that
  // meaning would silently turn every one of them into a multi-level preview.
  // `trial` (Pröva påslag, #16) is the fifth, for the same reason.
  async function preCalculate(articleId: string, quantity: number, save = false, multiLevel = false, trial: TrialMarkups | null = null) {
    const { header, materialRows, operationRows, warnings } = await computePreCalculation(articleId, quantity, multiLevel, trial);
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
  // opts.rates: the rate reader for this run instead of the service's own —
  // the configurator's variant creation costs inside its template
  // transaction and hands a reader that never calls Riksbanken (configurator.md).
  async function previewStructure(
    articleId: string, quantity: number, structure: PreviewStructure, opts: { rates?: Pick<ExchangeRateReader, "getRate"> } = {}
  ): Promise<DerivedCosting> {
    const warnings: string[] = [];
    const { source: configured, supplierPriceTier, markups: company } = await loadCostingConfig(settings);
    const source = preCalculationSource(configured, warnings);
    // The template's varugrupp → företaget (#16). Moves only the test
    // panel's Materialpåslag: the price is the template's own model (grundpris
    // + tillägg), and TVK/SVK — the beställningsvara's cost and the variant's
    // standard price — never read the price markups.
    const { markups } = await articleMarkups(articleId, company);

    const labels = new Map(
      (await repo.getArticleLabels([...new Set(structure.components.map((c) => c.componentArticleId))])).map((a) => [a.id, a])
    );
    const workCenterById = new Map(
      (await repo.getWorkCentersForCosting([...new Set(structure.operations.map((o) => o.workCenterId))])).map((w) => [w.id, w])
    );

    const port: SubAssemblyPort = {
      ...ratedPort(repo, createRateAttacher(opts.rates ?? rates, source, today())),
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
      //
      // Divided by what the totals bought (perUnitDivisor): the quantity on a
      // förkalkyl, N = the received quantity on a final efterkalkyl. A
      // preliminary efterkalkyl, or one with nothing received, writes nothing.
      const perUnitCost = manufacturingCost(calculation) / writeBackDivisor(calculation);
      return articles.updateStandardCost(calculation.articleId, roundToDecimals(perUnitCost, 4));
    },

    // Pröva påslag (#16, the review of etapp 1): a calculation saved with a
    // tried markup can carry any price markup its author typed, and the route
    // only asks for Artiklar OR Tillverkning — while setting the article's
    // försäljningspris directly needs Artiklar. So writing a TRIED price back
    // takes Artiklar too (`mayApplyTrial`, decided by the route); a calculation
    // on the group's and the company's markups stays open to Tillverkning.
    async applySalesPriceFromCalculation(id: string, opts: { mayApplyTrial?: boolean } = {}) {
      const calculation = await repo.findCostCalculationById(id);
      if (!calculation) throw new CostCalculationNotFoundError(id);
      const tried = calculation.generalMarkupLevel === "trial" || calculation.materialMarkupLevel === "trial";
      if (tried && opts.mayApplyTrial === false) throw new TrialSalesPriceNotAllowedError(id);
      const perUnitPrice = Number(calculation.salesPrice) / writeBackDivisor(calculation);
      return articles.updateSalesPrice(calculation.articleId, roundToDecimals(perUnitPrice, 4));
    },

    // Kalkylpris (#16 etapp 2) — the price chain's step after the price list
    // (sales/service/price-resolver.ts, bound in app.ts). null = the step
    // does not apply: neither the customer nor the order has a price markup
    // of its own, so the article's försäljningspris stays the company's
    // price and nothing is read. Otherwise the article's latest saved
    // förkalkyl (the one TB reads — calculated-price.ts) re-priced with the
    // row's markups, order → customer → varugrupp → company (orderRowMarkups,
    // field by field), as a delta against the calculation's own percentages
    // and base (calculatedUnitPrice). SEK, four decimals; the chain converts
    // to the order's currency. `dbc` is the caller's handle — a transaction
    // in etapp 3's repricing; the company's percentages come from the
    // settings reader, never from the transaction.
    async calculatedPrice(
      dbc: Db | Tx,
      q: { articleId: string; customer: LevelMarkups | null; order?: LevelMarkups | null }
    ): Promise<{ unitPrice: number; calculated: CalculatedPriceDetail } | { unavailable: CalculatedPriceUnavailable } | null> {
      if (!hasOwnMarkups(q.customer, q.order)) return null;
      const { markups: company } = await loadCostingConfig(settings);
      const { calculation, group } = await readCalculatedPriceBasis(dbc, q.articleId);
      const resolved = orderRowMarkups({
        order: q.order ?? null,
        customer: q.customer,
        group: group && {
          generalMarkupPercent: percentOrNull(group.generalMarkupPercent),
          materialMarkupPercent: percentOrNull(group.materialMarkupPercent),
        },
        company: { generalMarkupPercent: company.generalMarkupPercent, materialMarkupPercent: company.materialMarkupPercent },
      });
      if (!calculation) return { unavailable: "no-calculation" };
      const priced = calculatedUnitPrice(
        {
          salesPrice: Number(calculation.salesPrice),
          selfCost: selfCost(calculation),
          materialMarkupBase: calculation.materialMarkupBase === null ? null : Number(calculation.materialMarkupBase),
          generalMarkupPercent: Number(calculation.generalMarkupPercent),
          materialMarkupPercent: Number(calculation.materialMarkupPercent),
          quantity: Number(calculation.quantity),
          // Whether it was priced under today's chain (before 0130 TO sat
          // inside TVK/SVK — "calculation-outdated" when g moves).
          generalMarkup: Number(calculation.generalMarkup),
          businessOverhead: Number(calculation.businessOverhead),
          affoPercent: Number(calculation.affoPercent),
        },
        resolved.generalMarkup.percent,
        resolved.materialMarkup.percent
      );
      if ("unavailable" in priced) return priced;
      return {
        unitPrice: priced.unitPrice,
        calculated: {
          calculationId: calculation.id,
          calculatedAt: new Date(calculation.calculatedAt).toISOString(),
          quantity: Number(calculation.quantity),
          generalMarkup: resolved.generalMarkup,
          materialMarkup: resolved.materialMarkup,
        },
      };
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
