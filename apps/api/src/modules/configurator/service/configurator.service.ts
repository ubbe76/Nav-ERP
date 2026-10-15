import { parseRuleTarget } from "@navet/shared";
import type {
  ConfiguratorBomLineDetail, ConfiguratorDerivation, DerivedCosting, DerivedStructure, ConfiguratorEvaluation, ConfiguratorGroupDetail, ConfiguratorMode, ConfiguratorOperationDetail,
  ConfiguratorRuleDetail, ConfiguratorSelection, ConfiguratorTemplateDetail, ConfiguratorTemplateView, ConfiguratorValueDetail, CreateConfiguratorBomLineInput,
  CreateConfiguratorGroupInput, CreateConfiguratorOperationInput, CreateConfiguratorRuleInput, CreateConfiguratorValueInput, ListQuery, OrderRowConfiguration,
  OrderRowConfigurationCost, PriceSource, PublicTemplate, PublicTemplateSummary,
  UpdateConfiguratorBomLineInput, UpdateConfiguratorGroupInput, UpdateConfiguratorOperationInput, UpdateConfiguratorRuleInput,
  UpdateConfiguratorValueInput, VariantListRow, VariantOf, VariantPreviewRow, VariantRequest, VariantSelectionEntry, VariantStatus,
} from "@navet/shared";
import type { Db, Tx } from "@navet/db";
import type { InsertArticleInput } from "../../article/repository/article.repository.js";
import type { BomRowInsert } from "../../article/repository/bom-write.js";
import { ArticleNotFoundError, type ArticleService } from "../../article/service/article.service.js";
import type { RoutingOperationInsert } from "../../manufacturing/repository/routing-write.js";
import { WorkCenterNotFoundError } from "../../manufacturing/service/manufacturing.service.js";
import { CustomerNotFoundError } from "../../sales/service/sales.service.js";
import type { ResolvedPrice } from "../../sales/service/price-resolver.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import {
  createConfiguratorRepository, type BomLineWrite, type GroupInsert, type GroupPatch, type OperationWrite, type SortTable, type ValuePatch,
} from "../repository/configurator.repository.js";
import { deriveStructure, type BaseBomRow, type BaseOperation, type DeriveBomLine, type DeriveOperation, type DerivedStructureCore } from "./configurator-derive.js";
import { resolveConfiguration, type EngineCustomerPrice, type EngineTemplate } from "./configurator-engine.js";
import { explodeDerivedMaterials } from "./configurator-explode.js";
import { toPublicTemplate, toPublicTemplateSummary } from "./public-template.js";
import { coverageWarnings, findCoverageGaps } from "./structure-coverage.js";
import {
  assertGroupFieldsMatchKind, assertModeAllowed, formulaUsers, templateReferences, validateLineInput, validateOperationInput,
  validateRuleInput, TEMPLATE_IN_COMPONENT, TEMPLATE_IN_VALUE_ARTICLE, type LineFields, type OperationFields, type ReferenceTargets,
} from "./configurator-rules.js";
import {
  ConfiguratorCodeLockedError, ConfiguratorCodeTakenError, ConfiguratorGroupNotFoundError, ConfiguratorInvalidConfigurationError,
  ConfiguratorLineNotFoundError, ConfiguratorNotToOrderModeError, ConfiguratorNotVariantModeError, ConfiguratorOperationNotFoundError, ConfiguratorReferenceInUseError,
  ConfiguratorReorderMismatchError, ConfiguratorRuleNotFoundError, ConfiguratorSequenceTakenError, ConfiguratorTemplateExistsError,
  ConfiguratorTemplateHasVariantsError, ConfiguratorTemplateNotFoundError, ConfiguratorTooManyCombinationsError, ConfiguratorValueNotFoundError,
  ConfiguratorVariantNotDerivableError, ConfiguratorVariantNotFoundError, ConfiguratorVariantNotTemplateError, ConfiguratorVariantNumberRaceError, ConfiguratorVariantNumberTakenError,
  ConfiguratorVariantTooLongError, InvalidConfiguratorGroupError, InvalidConfiguratorLineError, InvalidConfiguratorOperationError,
  InvalidConfiguratorRuleError, InvalidConfiguratorVariantSetError,
} from "./configurator.errors.js";
import {
  linkMaterialsToOperations, manufacturingOperations, type ManufacturingMaterial, type ManufacturingOperation,
} from "./manufacturing-structure.js";
import { expandCombinations, MAX_VARIANT_COMBINATIONS, TooManyCombinationsError, VariantSetError, type VariantSets } from "./variant-expand.js";
import { selectionEntries, selectionFromEntries, variantArticleFields, variantIdentity, type VariantArticleFields } from "./variant-identity.js";
import { mergeVariantMaterials, variantRoutingRows, type VariantBomRow, type VariantRoutingRow } from "./variant-structure.js";

// Produktkonfigurator — the service owns every template mutation. Each write
// runs in ONE transaction that first locks the template row (FOR UPDATE) and
// only then loads what it validates against, so a rule/line/operation save and
// a concurrent delete of a group/alternative it references serialise: whichever
// runs second sees the first one's result (the delete refuses, or the save
// refuses). Nothing stored can point outside the template.

// Konfigurator 4b: what evaluateRowConfiguration answers — the configuration
// is null exactly when the selection is invalid (errors say why).
export type RowConfigurationEvaluation = {
  valid: boolean;
  errors: string[];
  configuration: OrderRowConfiguration | null;
  // Konfigurator 4c: the row's förkalkyl at the evaluated quantity — what the
  // row margin is measured against. null when invalid or not derivable.
  cost: OrderRowConfigurationCost | null;
};

// Konfigurator 4c: one configuration's derived structure as a TO's own rows
// at the TO quantity (deriveForManufacturing). operations/materials are empty
// and cost null when the configuration is not valid or not derivable; cost is
// also null when the caller skipped it (opts.withCost === false).
export type ConfiguredStructure = {
  valid: boolean;
  errors: string[];
  templateArticleId: string;
  key: string | null;
  selection: VariantSelectionEntry[];
  operations: ManufacturingOperation[];
  materials: ManufacturingMaterial[];
  cost: { manufacturingCostPerUnit: number | null; selfCostPerUnit: number | null } | null;
};
// What manufacturing (TO creation) and planning (the configured rows' cascade)
// are handed — bound late in app.ts like VariantPriceReader.
export type ConfiguredStructureReader = (
  templateArticleId: string, selection: ConfiguratorSelection, quantity: number, opts?: { withCost?: boolean }
) => Promise<ConfiguredStructure>;

// The sales price chain (resolvePrice), injected like StockBalanceReader.
export type PriceReader = (q: { customerId: string; articleId: string; quantity: number }) => Promise<
  { articleNumber: string; price: { unitPrice: number; discountPercent: number; source: PriceSource } | null } | null
>;

// The article module's structure walk, injected like PriceReader: a component
// (or an alternative's article) may not be the template nor contain it.
export type ArticleStructureReader = {
  exists(id: string): Promise<boolean>;
  // Is `candidateAncestorId` reachable walking down from `articleId`'s structure? True for the article itself.
  isDescendant(articleId: string, candidateAncestorId: string): Promise<boolean>;
  // The article as GET /articles/:id answers it — what resolveVariant hands the order form.
  find(id: string): Promise<Awaited<ReturnType<ArticleService["getArticle"]>>>;
};
export type ResolvedVariantArticle = NonNullable<Awaited<ReturnType<ArticleStructureReader["find"]>>>;
export type ResolveVariantResult = { article: ResolvedVariantArticle; created: boolean };

// The costing module's pre-calculation of a derived (not stored) structure,
// injected like PriceReader: the Kalkyl tab's multi-level calculation with the
// template's explodeBom/routing swapped for the derived ones.
export type CostingPreview = {
  previewStructure(
    articleId: string,
    quantity: number,
    structure: {
      components: {
        componentArticleId: string; quantity: number; unitId: string | null; unitFactor: string | null; operationId?: string | null;
      }[];
      operations: {
        sequenceNo: number; workCenterId: string; setupTime: number; runTimePerUnit: number; setupPrice: number | null; unitPrice: number | null;
      }[];
    }
  ): Promise<DerivedCosting>;
};

// The owning modules' Tx writers a variant is created with — article
// (insertArticle, insertBomRows) and manufacturing (insertRoutingOperations) —
// injected so this module never writes articles/bom_components/routing_operations itself.
export type VariantWriters = {
  insertArticle: (tx: Tx, input: InsertArticleInput) => Promise<{ id: string } | null>;
  insertBomRows: (tx: Tx, parentArticleId: string, rows: BomRowInsert[]) => Promise<void>;
  insertRoutingOperations: (tx: Tx, articleId: string, rows: RoutingOperationInsert[]) => Promise<Map<number, string>>;
};
// The stock module's balances, for the variant list's Saldo (summed per article here).
export type VariantStockReader = { balancesForArticles(ids: string[]): Promise<{ articleId: string; quantityOnHand: string }[]> };

