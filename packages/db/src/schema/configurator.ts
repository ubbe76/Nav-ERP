// packages/db/src/schema/configurator.ts
import { sql } from "drizzle-orm";
import {
  boolean, check, index, integer, jsonb, numeric, pgEnum, pgTable, timestamp, unique, uniqueIndex, uuid, varchar, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { articles } from "./article";
import { users } from "./auth";
import { routingOperations, workCenters } from "./manufacturing";

// Produktkonfigurator (delprojekt 1): a configurable article (mall) with
// option groups (valgrupper), their alternatives and rules. Pricing uses the
// article's own sales_price as grundpris — no second base price here.
export const configuratorModeEnum = pgEnum("configurator_mode", ["variants", "to_order"]);
export const configuratorGroupKindEnum = pgEnum("configurator_group_kind", ["choice", "boolean", "number"]);
export const configuratorArticleFieldEnum = pgEnum("configurator_article_field", ["colour", "surface_treatment"]);
export const configuratorRuleEffectEnum = pgEnum("configurator_rule_effect", ["exclude", "require", "limit"]);
export const configuratorLineSourceEnum = pgEnum("configurator_line_source", ["article", "group"]);

export const configuratorTemplates = pgTable("configurator_templates", {
  articleId: uuid("article_id")
    .primaryKey()
    .references(() => articles.id, { onDelete: "restrict" }),
  mode: configuratorModeEnum("mode").notNull(),
  // Delprojekt 5: Visa i API — only published templates on active articles
  // are visible to an OAuth client (the external configurator).
  published: boolean("published").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const configuratorGroups = pgTable(
  "configurator_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => configuratorTemplates.articleId, { onDelete: "cascade" }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    kind: configuratorGroupKindEnum("kind").notNull(),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull(),
    // boolean only: tillägg när valt
    priceAdd: numeric("price_add", { precision: 14, scale: 2 }).notNull().default("0"),
    // choice only: förvalt alternativ (set null when the value is deleted)
    defaultValueId: uuid("default_value_id").references((): AnyPgColumn => configuratorValues.id, { onDelete: "set null" }),
    // number only
    unit: varchar("unit", { length: 20 }),
    minValue: numeric("min_value", { precision: 14, scale: 4 }),
    maxValue: numeric("max_value", { precision: 14, scale: 4 }),
    step: numeric("step", { precision: 14, scale: 4 }),
    defaultNumber: numeric("default_number", { precision: 14, scale: 4 }),
    pricePerUnit: numeric("price_per_unit", { precision: 14, scale: 4 }).notNull().default("0"),
    priceBaseValue: numeric("price_base_value", { precision: 14, scale: 4 }).notNull().default("0"),
    // choice only: the article field (Färg/Ytbehandling) this group fills on a variant article.
    articleField: configuratorArticleFieldEnum("article_field"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("configurator_groups_article_code_unique").on(table.articleId, table.code),
    index("configurator_groups_default_value_idx").on(table.defaultValueId),
    check("configurator_groups_code_format", sql`${table.code} ~ '^[A-Z0-9]{1,20}$'`),
    check(
      "configurator_groups_number_fields",
      sql`(${table.kind} = 'number') = (${table.minValue} is not null and ${table.maxValue} is not null)
          and (${table.kind} = 'number' or (${table.unit} is null and ${table.step} is null and ${table.defaultNumber} is null
               and ${table.pricePerUnit} = 0 and ${table.priceBaseValue} = 0))`
    ),
    check("configurator_groups_min_max", sql`${table.minValue} is null or ${table.minValue} <= ${table.maxValue}`),
    check("configurator_groups_step_positive", sql`${table.step} is null or ${table.step} > 0`),
    check("configurator_groups_price_per_unit", sql`${table.pricePerUnit} >= 0`),
    check("configurator_groups_boolean_price", sql`${table.kind} = 'boolean' or ${table.priceAdd} = 0`),
    check("configurator_groups_choice_default", sql`${table.kind} = 'choice' or ${table.defaultValueId} is null`),
    check("configurator_groups_article_field_choice", sql`${table.articleField} is null or ${table.kind} = 'choice'`),
    uniqueIndex("configurator_groups_article_field_unique")
      .on(table.articleId, table.articleField)
      .where(sql`${table.articleField} is not null`),
    check("configurator_groups_required", sql`${table.kind} <> 'boolean' or not ${table.required}`),
  ]
);

export const configuratorValues = pgTable(
  "configurator_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => configuratorGroups.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    priceAdd: numeric("price_add", { precision: 14, scale: 2 }).notNull().default("0"),
    sortOrder: integer("sort_order").notNull(),
    active: boolean("active").notNull().default(true),
    // The article this alternative stands for ("komponent från val").
    articleId: uuid("article_id").references(() => articles.id, { onDelete: "restrict" }),
  },
  (table) => [
    unique("configurator_values_group_code_unique").on(table.groupId, table.code),
    check("configurator_values_code_format", sql`${table.code} ~ '^[A-Z0-9]{1,20}$'`),
  ]
);

export const configuratorRules = pgTable(
  "configurator_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => configuratorTemplates.articleId, { onDelete: "cascade" }),
    effect: configuratorRuleEffectEnum("effect").notNull(),
    // ConfiguratorCondition[] / target per effect — shape validated by zod in
    // @navet/shared and against the template on save (configurator-rules.ts).
    conditions: jsonb("conditions").notNull(),
    target: jsonb("target").notNull(),
    message: varchar("message", { length: 255 }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (table) => [index("configurator_rules_article_idx").on(table.articleId)]
);

// Conditional operations (villkorade operationer) added to the template's
// routing when all conditions hold.
export const configuratorOperations = pgTable(
  "configurator_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => configuratorTemplates.articleId, { onDelete: "cascade" }),
    sequenceNo: integer("sequence_no").notNull(),
    conditions: jsonb("conditions").notNull().default(sql`'[]'::jsonb`),
    workCenterId: uuid("work_center_id")
      .notNull()
      .references(() => workCenters.id, { onDelete: "restrict" }),
    description: varchar("description", { length: 255 }),
    setupTime: numeric("setup_time", { precision: 10, scale: 2 }),
    setupFormula: varchar("setup_formula", { length: 500 }),
    runTimePerUnit: numeric("run_time_per_unit", { precision: 10, scale: 4 }),
    runFormula: varchar("run_formula", { length: 500 }),
    // Lego (subcontract resource) pricing, as routing_operations.setup_price/unit_price; null = unpriced.
    setupPrice: numeric("setup_price", { precision: 14, scale: 2 }),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
  },
  (table) => [
    uniqueIndex("configurator_operations_article_sequence_unique").on(table.articleId, table.sequenceNo),
    index("configurator_operations_article_idx").on(table.articleId),
    check("configurator_operations_setup_one", sql`(${table.setupTime} is null) <> (${table.setupFormula} is null)`),
    check("configurator_operations_run_one", sql`(${table.runTimePerUnit} is null) <> (${table.runFormula} is null)`),
    check("configurator_operations_times_nonnegative", sql`coalesce(${table.setupTime}, 0) >= 0 and coalesce(${table.runTimePerUnit}, 0) >= 0`),
    check("configurator_operations_prices_nonnegative", sql`coalesce(${table.setupPrice}, 0) >= 0 and coalesce(${table.unitPrice}, 0) >= 0`),
  ]
);

// Conditional BOM lines (villkorade strukturrader): component is a fixed
// article or the article of the chosen alternative in a choice group.
export const configuratorBomLines = pgTable(
  "configurator_bom_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => configuratorTemplates.articleId, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
    conditions: jsonb("conditions").notNull().default(sql`'[]'::jsonb`),
    source: configuratorLineSourceEnum("source").notNull(),
    componentArticleId: uuid("component_article_id").references(() => articles.id, { onDelete: "restrict" }),
    // NO ACTION on purpose: deleting a template cascades groups and lines in one statement.
    componentGroupId: uuid("component_group_id").references(() => configuratorGroups.id),
    quantity: numeric("quantity", { precision: 14, scale: 4 }),
    quantityFormula: varchar("quantity_formula", { length: 500 }),
    routingOperationId: uuid("routing_operation_id").references(() => routingOperations.id, { onDelete: "set null" }),
    configuratorOperationId: uuid("configurator_operation_id").references(() => configuratorOperations.id, { onDelete: "set null" }),
    note: varchar("note", { length: 255 }),
  },
  (table) => [
    index("configurator_bom_lines_article_idx").on(table.articleId),
    check("configurator_bom_lines_article_source", sql`(${table.source} = 'article') = (${table.componentArticleId} is not null)`),
    check("configurator_bom_lines_group_source", sql`(${table.source} = 'group') = (${table.componentGroupId} is not null)`),
    check("configurator_bom_lines_quantity_one", sql`(${table.quantity} is null) <> (${table.quantityFormula} is null)`),
    check("configurator_bom_lines_quantity_positive", sql`${table.quantity} is null or ${table.quantity} > 0`),
    check(
      "configurator_bom_lines_one_operation",
      sql`${table.routingOperationId} is null or ${table.configuratorOperationId} is null`
    ),
  ]
);

// Stocked variants (delprojekt 3): one row per generated variant article.
// selection is a VariantSelectionEntry[] snapshot; config_key the canonical
// key of the choices, unique per template.
export const configuratorVariants = pgTable(
  "configurator_variants",
  {
    articleId: uuid("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "restrict" }),
    templateArticleId: uuid("template_article_id")
      .notNull()
      .references(() => configuratorTemplates.articleId, { onDelete: "restrict" }),
    configKey: varchar("config_key", { length: 1000 }).notNull(),
    selection: jsonb("selection").notNull(), // VariantSelectionEntry[]
    calcQuantity: numeric("calc_quantity", { precision: 14, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("configurator_variants_template_key_unique").on(t.templateArticleId, t.configKey),
    index("configurator_variants_template_idx").on(t.templateArticleId),
  ]
);
