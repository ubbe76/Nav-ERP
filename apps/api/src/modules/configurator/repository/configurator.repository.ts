import { and, asc, count, eq, ilike, inArray, isNotNull, max, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles, bomComponents, configuratorBomLines, configuratorGroups, configuratorOperations, configuratorRules, configuratorTemplates,
  configuratorValues, configuratorVariants, routingOperations, salesOrderRows, salesOrders, units, workCenters, type Db, type Tx,
} from "@navet/db";
import type {
  ConfiguratorBomLineDetail, ConfiguratorCondition, ConfiguratorGroupDetail, ConfiguratorMode, ConfiguratorOperationDetail,
  ConfiguratorRuleDetail, ConfiguratorRuleEffect, ConfiguratorRuleTarget, ConfiguratorTemplateDetail, ConfiguratorValueDetail,
  ListQuery, OrderRowConfiguration, VariantOf, VariantSelectionEntry,
} from "@navet/shared";
import { ilikePattern } from "@navet/shared";
import { explodeBom } from "../../article/service/bom-explosion.js";
import type { BaseBomRow, BaseOperation } from "../service/configurator-derive.js";
import type { PublicTemplateSummarySource } from "../service/public-template.js";
import type { ExplodeBomRow } from "../service/configurator-explode.js";
import type { TemplateRoutingRow } from "../service/variant-structure.js";

// Produktkonfigurator — data access. Every method takes its executor
// explicitly: the service runs all writes inside one transaction that first
// takes the template row FOR UPDATE (lockTemplate), and reads for evaluate
// run on the plain db. The template's ordinary structure and route
// (bom_components, routing_operations) are only ever READ here.
export type Executor = Db | Tx;

export type SortTable = "groups" | "values" | "rules" | "bomLines";

type GroupRow = typeof configuratorGroups.$inferSelect;
type ValueRow = typeof configuratorValues.$inferSelect;
type RuleRow = typeof configuratorRules.$inferSelect;

export type GroupInsert = Omit<typeof configuratorGroups.$inferInsert, "id" | "createdAt" | "updatedAt">;
export type GroupPatch = Partial<Omit<GroupInsert, "articleId" | "kind" | "sortOrder">>;
export type ValueInsert = Omit<typeof configuratorValues.$inferInsert, "id">;
export type ValuePatch = Partial<Pick<ValueInsert, "code" | "name" | "priceAdd" | "active" | "articleId">>;
export type RuleWrite = {
  effect: ConfiguratorRuleEffect;
  conditions: ConfiguratorCondition[];
  target: ConfiguratorRuleTarget;
  message: string;
  active: boolean;
};
// Full rows (the service always validates and writes the merged row).
export type BomLineWrite = {
  conditions: ConfiguratorCondition[];
  source: "article" | "group";
  componentArticleId: string | null;
  componentGroupId: string | null;
  quantity: string | null;
  quantityFormula: string | null;
  routingOperationId: string | null;
  configuratorOperationId: string | null;
  note: string | null;
};
export type OperationWrite = {
  conditions: ConfiguratorCondition[];
  sequenceNo: number;
  workCenterId: string;
  description: string | null;
  setupTime: string | null;
  setupFormula: string | null;
  runTimePerUnit: string | null;
  runFormula: string | null;
  setupPrice: string | null;
  unitPrice: string | null;
};

type ValueJoin = { value: ValueRow; articleNumber: string | null; articleName: string | null };

function toValueDetail(row: ValueJoin): ConfiguratorValueDetail {
  const v = row.value;
  return {
    id: v.id, code: v.code, name: v.name, priceAdd: v.priceAdd, sortOrder: v.sortOrder, active: v.active,
    articleId: v.articleId, articleNumber: row.articleNumber, articleName: row.articleName,
  };
}

function toGroupDetail(row: GroupRow, values: ValueJoin[]): ConfiguratorGroupDetail {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    required: row.required,
    sortOrder: row.sortOrder,
    priceAdd: row.priceAdd,
    defaultValueId: row.defaultValueId,
    articleField: row.articleField,
    unit: row.unit,
    minValue: row.minValue,
    maxValue: row.maxValue,
    step: row.step,
    defaultNumber: row.defaultNumber,
    pricePerUnit: row.pricePerUnit,
    priceBaseValue: row.priceBaseValue,
    values: values.map(toValueDetail),
  };
}