// What the pure derivation (deriveStructure) is fed for one template.
export type DerivationInput = {
  detail: ConfiguratorTemplateDetail;
  baseBom: BaseBomRow[];
  baseOperations: BaseOperation[];
  lines: DeriveBomLine[];
  operations: DeriveOperation[];
};

const GROUP_CODE_UNIQUE = "configurator_groups_article_code_unique";
const GROUP_ARTICLE_FIELD_UNIQUE = "configurator_groups_article_field_unique";
const ARTICLE_FIELD_NAME: Record<string, string> = { colour: "Färg", surface_treatment: "Ytbehandling" };
const VALUE_CODE_UNIQUE = "configurator_values_group_code_unique";
const OPERATION_SEQUENCE_UNIQUE = "configurator_operations_article_sequence_unique";
const TEMPLATE_PKEY = "configurator_templates_pkey";
const ARTICLE_NUMBER_UNIQUE = "articles_article_number_unique";
const VARIANT_KEY_UNIQUE = "configurator_variants_template_key_unique";
const MISSING_BASE_PRICE = "Grundpris saknas — försäljningspris lämnas tomt";

const num = (v: number | null | undefined): string | null => (v === null || v === undefined ? null : String(v));
const toNumber = (v: string | null): number | null => (v === null ? null : Number(v));
const round4 = (n: number) => Number(n.toFixed(4));

// --- stocked variants: the plan one preview/create works from ---

// One combination as planned: the preview row plus, for status "new", what
// the creation writes (identity snapshot, article fields, merged structure,
// derived route). toPreviewRow drops the write-only parts.
type PlannedCombination = {
  selection: ConfiguratorSelection;
  status: VariantStatus;
  articleId: string | null;
  key: string | null;
  articleNumber: string | null;
  name: string | null;
  salesPrice: number | null;
  standardCost: number | null;
  // The engine's (and identity/number) messages — what a customer may see.
  errors: string[];
  // The derivation's messages (structure lines, operations, formulas) — kept
  // apart so resolveVariant never hands them to an API client; only the
  // article card's preview (Nav users) shows them, after `errors`.
  structureErrors: string[];
  // "invalid" because the engine accepted the selection but the structure is
  // not derivable (resolveVariant's ConfiguratorVariantNotDerivableError).
  notDerivable: boolean;
  warnings: string[];
  identitySelection: VariantSelectionEntry[];
  articleFields: VariantArticleFields;
  bom: VariantBomRow[];
  routing: VariantRoutingRow[];
};

function toPreviewRow(row: PlannedCombination): VariantPreviewRow {
  const { selection, status, articleId, articleNumber, name, salesPrice, standardCost, errors, structureErrors, warnings } = row;
  return { selection, status, articleId, articleNumber, name, salesPrice, standardCost, errors: [...errors, ...structureErrors], warnings };
}

// One value per group, as planCombinations' sets want it. Groups absent from
// the selection stay absent (the engine applies defaults), exactly like dp3;
// a null (deliberately empty, delprojekt 5) is passed through to the engine.
function setsFromSelection(selection: ConfiguratorSelection): VariantSets {
  const sets: VariantSets = {};
  for (const [code, value] of Object.entries(selection)) {
    sets[code] = typeof value === "string" ? [value] : typeof value === "boolean" ? [value] : [value];
  }
  return sets;
}

// A derived operation as a routing_operations insert. A base operation copies
// every column of the template's row except its identity; a conditional one
// gets the defaults (time unit minutes, no comment/print flags) and the
// resource's supplier on a lego resource.
function toRoutingInsert(r: VariantRoutingRow): RoutingOperationInsert {
  const derived = {
    sequenceNo: r.sequenceNo, workCenterId: r.workCenterId, description: r.description,
    setupTime: String(r.setupTime), runTimePerUnit: String(r.runTimePerUnit), costingOnly: r.costingOnly,
    setupPrice: num(r.setupPrice), unitPrice: num(r.unitPrice),
  };
  if (r.copyFrom) {
    const { id: _id, articleId: _articleId, ...rest } = r.copyFrom;
    return { ...rest, ...derived } as RoutingOperationInsert;
  }
  return { ...derived, subcontractSupplierId: r.subcontractSupplierId, timeUnit: "minutes_per_unit" };
}

// "Används av varianter: 63000-A-RD, … och N till" — at most ten numbers spelled out.
function variantUsageLabel(articleNumbers: string[]): string {
  const shown = articleNumbers.slice(0, 10).join(", ");
  const rest = articleNumbers.length - 10;
  return `Används av varianter: ${shown}${rest > 0 ? ` och ${rest} till` : ""}`;
}

// Group codes and `GRUPP=ALTERNATIV` pairs the variants' keys spell, each with
// the variants' article numbers. A group with no value in a variant (empty
// choice, unchecked ja/nej) is not in that variant's key and so not locked by it.
// Konfigurator 4b: a configured order row's stored selection counts the same
// way — its "article number" is the readable source `orderrad KO-1024`.
function codesUsedByVariants(
  variants: { articleNumber: string; selection: VariantSelectionEntry[] }[]
): { groupCodes: Map<string, string[]>; pairs: Map<string, string[]> } {
  const groupCodes = new Map<string, string[]>();
  const pairs = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, articleNumber: string) => {
    const list = map.get(key);
    if (list) list.push(articleNumber);
    else map.set(key, [articleNumber]);
  };
  for (const v of variants) {
    for (const entry of v.selection) {
      if (entry.value === null || entry.value === false) continue;
      add(groupCodes, entry.groupCode, v.articleNumber);
      if (entry.kind === "choice" && entry.valueCode !== null) add(pairs, `${entry.groupCode}=${entry.valueCode}`, v.articleNumber);
    }
  }
  return { groupCodes, pairs };
}

// numeric strings → numbers for the pure engine. Exported for the route tests.
export function toEngineTemplate(detail: ConfiguratorTemplateDetail): EngineTemplate {
  return {
    basePrice: toNumber(detail.basePrice),
    groups: detail.groups.map((g) => ({
      id: g.id,
      code: g.code,
      name: g.name,
      kind: g.kind,
      required: g.required,
      sortOrder: g.sortOrder,
      priceAdd: Number(g.priceAdd),
      defaultValueId: g.defaultValueId,
      unit: g.unit,
      minValue: toNumber(g.minValue),
      maxValue: toNumber(g.maxValue),
      step: toNumber(g.step),
      defaultNumber: toNumber(g.defaultNumber),
      pricePerUnit: Number(g.pricePerUnit),
      priceBaseValue: Number(g.priceBaseValue),
      values: g.values.map((v) => ({
        id: v.id, code: v.code, name: v.name, priceAdd: Number(v.priceAdd), sortOrder: v.sortOrder, active: v.active, articleId: v.articleId,
      })),
    })),
    rules: detail.rules.map((r) => ({
      id: r.id, effect: r.effect, conditions: r.conditions, target: r.target, message: r.message, sortOrder: r.sortOrder, active: r.active,
    })),
  };
}

// The derivation's view of the stored rows: numbers as numbers, and the
// "Strukturrad N (namn)" label that prefixes every message about a line.
export function toDeriveRows(detail: ConfiguratorTemplateDetail): { lines: DeriveBomLine[]; operations: DeriveOperation[] } {
  const lines = [...detail.bomLines].sort((a, b) => a.sortOrder - b.sortOrder).map((l, i) => ({
    id: l.id,
    sortOrder: l.sortOrder,
    conditions: l.conditions,
    source: l.source,
    componentArticleId: l.componentArticleId,
    componentGroupId: l.componentGroupId,
    quantity: toNumber(l.quantity),
    quantityFormula: l.quantityFormula,
    routingOperationId: l.routingOperationId,
    configuratorOperationId: l.configuratorOperationId,
    label: `Strukturrad ${i + 1} (${l.componentArticleName ?? l.componentGroupName ?? "?"})`,
  }));
  const operations = detail.operations.map((o) => ({
    id: o.id,
    sequenceNo: o.sequenceNo,
    conditions: o.conditions,
    workCenterId: o.workCenterId,
    description: o.description,
    setupTime: toNumber(o.setupTime),
    setupFormula: o.setupFormula,
    runTimePerUnit: toNumber(o.runTimePerUnit),
    runFormula: o.runFormula,
    setupPrice: toNumber(o.setupPrice),
    unitPrice: toNumber(o.unitPrice),
  }));
  return { lines, operations };
}

