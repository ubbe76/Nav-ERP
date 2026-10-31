// apps/api/test/configurator-schema.test.ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  db, configuratorTemplates, configuratorGroups, configuratorValues, configuratorBomLines, configuratorOperations, configuratorVariants, workCenters,
  customers, emailLog, salesOrderRows, salesOrders,
} from "@navet/db";
import {
  createConfiguratorGroupSchema, configuratorConditionSchema, createConfiguratorBomLineSchema, updateConfiguratorBomLineSchema,
  createConfiguratorOperationSchema, updateConfiguratorOperationSchema, createConfiguratorValueSchema, updateConfiguratorValueSchema,
  deriveConfigurationSchema, configuratorSelectionSchema, variantSetsSchema, isOnNumberStep,
} from "@navet/shared";
import { isUniqueViolation } from "../src/modules/system/service/db-errors.js";
import { makeArticle, resetConfigurator } from "./helpers/configurator.js";

// drizzle wraps the driver error: the constraint name sits on `cause`.
const hitsConstraint = (name: string) => (err: unknown) =>
  (err as { cause?: { constraint_name?: string } }).cause?.constraint_name === name;

beforeEach(resetConfigurator);
afterAll(resetConfigurator);

describe("configurator schema", () => {
  it("rejects a lower-case code and a number group without min/max", async () => {
    const article = await makeArticle();
    await db.insert(configuratorTemplates).values({ articleId: article.id, mode: "variants" });
    await expect(
      db.insert(configuratorGroups).values({ articleId: article.id, code: "farg", name: "Färg", kind: "choice", sortOrder: 1 })
    ).rejects.toThrow();
    await expect(
      db.insert(configuratorGroups).values({ articleId: article.id, code: "BREDD", name: "Bredd", kind: "number", sortOrder: 1 })
    ).rejects.toThrow();
  });

  it("rejects number fields on a choice group and a price on a choice group", async () => {
    const article = await makeArticle();
    await db.insert(configuratorTemplates).values({ articleId: article.id, mode: "variants" });
    await expect(
      db.insert(configuratorGroups).values({ articleId: article.id, code: "FARG", name: "Färg", kind: "choice", sortOrder: 1, unit: "mm" })
    ).rejects.toThrow();
    await expect(
      db.insert(configuratorGroups).values({ articleId: article.id, code: "FARG", name: "Färg", kind: "choice", sortOrder: 1, priceAdd: "10" })
    ).rejects.toThrow();
  });

  it("nulls a group's default when its value is deleted", async () => {
    const article = await makeArticle();
    await db.insert(configuratorTemplates).values({ articleId: article.id, mode: "variants" });
    const [group] = await db
      .insert(configuratorGroups)
      .values({ articleId: article.id, code: "FARG", name: "Färg", kind: "choice", sortOrder: 1 })
      .returning();
    const [value] = await db.insert(configuratorValues).values({ groupId: group!.id, code: "RD", name: "Röd", sortOrder: 1 }).returning();
    const { eq } = await import("drizzle-orm");
    await db.update(configuratorGroups).set({ defaultValueId: value!.id }).where(eq(configuratorGroups.id, group!.id));
    await db.delete(configuratorValues).where(eq(configuratorValues.id, value!.id));
    const [after] = await db.select().from(configuratorGroups).where(eq(configuratorGroups.id, group!.id));
    expect(after!.defaultValueId).toBeNull();
  });

  it("zod: number group needs min <= max and a default inside the range", () => {
    expect(createConfiguratorGroupSchema.safeParse({ code: "BREDD", name: "Bredd", kind: "number", minValue: 10, maxValue: 5 }).success).toBe(false);
    expect(
      createConfiguratorGroupSchema.safeParse({ code: "BREDD", name: "Bredd", kind: "number", minValue: 800, maxValue: 3000, defaultNumber: 500 }).success
    ).toBe(false);
    expect(configuratorConditionSchema.safeParse({ groupId: crypto.randomUUID(), op: "gt", value: 1.23456 }).success).toBe(false);
    // "Högst 4 decimaler" is exact for large numbers too (an absolute tolerance on n×10⁴ is not)
    const cond = (value: number) => configuratorConditionSchema.safeParse({ groupId: crypto.randomUUID(), op: "gt", value }).success;
    expect([cond(1234567.1234), cond(1078213.6444), cond(9999999999.9999)]).toEqual([true, true, true]);
    expect(cond(1234567.12345)).toBe(false);
  });

  it("zod: a number group's default must lie on the step grid counted from min (the engine's own test)", () => {
    const group = (defaultNumber: number, step: number | null = 50) =>
      createConfiguratorGroupSchema.safeParse({ code: "BREDD", name: "Bredd", kind: "number", minValue: 800, maxValue: 3000, step, defaultNumber });
    expect(group(1200).success).toBe(true);
    expect(group(1225).success).toBe(false);
    expect(group(1225, null).success).toBe(true);
    expect(isOnNumberStep(1200, 800, 50)).toBe(true);
    expect(isOnNumberStep(1225, 800, 50)).toBe(false);
    // Exact in 1e-4 units: 0.3 from 0 in steps of 0.1 is on the grid despite float arithmetic.
    expect(isOnNumberStep(0.3, 0, 0.1)).toBe(true);
    expect(isOnNumberStep(5, null, 0.1)).toBe(true);
  });

  it("zod: a selection value may be null (deliberately empty, delprojekt 5); so may a choice/number set's value", () => {
    expect(configuratorSelectionSchema.safeParse({ LOCK: null, BREDD: 1200, HJUL: false, FARG: "RD" }).success).toBe(true);
    expect(configuratorSelectionSchema.safeParse({ LOCK: undefined }).success).toBe(false);
    expect(configuratorSelectionSchema.safeParse({ LOCK: {} }).success).toBe(false);
    // Skapa variant passes a cleared default through as a one-value set.
    expect(variantSetsSchema.safeParse({ LOCK: [null] }).success).toBe(true);
    expect(variantSetsSchema.safeParse({ LOCK: ["A", null] }).success).toBe(true);
    expect(variantSetsSchema.safeParse({ BREDD: [1200, null] }).success).toBe(true);
  });

  it("zod: a boolean set takes no null and at most two values (null ≡ false would repeat a key)", () => {
    expect(variantSetsSchema.safeParse({ HJUL: [true, false] }).success).toBe(true);
    expect(variantSetsSchema.safeParse({ HJUL: [true, null] }).success).toBe(false);
    expect(variantSetsSchema.safeParse({ HJUL: [false, null] }).success).toBe(false);
    expect(variantSetsSchema.safeParse({ HJUL: [true, false, null] }).success).toBe(false);
    expect(variantSetsSchema.safeParse({ HJUL: [true, false, true] }).success).toBe(false);
  });
});