function toRuleDetail(row: RuleRow): ConfiguratorRuleDetail {
  return {
    id: row.id,
    effect: row.effect,
    conditions: row.conditions as ConfiguratorCondition[],
    target: row.target as ConfiguratorRuleTarget,
    message: row.message,
    sortOrder: row.sortOrder,
    active: row.active,
  };
}

const SORT_TABLES = {
  groups: { table: configuratorGroups, id: configuratorGroups.id, sortOrder: configuratorGroups.sortOrder, scope: configuratorGroups.articleId },
  values: { table: configuratorValues, id: configuratorValues.id, sortOrder: configuratorValues.sortOrder, scope: configuratorValues.groupId },
  rules: { table: configuratorRules, id: configuratorRules.id, sortOrder: configuratorRules.sortOrder, scope: configuratorRules.articleId },
  bomLines: { table: configuratorBomLines, id: configuratorBomLines.id, sortOrder: configuratorBomLines.sortOrder, scope: configuratorBomLines.articleId },
} as const;

// The template article as the variant tables read it (template_article_id → articles).
const templateArticles = alias(articles, "template_articles");

// What a variant row carries about its template and the article it became.
export type VariantRow = {
  articleId: string;
  configKey: string;
  articleNumber: string;
  name: string;
  salesPrice: string | null;
  standardCost: string | null;
  active: boolean;
  selection: VariantSelectionEntry[];
};

// Joins for the line detail: component article, component group and the
// linked operation's number (ordinary route or conditional).
const componentArticles = alias(articles, "component_articles");
const componentGroups = alias(configuratorGroups, "component_groups");
const linkedRouting = alias(routingOperations, "linked_routing");
const linkedOperations = alias(configuratorOperations, "linked_operations");

const BOM_LINE_SELECT = {
  line: configuratorBomLines,
  componentArticleNumber: componentArticles.articleNumber,
  componentArticleName: componentArticles.name,
  componentGroupCode: componentGroups.code,
  componentGroupName: componentGroups.name,
  routingSequenceNo: linkedRouting.sequenceNo,
  operationSequenceNo: linkedOperations.sequenceNo,
};
type BomLineJoin = {
  line: typeof configuratorBomLines.$inferSelect;
  componentArticleNumber: string | null;
  componentArticleName: string | null;
  componentGroupCode: string | null;
  componentGroupName: string | null;
  routingSequenceNo: number | null;
  operationSequenceNo: number | null;
};

function toBomLineDetail(row: BomLineJoin): ConfiguratorBomLineDetail {
  const l = row.line;
  return {
    id: l.id,
    sortOrder: l.sortOrder,
    conditions: l.conditions as ConfiguratorCondition[],
    source: l.source,
    componentArticleId: l.componentArticleId,
    componentArticleNumber: row.componentArticleNumber,
    componentArticleName: row.componentArticleName,
    componentGroupId: l.componentGroupId,
    componentGroupCode: row.componentGroupCode,
    componentGroupName: row.componentGroupName,
    quantity: l.quantity,
    quantityFormula: l.quantityFormula,
    routingOperationId: l.routingOperationId,
    configuratorOperationId: l.configuratorOperationId,
    operationSequenceNo: l.routingOperationId ? row.routingSequenceNo : l.configuratorOperationId ? row.operationSequenceNo : null,
    note: l.note,
  };
}

const OPERATION_SELECT = { op: configuratorOperations, workCenterCode: workCenters.code, workCenterName: workCenters.name };
type OperationJoin = { op: typeof configuratorOperations.$inferSelect; workCenterCode: string; workCenterName: string };

function toOperationDetail(row: OperationJoin): ConfiguratorOperationDetail {
  const o = row.op;
  return {
    id: o.id,
    sequenceNo: o.sequenceNo,
    conditions: o.conditions as ConfiguratorCondition[],
    workCenterId: o.workCenterId,
    workCenterCode: row.workCenterCode,
    workCenterName: row.workCenterName,
    description: o.description,
    setupTime: o.setupTime,
    setupFormula: o.setupFormula,
    runTimePerUnit: o.runTimePerUnit,
    runFormula: o.runFormula,
    setupPrice: o.setupPrice,
    unitPrice: o.unitPrice,
  };
}