function assertSameSet(current: string[], ids: string[]) {
  const wanted = new Set(ids);
  if (wanted.size !== ids.length || ids.length !== current.length || !current.every((id) => wanted.has(id))) {
    throw new ConfiguratorReorderMismatchError();
  }
}

function groupInsert(articleId: string, sortOrder: number, input: CreateConfiguratorGroupInput): GroupInsert {
  const base = { articleId, code: input.code, name: input.name, kind: input.kind, sortOrder };
  if (input.kind === "choice") return { ...base, required: input.required ?? false, articleField: input.articleField ?? null };
  if (input.kind === "boolean") return { ...base, priceAdd: String(input.priceAdd ?? 0) };
  return {
    ...base,
    required: input.required ?? false,
    unit: input.unit ?? null,
    minValue: String(input.minValue),
    maxValue: String(input.maxValue),
    step: num(input.step),
    defaultNumber: num(input.defaultNumber),
    pricePerUnit: String(input.pricePerUnit ?? 0),
    priceBaseValue: String(input.priceBaseValue ?? 0),
  };
}

function groupPatch(input: UpdateConfiguratorGroupInput): GroupPatch {
  const patch: GroupPatch = {};
  if (input.code !== undefined) patch.code = input.code;
  if (input.name !== undefined) patch.name = input.name;
  if (input.required !== undefined) patch.required = input.required;
  if (input.priceAdd !== undefined) patch.priceAdd = String(input.priceAdd);
  if (input.defaultValueId !== undefined) patch.defaultValueId = input.defaultValueId;
  if (input.articleField !== undefined) patch.articleField = input.articleField;
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.minValue !== undefined) patch.minValue = String(input.minValue);
  if (input.maxValue !== undefined) patch.maxValue = String(input.maxValue);
  if (input.step !== undefined) patch.step = num(input.step);
  if (input.defaultNumber !== undefined) patch.defaultNumber = num(input.defaultNumber);
  if (input.pricePerUnit !== undefined) patch.pricePerUnit = String(input.pricePerUnit);
  if (input.priceBaseValue !== undefined) patch.priceBaseValue = String(input.priceBaseValue);
  return patch;
}

function valuePatch(input: UpdateConfiguratorValueInput): ValuePatch {
  const patch: ValuePatch = {};
  if (input.code !== undefined) patch.code = input.code;
  if (input.name !== undefined) patch.name = input.name;
  if (input.priceAdd !== undefined) patch.priceAdd = String(input.priceAdd);
  if (input.active !== undefined) patch.active = input.active;
  if (input.articleId !== undefined) patch.articleId = input.articleId;
  return patch;
}

// --- merged rows: stored ∪ patch, undefined = keep ---

const LINE_KEYS = [
  "conditions", "source", "componentArticleId", "componentGroupId", "quantity", "quantityFormula", "routingOperationId",
  "configuratorOperationId", "note",
] as const satisfies readonly (keyof LineFields)[];

function lineFields(stored: ConfiguratorBomLineDetail | null, input: CreateConfiguratorBomLineInput | UpdateConfiguratorBomLineInput): LineFields {
  const base: LineFields = stored
    ? { ...stored, quantity: toNumber(stored.quantity) }
    : {
        conditions: [], source: "article", componentArticleId: null, componentGroupId: null, quantity: null, quantityFormula: null,
        routingOperationId: null, configuratorOperationId: null, note: null,
      };
  const merged: LineFields = { ...base };
  for (const key of LINE_KEYS) {
    const v = input[key];
    if (v !== undefined) (merged as Record<string, unknown>)[key] = v;
  }
  return merged;
}

// Only the writable columns — never id/sort_order or the joined display fields a stored detail carries.
function lineWrite(f: LineFields): BomLineWrite {
  return {
    conditions: f.conditions, source: f.source, componentArticleId: f.componentArticleId, componentGroupId: f.componentGroupId,
    quantity: num(f.quantity), quantityFormula: f.quantityFormula, routingOperationId: f.routingOperationId,
    configuratorOperationId: f.configuratorOperationId, note: f.note,
  };
}

const OPERATION_KEYS = [
  "conditions", "sequenceNo", "workCenterId", "description", "setupTime", "setupFormula", "runTimePerUnit", "runFormula", "setupPrice", "unitPrice",
] as const satisfies readonly (keyof OperationFields)[];

function operationFields(
  stored: ConfiguratorOperationDetail | null,
  input: CreateConfiguratorOperationInput | UpdateConfiguratorOperationInput
): OperationFields {
  const base: OperationFields = stored
    ? {
        ...stored, setupTime: toNumber(stored.setupTime), runTimePerUnit: toNumber(stored.runTimePerUnit),
        setupPrice: toNumber(stored.setupPrice), unitPrice: toNumber(stored.unitPrice),
      }
    : { conditions: [], sequenceNo: 0, workCenterId: "", description: null, setupTime: null, setupFormula: null, runTimePerUnit: null, runFormula: null, setupPrice: null, unitPrice: null };
  const merged: OperationFields = { ...base };
  for (const key of OPERATION_KEYS) {
    const v = input[key];
    if (v !== undefined) (merged as Record<string, unknown>)[key] = v;
  }
  return merged;
}

function operationWrite(f: OperationFields): OperationWrite {
  return {
    conditions: f.conditions, sequenceNo: f.sequenceNo, workCenterId: f.workCenterId, description: f.description,
    setupTime: num(f.setupTime), setupFormula: f.setupFormula, runTimePerUnit: num(f.runTimePerUnit), runFormula: f.runFormula,
    setupPrice: num(f.setupPrice), unitPrice: num(f.unitPrice),
  };
}

