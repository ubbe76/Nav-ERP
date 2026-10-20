// packages/shared/src/configurator.ts
import { z } from "zod";
import { listQuerySchema } from "./list.js";
import type { PriceSource } from "./sales.js";

export const configuratorCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{1,20}$/, "Kod: 1–20 tecken A–Z och 0–9");
export const configuratorModeSchema = z.enum(["variants", "to_order"]);
export const configuratorGroupKindSchema = z.enum([
  "choice",
  "boolean",
  "number",
]);
export const configuratorRuleEffectSchema = z.enum([
  "exclude",
  "require",
  "limit",
]);
export type ConfiguratorMode = z.infer<typeof configuratorModeSchema>;
export type ConfiguratorGroupKind = z.infer<typeof configuratorGroupKindSchema>;
export const configuratorArticleFieldSchema = z.enum(["colour", "surface_treatment"]);
export type ConfiguratorArticleField = z.infer<typeof configuratorArticleFieldSchema>;
export type ConfiguratorRuleEffect = z.infer<
  typeof configuratorRuleEffectSchema
>;

const amount = z.coerce.number().finite();
const number2 = z.coerce
  .number()
  .finite()
  .refine((v) => Number(v.toFixed(2)) === v, "Högst 2 decimaler");
const number4 = z.coerce
  .number()
  .finite()
  // Exact: an absolute tolerance on v×10⁴ misjudges large numbers.
  .refine((v) => Number(v.toFixed(4)) === v, "Högst 4 decimaler");

// Strict throughout: a target shaped for another effect must fail, never be
// silently stripped into a valid shape (that would invert a rule's meaning).
export const configuratorConditionSchema = z.union([
  z
    .object({
      groupId: z.string().uuid(),
      op: z.enum(["is", "is_not"]),
      valueIds: z.array(z.string().uuid()).min(1),
    })
    .strict(),
  z
    .object({
      groupId: z.string().uuid(),
      op: z.enum(["selected", "not_selected"]),
    })
    .strict(),
  z
    .object({
      groupId: z.string().uuid(),
      op: z.enum(["eq", "ne", "lt", "le", "gt", "ge"]),
      value: number4,
    })
    .strict(),
]);
export type ConfiguratorCondition = z.infer<typeof configuratorConditionSchema>;

export const configuratorExcludeTargetSchema = z
  .object({
    groupId: z.string().uuid(),
    valueIds: z.array(z.string().uuid()).min(1),
  })
  .strict();
export const configuratorLimitTargetSchema = z
  .object({
    groupId: z.string().uuid(),
    min: number4.optional(),
    max: number4.optional(),
  })
  .strict()
  .refine(
    (t) => t.min !== undefined || t.max !== undefined,
    "Ange min eller max",
  )
  .refine(
    (t) => t.min === undefined || t.max === undefined || t.min <= t.max,
    "Min får inte vara större än max",
  );
export type ConfiguratorRuleTarget =
  | z.infer<typeof configuratorExcludeTargetSchema>
  | ConfiguratorCondition
  | z.infer<typeof configuratorLimitTargetSchema>;

// Delprojekt 5: `published` = Visa i API (off by default; changeable in every mode).
export const createConfiguratorTemplateSchema = z.object({
  mode: configuratorModeSchema,
  published: z.boolean().optional(),
});
export const updateConfiguratorTemplateSchema = z
  .object({
    mode: configuratorModeSchema.optional(),
    published: z.boolean().optional(),
  })
  .refine((v) => v.mode !== undefined || v.published !== undefined, "Ange läge eller Visa i API");

