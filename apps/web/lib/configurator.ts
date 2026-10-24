import type { Article } from "./types";

// Hand-written mirror of packages/shared/src/configurator.ts (the web cannot
// import @navet/shared). apps/api/test/configurator.shared.test.ts guards the
// label maps against the shared enums. Numeric fields arrive as strings.

export type ConfiguratorMode = "variants" | "to_order";
export type ConfiguratorGroupKind = "choice" | "boolean" | "number";
export const CONFIGURATOR_ARTICLE_FIELDS = ["colour", "surface_treatment"] as const;
export type ConfiguratorArticleField = (typeof CONFIGURATOR_ARTICLE_FIELDS)[number];
export type ConfiguratorRuleEffect = "exclude" | "require" | "limit";
// Mirror of priceSourceSchema in packages/shared/src/sales.ts (pinned by
// apps/api/test/configurator.shared.test.ts).
export const PRICE_SOURCES = ["customer_article", "customer_group", "price_list", "customer_discount", "article"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const CONFIGURATOR_MODE_LABELS: Record<ConfiguratorMode, string> = {
  variants: "Variantartiklar",
  to_order: "Beställningsvara",
};
export const CONFIGURATOR_GROUP_KIND_LABELS: Record<ConfiguratorGroupKind, string> = {
  choice: "Listval",
  boolean: "Ja/nej",
  number: "Mått/tal",
};
export const CONFIGURATOR_RULE_EFFECT_LABELS: Record<ConfiguratorRuleEffect, string> = {
  exclude: "Utesluter",
  require: "Kräver",
  limit: "Begränsar",
};
export const CONDITION_OP_LABELS = {
  is: "är",
  is_not: "är inte",
  selected: "är vald",
  not_selected: "är inte vald",
  eq: "=",
  ne: "≠",
  lt: "<",
  le: "≤",
  gt: ">",
  ge: "≥",
} as const;

export type ConfiguratorCondition =
  | { groupId: string; op: "is" | "is_not"; valueIds: string[] }
  | { groupId: string; op: "selected" | "not_selected" }
  | { groupId: string; op: "eq" | "ne" | "lt" | "le" | "gt" | "ge"; value: number };

export type ConfiguratorRuleTarget =
  | { groupId: string; valueIds: string[] }
  | ConfiguratorCondition
  | { groupId: string; min?: number; max?: number };

// Mirror of configuratorLineSourceSchema (pinned by configurator.shared.test.ts).
export const CONFIGURATOR_LINE_SOURCES = ["article", "group"] as const;
export type ConfiguratorLineSource = (typeof CONFIGURATOR_LINE_SOURCES)[number];

// A missing key = the group's default; null = deliberately empty (clears a default).
export type ConfiguratorSelection = Record<string, string | boolean | number | null>;

export interface ConfiguratorEvaluationGroup {
  code: string;
  kind: ConfiguratorGroupKind;
  value: string | boolean | number | null;
  defaulted: boolean;
  availableValueCodes?: string[];
  min?: number;
  max?: number;
  errors: string[];
}
export interface ConfiguratorEvaluation {
  valid: boolean;
  key: string | null;
  groups: ConfiguratorEvaluationGroup[];
  errors: string[];
  price: {
    base: number | null;
    additions: { groupCode: string; label: string; amount: number }[];
    unitPrice: number | null;
    discountPercent: number;
    source: PriceSource | null;
  };
  warnings: string[];
  // Valuta: what the prices are in (set by evaluate/derive; SEK has rate 1).
  currency?: string;
  exchangeRate?: number;
}

export interface ConfiguratorValueDetail {
  id: string;
  code: string;
  name: string;
  priceAdd: string;
  sortOrder: number;
  active: boolean;
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
}
export interface ConfiguratorGroupDetail {
  id: string;
  code: string;
  name: string;
  kind: ConfiguratorGroupKind;
  required: boolean;
  sortOrder: number;
  priceAdd: string;
  defaultValueId: string | null;
  articleField: ConfiguratorArticleField | null;
  unit: string | null;
  minValue: string | null;
  maxValue: string | null;
  step: string | null;
  defaultNumber: string | null;
  pricePerUnit: string;
  priceBaseValue: string;
  values: ConfiguratorValueDetail[];
}
export interface ConfiguratorRuleDetail {
  id: string;
  effect: ConfiguratorRuleEffect;
  conditions: ConfiguratorCondition[];
  target: ConfiguratorRuleTarget;
  message: string;
  sortOrder: number;
  active: boolean;
}
export interface ConfiguratorBomLineDetail {
  id: string;
  sortOrder: number;
  conditions: ConfiguratorCondition[];
  source: ConfiguratorLineSource;
  componentArticleId: string | null;
  componentArticleNumber: string | null;
  componentArticleName: string | null;
  componentGroupId: string | null;
  componentGroupCode: string | null;
  componentGroupName: string | null;
  quantity: string | null;
  quantityFormula: string | null;
  routingOperationId: string | null;
  configuratorOperationId: string | null;
  operationSequenceNo: number | null;
  note: string | null;
}
export interface ConfiguratorOperationDetail {
  id: string;
  sequenceNo: number;
  conditions: ConfiguratorCondition[];
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  description: string | null;
  setupTime: string | null;
  setupFormula: string | null;
  runTimePerUnit: string | null;
  runFormula: string | null;
  setupPrice: string | null;
  unitPrice: string | null;
}
export interface ConfiguratorTemplateDetail {
  articleId: string;
  mode: ConfiguratorMode;
  /** Visa i API: the template is visible to external systems. */
  published: boolean;
  basePrice: string | null;
  groups: ConfiguratorGroupDetail[];
  rules: ConfiguratorRuleDetail[];
  bomLines: ConfiguratorBomLineDetail[];
  operations: ConfiguratorOperationDetail[];
}
/** GET /articles/:id/configurator — plus the täckningsvarningar for the structure lines. */
export type ConfiguratorTemplateView = ConfiguratorTemplateDetail & { structureWarnings: string[] };

// Mirror of the derive response (shared/configurator.ts), guarded by
// configurator.shared.test.ts.
export type DerivedOperationRef = { kind: "base" | "configurator"; id: string; sequenceNo: number };
export type DerivedMaterial = {
  source: "base" | "line";
  lineId: string | null;
  baseRowId: string | null; // bom_components.id for source "base", null for lines
  componentArticleId: string;
  quantity: number;
  unitId: string | null;
  unitFactor: string | null;
  operation: DerivedOperationRef | null;
  articleNumber: string;
  articleName: string;
  unitCode: string | null;
};
export type DerivedOperation = {
  kind: "base" | "configurator";
  id: string;
  sequenceNo: number;
  workCenterId: string;
  description: string | null;
  setupTime: number;
  runTimePerUnit: number;
  costingOnly: boolean;
  setupPrice: number | null;
  unitPrice: number | null;
  workCenterCode: string;
  workCenterName: string;
};
export type DerivedStructure = {
  derivable: boolean;
  materials: DerivedMaterial[];
  operations: DerivedOperation[];
  errors: string[];
  warnings: string[];
};
export type DerivedCosting = {
  quantity: number;
  materialRows: { articleNumber: string; name: string; quantity: number; unitCost: number; total: number }[];
  operationRows: { sequenceNo: number; workCenterName: string; hours: number; total: number }[];
  materialCost: number;
  operationCost: number; // lön + lego, without TO
  markups: number; // MO + LO
  overhead: number; // TO — outside TVK/SVK, added to the sales price last
  materialMarkup: number; // materialpåslag on dM + MO — outside TVK/SVK, sales price only
  manufacturingCost: number;
  manufacturingCostPerUnit: number;
  selfCost: number;
  selfCostPerUnit: number;
  warnings: string[];
};
export type ConfiguratorDerivation = {
  evaluation: ConfiguratorEvaluation;
  structure: DerivedStructure;
  costing: DerivedCosting | null;
};

// --- Stocked variants (mirror of packages/shared/src/configurator.ts) ---

export type VariantSelectionEntry = {
  groupCode: string;
  groupName: string;
  kind: ConfiguratorGroupKind;
  valueCode: string | null;
  valueName: string | null;
  value: string | boolean | number | null;
  unit: string | null;
};
export type VariantStatus = "new" | "exists" | "invalid" | "number_taken" | "too_long" | "created";
export type VariantPreviewRow = {
  selection: ConfiguratorSelection;
  status: VariantStatus;
  articleId: string | null;
  articleNumber: string | null;
  name: string | null;
  salesPrice: number | null;
  standardCost: number | null;
  errors: string[];
  warnings: string[];
};
export type VariantListRow = {
  articleId: string;
  articleNumber: string;
  name: string;
  salesPrice: string | null;
  standardCost: string | null;
  onHand: string;
  active: boolean;
  selection: VariantSelectionEntry[];
};
export type VariantOf = {
  templateArticleId: string;
  templateArticleNumber: string;
  templateName: string;
  configKey: string;
  selection: VariantSelectionEntry[];
  calcQuantity: string;
};

// What ConfigureModal hands a form in to_order mode; lines = draftLines(groups, evaluation).
export type RowConfigurationDraft = { selection: ConfiguratorSelection; evaluation: ConfiguratorEvaluation; lines: string[] };

// Mirror of selectionFromEntries in variant-identity.ts: stored entries back to
// a selection. An empty entry becomes null (deliberately empty), never a
// missing key — otherwise a default added later would come back.
export function selectionFromEntries(entries: VariantSelectionEntry[]): ConfiguratorSelection {
  const selection: ConfiguratorSelection = {};
  for (const e of entries) selection[e.groupCode] = e.value;
  return selection;
}

// Beställningsvara på orderraden (4b): sales_order_rows.configuration / the
// invoice row's copy. Mirror of OrderRowConfiguration in @navet/shared.
export type OrderRowConfiguration = {
  templateArticleId: string;
  key: string;
  selection: VariantSelectionEntry[];
  price: {
    base: number | null;
    additions: { groupCode: string; label: string; amount: number }[];
    unitPrice: number | null;
    discountPercent: number;
    source: PriceSource | null;
  };
};

// POST /configurator/:articleId/variant — fetch or create the variant for a selection.
export type ResolveVariantResult = { article: Article; created: boolean };

// Tillverkningsorder för beställningsvara (4c): manufacturing_orders.configuration.
// Mirror of ManufacturingOrderConfiguration in @navet/shared. cost is null for the
// verkstad profile (price hiding) and when the förkalkyl is missing.
export type ManufacturingOrderConfiguration = {
  templateArticleId: string;
  key: string;
  selection: VariantSelectionEntry[];
  cost: { manufacturingCostPerUnit: number | null; calculatedAt: string };
};