export function createConfiguratorService(deps: {
  db: Db;
  prices: PriceReader;
  customerExists: (id: string) => Promise<boolean>;
  articles: ArticleStructureReader;
  costing: CostingPreview;
  writers: VariantWriters;
  stock: VariantStockReader;
}) {
  const { db } = deps;
  const repo = createConfiguratorRepository();

  // Every template mutation goes through here: lock first, then load.
  function write<T>(articleId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      if (!(await repo.lockTemplate(tx, articleId))) throw new ConfiguratorTemplateNotFoundError();
      return fn(tx);
    });
  }

  async function mapCodeTaken<T>(code: string | undefined, constraint: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (code !== undefined && isUniqueViolation(err, constraint)) throw new ConfiguratorCodeTakenError(code);
      throw err;
    }
  }

  // One group per template may fill an article field; the partial unique index decides.
  async function mapArticleFieldTaken<T>(articleId: string, field: string | null | undefined, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (field && isUniqueViolation(err, GROUP_ARTICLE_FIELD_UNIQUE)) {
        const holder = (await repo.loadTemplate(db, articleId))?.groups.find((g) => g.articleField === field);
        throw new InvalidConfiguratorGroupError(`${ARTICLE_FIELD_NAME[field] ?? field} fylls redan av valgruppen ${holder?.name ?? "?"}`);
      }
      throw err;
    }
  }

  // The unique index is the backstop behind validateOperationInput's check.
  async function mapSequenceTaken<T>(sequenceNo: number | undefined, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (sequenceNo !== undefined && isUniqueViolation(err, OPERATION_SEQUENCE_UNIQUE)) throw new ConfiguratorSequenceTakenError(sequenceNo);
      throw err;
    }
  }

  async function loadOrThrow(ex: Db | Tx, articleId: string): Promise<ConfiguratorTemplateDetail> {
    const detail = await repo.loadTemplate(ex, articleId);
    if (!detail) throw new ConfiguratorTemplateNotFoundError();
    return detail;
  }

  // Delprojekt 5: the visibility rule for the external API's reads. A client
  // gets the same 404 for a hidden template as for an unknown one.
  async function visibleTemplate(articleId: string, opts: { client: boolean }): Promise<{ articleNumber: string; name: string }> {
    const head = await repo.templateVisibility(db, articleId);
    if (!head || (opts.client && (!head.published || !head.active))) throw new ConfiguratorTemplateNotFoundError();
    return { articleNumber: head.articleNumber, name: head.name };
  }

  async function requireGroup(tx: Tx, articleId: string, groupId: string): Promise<ConfiguratorGroupDetail> {
    const group = await repo.findGroup(tx, articleId, groupId);
    if (!group) throw new ConfiguratorGroupNotFoundError();
    return group;
  }

  async function requireValue(tx: Tx, articleId: string, groupId: string, valueId: string): Promise<{ group: ConfiguratorGroupDetail; value: ConfiguratorValueDetail }> {
    const group = await requireGroup(tx, articleId, groupId);
    const value = await repo.findValue(tx, groupId, valueId);
    if (!value) throw new ConfiguratorValueNotFoundError();
    return { group, value };
  }

  // A component article / an alternative's article must exist and may neither
  // be the template nor contain it (the structure would loop). The article
  // module's walk runs on the plain db — bom_components sit outside the template
  // lock; the FK (restrict) is the backstop should the article vanish meanwhile.
  async function assertArticleOutsideTemplate(articleId: string, templateArticleId: string, fail: () => Error) {
    if (!(await deps.articles.exists(articleId))) throw new ArticleNotFoundError(articleId);
    if (articleId === templateArticleId || (await deps.articles.isDescendant(articleId, templateArticleId))) throw fail();
  }

  // Refuse deleting a group/alternative while any rule, structure line or
  // operation points at it — in a condition, as component source or by code
  // in a formula — or while a variant's key spells it; the list tells the
  // user where.
  async function assertNotReferenced(tx: Tx, articleId: string, refs: ReferenceTargets, variantUsers: string[]) {
    const using = templateReferences(await loadOrThrow(tx, articleId), refs);
    if (variantUsers.length > 0) using.push(variantUsageLabel(variantUsers));
    if (using.length > 0) throw new ConfiguratorReferenceInUseError(using);
  }

  // A code a formula uses is locked (the formula would otherwise dangle).
  function assertCodeNotInFormulas(template: ConfiguratorTemplateDetail, refs: Pick<ReferenceTargets, "codes" | "pairs">) {
    const using = formulaUsers(template, refs);
    if (using.length > 0) throw new ConfiguratorReferenceInUseError(using);
  }

  const valuePair = (groupCode: string, valueCode: string) => `${groupCode}=${valueCode}`;

  async function reorder(articleId: string, table: SortTable, scopeId: string, ids: string[], tx: Tx) {
    assertSameSet(await repo.idsInScope(tx, table, scopeId), ids);
    await repo.setSortOrder(tx, table, ids);
  }

  // The code lock: group codes and GRUPP=ALTERNATIV pairs spelled by the
  // template's variants' keys AND by configured order rows' stored selections
  // (4b) — a row keeps its configuration whatever the order's status, so the
  // codes stay locked. Renaming one would make the same combination creatable
  // twice (variants) or make the row's stored key stop matching (rows).
  async function codesInUse(tx: Tx, articleId: string) {
    const rows = await repo.configuredRowsOfTemplate(tx, articleId);
    return codesUsedByVariants([
      ...(await repo.variantsOfTemplate(tx, articleId)),
      ...rows.map((r) => ({ articleNumber: `orderrad ${r.orderNumber}`, selection: r.selection })),
    ]);
  }

  // The template article read FOR SHARE under the template write, so a
  // concurrent type/phantom change (FOR UPDATE on the article row) waits.
  async function lockedTemplateArticle(tx: Tx, articleId: string, mode: ConfiguratorMode) {
    const article = await repo.templateArticleRow(tx, articleId, "share");
    if (!article) throw new ArticleNotFoundError(articleId);
    assertModeAllowed(article, mode);
    return article;
  }

  async function assertNoVariants(tx: Tx, articleId: string) {
    if ((await repo.variantsOfTemplate(tx, articleId)).length > 0) throw new ConfiguratorTemplateHasVariantsError();
  }

  // Validate a merged line under the lock: pure checks first, then the two async article checks.
  async function validateLine(tx: Tx, articleId: string, template: ConfiguratorTemplateDetail, line: LineFields) {
    const routing = await repo.listBaseRouting(tx, articleId);
    validateLineInput(toEngineTemplate(template), line, {
      templateArticleId: articleId,
      routingOperationIds: new Set(routing.map((o) => o.id)),
      configuratorOperationIds: new Set(template.operations.map((o) => o.id)),
    });
    if (line.source === "article" && line.componentArticleId) {
      await assertArticleOutsideTemplate(line.componentArticleId, articleId, () => new InvalidConfiguratorLineError(TEMPLATE_IN_COMPONENT));
    }
  }

  // `checkActive`: the resource must be active when an operation is created or moved to another resource; a stored
  // operation whose resource was deactivated since stays editable (description, times, conditions).
  // Lego prices belong to a legoresurs, as on the article's own route (manufacturing.service): incoming
  // non-null prices on any other resource are refused, and stored ones are cleared when the operation
  // moves to such a resource. Returns the operation to store.
  async function validateOperation(
    tx: Tx, articleId: string, template: ConfiguratorTemplateDetail, op: OperationFields,
    incoming: Pick<UpdateConfiguratorOperationInput, "setupPrice" | "unitPrice">, selfId: string | null, checkActive: boolean
  ): Promise<OperationFields> {
    const routing = await repo.listBaseRouting(tx, articleId);
    validateOperationInput(toEngineTemplate(template), op, {
      baseSequenceNos: new Set(routing.map((o) => o.sequenceNo)),
      otherSequenceNos: new Set(template.operations.filter((o) => o.id !== selfId).map((o) => o.sequenceNo)),
    });
    const workCenter = await repo.findWorkCenter(tx, op.workCenterId);
    if (!workCenter) throw new WorkCenterNotFoundError(op.workCenterId);
    if (checkActive && !workCenter.active) throw new InvalidConfiguratorOperationError("Resursen är inaktiv");
    if (workCenter.type === "subcontract") return op;
    if (incoming.setupPrice != null || incoming.unitPrice != null) {
      throw new InvalidConfiguratorOperationError("Ställpris och styckpris kräver en legoresurs");
    }
    return { ...op, setupPrice: null, unitPrice: null };
  }

  // A plain read (no lock). A local function so evaluatePublic shares it.
  async function evaluate(
    articleId: string,
    input: { selection: ConfiguratorSelection; customerId?: string; quantity: number }
  ): Promise<ConfiguratorEvaluation> {
    const template = await loadOrThrow(db, articleId);
    return resolveConfiguration(toEngineTemplate(template), input.selection, await customerPriceFor(articleId, input)).evaluation;
  }

  // The customer price chain, as evaluate and derive both price a configuration.
  async function customerPriceFor(
    articleId: string, input: { customerId?: string; quantity: number }
  ): Promise<EngineCustomerPrice | undefined> {
    if (input.customerId === undefined) return undefined;
    if (!(await deps.customerExists(input.customerId))) throw new CustomerNotFoundError(input.customerId);
    const res = await deps.prices({ customerId: input.customerId, articleId, quantity: input.quantity });
    return res?.price ?? null; // null: the chain gave nothing → base price, source "article"
  }

  // Everything deriveStructure needs, read without changing anything. The
  // template's ordinary structure and route come straight from
  // bom_components/routing_operations.
  async function loadDerivationInput(ex: Db | Tx, articleId: string): Promise<DerivationInput> {
    const detail = await loadOrThrow(ex, articleId);
    const [baseBom, baseOperations] = await Promise.all([repo.listBaseBom(ex, articleId), repo.listBaseRouting(ex, articleId)]);
    return { detail, baseBom, baseOperations, ...toDeriveRows(detail) };
  }

  // The pre-costing of a derived structure, exactly as derive feeds it.
  function costStructure(articleId: string, quantity: number, core: DerivedStructureCore) {
    return deps.costing.previewStructure(articleId, quantity, {
      components: core.materials.map((m) => ({
        componentArticleId: m.componentArticleId, quantity: m.quantity, unitId: m.unitId, unitFactor: m.unitFactor,
        operationId: m.operation?.id ?? null,
      })),
      operations: core.operations.map((o) => ({
        sequenceNo: o.sequenceNo, workCenterId: o.workCenterId, setupTime: o.setupTime, runTimePerUnit: o.runTimePerUnit,
        setupPrice: o.setupPrice, unitPrice: o.unitPrice,
      })),
    });
  }

  // Konfigurator 4c: one configuration's structure as a TO's own rows, at the
  // TO quantity — what a beställningsvara's TO is created with (and what
  // planning cascades from). The same derivation as derive/variants; the
  // route's other columns come from the template's routing rows (the
  // variant builder's variantRoutingRows), costing-only operations are
  // dropped, phantoms dissolved and rows merged per (article, operation).
  // Reads only — never inside another module's transaction. A local function
  // (not a method) so evaluateRowConfiguration can call it without `this`.
  async function deriveForManufacturing(
    templateArticleId: string, selection: ConfiguratorSelection, quantity: number, opts: { withCost?: boolean } = {}
  ): Promise<ConfiguredStructure> {
    const loaded = await loadDerivationInput(db, templateArticleId);
    if (loaded.detail.mode !== "to_order") throw new ConfiguratorNotToOrderModeError();
    const template = toEngineTemplate(loaded.detail);
    const { evaluation, effective } = resolveConfiguration(template, selection, undefined);
    const core = deriveStructure({
      template, evaluation, effective,
      baseBom: loaded.baseBom, baseOperations: loaded.baseOperations, lines: loaded.lines, operations: loaded.operations,
    });
    const empty = { templateArticleId, selection: [], operations: [], materials: [], cost: null };
    if (!evaluation.valid || evaluation.key === null) {
      return { ...empty, valid: false, key: null, errors: [...evaluation.errors, ...evaluation.groups.flatMap((g) => g.errors)] };
    }
    if (!core.derivable) return { ...empty, valid: false, key: evaluation.key, errors: [...core.errors] };

    const componentIds = [...new Set(core.materials.map((m) => m.componentArticleId))];
    const [templateRouting, workCenters, labels, phantoms] = await Promise.all([
      repo.listTemplateRoutingRows(db, templateArticleId),
      repo.workCentersForVariants(db, [...new Set(core.operations.map((o) => o.workCenterId))]),
      repo.derivationLabels(db, { articleIds: componentIds, unitIds: [], workCenterIds: [] }),
      repo.phantomIds(db, componentIds),
    ]);
    const operations = manufacturingOperations(variantRoutingRows(core.operations, new Map(templateRouting.map((r) => [r.id, r])), workCenters));
    const exploded = await explodeDerivedMaterials(
      core.materials.map((m) => ({
        componentArticleId: m.componentArticleId,
        componentName: labels.articles.get(m.componentArticleId)?.name ?? "",
        totalQuantity: m.quantity * quantity,
        unitId: m.unitId, unitFactor: m.unitFactor,
        operationId: m.operation?.id ?? null,
        isPhantom: phantoms.has(m.componentArticleId),
      })),
      (id, q) => repo.explodeBom(db, id, q)
    );
    // Merged per (article, TO operation) and rounded to four decimals inside
    // linkMaterialsToOperations — one row per unique key, no float noise.
    const materials = linkMaterialsToOperations(exploded, core.operations, new Set(operations.map((o) => o.sequenceNo)));

    let cost: ConfiguredStructure["cost"] = null;
    if (opts.withCost !== false) {
      // Same rule as a variant's standard cost: a figure only when something
      // was costed and it is finite and > 0 — otherwise null, never 0.
      const costing = await costStructure(templateArticleId, quantity, core);
      const costed = costing.materialRows.length + costing.operationRows.length > 0;
      const usable = (n: number) => (costed && Number.isFinite(n) && n > 0 ? round4(n) : null);
      cost = { manufacturingCostPerUnit: usable(costing.manufacturingCostPerUnit), selfCostPerUnit: usable(costing.selfCostPerUnit) };
    }
    return {
      valid: true, errors: [], templateArticleId, key: evaluation.key,
      selection: selectionEntries(template, effective), operations, materials, cost,
    };
  }

  // --- stocked variants (lagerförda varianter) ---

  // One plan shared by preview and create: every combination evaluated,
  // derived and identified, then checked against the template's existing
  // variants (key) and the article register (number). Reads only; create
  // runs it inside its transaction so the preview is never trusted.
  async function planCombinations(
    ex: Db | Tx, articleId: string, templateArticle: { articleNumber: string; name: string }, input: { sets: VariantSets; calcQuantity: number }
  ): Promise<PlannedCombination[]> {
    const loaded = await loadDerivationInput(ex, articleId);
    if (loaded.detail.mode !== "variants") throw new ConfiguratorNotVariantModeError();
    const template = toEngineTemplate(loaded.detail);

    let selections: ConfiguratorSelection[];
    try {
      selections = expandCombinations(template, input.sets);
    } catch (err) {
      if (err instanceof TooManyCombinationsError) throw new ConfiguratorTooManyCombinationsError(err.count, MAX_VARIANT_COMBINATIONS);
      if (err instanceof VariantSetError) throw new InvalidConfiguratorVariantSetError(err.message);
      throw err;
    }

    const existingByKey = new Map((await repo.variantsOfTemplate(ex, articleId)).map((v) => [v.configKey, v]));
    const rows: PlannedCombination[] = [];
    const structures = new Map<PlannedCombination, DerivedStructureCore>();
    for (const selection of selections) {
      const { evaluation, effective } = resolveConfiguration(template, selection, undefined);
      const structure = deriveStructure({
        template, evaluation, effective,
        baseBom: loaded.baseBom, baseOperations: loaded.baseOperations, lines: loaded.lines, operations: loaded.operations,
      });
      const row: PlannedCombination = {
        selection, status: "new", articleId: null, key: evaluation.key, articleNumber: null, name: null, salesPrice: null, standardCost: null,
        errors: [], structureErrors: [], notDerivable: false, warnings: [], identitySelection: [], articleFields: {}, bom: [], routing: [],
      };
      rows.push(row);
      if (!evaluation.valid) {
        row.status = "invalid";
        row.errors = [...evaluation.errors, ...evaluation.groups.flatMap((g) => g.errors)];
        row.structureErrors = [...structure.errors];
        continue;
      }
      const identity = variantIdentity(template, templateArticle, effective);
      row.articleNumber = identity.articleNumber;
      row.name = identity.name;
      row.salesPrice = evaluation.price.unitPrice;
      if (row.salesPrice === null) row.warnings.push(MISSING_BASE_PRICE);
      // An existing combination stays `exists` even if the template was renamed past the length limits since.
      const existing = existingByKey.get(evaluation.key!);
      if (existing) {
        row.status = "exists";
        row.articleId = existing.articleId;
        row.standardCost = toNumber(existing.standardCost);
        continue;
      }
      if (!structure.derivable) {
        row.status = "invalid";
        row.notDerivable = true;
        row.structureErrors = [...structure.errors];
        continue;
      }
      if (!identity.ok) {
        row.status = "too_long";
        row.errors = [identity.error];
        continue;
      }
      row.identitySelection = identity.selection;
      row.articleFields = variantArticleFields(loaded.detail.groups, effective);
      row.warnings.push(...structure.warnings);
      structures.set(row, structure);
    }

    // A number already in the register, or planned twice in this call (codes
    // can collide once joined with "-"), stops the combination — never an overwrite.
    const candidates = rows.filter((r) => r.status === "new");
    const taken = await repo.articleIdsByNumber(ex, candidates.map((r) => r.articleNumber!));
    const planned = new Set<string>();
    for (const row of candidates) {
      if (taken.has(row.articleNumber!) || planned.has(row.articleNumber!)) {
        row.status = "number_taken";
        row.errors = [`Artikelnumret ${row.articleNumber} finns redan`];
        structures.delete(row);
      } else {
        planned.add(row.articleNumber!);
      }
    }

    // What the new ones are written with: merged structure, derived route and the pre-costing at the calc quantity.
    const newRows = [...structures.keys()];
    if (newRows.length === 0) return rows;
    const [labels, templateRouting, workCenters] = await Promise.all([
      repo.derivationLabels(ex, {
        articleIds: [...new Set(newRows.flatMap((r) => structures.get(r)!.materials.map((m) => m.componentArticleId)))], unitIds: [], workCenterIds: [],
      }),
      repo.listTemplateRoutingRows(ex, articleId),
      repo.workCentersForVariants(ex, [...new Set(loaded.detail.operations.map((o) => o.workCenterId))]),
    ]);
    const routingById = new Map(templateRouting.map((r) => [r.id, r]));
    for (const row of newRows) {
      const structure = structures.get(row)!;
      const merged = mergeVariantMaterials(structure.materials, (id) => labels.articles.get(id)?.articleNumber ?? id);
      row.bom = merged.rows;
      row.warnings.push(...merged.warnings);
      row.routing = variantRoutingRows(structure.operations, routingById, workCenters);
      const costing = await costStructure(articleId, input.calcQuantity, structure);
      const perUnit = costing.manufacturingCostPerUnit;
      const costed = costing.materialRows.length + costing.operationRows.length > 0 && Number.isFinite(perUnit) && perUnit > 0;
      row.standardCost = costed ? round4(perUnit) : null;
      row.warnings.push(...costing.warnings);
    }
    return rows;
  }

  // Shared by createVariants and resolveVariant so the two can never drift: one
  // planned "new" combination becomes an article with the derived route, the
  // merged structure and its link row, inside the caller's template transaction.
  async function createPlannedVariant(
    tx: Tx, articleId: string, templateArticle: NonNullable<Awaited<ReturnType<typeof repo.templateArticleRow>>>,
    row: PlannedCombination, calcQuantity: number, userId: string | null
  ): Promise<{ id: string }> {
    const created = await deps.writers.insertArticle(tx, {
      articleNumber: row.articleNumber!, name: row.name!, type: "manufactured", isPhantom: false, active: true,
      unitId: templateArticle.unitId, groupId: templateArticle.groupId ?? undefined,
      defaultLocationId: templateArticle.defaultLocationId ?? undefined,
      salesPrice: row.salesPrice ?? undefined, standardCost: row.standardCost ?? undefined,
      ...row.articleFields,
      // Information (vat, weight, dimensions, planning, alternative units) from the template, like Kopiera från.
      copyFrom: { articleId, parts: ["information"] },
    });
    // The template is locked, so the copy source cannot have vanished.
    if (!created) throw new ConfiguratorTemplateNotFoundError();
    const operationIds = await deps.writers.insertRoutingOperations(tx, created.id, row.routing.map(toRoutingInsert));
    await deps.writers.insertBomRows(
      tx, created.id,
      row.bom.map((b) => ({
        componentArticleId: b.componentArticleId, quantity: b.quantity, unitId: b.unitId, unitFactor: b.unitFactor,
        routingOperationId: b.operationSequenceNo === null ? null : operationIds.get(b.operationSequenceNo)!,
      }))
    );
    await repo.insertVariantLink(tx, {
      articleId: created.id, templateArticleId: articleId, configKey: row.key!, selection: row.identitySelection,
      calcQuantity, createdBy: userId,
    });
    return created;
  }

  // A concurrent POST /articles took the number after the check; the key index
  // cannot fire under the template lock but is mapped the same.
  async function mapVariantRace<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (isUniqueViolation(err, ARTICLE_NUMBER_UNIQUE) || isUniqueViolation(err, VARIANT_KEY_UNIQUE)) throw new ConfiguratorVariantNumberRaceError();
      throw err;
    }
  }

  return {
    async getTemplate(articleId: string): Promise<ConfiguratorTemplateView> {
      const detail = await loadOrThrow(db, articleId);
      const { groups } = toEngineTemplate(detail);
      return { ...detail, structureWarnings: coverageWarnings(groups, findCoverageGaps(groups, toDeriveRows(detail).lines)) };
    },

    // A variant is never a template of its own (its structure is the template's derivation).
    async createTemplate(articleId: string, input: { mode: ConfiguratorMode; published?: boolean }): Promise<ConfiguratorTemplateDetail> {
      try {
        return await db.transaction(async (tx) => {
          await lockedTemplateArticle(tx, articleId, input.mode);
          if (await repo.isVariant(tx, articleId)) throw new ConfiguratorVariantNotTemplateError();
          await repo.insertTemplate(tx, articleId, input.mode, input.published ?? false);
          return loadOrThrow(tx, articleId);
        });
      } catch (err) {
        if (isUniqueViolation(err, TEMPLATE_PKEY)) throw new ConfiguratorTemplateExistsError();
        throw err;
      }
    },

    // A template with variants stays in the variants mode. The mode rules run
    // only when the mode is sent; Visa i API (published) may change in any mode.
    async updateTemplate(articleId: string, input: { mode?: ConfiguratorMode; published?: boolean }): Promise<ConfiguratorTemplateDetail> {
      return write(articleId, async (tx) => {
        if (input.mode !== undefined) {
          if (input.mode !== "variants") await assertNoVariants(tx, articleId);
          await lockedTemplateArticle(tx, articleId, input.mode);
        }
        await repo.updateTemplate(tx, articleId, { mode: input.mode, published: input.published });
        return loadOrThrow(tx, articleId);
      });
    },

    // --- the external API (delprojekt 5) ---
    // The rule: an OAuth client only ever sees published templates on active
    // articles, and a hidden one answers exactly like an unknown one (404) so
    // it cannot be discovered. A session (the web) sees what it always saw.

    // GET /configurator/templates — the same selection for client and session.
    async listPublicTemplates(query: ListQuery): Promise<{ rows: PublicTemplateSummary[]; total: number }> {
      const { rows, total } = await repo.listPublishedTemplates(db, query);
      return { rows: rows.map((r) => toPublicTemplateSummary(r, r)), total };
    },

    async getPublicTemplate(articleId: string, opts: { client: boolean }): Promise<PublicTemplate> {
      const article = await visibleTemplate(articleId, opts);
      return toPublicTemplate(await loadOrThrow(db, articleId), article);
    },

    async evaluatePublic(
      articleId: string,
      input: { selection: ConfiguratorSelection; customerId?: string; quantity: number },
      opts: { client: boolean }
    ): Promise<ConfiguratorEvaluation> {
      await visibleTemplate(articleId, opts);
      return evaluate(articleId, input);
    },

    // For POST /quotes from a client: the templates among the rows' articles it may not use.
    async unpublishedTemplates(articleIds: string[]): Promise<{ articleId: string; articleNumber: string }[]> {
      return repo.unpublishedTemplates(db, [...new Set(articleIds)]);
    },

    // Groups, values, rules, lines and operations go with it (ON DELETE cascade);
    // variants do not — a template with variants cannot be deleted (the FK is the backstop).
    async deleteTemplate(articleId: string): Promise<void> {
      await write(articleId, async (tx) => {
        await assertNoVariants(tx, articleId);
        await repo.deleteTemplate(tx, articleId);
      });
    },

    // --- groups ---

    async createGroup(articleId: string, input: CreateConfiguratorGroupInput): Promise<ConfiguratorGroupDetail> {
      return mapArticleFieldTaken(articleId, input.kind === "choice" ? input.articleField : undefined, () =>
        mapCodeTaken(input.code, GROUP_CODE_UNIQUE, () =>
          write(articleId, async (tx) => {
            const sortOrder = (await repo.maxSortOrder(tx, "groups", articleId)) + 1;
            return repo.insertGroup(tx, groupInsert(articleId, sortOrder, input));
          })
        )
      );
    },

    async updateGroup(articleId: string, groupId: string, input: UpdateConfiguratorGroupInput): Promise<ConfiguratorGroupDetail> {
      return mapArticleFieldTaken(articleId, input.articleField, () =>
      mapCodeTaken(input.code, GROUP_CODE_UNIQUE, () =>
        write(articleId, async (tx) => {
          const group = await requireGroup(tx, articleId, groupId);
          assertGroupFieldsMatchKind(group.kind, input);
          if (input.defaultValueId) {
            const value = group.values.find((v) => v.id === input.defaultValueId);
            if (!value || !value.active) throw new InvalidConfiguratorGroupError("Förvalet ska vara ett aktivt alternativ i valgruppen");
          }
          if (group.kind === "number") {
            const min = input.minValue ?? Number(group.minValue);
            const max = input.maxValue ?? Number(group.maxValue);
            const def = input.defaultNumber !== undefined ? input.defaultNumber : toNumber(group.defaultNumber);
            if (min > max) throw new InvalidConfiguratorGroupError("Min får inte vara större än max");
            if (def !== null && (def < min || def > max)) throw new InvalidConfiguratorGroupError("Förvalet ska ligga inom intervallet");
          }
          if (input.code !== undefined && input.code !== group.code) {
            // A variant's key spells the code, and so does a formula in a line's quantity or an operation's times.
            if ((await codesInUse(tx, articleId)).groupCodes.has(group.code)) throw new ConfiguratorCodeLockedError(group.code);
            assertCodeNotInFormulas(await loadOrThrow(tx, articleId), { codes: [group.code] });
          }
          return repo.updateGroup(tx, groupId, groupPatch(input));
        })
      ));
    },

    async deleteGroup(articleId: string, groupId: string): Promise<void> {
      await write(articleId, async (tx) => {
        const group = await requireGroup(tx, articleId, groupId);
        await assertNotReferenced(
          tx, articleId,
          {
            groupIds: [group.id], valueIds: group.values.map((v) => v.id),
            codes: [group.code], pairs: group.values.map((v) => valuePair(group.code, v.code)),
          },
          (await codesInUse(tx, articleId)).groupCodes.get(group.code) ?? []
        );
        await repo.deleteGroup(tx, groupId);
      });
    },

    async reorderGroups(articleId: string, ids: string[]): Promise<void> {
      await write(articleId, (tx) => reorder(articleId, "groups", articleId, ids, tx));
    },

    // --- values (alternativ, listval only) ---

    async createValue(articleId: string, groupId: string, input: CreateConfiguratorValueInput): Promise<ConfiguratorValueDetail> {
      return mapCodeTaken(input.code, VALUE_CODE_UNIQUE, () =>
        write(articleId, async (tx) => {
          const group = await requireGroup(tx, articleId, groupId);
          if (group.kind !== "choice") throw new InvalidConfiguratorGroupError("Alternativ finns bara i ett listval");
          if (input.articleId) {
            await assertArticleOutsideTemplate(input.articleId, articleId, () => new InvalidConfiguratorGroupError(TEMPLATE_IN_VALUE_ARTICLE));
          }
          const sortOrder = (await repo.maxSortOrder(tx, "values", groupId)) + 1;
          return repo.insertValue(tx, {
            groupId, code: input.code, name: input.name, priceAdd: String(input.priceAdd ?? 0), active: input.active ?? true, sortOrder,
            articleId: input.articleId ?? null,
          });
        })
      );
    },

    async updateValue(articleId: string, groupId: string, valueId: string, input: UpdateConfiguratorValueInput): Promise<ConfiguratorValueDetail> {
      return mapCodeTaken(input.code, VALUE_CODE_UNIQUE, () =>
        write(articleId, async (tx) => {
          const { group, value } = await requireValue(tx, articleId, groupId, valueId);
          if (input.articleId) {
            await assertArticleOutsideTemplate(input.articleId, articleId, () => new InvalidConfiguratorGroupError(TEMPLATE_IN_VALUE_ARTICLE));
          }
          if (input.code !== undefined && input.code !== value.code) {
            // A variant's key spells the pair, and so does a formula comparing the group against this alternative (`om(FARG = "EP"; …)`).
            const pair = valuePair(group.code, value.code);
            if ((await codesInUse(tx, articleId)).pairs.has(pair)) throw new ConfiguratorCodeLockedError(value.code);
            assertCodeNotInFormulas(await loadOrThrow(tx, articleId), { pairs: [pair] });
          }
          return repo.updateValue(tx, valueId, valuePatch(input));
        })
      );
    },

    // The group's default goes to null by ON DELETE set null. An alternative a
    // variant uses cannot be deleted but can be deactivated (updateValue).
    async deleteValue(articleId: string, groupId: string, valueId: string): Promise<void> {
      await write(articleId, async (tx) => {
        const { group, value } = await requireValue(tx, articleId, groupId, valueId);
        const pair = valuePair(group.code, value.code);
        await assertNotReferenced(tx, articleId, { valueIds: [valueId], pairs: [pair] }, (await codesInUse(tx, articleId)).pairs.get(pair) ?? []);
        await repo.deleteValue(tx, valueId);
      });
    },

    async reorderValues(articleId: string, groupId: string, ids: string[]): Promise<void> {
      await write(articleId, async (tx) => {
        await requireGroup(tx, articleId, groupId);
        await reorder(articleId, "values", groupId, ids, tx);
      });
    },

    // --- rules ---

    async createRule(articleId: string, input: CreateConfiguratorRuleInput): Promise<ConfiguratorRuleDetail> {
      const target = parseRuleTarget(input.effect, input.target); // ZodError → 400 in the route
      return write(articleId, async (tx) => {
        const template = await loadOrThrow(tx, articleId); // after the lock
        validateRuleInput(toEngineTemplate(template), input.effect, input.conditions, target);
        const sortOrder = (await repo.maxSortOrder(tx, "rules", articleId)) + 1;
        return repo.insertRule(tx, articleId, sortOrder, {
          effect: input.effect, conditions: input.conditions, target, message: input.message, active: input.active ?? true,
        });
      });
    },

    // Validates the merged rule (stored ∪ patch) — a PATCH of only the
    // conditions can make the stored target sit in its own conditions.
    async updateRule(articleId: string, ruleId: string, input: UpdateConfiguratorRuleInput): Promise<ConfiguratorRuleDetail> {
      return write(articleId, async (tx) => {
        const existing = await repo.findRule(tx, articleId, ruleId);
        if (!existing) throw new ConfiguratorRuleNotFoundError();
        // The stored target belongs to the stored effect — re-reading it under
        // another effect could turn the rule into its opposite.
        if (input.effect !== undefined && input.effect !== existing.effect && input.target === undefined)
          throw new InvalidConfiguratorRuleError("Ange mål när effekten ändras");
        const effect = input.effect ?? existing.effect;
        const conditions = input.conditions ?? existing.conditions;
        const target = parseRuleTarget(effect, input.target !== undefined ? input.target : existing.target);
        const template = await loadOrThrow(tx, articleId);
        validateRuleInput(toEngineTemplate(template), effect, conditions, target);
        return repo.updateRule(tx, ruleId, {
          effect, conditions, target, message: input.message ?? existing.message, active: input.active ?? existing.active,
        });
      });
    },

    async deleteRule(articleId: string, ruleId: string): Promise<void> {
      await write(articleId, async (tx) => {
        if (!(await repo.deleteRule(tx, articleId, ruleId))) throw new ConfiguratorRuleNotFoundError();
      });
    },

    async reorderRules(articleId: string, ids: string[]): Promise<void> {
      await write(articleId, (tx) => reorder(articleId, "rules", articleId, ids, tx));
    },

    // --- structure lines (villkorade strukturrader) ---

    async createBomLine(articleId: string, input: CreateConfiguratorBomLineInput): Promise<ConfiguratorBomLineDetail> {
      return write(articleId, async (tx) => {
        const template = await loadOrThrow(tx, articleId);
        const line = lineFields(null, input);
        await validateLine(tx, articleId, template, line);
        const sortOrder = (await repo.maxSortOrder(tx, "bomLines", articleId)) + 1;
        return repo.insertBomLine(tx, articleId, sortOrder, lineWrite(line));
      });
    },

    // Validates the merged line (stored ∪ patch): the update schema is a
    // strict partial, so switching fixed → formula sends both fields.
    async updateBomLine(articleId: string, lineId: string, input: UpdateConfiguratorBomLineInput): Promise<ConfiguratorBomLineDetail> {
      return write(articleId, async (tx) => {
        const existing = await repo.findBomLine(tx, articleId, lineId);
        if (!existing) throw new ConfiguratorLineNotFoundError();
        const template = await loadOrThrow(tx, articleId);
        const line = lineFields(existing, input);
        await validateLine(tx, articleId, template, line);
        return repo.updateBomLine(tx, lineId, lineWrite(line));
      });
    },

    async deleteBomLine(articleId: string, lineId: string): Promise<void> {
      await write(articleId, async (tx) => {
        if (!(await repo.deleteBomLine(tx, articleId, lineId))) throw new ConfiguratorLineNotFoundError();
      });
    },

    async reorderBomLines(articleId: string, ids: string[]): Promise<void> {
      await write(articleId, (tx) => reorder(articleId, "bomLines", articleId, ids, tx));
    },

    // --- conditional operations (villkorade operationer) ---

    async createOperation(articleId: string, input: CreateConfiguratorOperationInput): Promise<ConfiguratorOperationDetail> {
      return mapSequenceTaken(input.sequenceNo, () =>
        write(articleId, async (tx) => {
          const template = await loadOrThrow(tx, articleId);
          const op = await validateOperation(tx, articleId, template, operationFields(null, input), input, null, true);
          return repo.insertOperation(tx, articleId, operationWrite(op));
        })
      );
    },

    async updateOperation(articleId: string, operationId: string, input: UpdateConfiguratorOperationInput): Promise<ConfiguratorOperationDetail> {
      return mapSequenceTaken(input.sequenceNo, () =>
        write(articleId, async (tx) => {
          const existing = await repo.findOperation(tx, articleId, operationId);
          if (!existing) throw new ConfiguratorOperationNotFoundError();
          const template = await loadOrThrow(tx, articleId);
          const merged = operationFields(existing, input);
          const op = await validateOperation(tx, articleId, template, merged, input, operationId, merged.workCenterId !== existing.workCenterId);
          return repo.updateOperation(tx, operationId, operationWrite(op));
        })
      );
    },

    // Lines linked to it become unlinked (ON DELETE set null) — the derivation
    // then treats them as unlinked material.
    async deleteOperation(articleId: string, operationId: string): Promise<void> {
      await write(articleId, async (tx) => {
        if (!(await repo.deleteOperation(tx, articleId, operationId))) throw new ConfiguratorOperationNotFoundError();
      });
    },

    // --- evaluate / derive (no lock: reads) ---

    evaluate,

    // The one derivation: evaluate → deriveStructure → enrich → pre-costing of
    // exactly that structure (null when the configuration is not derivable).
    async derive(
      articleId: string,
      input: { selection: ConfiguratorSelection; customerId?: string; quantity: number }
    ): Promise<ConfiguratorDerivation> {
      const loaded = await loadDerivationInput(db, articleId);
      const customerPrice = await customerPriceFor(articleId, input);
      const { evaluation, effective } = resolveConfiguration(toEngineTemplate(loaded.detail), input.selection, customerPrice);
      const core = deriveStructure({
        template: toEngineTemplate(loaded.detail), evaluation, effective,
        baseBom: loaded.baseBom, baseOperations: loaded.baseOperations, lines: loaded.lines, operations: loaded.operations,
      });

      const labels = await repo.derivationLabels(db, {
        articleIds: [...new Set(core.materials.map((m) => m.componentArticleId))],
        unitIds: [...new Set(core.materials.map((m) => m.unitId).filter((u): u is string => u !== null))],
        workCenterIds: [...new Set(core.operations.map((o) => o.workCenterId))],
      });
      const structure: DerivedStructure = {
        ...core,
        materials: core.materials.map((m) => ({
          ...m,
          articleNumber: labels.articles.get(m.componentArticleId)?.articleNumber ?? "",
          articleName: labels.articles.get(m.componentArticleId)?.name ?? "",
          unitCode: m.unitId ? labels.units.get(m.unitId) ?? null : null,
        })),
        operations: core.operations.map((o) => ({
          ...o,
          workCenterCode: labels.workCenters.get(o.workCenterId)?.code ?? "",
          workCenterName: labels.workCenters.get(o.workCenterId)?.name ?? "",
        })),
      };

      const costing = core.derivable ? await costStructure(articleId, input.quantity, core) : null;
      return { evaluation, structure, costing };
    },

    // What the derivation reads (a plain read, like evaluate).
    loadDerivationInput: (articleId: string) => loadDerivationInput(db, articleId),

    // --- stocked variants (lagerförda varianter) ---

    // The template's variants with their stock on hand, by article number.
    async listVariants(articleId: string): Promise<VariantListRow[]> {
      await loadOrThrow(db, articleId);
      const variants = await repo.variantsOfTemplate(db, articleId);
      const onHand = new Map<string, number>();
      for (const b of await deps.stock.balancesForArticles(variants.map((v) => v.articleId))) {
        onHand.set(b.articleId, (onHand.get(b.articleId) ?? 0) + Number(b.quantityOnHand));
      }
      return variants.map(({ configKey: _key, ...v }) => ({ ...v, onHand: String(round4(onHand.get(v.articleId) ?? 0)) }));
    },

    // One row per combination with its status; nothing is written. A missing
    // article is as "not configurable" as one without a template.
    async previewVariants(articleId: string, input: VariantRequest): Promise<VariantPreviewRow[]> {
      const templateArticle = await repo.templateArticleRow(db, articleId);
      if (!templateArticle) throw new ConfiguratorTemplateNotFoundError();
      return (await planCombinations(db, articleId, templateArticle, input)).map(toPreviewRow);
    },

    // ONE transaction: the template row FOR UPDATE, the template article FOR
    // SHARE, then everything is planned afresh inside it (the preview is
    // never trusted) and every "new" combination becomes an article with the
    // derived route, the merged structure and its link row — all or nothing.
    // The other statuses are reported unchanged.
    async createVariants(articleId: string, input: VariantRequest, userId: string | null): Promise<VariantPreviewRow[]> {
      return mapVariantRace(() =>
        write(articleId, async (tx) => {
          const templateArticle = await lockedTemplateArticle(tx, articleId, "variants");
          const plan = await planCombinations(tx, articleId, templateArticle, input);
          for (const row of plan) {
            if (row.status !== "new") continue;
            const created = await createPlannedVariant(tx, articleId, templateArticle, row, input.calcQuantity, userId);
            row.status = "created";
            row.articleId = created.id;
          }
          return plan.map(toPreviewRow);
        })
      );
    },

    // Konfigurera på orderraden (4a): fetch-or-create ONE variant for a selection.
    // Same lock, same plan and same writers as createVariants; the calc quantity
    // is the template's order quantity (never the row's), so the variant's
    // standard cost does not depend on which order happened to create it.
    async resolveVariant(articleId: string, selection: ConfiguratorSelection, userId: string | null): Promise<ResolveVariantResult> {
      const outcome = await mapVariantRace(() =>
        write(articleId, async (tx) => {
          const templateArticle = await lockedTemplateArticle(tx, articleId, "variants");
          const calcQuantity = templateArticle.orderQuantity !== null ? Number(templateArticle.orderQuantity) : 1;
          const [row] = await planCombinations(tx, articleId, templateArticle, { sets: setsFromSelection(selection), calcQuantity });
          // One value per group always expands to exactly one combination.
          if (!row) throw new ConfiguratorInvalidConfigurationError([]);
          switch (row.status) {
            case "exists":
              return { articleId: row.articleId!, created: false };
            case "new": {
              const created = await createPlannedVariant(tx, articleId, templateArticle, row, calcQuantity, userId);
              return { articleId: created.id, created: true };
            }
            case "invalid":
              // Only the engine's messages leave as details; the derivation's
              // (structure lines, operations) stay in Nav — see the error class.
              if (row.notDerivable) throw new ConfiguratorVariantNotDerivableError();
              throw new ConfiguratorInvalidConfigurationError(row.errors);
            case "number_taken":
              throw new ConfiguratorVariantNumberTakenError(row.articleNumber!);
            case "too_long":
              throw new ConfiguratorVariantTooLongError(row.errors[0] ?? "Artikelnumret eller benämningen blir för lång");
            default:
              throw new ConfiguratorInvalidConfigurationError(row.errors);
          }
        })
      );
      const article = await deps.articles.find(outcome.articleId);
      if (!article) throw new ArticleNotFoundError(outcome.articleId);
      return { article, created: outcome.created };
    },

    async getVariantOf(articleId: string): Promise<VariantOf> {
      const row = await repo.variantOf(db, articleId);
      if (!row) throw new ConfiguratorVariantNotFoundError();
      return row;
    },

    // Ändra konfiguration on a variant row: which template the row's article
    // came from and the variant's key (null = plain article, never a 404).
    async findVariantOf(articleId: string): Promise<{ templateArticleId: string; configKey: string } | null> {
      const row = await repo.variantOf(db, articleId);
      return row ? { templateArticleId: row.templateArticleId, configKey: row.configKey } : null;
    },

    // Konfigurator 4b: a beställningsvara row's configuration — the template in
    // to_order, the customer's chain on the template (as evaluate) and the same
    // selection builder as a variant's stored selection. Pure evaluation: nothing
    // is written; the sales service stores the result on the row.
    async evaluateRowConfiguration(
      templateArticleId: string, selection: ConfiguratorSelection, opts: { customerId: string; quantity: number }
    ): Promise<RowConfigurationEvaluation> {
      const detail = await loadOrThrow(db, templateArticleId);
      if (detail.mode !== "to_order") throw new ConfiguratorNotToOrderModeError();
      const template = toEngineTemplate(detail);
      const { evaluation, effective } = resolveConfiguration(template, selection, await customerPriceFor(templateArticleId, opts));
      if (!evaluation.valid || evaluation.key === null) {
        return { valid: false, errors: [...evaluation.errors, ...evaluation.groups.flatMap((g) => g.errors)], configuration: null, cost: null };
      }
      // Konfigurator 4c: the row's förkalkyl at the row quantity (TVK/SVK per
      // unit) — null when the structure is not derivable or carries no cost.
      const structure = await deriveForManufacturing(templateArticleId, selection, opts.quantity);
      const cost: OrderRowConfigurationCost | null =
        structure.valid && structure.cost
          ? { ...structure.cost, quantity: opts.quantity, calculatedAt: new Date().toISOString() }
          : null;
      return {
        valid: true, errors: [],
        configuration: {
          templateArticleId, key: evaluation.key, selection: selectionEntries(template, effective),
          price: {
            base: evaluation.price.base, additions: evaluation.price.additions, unitPrice: evaluation.price.unitPrice,
            discountPercent: evaluation.price.discountPercent, source: evaluation.price.source,
          },
        },
        cost,
      };
    },

    // Konfigurator 4c: see the local deriveForManufacturing above.
    deriveForManufacturing,

    // Konfigurator 4a (beslut C): the variant's price through the template —
    // the customer's chain on the TEMPLATE (deps.prices, which has no variant
    // step of its own) plus the stored configuration's additions. undefined: not
    // a variant; null: the stored selection no longer validates or the template
    // has no base price — resolvePrice then continues down the variant's own chain.
    async variantPrice(q: { customerId: string; variantArticleId: string; quantity: number }): Promise<ResolvedPrice | null | undefined> {
      const link = await repo.variantOf(db, q.variantArticleId);
      if (!link) return undefined;
      const detail = await repo.loadTemplate(db, link.templateArticleId);
      if (!detail) return null;
      const templatePrice = await deps.prices({ customerId: q.customerId, articleId: link.templateArticleId, quantity: q.quantity });
      const { evaluation } = resolveConfiguration(toEngineTemplate(detail), selectionFromEntries(link.selection), templatePrice?.price ?? null);
      if (!evaluation.valid || evaluation.price.unitPrice === null || evaluation.price.source === null) return null;
      return { unitPrice: evaluation.price.unitPrice, discountPercent: evaluation.price.discountPercent, source: evaluation.price.source };
    },
  };
}

export type ConfiguratorService = ReturnType<typeof createConfiguratorService>;