const groupBase = {
  code: configuratorCodeSchema,
  name: z.string().trim().min(1).max(100),
};
export const createConfiguratorGroupSchema = z
  .discriminatedUnion("kind", [
    z.object({
      ...groupBase,
      kind: z.literal("choice"),
      required: z.boolean().default(false),
      articleField: configuratorArticleFieldSchema.nullable().optional(),
    }),
    z.object({
      ...groupBase,
      kind: z.literal("boolean"),
      priceAdd: amount.default(0),
    }),
    z.object({
      ...groupBase,
      kind: z.literal("number"),
      required: z.boolean().default(false),
      unit: z.string().trim().max(20).nullable().default(null),
      minValue: number4,
      maxValue: number4,
      step: number4
        .refine((v) => v > 0, "Måste vara större än 0")
        .nullable()
        .default(null),
      defaultNumber: number4.nullable().default(null),
      pricePerUnit: number4
        .refine((v) => v >= 0, "Får inte vara negativt")
        .default(0),
      priceBaseValue: number4.default(0),
    }),
  ])
  .superRefine((g, ctx) => {
    if (g.kind !== "number") return;
    if (g.minValue > g.maxValue)
      ctx.addIssue({
        code: "custom",
        path: ["minValue"],
        message: "Min får inte vara större än max",
      });
    if (
      g.defaultNumber !== null &&
      (g.defaultNumber < g.minValue || g.defaultNumber > g.maxValue)
    )
      ctx.addIssue({
        code: "custom",
        path: ["defaultNumber"],
        message: "Förvalet ska ligga inom intervallet",
      });
  });
// Update: every field optional, kind never changes. Fields that do not belong
// to the group's kind are rejected by the service (InvalidConfiguratorGroupError).
export const updateConfiguratorGroupSchema = z
  .object({
    code: configuratorCodeSchema,
    name: z.string().trim().min(1).max(100),
    required: z.boolean(),
    priceAdd: amount,
    defaultValueId: z.string().uuid().nullable(),
    articleField: configuratorArticleFieldSchema.nullable(),
    unit: z.string().trim().max(20).nullable(),
    minValue: number4,
    maxValue: number4,
    step: number4.refine((v) => v > 0, "Måste vara större än 0").nullable(),
    defaultNumber: number4.nullable(),
    pricePerUnit: number4.refine((v) => v >= 0, "Får inte vara negativt"),
    priceBaseValue: number4,
  })
  .partial()
  .strict();

export const createConfiguratorValueSchema = z.object({
  code: configuratorCodeSchema,
  name: z.string().trim().min(1).max(100),
  priceAdd: amount.default(0),
  active: z.boolean().default(true),
  articleId: z.string().uuid().nullable().optional(),
});
export const updateConfiguratorValueSchema = createConfiguratorValueSchema
  .partial()
  .strict();

export const createConfiguratorRuleSchema = z.object({
  effect: configuratorRuleEffectSchema,
  conditions: z.array(configuratorConditionSchema).max(20),
  target: z.unknown(), // parsed per effect by parseRuleTarget below
  message: z.string().trim().min(1).max(255),
  active: z.boolean().default(true),
});
export const updateConfiguratorRuleSchema = createConfiguratorRuleSchema
  .partial()
  .strict();

export function parseRuleTarget(
  effect: ConfiguratorRuleEffect,
  target: unknown,
): ConfiguratorRuleTarget {
  if (effect === "exclude")
    return configuratorExcludeTargetSchema.parse(target);
  if (effect === "limit") return configuratorLimitTargetSchema.parse(target);
  return configuratorConditionSchema.parse(target);
}

export const configuratorLineSourceSchema = z.enum(["article", "group"]);
export type ConfiguratorLineSource = z.infer<typeof configuratorLineSourceSchema>;

const formulaText = z.string().trim().min(1).max(500);
const conditionList = z.array(configuratorConditionSchema).max(20);