export function createConfiguratorRepository() {
  async function valuesOfGroups(ex: Executor, groupIds: string[]): Promise<ValueJoin[]> {
    if (groupIds.length === 0) return [];
    return ex
      .select({ value: configuratorValues, articleNumber: articles.articleNumber, articleName: articles.name })
      .from(configuratorValues)
      .leftJoin(articles, eq(articles.id, configuratorValues.articleId))
      .where(inArray(configuratorValues.groupId, groupIds))
      .orderBy(asc(configuratorValues.sortOrder), asc(configuratorValues.code));
  }

  async function groupDetail(ex: Executor, row: GroupRow): Promise<ConfiguratorGroupDetail> {
    return toGroupDetail(row, await valuesOfGroups(ex, [row.id]));
  }

  function valueQuery(ex: Executor) {
    return ex
      .select({ value: configuratorValues, articleNumber: articles.articleNumber, articleName: articles.name })
      .from(configuratorValues)
      .leftJoin(articles, eq(articles.id, configuratorValues.articleId));
  }

  async function valueDetail(ex: Executor, valueId: string): Promise<ConfiguratorValueDetail | null> {
    const [row] = await valueQuery(ex).where(eq(configuratorValues.id, valueId));
    return row ? toValueDetail(row) : null;
  }

  function bomLineQuery(ex: Executor) {
    return ex
      .select(BOM_LINE_SELECT)
      .from(configuratorBomLines)
      .leftJoin(componentArticles, eq(componentArticles.id, configuratorBomLines.componentArticleId))
      .leftJoin(componentGroups, eq(componentGroups.id, configuratorBomLines.componentGroupId))
      .leftJoin(linkedRouting, eq(linkedRouting.id, configuratorBomLines.routingOperationId))
      .leftJoin(linkedOperations, eq(linkedOperations.id, configuratorBomLines.configuratorOperationId));
  }

  async function listBomLines(ex: Executor, articleId: string): Promise<ConfiguratorBomLineDetail[]> {
    const rows = await bomLineQuery(ex)
      .where(eq(configuratorBomLines.articleId, articleId))
      .orderBy(asc(configuratorBomLines.sortOrder), asc(configuratorBomLines.id));
    return rows.map(toBomLineDetail);
  }

  async function bomLineDetail(ex: Executor, lineId: string): Promise<ConfiguratorBomLineDetail | null> {
    const [row] = await bomLineQuery(ex).where(eq(configuratorBomLines.id, lineId));
    return row ? toBomLineDetail(row) : null;
  }

  function operationQuery(ex: Executor) {
    return ex.select(OPERATION_SELECT).from(configuratorOperations).innerJoin(workCenters, eq(workCenters.id, configuratorOperations.workCenterId));
  }

  async function listOperations(ex: Executor, articleId: string): Promise<ConfiguratorOperationDetail[]> {
    const rows = await operationQuery(ex)
      .where(eq(configuratorOperations.articleId, articleId))
      .orderBy(asc(configuratorOperations.sequenceNo), asc(configuratorOperations.id));
    return rows.map(toOperationDetail);
  }

  async function operationDetail(ex: Executor, operationId: string): Promise<ConfiguratorOperationDetail | null> {
    const [row] = await operationQuery(ex).where(eq(configuratorOperations.id, operationId));
    return row ? toOperationDetail(row) : null;
  }

  return {
    // The serialisation point for every template mutation: a rule save and a
    // concurrent group/alternative delete queue on this row, and the loser
    // re-reads the template after the winner committed (READ COMMITTED).
    async lockTemplate(tx: Tx, articleId: string): Promise<{ articleId: string; mode: ConfiguratorMode } | null> {
      const [row] = await tx
        .select({ articleId: configuratorTemplates.articleId, mode: configuratorTemplates.mode })
        .from(configuratorTemplates)
        .where(eq(configuratorTemplates.articleId, articleId))
        .for("update");
      return row ?? null;
    },

    async loadTemplate(ex: Executor, articleId: string): Promise<ConfiguratorTemplateDetail | null> {
      const [template] = await ex
        .select({
          articleId: configuratorTemplates.articleId, mode: configuratorTemplates.mode, published: configuratorTemplates.published,
          basePrice: articles.salesPrice,
        })
        .from(configuratorTemplates)
        .innerJoin(articles, eq(articles.id, configuratorTemplates.articleId))
        .where(eq(configuratorTemplates.articleId, articleId));
      if (!template) return null;
      const groups = await ex
        .select()
        .from(configuratorGroups)
        .where(eq(configuratorGroups.articleId, articleId))
        .orderBy(asc(configuratorGroups.sortOrder), asc(configuratorGroups.code));
      const values = await valuesOfGroups(ex, groups.map((g) => g.id));
      const rules = await ex
        .select()
        .from(configuratorRules)
        .where(eq(configuratorRules.articleId, articleId))
        .orderBy(asc(configuratorRules.sortOrder), asc(configuratorRules.id));
      return {
        articleId: template.articleId,
        mode: template.mode,
        published: template.published,
        basePrice: template.basePrice,
        groups: groups.map((g) => toGroupDetail(g, values.filter((v) => v.value.groupId === g.id))),
        rules: rules.map(toRuleDetail),
        bomLines: await listBomLines(ex, articleId),
        operations: await listOperations(ex, articleId),
      };
    },

    // The template's article row: what the mode check reads and what a variant
    // inherits (unit, group, location) plus its identity (number, name). With
    // `lock: "share"` the row is read FOR SHARE so a concurrent type/phantom
    // change (which takes it FOR UPDATE) serialises with the template write.
    async templateArticleRow(ex: Executor, articleId: string, lock?: "share") {
      const query = ex
        .select({
          id: articles.id, articleNumber: articles.articleNumber, name: articles.name, type: articles.type, isPhantom: articles.isPhantom,
          unitId: articles.unitId, groupId: articles.groupId, articleCodeId: articles.articleCodeId,
          defaultLocationId: articles.defaultLocationId, orderQuantity: articles.orderQuantity,
        })
        .from(articles)
        .where(eq(articles.id, articleId));
      const [row] = lock ? await query.for("share") : await query;
      return row ?? null;
    },

    // --- the template's ordinary structure and route (read only) ---
    // Per finished unit, base unit — exactly as bom_components stores them.
    async listBaseBom(ex: Executor, articleId: string): Promise<BaseBomRow[]> {
      const rows = await ex
        .select({
          id: bomComponents.id,
          componentArticleId: bomComponents.componentArticleId, quantity: bomComponents.quantity, unitId: bomComponents.unitId,
          unitFactor: bomComponents.unitFactor, routingOperationId: bomComponents.routingOperationId,
        })
        .from(bomComponents)
        .where(eq(bomComponents.parentArticleId, articleId))
        .orderBy(asc(bomComponents.createdAt), asc(bomComponents.id));
      return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
    },
    // Every operation of the route, costing-only ones included (the derivation's
    // consumers decide, as the Kalkyl tab and the release snapshot do today).
    async listBaseRouting(ex: Executor, articleId: string): Promise<BaseOperation[]> {
      const rows = await ex
        .select({
          id: routingOperations.id, sequenceNo: routingOperations.sequenceNo, workCenterId: routingOperations.workCenterId,
          description: routingOperations.description, setupTime: routingOperations.setupTime, runTimePerUnit: routingOperations.runTimePerUnit,
          costingOnly: routingOperations.costingOnly, setupPrice: routingOperations.setupPrice, unitPrice: routingOperations.unitPrice,
        })
        .from(routingOperations)
        .where(eq(routingOperations.articleId, articleId))
        .orderBy(asc(routingOperations.sequenceNo), asc(routingOperations.id));
      return rows.map((r) => ({
        ...r, setupTime: Number(r.setupTime), runTimePerUnit: Number(r.runTimePerUnit),
        setupPrice: r.setupPrice === null ? null : Number(r.setupPrice), unitPrice: r.unitPrice === null ? null : Number(r.unitPrice),
      }));
    },
    // The template's full routing rows — a variant's base operations copy every column of theirs.
    async listTemplateRoutingRows(ex: Executor, articleId: string): Promise<TemplateRoutingRow[]> {
      return ex.select().from(routingOperations).where(eq(routingOperations.articleId, articleId)).orderBy(asc(routingOperations.sequenceNo));
    },
    // Resource type and supplier, for a conditional operation's subcontract_supplier_id default.
    async workCentersForVariants(ex: Executor, ids: string[]): Promise<Map<string, { type: string; supplierId: string | null }>> {
      if (ids.length === 0) return new Map();
      const rows = await ex
        .select({ id: workCenters.id, type: workCenters.type, supplierId: workCenters.supplierId })
        .from(workCenters)
        .where(inArray(workCenters.id, ids));
      return new Map(rows.map((r) => [r.id, { type: r.type, supplierId: r.supplierId }]));
    },
    // Display data for a derived structure: article number/name, unit code, resource code/name.
    async derivationLabels(ex: Executor, ids: { articleIds: string[]; unitIds: string[]; workCenterIds: string[] }) {
      const [arts, unitRows, wcs] = await Promise.all([
        ids.articleIds.length
          ? ex.select({ id: articles.id, articleNumber: articles.articleNumber, name: articles.name }).from(articles).where(inArray(articles.id, ids.articleIds))
          : [],
        ids.unitIds.length ? ex.select({ id: units.id, code: units.code }).from(units).where(inArray(units.id, ids.unitIds)) : [],
        ids.workCenterIds.length
          ? ex.select({ id: workCenters.id, code: workCenters.code, name: workCenters.name }).from(workCenters).where(inArray(workCenters.id, ids.workCenterIds))
          : [],
      ]);
      return {
        articles: new Map(arts.map((a) => [a.id, a])),
        units: new Map(unitRows.map((u) => [u.id, u.code])),
        workCenters: new Map(wcs.map((w) => [w.id, w])),
      };
    },
    // Konfigurator 4c: which of the derived components are phantoms — dissolved
    // into their own structure on a TO, as the costing preview and release do.
    async phantomIds(ex: Executor, ids: string[]): Promise<Set<string>> {
      if (ids.length === 0) return new Set();
      const rows = await ex
        .select({ id: articles.id })
        .from(articles)
        .where(and(inArray(articles.id, ids), eq(articles.isPhantom, true)));
      return new Set(rows.map((r) => r.id));
    },
    // The article module's structure walk (the same one the costing repository
    // wraps) — a phantom component's parts with their quantities multiplied down.
    explodeBom(ex: Executor, articleId: string, quantity: number): Promise<ExplodeBomRow[]> {
      return explodeBom(ex, articleId, quantity);
    },
    async findWorkCenter(ex: Executor, id: string): Promise<{ id: string; active: boolean; type: string } | null> {
      const [row] = await ex
        .select({ id: workCenters.id, active: workCenters.active, type: workCenters.type })
        .from(workCenters)
        .where(eq(workCenters.id, id));
      return row ?? null;
    },

    // --- template ---
    async insertTemplate(ex: Executor, articleId: string, mode: ConfiguratorMode, published = false): Promise<void> {
      await ex.insert(configuratorTemplates).values({ articleId, mode, published });
    },
    async updateTemplate(ex: Executor, articleId: string, patch: { mode?: ConfiguratorMode; published?: boolean }): Promise<void> {
      await ex
        .update(configuratorTemplates)
        .set({
          ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
          ...(patch.published !== undefined ? { published: patch.published } : {}),
          updatedAt: new Date(),
        })
        .where(eq(configuratorTemplates.articleId, articleId));
    },

    // --- the external API (delprojekt 5) ---
    // What the visibility rule reads: the flag, the article's active flag and
    // the article's identity for the public answer. null = not a template.
    async templateVisibility(
      ex: Executor, articleId: string
    ): Promise<{ published: boolean; active: boolean; articleNumber: string; name: string } | null> {
      const [row] = await ex
        .select({ published: configuratorTemplates.published, active: articles.active, articleNumber: articles.articleNumber, name: articles.name })
        .from(configuratorTemplates)
        .innerJoin(articles, eq(articles.id, configuratorTemplates.articleId))
        .where(eq(configuratorTemplates.articleId, articleId));
      return row ?? null;
    },

    // GET /configurator/templates: published templates on active articles,
    // sorted on article number. Rows and count(*) share one where; the page's
    // groups are read in one query (no values, rules, lines or operations).
    async listPublishedTemplates(
      ex: Executor, query: ListQuery
    ): Promise<{ rows: (PublicTemplateSummarySource & { articleNumber: string; name: string })[]; total: number }> {
      const conditions = [eq(configuratorTemplates.published, true), eq(articles.active, true)];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(articles.articleNumber, pattern), ilike(articles.name, pattern))!);
      }
      const where = and(...conditions);
      const [templates, totalRows] = await Promise.all([
        ex
          .select({
            articleId: configuratorTemplates.articleId, mode: configuratorTemplates.mode, basePrice: articles.salesPrice,
            articleNumber: articles.articleNumber, name: articles.name,
          })
          .from(configuratorTemplates)
          .innerJoin(articles, eq(articles.id, configuratorTemplates.articleId))
          .where(where)
          .orderBy(asc(articles.articleNumber))
          .limit(query.limit)
          .offset(query.offset),
        ex
          .select({ total: count() })
          .from(configuratorTemplates)
          .innerJoin(articles, eq(articles.id, configuratorTemplates.articleId))
          .where(where),
      ]);
      const groups =
        templates.length === 0
          ? []
          : await ex
              .select({
                articleId: configuratorGroups.articleId, code: configuratorGroups.code, name: configuratorGroups.name,
                kind: configuratorGroups.kind, required: configuratorGroups.required, sortOrder: configuratorGroups.sortOrder,
              })
              .from(configuratorGroups)
              .where(inArray(configuratorGroups.articleId, templates.map((t) => t.articleId)));
      return {
        rows: templates.map((t) => ({ ...t, groups: groups.filter((g) => g.articleId === t.articleId) })),
        total: totalRows[0]!.total,
      };
    },

    // Templates among `articleIds` an OAuth client may not use: not published,
    // or on an inactive article. Ids that are no template are not in the answer.
    async unpublishedTemplates(ex: Executor, articleIds: string[]): Promise<{ articleId: string; articleNumber: string }[]> {
      if (articleIds.length === 0) return [];
      return ex
        .select({ articleId: configuratorTemplates.articleId, articleNumber: articles.articleNumber })
        .from(configuratorTemplates)
        .innerJoin(articles, eq(articles.id, configuratorTemplates.articleId))
        .where(
          and(
            inArray(configuratorTemplates.articleId, articleIds),
            or(eq(configuratorTemplates.published, false), eq(articles.active, false))
          )
        )
        .orderBy(asc(articles.articleNumber));
    },
    // Groups (and so values), rules, lines and operations go by ON DELETE cascade.
    async deleteTemplate(ex: Executor, articleId: string): Promise<void> {
      await ex.delete(configuratorTemplates).where(eq(configuratorTemplates.articleId, articleId));
    },

    // --- groups ---
    async findGroup(ex: Executor, articleId: string, groupId: string): Promise<ConfiguratorGroupDetail | null> {
      const [row] = await ex
        .select()
        .from(configuratorGroups)
        .where(and(eq(configuratorGroups.id, groupId), eq(configuratorGroups.articleId, articleId)));
      return row ? groupDetail(ex, row) : null;
    },
    async insertGroup(ex: Executor, values: GroupInsert): Promise<ConfiguratorGroupDetail> {
      const [row] = await ex.insert(configuratorGroups).values(values).returning();
      return toGroupDetail(row!, []);
    },
    async updateGroup(ex: Executor, groupId: string, patch: GroupPatch): Promise<ConfiguratorGroupDetail> {
      const [row] = await ex
        .update(configuratorGroups)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(configuratorGroups.id, groupId))
        .returning();
      return groupDetail(ex, row!);
    },
    async deleteGroup(ex: Executor, groupId: string): Promise<void> {
      await ex.delete(configuratorGroups).where(eq(configuratorGroups.id, groupId));
    },

    // --- values ---
    async findValue(ex: Executor, groupId: string, valueId: string): Promise<ConfiguratorValueDetail | null> {
      const [row] = await valueQuery(ex).where(and(eq(configuratorValues.id, valueId), eq(configuratorValues.groupId, groupId)));
      return row ? toValueDetail(row) : null;
    },
    async insertValue(ex: Executor, values: ValueInsert): Promise<ConfiguratorValueDetail> {
      const [row] = await ex.insert(configuratorValues).values(values).returning({ id: configuratorValues.id });
      return (await valueDetail(ex, row!.id))!;
    },
    async updateValue(ex: Executor, valueId: string, patch: ValuePatch): Promise<ConfiguratorValueDetail> {
      // An empty PATCH body is legal (all fields optional): read instead of an
      // UPDATE with an empty SET.
      if (Object.keys(patch).length > 0) {
        await ex.update(configuratorValues).set(patch).where(eq(configuratorValues.id, valueId));
      }
      return (await valueDetail(ex, valueId))!;
    },
    async deleteValue(ex: Executor, valueId: string): Promise<void> {
      await ex.delete(configuratorValues).where(eq(configuratorValues.id, valueId));
    },

    // --- rules ---
    async listRules(ex: Executor, articleId: string): Promise<ConfiguratorRuleDetail[]> {
      const rows = await ex
        .select()
        .from(configuratorRules)
        .where(eq(configuratorRules.articleId, articleId))
        .orderBy(asc(configuratorRules.sortOrder), asc(configuratorRules.id));
      return rows.map(toRuleDetail);
    },
    async findRule(ex: Executor, articleId: string, ruleId: string): Promise<ConfiguratorRuleDetail | null> {
      const [row] = await ex
        .select()
        .from(configuratorRules)
        .where(and(eq(configuratorRules.id, ruleId), eq(configuratorRules.articleId, articleId)));
      return row ? toRuleDetail(row) : null;
    },
    async insertRule(ex: Executor, articleId: string, sortOrder: number, rule: RuleWrite): Promise<ConfiguratorRuleDetail> {
      const [row] = await ex
        .insert(configuratorRules)
        .values({ articleId, sortOrder, ...rule })
        .returning();
      return toRuleDetail(row!);
    },
    async updateRule(ex: Executor, ruleId: string, rule: RuleWrite): Promise<ConfiguratorRuleDetail> {
      const [row] = await ex.update(configuratorRules).set(rule).where(eq(configuratorRules.id, ruleId)).returning();
      return toRuleDetail(row!);
    },
    async deleteRule(ex: Executor, articleId: string, ruleId: string): Promise<boolean> {
      const rows = await ex
        .delete(configuratorRules)
        .where(and(eq(configuratorRules.id, ruleId), eq(configuratorRules.articleId, articleId)))
        .returning({ id: configuratorRules.id });
      return rows.length > 0;
    },

    // --- structure lines (villkorade strukturrader) ---
    listBomLines,
    async findBomLine(ex: Executor, articleId: string, lineId: string): Promise<ConfiguratorBomLineDetail | null> {
      const [row] = await bomLineQuery(ex).where(and(eq(configuratorBomLines.id, lineId), eq(configuratorBomLines.articleId, articleId)));
      return row ? toBomLineDetail(row) : null;
    },
    async insertBomLine(ex: Executor, articleId: string, sortOrder: number, line: BomLineWrite): Promise<ConfiguratorBomLineDetail> {
      const [row] = await ex.insert(configuratorBomLines).values({ articleId, sortOrder, ...line }).returning({ id: configuratorBomLines.id });
      return (await bomLineDetail(ex, row!.id))!;
    },
    async updateBomLine(ex: Executor, lineId: string, line: BomLineWrite): Promise<ConfiguratorBomLineDetail> {
      await ex.update(configuratorBomLines).set(line).where(eq(configuratorBomLines.id, lineId));
      return (await bomLineDetail(ex, lineId))!;
    },
    async deleteBomLine(ex: Executor, articleId: string, lineId: string): Promise<boolean> {
      const rows = await ex
        .delete(configuratorBomLines)
        .where(and(eq(configuratorBomLines.id, lineId), eq(configuratorBomLines.articleId, articleId)))
        .returning({ id: configuratorBomLines.id });
      return rows.length > 0;
    },

    // --- conditional operations (villkorade operationer) ---
    listOperations,
    async findOperation(ex: Executor, articleId: string, operationId: string): Promise<ConfiguratorOperationDetail | null> {
      const [row] = await operationQuery(ex).where(and(eq(configuratorOperations.id, operationId), eq(configuratorOperations.articleId, articleId)));
      return row ? toOperationDetail(row) : null;
    },
    async insertOperation(ex: Executor, articleId: string, op: OperationWrite): Promise<ConfiguratorOperationDetail> {
      const [row] = await ex.insert(configuratorOperations).values({ articleId, ...op }).returning({ id: configuratorOperations.id });
      return (await operationDetail(ex, row!.id))!;
    },
    async updateOperation(ex: Executor, operationId: string, op: OperationWrite): Promise<ConfiguratorOperationDetail> {
      await ex.update(configuratorOperations).set(op).where(eq(configuratorOperations.id, operationId));
      return (await operationDetail(ex, operationId))!;
    },
    // Lines linked to it go to configurator_operation_id = null (ON DELETE set null).
    async deleteOperation(ex: Executor, articleId: string, operationId: string): Promise<boolean> {
      const rows = await ex
        .delete(configuratorOperations)
        .where(and(eq(configuratorOperations.id, operationId), eq(configuratorOperations.articleId, articleId)))
        .returning({ id: configuratorOperations.id });
      return rows.length > 0;
    },

    // --- stocked variants (lagerförda varianter) ---
    // The template's variants, by article number — the list, the key lookup
    // (exists) and the code lock all read this.
    async variantsOfTemplate(ex: Executor, templateArticleId: string): Promise<VariantRow[]> {
      const rows = await ex
        .select({
          articleId: configuratorVariants.articleId, configKey: configuratorVariants.configKey, selection: configuratorVariants.selection,
          articleNumber: articles.articleNumber, name: articles.name, salesPrice: articles.salesPrice, standardCost: articles.standardCost,
          active: articles.active,
        })
        .from(configuratorVariants)
        .innerJoin(articles, eq(articles.id, configuratorVariants.articleId))
        .where(eq(configuratorVariants.templateArticleId, templateArticleId))
        .orderBy(asc(articles.articleNumber));
      return rows.map((r) => ({ ...r, selection: r.selection as VariantSelectionEntry[] }));
    },
    // Konfigurator 4b: configured beställningsvara rows on this template (any
    // order status) — the code lock reads them.
    async configuredRowsOfTemplate(ex: Executor, templateArticleId: string): Promise<{ orderNumber: string; selection: VariantSelectionEntry[] }[]> {
      const rows = await ex
        .select({ orderNumber: salesOrders.orderNumber, configuration: salesOrderRows.configuration })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .where(and(eq(salesOrderRows.articleId, templateArticleId), isNotNull(salesOrderRows.configuration)));
      return rows.map((r) => ({ orderNumber: r.orderNumber, selection: (r.configuration as OrderRowConfiguration).selection }));
    },
    // articleNumber → id for the numbers that already exist (number_taken).
    async articleIdsByNumber(ex: Executor, numbers: string[]): Promise<Map<string, string>> {
      if (numbers.length === 0) return new Map();
      const rows = await ex
        .select({ id: articles.id, articleNumber: articles.articleNumber })
        .from(articles)
        .where(inArray(articles.articleNumber, numbers));
      return new Map(rows.map((r) => [r.articleNumber, r.id]));
    },
    async insertVariantLink(
      tx: Tx,
      row: { articleId: string; templateArticleId: string; configKey: string; selection: VariantSelectionEntry[]; calcQuantity: number; createdBy: string | null }
    ): Promise<void> {
      await tx.insert(configuratorVariants).values({ ...row, calcQuantity: String(row.calcQuantity) });
    },
    async variantOf(ex: Executor, articleId: string): Promise<VariantOf | null> {
      const [row] = await ex
        .select({
          templateArticleId: configuratorVariants.templateArticleId, templateArticleNumber: templateArticles.articleNumber,
          templateName: templateArticles.name, configKey: configuratorVariants.configKey, selection: configuratorVariants.selection,
          calcQuantity: configuratorVariants.calcQuantity,
        })
        .from(configuratorVariants)
        .innerJoin(templateArticles, eq(templateArticles.id, configuratorVariants.templateArticleId))
        .where(eq(configuratorVariants.articleId, articleId));
      return row ? { ...row, selection: row.selection as VariantSelectionEntry[] } : null;
    },
    async isVariant(ex: Executor, articleId: string): Promise<boolean> {
      const rows = await ex.select({ articleId: configuratorVariants.articleId }).from(configuratorVariants).where(eq(configuratorVariants.articleId, articleId));
      return rows.length > 0;
    },

    // --- ordering ---
    async idsInScope(ex: Executor, table: SortTable, scopeId: string): Promise<string[]> {
      const t = SORT_TABLES[table];
      const rows = await ex.select({ id: t.id }).from(t.table).where(eq(t.scope, scopeId));
      return rows.map((r) => r.id);
    },
    async maxSortOrder(ex: Executor, table: SortTable, scopeId: string): Promise<number> {
      const t = SORT_TABLES[table];
      const [row] = await ex.select({ value: max(t.sortOrder) }).from(t.table).where(eq(t.scope, scopeId));
      return row?.value ?? 0;
    },
    // sort_order = index + 1, one statement.
    async setSortOrder(ex: Executor, table: SortTable, ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const t = SORT_TABLES[table];
      const cases = sql.join(
        ids.map((id, i) => sql`when ${id}::uuid then ${i + 1}::integer`),
        sql` `
      );
      await ex
        .update(t.table)
        .set({ sortOrder: sql`case ${t.id} ${cases} end` })
        .where(inArray(t.id, ids));
    },
  };
}

export type ConfiguratorRepository = ReturnType<typeof createConfiguratorRepository>;