describe("configurator derivation schema (0110)", () => {
  async function template() {
    const article = await makeArticle();
    await db.insert(configuratorTemplates).values({ articleId: article.id, mode: "variants" });
    return article;
  }
  async function workCenter() {
    await db.insert(workCenters).values({ code: "987", name: "Konf-test" }).onConflictDoNothing();
    const [wc] = await db.select().from(workCenters).where(eq(workCenters.code, "987"));
    return wc!;
  }
  async function group(articleId: string) {
    const [g] = await db
      .insert(configuratorGroups)
      .values({ articleId, code: "LOCK", name: "Lock", kind: "choice", sortOrder: 1 })
      .returning();
    return g!;
  }

  it("rejects a bom line whose source and component do not match", async () => {
    const t = await template();
    const comp = await makeArticle({ type: "purchased" });
    await expect(
      db.insert(configuratorBomLines).values({ articleId: t.id, sortOrder: 1, source: "article", quantity: "1" })
    ).rejects.toThrow();
    const g = await group(t.id);
    await expect(
      db.insert(configuratorBomLines).values({ articleId: t.id, sortOrder: 1, source: "article", componentArticleId: comp.id, componentGroupId: g.id, quantity: "1" })
    ).rejects.toThrow();
    await expect(
      db.insert(configuratorBomLines).values({ articleId: t.id, sortOrder: 1, source: "group", quantity: "1" })
    ).rejects.toThrow();
    await db.insert(configuratorBomLines).values({ articleId: t.id, sortOrder: 1, source: "article", componentArticleId: comp.id, quantity: "1" });
    await db.insert(configuratorBomLines).values({ articleId: t.id, sortOrder: 2, source: "group", componentGroupId: g.id, quantityFormula: "BREDD" });
  });

  it("rejects both or neither of quantity and quantity_formula, and a non-positive quantity", async () => {
    const t = await template();
    const comp = await makeArticle({ type: "purchased" });
    const base = { articleId: t.id, sortOrder: 1, source: "article" as const, componentArticleId: comp.id };
    await expect(db.insert(configuratorBomLines).values({ ...base, quantity: "1", quantityFormula: "2" })).rejects.toThrow();
    await expect(db.insert(configuratorBomLines).values({ ...base })).rejects.toThrow();
    await expect(db.insert(configuratorBomLines).values({ ...base, quantity: "0" })).rejects.toThrow();
  });

  it("rejects a bom line linked to both a routing and a configurator operation", async () => {
    const t = await template();
    const comp = await makeArticle({ type: "purchased" });
    const wc = await workCenter();
    const [op] = await db.insert(configuratorOperations).values({ articleId: t.id, sequenceNo: 10, workCenterId: wc.id, setupTime: "0", runTimePerUnit: "1" }).returning();
    const { routingOperations } = await import("@navet/db");
    const [rop] = await db.insert(routingOperations).values({ articleId: t.id, sequenceNo: 20, workCenterId: wc.id, setupTime: "0", runTimePerUnit: "1" }).returning();
    const base = { articleId: t.id, sortOrder: 1, source: "article" as const, componentArticleId: comp.id, quantity: "1" };
    await expect(
      db.insert(configuratorBomLines).values({ ...base, configuratorOperationId: op!.id, routingOperationId: rop!.id })
    ).rejects.toThrow();
    await db.insert(configuratorBomLines).values({ ...base, configuratorOperationId: op!.id });
  });

  it("rejects an operation without setup or run time and a duplicate sequence number", async () => {
    const t = await template();
    const wc = await workCenter();
    const op = { articleId: t.id, sequenceNo: 10, workCenterId: wc.id };
    await expect(db.insert(configuratorOperations).values({ ...op, runTimePerUnit: "1" })).rejects.toThrow();
    await expect(db.insert(configuratorOperations).values({ ...op, setupTime: "1" })).rejects.toThrow();
    await expect(db.insert(configuratorOperations).values({ ...op, setupTime: "1", setupFormula: "2", runTimePerUnit: "1" })).rejects.toThrow();
    await expect(db.insert(configuratorOperations).values({ ...op, setupTime: "-1", runTimePerUnit: "1" })).rejects.toThrow();
    await db.insert(configuratorOperations).values({ ...op, setupTime: "1", runFormula: "BREDD / 100" });
    await expect(db.insert(configuratorOperations).values({ ...op, setupTime: "1", runTimePerUnit: "1" })).rejects.toThrow();
  });

  it("cascades lines and operations with the template and keeps a group referenced by a line", async () => {
    const t = await template();
    const wc = await workCenter();
    const g = await group(t.id);
    await db.insert(configuratorBomLines).values({ articleId: t.id, sortOrder: 1, source: "group", componentGroupId: g.id, quantity: "1" });
    await db.insert(configuratorOperations).values({ articleId: t.id, sequenceNo: 10, workCenterId: wc.id, setupTime: "0", runTimePerUnit: "1" });
    await expect(db.delete(configuratorGroups).where(eq(configuratorGroups.id, g.id))).rejects.toThrow();
    await db.delete(configuratorTemplates).where(eq(configuratorTemplates.articleId, t.id));
    expect(await db.select().from(configuratorBomLines)).toHaveLength(0);
    expect(await db.select().from(configuratorOperations)).toHaveLength(0);
  });

  it("stores an article on a value", async () => {
    const t = await template();
    const g = await group(t.id);
    const comp = await makeArticle({ type: "purchased" });
    const [v] = await db.insert(configuratorValues).values({ groupId: g.id, code: "A", name: "A", sortOrder: 1, articleId: comp.id }).returning();
    expect(v!.articleId).toBe(comp.id);
  });

  it("zod: bom line source must match its field, one quantity form, one operation link", () => {
    const id = () => crypto.randomUUID();
    const ok = { source: "article", componentArticleId: id(), quantity: 2 };
    expect(createConfiguratorBomLineSchema.safeParse(ok).success).toBe(true);
    expect(createConfiguratorBomLineSchema.parse(ok).conditions).toEqual([]);
    expect(createConfiguratorBomLineSchema.safeParse({ source: "group", componentGroupId: id(), quantityFormula: "BREDD" }).success).toBe(true);
    expect(createConfiguratorBomLineSchema.safeParse({ source: "group", componentGroupId: id(), componentArticleId: id(), quantity: 1 }).success).toBe(false);
    expect(createConfiguratorBomLineSchema.safeParse({ source: "article", componentGroupId: id(), quantity: 1 }).success).toBe(false);
    expect(createConfiguratorBomLineSchema.safeParse({ ...ok, quantityFormula: "1" }).success).toBe(false);
    expect(createConfiguratorBomLineSchema.safeParse({ source: "article", componentArticleId: id() }).success).toBe(false);
    expect(createConfiguratorBomLineSchema.safeParse({ ...ok, quantity: 0 }).success).toBe(false);
    expect(createConfiguratorBomLineSchema.safeParse({ ...ok, quantity: 1.23456 }).success).toBe(false);
    expect(createConfiguratorBomLineSchema.safeParse({ ...ok, routingOperationId: id(), configuratorOperationId: id() }).success).toBe(false);
    expect(createConfiguratorBomLineSchema.safeParse({ ...ok, routingOperationId: id() }).success).toBe(true);
  });

  it("zod: bom line update is partial and strict", () => {
    expect(updateConfiguratorBomLineSchema.safeParse({ note: "x" }).success).toBe(true);
    expect(updateConfiguratorBomLineSchema.safeParse({}).success).toBe(true);
    expect(updateConfiguratorBomLineSchema.safeParse({ nonsense: 1 }).success).toBe(false);
  });

  it("zod: operation needs exactly one of time and formula per pair, and update is strict", () => {
    const wc = crypto.randomUUID();
    const ok = { sequenceNo: 10, workCenterId: wc, setupTime: 5, runTimePerUnit: 1.5 };
    expect(createConfiguratorOperationSchema.safeParse(ok).success).toBe(true);
    expect(createConfiguratorOperationSchema.safeParse({ sequenceNo: 10, workCenterId: wc, setupFormula: "1", runFormula: "BREDD/10" }).success).toBe(true);
    expect(createConfiguratorOperationSchema.safeParse({ ...ok, setupFormula: "1" }).success).toBe(false);
    expect(createConfiguratorOperationSchema.safeParse({ ...ok, runFormula: "1" }).success).toBe(false);
    expect(createConfiguratorOperationSchema.safeParse({ sequenceNo: 10, workCenterId: wc, setupTime: 5 }).success).toBe(false);
    expect(createConfiguratorOperationSchema.safeParse({ ...ok, setupTime: -1 }).success).toBe(false);
    expect(createConfiguratorOperationSchema.safeParse({ ...ok, setupTime: 1.234 }).success).toBe(false);
    expect(createConfiguratorOperationSchema.safeParse({ ...ok, sequenceNo: 0 }).success).toBe(false);
    expect(updateConfiguratorOperationSchema.safeParse({ description: "x" }).success).toBe(true);
    expect(updateConfiguratorOperationSchema.safeParse({ nonsense: 1 }).success).toBe(false);
  });

  it("zod: values carry an optional article id; derive shares the evaluate schema", () => {
    const id = crypto.randomUUID();
    expect(createConfiguratorValueSchema.parse({ code: "A", name: "A", articleId: id }).articleId).toBe(id);
    expect(updateConfiguratorValueSchema.safeParse({ articleId: null }).success).toBe(true);
    expect(updateConfiguratorValueSchema.safeParse({ articleId: "x" }).success).toBe(false);
    expect(deriveConfigurationSchema.parse({}).quantity).toBe(1);
  });

  it("article_field: only on a choice group, once per template, but reusable across templates", async () => {
    const a = await makeArticle();
    const b = await makeArticle();
    await db.insert(configuratorTemplates).values([{ articleId: a.id, mode: "variants" }, { articleId: b.id, mode: "variants" }]);
    await expect(
      db.insert(configuratorGroups).values({ articleId: a.id, code: "HJUL", name: "Hjul", kind: "boolean", sortOrder: 1, articleField: "colour" })
    ).rejects.toSatisfy(hitsConstraint("configurator_groups_article_field_choice"));
    await db.insert(configuratorGroups).values({ articleId: a.id, code: "FARG", name: "Färg", kind: "choice", sortOrder: 1, articleField: "colour" });
    await expect(
      db.insert(configuratorGroups).values({ articleId: a.id, code: "FARG2", name: "Färg 2", kind: "choice", sortOrder: 2, articleField: "colour" })
    ).rejects.toSatisfy(hitsConstraint("configurator_groups_article_field_unique"));
    await db.insert(configuratorGroups).values({ articleId: b.id, code: "FARG", name: "Färg", kind: "choice", sortOrder: 1, articleField: "colour" });
  });

  it("configurator_variants: unique (template, key) and the template row is protected by FK", async () => {
    const tpl = await makeArticle();
    const v1 = await makeArticle();
    const v2 = await makeArticle();
    await db.insert(configuratorTemplates).values({ articleId: tpl.id, mode: "variants" });
    await db.insert(configuratorVariants).values({ articleId: v1.id, templateArticleId: tpl.id, configKey: "FARG=RD", selection: [], calcQuantity: "1" });
    await expect(
      db.insert(configuratorVariants).values({ articleId: v2.id, templateArticleId: tpl.id, configKey: "FARG=RD", selection: [], calcQuantity: "1" })
    ).rejects.toSatisfy(hitsConstraint("configurator_variants_template_key_unique"));
    await expect(db.delete(configuratorTemplates).where(eq(configuratorTemplates.articleId, tpl.id))).rejects.toSatisfy(hitsConstraint("configurator_variants_template_article_id_configurator_template"));
  });
});