// Conditional BOM line (villkorad strukturrad). Create is refined as a whole;
// update is a strict partial and the service validates the merged row.
const bomLineFields = {
  source: configuratorLineSourceSchema,
  componentArticleId: z.string().uuid().nullable().optional(),
  componentGroupId: z.string().uuid().nullable().optional(),
  quantity: number4.refine((v) => v > 0, "Måste vara större än 0").nullable().optional(),
  quantityFormula: formulaText.nullable().optional(),
  routingOperationId: z.string().uuid().nullable().optional(),
  configuratorOperationId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(255).nullable().optional(),
};
export const createConfiguratorBomLineSchema = z
  .object({ conditions: conditionList.default([]), ...bomLineFields })
  .superRefine((l, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (l.source === "article") {
      if (!l.componentArticleId) issue("componentArticleId", "Ange komponentartikel");
      if (l.componentGroupId) issue("componentGroupId", "Källan Artikel tar ingen grupp");
    } else {
      if (!l.componentGroupId) issue("componentGroupId", "Ange valgrupp");
      if (l.componentArticleId) issue("componentArticleId", "Källan Från val tar ingen artikel");
    }
    const hasQuantity = l.quantity != null;
    const hasFormula = l.quantityFormula != null;
    if (hasQuantity === hasFormula) issue("quantity", "Ange antingen fast antal eller formel");
    if (l.routingOperationId && l.configuratorOperationId)
      issue("configuratorOperationId", "Högst en operationskoppling");
  });
export const updateConfiguratorBomLineSchema = z
  .object({ conditions: conditionList, ...bomLineFields })
  .partial()
  .strict();

// Conditional operation (villkorad operation).
const operationFields = {
  sequenceNo: z.coerce.number().int().min(1).max(9999),
  workCenterId: z.string().uuid(),
  description: z.string().trim().max(255).nullable().optional(),
  setupTime: number2.refine((v) => v >= 0, "Får inte vara negativt").nullable().optional(),
  setupFormula: formulaText.nullable().optional(),
  runTimePerUnit: number4.refine((v) => v >= 0, "Får inte vara negativt").nullable().optional(),
  runFormula: formulaText.nullable().optional(),
  // Lego pricing (subcontract resources), like routing_operations.setup_price/unit_price; null clears.
  setupPrice: number2.refine((v) => v >= 0, "Får inte vara negativt").nullable().optional(),
  unitPrice: number4.refine((v) => v >= 0, "Får inte vara negativt").nullable().optional(),
};
export const createConfiguratorOperationSchema = z
  .object({ conditions: conditionList.default([]), ...operationFields })
  .superRefine((o, ctx) => {
    if ((o.setupTime != null) === (o.setupFormula != null))
      ctx.addIssue({ code: "custom", path: ["setupTime"], message: "Ange antingen fast ställtid eller formel" });
    if ((o.runTimePerUnit != null) === (o.runFormula != null))
      ctx.addIssue({ code: "custom", path: ["runTimePerUnit"], message: "Ange antingen fast stycktid eller formel" });
  });
export const updateConfiguratorOperationSchema = z
  .object({ conditions: conditionList, ...operationFields })
  .partial()
  .strict();

export const configuratorReorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

// A missing key = the group's default; `null` = deliberately empty (delprojekt
// 5: the external API and — Välj — clear a default with it).
export const configuratorSelectionSchema = z.record(
  z.string().max(20),
  z.union([z.string().max(20), z.boolean(), z.number().finite(), z.null()]),
);
export type ConfiguratorSelection = z.infer<typeof configuratorSelectionSchema>;
export const evaluateConfigurationSchema = z.object({
  selection: configuratorSelectionSchema.default({}),
  customerId: z.string().uuid().optional(),
  quantity: z.coerce.number().positive().default(1),
});

// Derivation takes the same body as evaluate (selection, customer, quantity).
export const deriveConfigurationSchema = evaluateConfigurationSchema;

export type ConfiguratorEvaluationGroup = {
  code: string;
  kind: ConfiguratorGroupKind;
  value: string | boolean | number | null;
  defaulted: boolean;
  availableValueCodes?: string[];
  min?: number;
  max?: number;
  errors: string[];
};
export type ConfiguratorEvaluation = {
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
};

