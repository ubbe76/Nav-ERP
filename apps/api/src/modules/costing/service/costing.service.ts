import type { CostCalculationType, CostingMaterialSource, CostingSupplierPriceTier, DerivedCosting } from "@navet/shared";
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
    costingMaterialSource: CostingMaterialSource;
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
  markups: CostingMarkups
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
  };
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
  }
) {
  async function loadCostingConfig(): Promise<{
    source: CostingMaterialSource;
    supplierPriceTier: CostingSupplierPriceTier;
    markups: CostingMarkups;
  }> {
    const s = await settings.getSettings();
    return {
      source: s.costingMaterialSource,
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
    const { source: configured, supplierPriceTier, markups } = await loadCostingConfig();
    const source = preCalculationSource(configured, warnings);

    let materialRows: MaterialRowWrite[];
    let operationRows: OperationRowWrite[];

    if (multiLevel) {
      const level = await costMultiLevel(repo, articleId, quantity, source, markups, supplierPriceTier);
      materialRows = level.materialRows;
      operationRows = level.operationRows;
      warnings.push(...level.warnings);
    } else {
      const components = await repo.explodeBom(articleId, quantity);
      const basisById = new Map(
        (await repo.getComponentCostBasis(components.map((c) => c.componentArticleId))).map((b) => [b.id, b])
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

  // Requires an existing MO — actual material consumption x unit cost, actual
  // reported hours per operation x work center hourly rate, then the same
  // markups as the pre-calculation. Read and arithmetic only, as above.
  async function computePostCalculation(manufacturingOrderId: string) {
    const order = await repo.findManufacturingOrderById(manufacturingOrderId);
    if (!order) throw new ManufacturingOrderNotFoundError(manufacturingOrderId);

    const warnings: string[] = [];
    const { source, supplierPriceTier, markups } = await loadCostingConfig();

    const consumptions = await repo.getMaterialConsumptionsWithCost(manufacturingOrderId);
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
    const operationRows: OperationRowWrite[] = [];
    for (const op of operations) {
      if (op.workCenterType === "subcontract") {
        // Actual cost from the linked lego IO rows (received quantity ×
        // à-pris + ställpris, in SEK) when any receipt exists; otherwise the
        // release snapshot's prices × reported OK quantity — the same
        // standard the pre-calculation used.
        const actual = actualSubcontractCosts.get(op.operationId);
        if (actual !== undefined) {
          operationRows.push(buildSubcontractOperationRow(op, actual));
        } else {
          if (Number(op.quantityCompleted ?? 0) === 0) {
            warnings.push(`Operation ${op.sequenceNo} (${op.workCenterName}): ingen inlevererad legoorder`);
          }
          const fallback = Number(op.setupPrice ?? 0) + Number(op.unitPrice ?? 0) * Number(op.quantityCompleted ?? 0);
          operationRows.push(buildSubcontractOperationRow(op, fallback));
        }
        continue;
      }
      const hours = Number(op.reportedHours);
      if (hours === 0) warnings.push(`Operation ${op.sequenceNo} (${op.workCenterName}): ingen rapporterad tid`);
      operationRows.push(buildOperationRow({ ...op, hours, setupHours: null }));
    }

    const costs = applyMarkups(directCosts(materialRows, operationRows), markups);
    const header = toHeader(
      // A post-calculation is never multi-level: a consumed sub-assembly is a
      // real stocked article that was received at a price, and the actual-cost
      // material source is this calculation's answer to that same question.
      { articleId: order.articleId, manufacturingOrderId, quantity: Number(order.quantity), type: "post", multiLevel: false },
      costs,
      source,
      markups
    );
    return { header, materialRows, operationRows, warnings };
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

  async function postCalculate(
    manufacturingOrderId: string,
    save: true
  ): Promise<{ calculation: SavedCostCalculation; warnings: string[] }>;
  async function postCalculate(
    manufacturingOrderId: string,
    save?: false
  ): Promise<{ calculation: CostCalculationDraft; warnings: string[] }>;
  async function postCalculate(manufacturingOrderId: string, save = false) {
    const { header, materialRows, operationRows, warnings } = await computePostCalculation(manufacturingOrderId);
    const calculation = save ? await repo.createCostCalculation(header, materialRows, operationRows) : toDraft(header);
    return { calculation, warnings: distinct(warnings) };
  }

  // Förkalkyl for a derived structure (configurator): the SAME multi-level
  // calculation as the Kalkyl tab, with the template's own explodeBom/routing
  // swapped for the derived ones through a SubAssemblyPort. Every other article
  // (halvfabrikat) delegates to the repository, so sub-levels are costed with
  // the same markups, material source and supplier tier. Nothing is saved.
  async function previewStructure(articleId: string, quantity: number, structure: PreviewStructure): Promise<DerivedCosting> {
    const warnings: string[] = [];
    const { source: configured, supplierPriceTier, markups } = await loadCostingConfig();
    const source = preCalculationSource(configured, warnings);

    const labels = new Map(
      (await repo.getArticleLabels([...new Set(structure.components.map((c) => c.componentArticleId))])).map((a) => [a.id, a])
    );
    const workCenterById = new Map(
      (await repo.getWorkCentersForCosting([...new Set(structure.operations.map((o) => o.workCenterId))])).map((w) => [w.id, w])
    );

    const port: SubAssemblyPort = {
      ...repo,
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

    // Header plus its specification rows, the shape the detail view needs.
    // Calculations saved before the row tables existed simply have none.
    async getCostCalculation(id: string) {
      const calculation = await repo.findCostCalculationById(id);
      if (!calculation) return null;
      const [materialRows, operationRows] = await Promise.all([repo.listMaterialRows(id), repo.listOperationRows(id)]);
      return { ...calculation, materialRows, operationRows };
    },

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