// Konfigurator 4b: the order-row configuration columns (migration 0113). The
// shared configurator reset leaves the sales tables alone, so clear them here.
describe("sales_order_rows.configuration (4b)", () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE email_log, sales_order_rows, sales_orders, customers CASCADE`);
  });

  it("two configured rows of the same article are allowed, two ordinary rows are not", async () => {
    const article = await makeArticle();
    const [customer] = await db.insert(customers).values({ customerNumber: `K-${crypto.randomUUID().slice(0, 6)}`, name: "Kund" }).returning();
    const [order] = await db.insert(salesOrders).values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 8)}`, customerId: customer!.id }).returning();
    const cfg = { templateArticleId: article.id, key: "LOCK=A", selection: [], price: { base: 1000, additions: [], unitPrice: 1000, discountPercent: 0, source: "article" } };
    const row = (configuration: unknown) => ({ salesOrderId: order!.id, articleId: article.id, quantityOrdered: "1", unitPrice: "1000", configuration });
    await db.insert(salesOrderRows).values([row(cfg), row({ ...cfg, key: "LOCK=B" })]);
    await db.insert(salesOrderRows).values(row(null));
    const err = await db.insert(salesOrderRows).values(row(null)).catch((e: unknown) => e);
    expect(isUniqueViolation(err, "sales_order_rows_order_article_unique")).toBe(true);
    expect(await db.select().from(salesOrderRows)).toHaveLength(3);
  });

  it("customers.show_configuration_prices defaults to false, email_log and invoice_rows accept null", async () => {
    const [customer] = await db.insert(customers).values({ customerNumber: `K-${crypto.randomUUID().slice(0, 6)}`, name: "Kund" }).returning();
    expect(customer!.showConfigurationPrices).toBe(false);
    const [log] = await db.insert(emailLog).values({ documentType: "test", documentId: null, recipient: "a@b.se", subject: "x", status: "sent" }).returning();
    expect(log!.showConfigurationPrices).toBeNull();
  });
});

// Konfigurator 4c: the configured-manufacturing columns (migration 0114).
describe("configured manufacturing columns (4c)", () => {
  it("0114: manufacturing_orders.configuration and sales_order_rows.configuration_cost are nullable jsonb", async () => {
    const cols = [
      ...(await db.execute(sql`
        select table_name, column_name, data_type, is_nullable from information_schema.columns
        where (table_name = 'manufacturing_orders' and column_name = 'configuration')
           or (table_name = 'sales_order_rows' and column_name = 'configuration_cost')
        order by table_name`)),
    ];
    expect(cols).toEqual([
      { table_name: "manufacturing_orders", column_name: "configuration", data_type: "jsonb", is_nullable: "YES" },
      { table_name: "sales_order_rows", column_name: "configuration_cost", data_type: "jsonb", is_nullable: "YES" },
    ]);
  });
});

// Konfigurator 5: Visa i API (migration 0115).
describe("published flag (delprojekt 5)", () => {
  it("0115: configurator_templates.published is boolean NOT NULL default false", async () => {
    const cols = [
      ...(await db.execute(sql`
        select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_name = 'configurator_templates' and column_name = 'published'`)),
    ];
    expect(cols).toEqual([{ column_name: "published", data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
  });
});