export type ConfiguratorValueDetail = {
  id: string;
  code: string;
  name: string;
  priceAdd: string;
  sortOrder: number;
  active: boolean;
  articleId: string | null;
  articleNumber: string | null;
  articleName: string | null;
};
export type ConfiguratorGroupDetail = {
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
};
export type ConfiguratorRuleDetail = {
  id: string;
  effect: ConfiguratorRuleEffect;
  conditions: ConfiguratorCondition[];
  target: ConfiguratorRuleTarget;
  message: string;
  sortOrder: number;
  active: boolean;
};
export type ConfiguratorBomLineDetail = {
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
  // Sequence number of the linked operation (routing or conditional), if any.
  operationSequenceNo: number | null;
  note: string | null;
};
export type ConfiguratorOperationDetail = {
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
};
export type ConfiguratorTemplateDetail = {
  articleId: string;
  mode: ConfiguratorMode;
  published: boolean;
  basePrice: string | null;
  groups: ConfiguratorGroupDetail[];
  rules: ConfiguratorRuleDetail[];
  bomLines: ConfiguratorBomLineDetail[];
  operations: ConfiguratorOperationDetail[];
};
// GET /articles/:id/configurator — the template plus its täckningsvarningar: alternatives that a family of
// structure lines (one line per alternative) leaves uncovered (structure-coverage.ts).
export type ConfiguratorTemplateView = ConfiguratorTemplateDetail & { structureWarnings: string[] };

// Delprojekt 5: what the external configurator (OAuth client or session) is
// shown of a template — customer-safe only. Never rules, structure lines,
// operations, article links, article fields, internal ids or costs; numbers
// are numbers. Built by the pure mappers in the configurator module.
export const listPublicTemplatesQuerySchema = listQuerySchema;
export type PublicTemplateGroupSummary = { code: string; name: string; kind: ConfiguratorGroupKind; required: boolean };
export type PublicTemplateSummary = {
  articleId: string;
  articleNumber: string;
  name: string;
  mode: ConfiguratorMode;
  basePrice: number | null;
  groups: PublicTemplateGroupSummary[];
};
export type PublicTemplateGroup = PublicTemplateGroupSummary & {
  unit: string | null;
  min: number | null;
  max: number | null;
  step: number | null;
  // The alternative's code (choice), true/false (boolean) or a number (number); null = no default.
  default: string | boolean | number | null;
  priceAdd: number;
  pricePerUnit: number;
  priceBaseValue: number;
  values: { code: string; name: string; priceAdd: number }[];
};
export type PublicTemplate = Omit<PublicTemplateSummary, "groups"> & { groups: PublicTemplateGroup[] };

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
  setupPrice: number | null; // lego operations (subcontract resource); null = unpriced
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
  manufacturingCost: number; // TVK = materialCost + operationCost + markups
  manufacturingCostPerUnit: number;
  selfCost: number; // SVK = tillverkningskostnad + Affo (no general markup, no TO) — margin.ts's basis
  selfCostPerUnit: number;
  warnings: string[];
};
export type ConfiguratorDerivation = {
  evaluation: ConfiguratorEvaluation;
  structure: DerivedStructure;
  costing: DerivedCosting | null;
};

// Service inputs (the parsed bodies the routes hand to the service).
export type CreateConfiguratorTemplateInput = z.infer<typeof createConfiguratorTemplateSchema>;
export type UpdateConfiguratorTemplateInput = z.infer<typeof updateConfiguratorTemplateSchema>;
export type CreateConfiguratorGroupInput = z.infer<typeof createConfiguratorGroupSchema>;
export type UpdateConfiguratorGroupInput = z.infer<typeof updateConfiguratorGroupSchema>;
export type CreateConfiguratorValueInput = z.infer<typeof createConfiguratorValueSchema>;
export type UpdateConfiguratorValueInput = z.infer<typeof updateConfiguratorValueSchema>;
export type CreateConfiguratorRuleInput = z.infer<typeof createConfiguratorRuleSchema>;
export type UpdateConfiguratorRuleInput = z.infer<typeof updateConfiguratorRuleSchema>;
export type EvaluateConfigurationInput = z.infer<typeof evaluateConfigurationSchema>;
export type CreateConfiguratorBomLineInput = z.infer<typeof createConfiguratorBomLineSchema>;
export type UpdateConfiguratorBomLineInput = z.infer<typeof updateConfiguratorBomLineSchema>;
export type CreateConfiguratorOperationInput = z.infer<typeof createConfiguratorOperationSchema>;
export type UpdateConfiguratorOperationInput = z.infer<typeof updateConfiguratorOperationSchema>;
export type DeriveConfigurationInput = z.infer<typeof deriveConfigurationSchema>;

// --- Stocked variants (delprojekt 3) ---

// A null in a choice/number set is the engine's "deliberately empty" (delprojekt
// 5: Skapa variant passes a cleared default through). A boolean set takes no
// null — the engine reads a cleared boolean as false, so [false, null] would be
// two combinations with one key; the web's checkbox never sends one.
export const variantSetsSchema = z.record(
  z.string().max(20),
  z.union([
    z.array(z.string().max(20).nullable()).min(1).max(200),
    z.array(z.boolean()).min(1).max(2),
    z.array(z.number().finite().nullable()).min(1).max(200),
  ])
);
export const variantRequestSchema = z.object({
  sets: variantSetsSchema.default({}),
  calcQuantity: z.coerce
    .number()
    .positive()
    .refine((n) => Number(n.toFixed(4)) === n, "Högst 4 decimaler"),
});
export type VariantRequest = z.infer<typeof variantRequestSchema>;

// Konfigurera på orderraden (delprojekt 4a): fetch-or-create ONE variant for a
// selection — the same selection shape evaluate takes.
export const resolveVariantSchema = z.object({ selection: configuratorSelectionSchema.default({}) });
export type ResolveVariantInput = z.infer<typeof resolveVariantSchema>;

export type VariantSelectionEntry = {
  groupCode: string;
  groupName: string;
  kind: ConfiguratorGroupKind;
  valueCode: string | null;
  valueName: string | null;
  value: string | boolean | number | null;
  unit: string | null;
};
// Beställningsvara på orderraden (delprojekt 4b): what sales_order_rows.configuration
// (and the invoice row's copy) holds. Self-contained — the template's id is
// repeated so the invoice copy stands on its own, and the labels are frozen
// here so the documents print the same lines after the template changes.
export type OrderRowConfiguration = {
  templateArticleId: string; // = the row's article (the template)
  key: string; // canonicalKey
  selection: VariantSelectionEntry[]; // one entry per group, in group order (same builder as configurator_variants.selection)
  price: {
    base: number | null;
    additions: { groupCode: string; label: string; amount: number }[];
    unitPrice: number | null;
    discountPercent: number;
    // null when the template has no base price and the customer chain gives
    // nothing — valid, the seller then writes the row's own unit price.
    source: PriceSource | null;
  };
};
// Konfigurator 4c: manufacturing_orders.configuration — the TO of a
// beställningsvara. selection is the row's (frozen labels) or, for a free TO,
// the evaluation's own; cost is the förkalkyl of the TO's derived structure
// at the TO quantity, stamped as unit_cost on the TO receipt.
export type ManufacturingOrderConfiguration = {
  templateArticleId: string;
  key: string;
  selection: VariantSelectionEntry[];
  cost: { manufacturingCostPerUnit: number | null; calculatedAt: string };
};
// Konfigurator 4c: sales_order_rows.configuration_cost — the row's
// förkalkyl (SVK and TVK per unit at `quantity`). null figures = unknown, never 0.
export type OrderRowConfigurationCost = {
  selfCostPerUnit: number | null;
  manufacturingCostPerUnit: number | null;
  quantity: number;
  calculatedAt: string;
};
// Per-row input on POST /quotes and POST /sales-orders/:id/rows: only the
// selection — everything else is derived on the server.
export const orderRowConfigurationInputSchema = z.object({ selection: configuratorSelectionSchema.default({}) });
export type OrderRowConfigurationInput = z.infer<typeof orderRowConfigurationInputSchema>;

export type VariantStatus = "new" | "exists" | "invalid" | "number_taken" | "too_long" | "created";
export type VariantPreviewRow = {
  selection: ConfiguratorSelection; // what the engine was given for this combination
  status: VariantStatus;
  articleId: string | null; // exists / created
  articleNumber: string | null; // null only when the configuration is invalid
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
  // The variant's identity key (configurator_variants.config_key) — Ändra
  // konfiguration logs it before/after on the order row.
  configKey: string;
  selection: VariantSelectionEntry[];
  calcQuantity: string;
};
