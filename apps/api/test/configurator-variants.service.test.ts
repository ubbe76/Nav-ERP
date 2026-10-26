import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articleCodes, articleFiles, articleUnits, articles, bomComponents, configuratorVariants, customers, db, routingOperations, salesOrderRows, salesOrders, units } from "@navet/db";
import type { VariantSelectionEntry } from "@navet/shared";
import {
  ConfiguratorCodeLockedError, ConfiguratorNotVariantModeError, ConfiguratorReferenceInUseError, ConfiguratorTemplateHasVariantsError,
  ConfiguratorVariantNotFoundError, ConfiguratorVariantNotTemplateError,
} from "../src/modules/configurator/service/configurator.errors.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { makeArticle, makeVariantService, resetConfigurator, testCostingSettings, variantWriters } from "./helpers/configurator.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { vatRateGroupId } from "./helpers/vat-group.js";

// Delprojekt 3, Task 4: stocked variants — preview, creation in ONE
// transaction (article + route + structure + link), the code lock and the
// mode/lifecycle guards. The template is built like the derive tests': LOCK
// (from-choice line), FARG (fills Färg, default RD), BREDD, a conditional
// line and a conditional lego operation, a base operation with a comment and
// a costing-only base operation.

const service = makeVariantService();
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

async function reset() {
  await resetConfigurator();
  await db.execute(sql`TRUNCATE work_centers, routing_operations, cost_calculations, sales_order_rows, sales_orders, customers CASCADE`);
  Object.assign(testCostingSettings, {
    costingMaterialSource: "standard", costingMoPercent: 0, costingLoPercent: 0, costingAffoPercent: 0, costingGeneralMarkupPercent: 0,
  });
}
beforeEach(reset);
afterAll(reset);

let seq = 0;
const part = (name: string, extra: Record<string, unknown> = {}) =>
  testArticleService.createArticle({
    articleNumber: `V-${(seq += 1)}-${crypto.randomUUID().slice(0, 6)}`, name, type: "purchased", unit: "st", ...extra,
  } as never);
const workCenter = (code: string, hourlyRate: number, type: "machine" | "subcontract" = "machine") =>
  mfgService.createWorkCenter({ code, name: `Resurs ${code}`, type, hourlyRate, overheadPercent: 0, capacityFactor: 1, active: true });

// Hand-calculated at calc quantity 10 for LOCK=A, FARG=RD, BREDD=1200 (markups 0):
//   SKRUV base 8/unit (op 10)     → 80 × 2   = 160
//   LASA  from choice 1/unit      → 10 × 30  = 300
//   PLAT  plain line 2/unit       → 20 × 10  = 200
//   op 10 (600 kr/h): (5 + 1×10)/60 × 600    = 150
//   op 20 (costing only, 300 kr/h): 60/60 × 300 = 300
//   TVK 1110 → 111 per unit. FARG=BL adds LACK 1/unit × 15 = 150 and lego op 30: 100 + 5 × 10 = 150.
async function build(opts: { salesPrice?: number | null } = {}) {
  const article = await makeArticle({ salesPrice: opts.salesPrice === null ? undefined : opts.salesPrice ?? 1000 });
  await service.createTemplate(article.id, { mode: "variants" });
  const lock = await service.createGroup(article.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
  const lasA = await part("Lås A", { standardCost: 30 });
  const lasB = await part("Lås B", { standardCost: 40 });
  const a = await service.createValue(article.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true, articleId: lasA.id });
  const b = await service.createValue(article.id, lock.id, { code: "B", name: "Lås B", priceAdd: 50, active: true, articleId: lasB.id });
  const farg = await service.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false, articleField: "colour" });
  const rd = await service.createValue(article.id, farg.id, { code: "RD", name: "Röd", priceAdd: 0, active: true });
  const bl = await service.createValue(article.id, farg.id, { code: "BL", name: "Blå", priceAdd: 100, active: true });
  await service.updateGroup(article.id, farg.id, { defaultValueId: rd.id });
  const bredd = await service.createGroup(article.id, {
    code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", minValue: 500, maxValue: 2000, step: null,
    defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
  });

  const skruv = await part("Skruv", { standardCost: 2 });
  const plat = await part("Plåt", { standardCost: 10 });
  const lack = await part("Lack", { standardCost: 15 });
  const wcA = await workCenter("202", 600);
  const wcB = await workCenter("203", 300);
  const wcL = await workCenter("204", 0, "subcontract");
  const op10 = await mfgService.createRoutingOperation(article.id, {
    sequenceNo: 10, workCenterId: wcA.id, setupTime: 5, runTimePerUnit: 1, description: "Montering", comment: "Dra åt för hand", printOnWorkCard: true,
  });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: wcB.id, setupTime: 0, runTimePerUnit: 6, costingOnly: true });
  await testArticleService.addBomComponent(article.id, { componentArticleId: skruv.id, quantity: 8, routingOperationId: op10.id });

  await service.createBomLine(article.id, { conditions: [], source: "group", componentGroupId: lock.id, quantity: 1 });
  await service.createBomLine(article.id, { conditions: [], source: "article", componentArticleId: plat.id, quantity: 2 });
  await service.createBomLine(article.id, { conditions: [{ groupId: farg.id, op: "is", valueIds: [bl.id] }], source: "article", componentArticleId: lack.id, quantity: 1 });
  const op30 = await service.createOperation(article.id, {
    conditions: [{ groupId: farg.id, op: "is", valueIds: [bl.id] }], sequenceNo: 30, workCenterId: wcL.id, description: "Lackering",
    setupTime: 0, runTimePerUnit: 0, setupPrice: 100, unitPrice: 5,
  });
  return { article, lock, a, b, farg, rd, bl, bredd, wcA, wcB, wcL, op10, op30, parts: { skruv, plat, lack, lasA, lasB } };
}

const ONE = { sets: { LOCK: ["A"], BREDD: [1200] }, calcQuantity: 10 };

async function variantRows() {
  return db.select().from(configuratorVariants);
}
async function articleCount() {
  return (await db.select({ id: articles.id }).from(articles)).length;
}

describe("createVariants", () => {
  it("creates one variant: article fields, Information copied, structure and route derived, link row stored", async () => {
    const s = await build();
    // The varugrupp (and with it the 12 % rate) follows like the article code.
    const [code] = await db.insert(articleCodes).values({ code: `K${crypto.randomUUID().slice(0, 6)}`, name: `Kod ${crypto.randomUUID()}` }).returning();
    await testArticleService.updateArticle(s.article.id, { groupId: await vatRateGroupId(12), articleCodeId: code!.id, weight: 3.5 });
    // units is never truncated, so the alternative unit gets a code and name of its own.
    const tag = crypto.randomUUID().slice(0, 6);
    const kg = (await db.insert(units).values({ code: `KG${tag}`, name: `Kilogram ${tag}` }).returning())[0]!;
    await testArticleService.addArticleUnit(s.article.id, { unitId: kg.id, quantityPerBase: 2 });
    const before = await articleCount();

    const rows = await service.createVariants(s.article.id, ONE, null);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe("created");
    expect(row.articleNumber).toBe(`${s.article.articleNumber}-A-RD-1200`);
    expect(row.name).toBe("Papperskorg 50 l, Lås A, Röd, Bredd 1200 mm");
    expect(row.errors).toEqual([]);
    expect(await articleCount()).toBe(before + 1);

    const variant = (await testArticleService.getArticle(row.articleId!))!;
    expect(variant).toMatchObject({
      articleNumber: row.articleNumber, name: row.name, type: "manufactured", isPhantom: false, colour: "Röd", active: true,
      unitId: s.article.unitId, vatRate: "12.00", articleCodeId: code!.id, weight: "3.500",
    });
    // The engine's price (base 1000 + A 0 + RD 0), not the template's copied value by accident.
    const evaluation = await service.evaluate(s.article.id, { selection: { LOCK: "A", BREDD: 1200 }, quantity: 1 });
    expect(row.salesPrice).toBe(evaluation.price.unitPrice);
    expect(Number(variant.salesPrice)).toBe(1000);
    // Standard cost = TVK per unit at the calc quantity, straight from the pre-costing.
    const derived = await service.derive(s.article.id, { selection: { LOCK: "A", BREDD: 1200 }, quantity: 10 });
    expect(row.standardCost).toBe(Number(derived.costing!.manufacturingCostPerUnit.toFixed(4)));
    expect(Number(variant.standardCost)).toBe(111);
    // Alternative units follow (same base unit); files never do.
    const altUnits = await db.select().from(articleUnits).where(eq(articleUnits.articleId, variant.id));
    expect(altUnits.map((u) => [u.unitId, u.quantityPerBase])).toEqual([[kg.id, "2.000000"]]);
    expect(await db.select({ id: articleFiles.id }).from(articleFiles).where(eq(articleFiles.articleId, variant.id))).toEqual([]);

    // Route: derived operations with the template's columns kept (comment, print flag, costing_only).
    const ops = await db.select().from(routingOperations).where(eq(routingOperations.articleId, variant.id)).orderBy(routingOperations.sequenceNo);
    expect(ops.map((o) => [o.sequenceNo, o.workCenterId, o.setupTime, o.runTimePerUnit, o.costingOnly, o.comment, o.printOnWorkCard])).toEqual([
      [10, s.wcA.id, "5.00", "1.0000", false, "Dra åt för hand", true],
      [20, s.wcB.id, "0.00", "6.0000", true, null, false],
    ]);
    // Structure: the derived materials, the SKRUV row linked to the variant's own op 10.
    const bom = await db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, variant.id));
    const byComponent = Object.fromEntries(bom.map((b) => [b.componentArticleId, [Number(b.quantity), b.routingOperationId]]));
    expect(byComponent).toEqual({
      [s.parts.skruv.id]: [8, ops[0]!.id],
      [s.parts.lasA.id]: [1, null],
      [s.parts.plat.id]: [2, null],
    });
    expect(derived.structure.materials.map((m) => m.componentArticleId).sort()).toEqual(Object.keys(byComponent).sort());

    const [link] = await variantRows();
    expect(link).toMatchObject({ articleId: variant.id, templateArticleId: s.article.id, configKey: "BREDD=1200;FARG=RD;LOCK=A", calcQuantity: "10.0000" });
    const selection = link!.selection as VariantSelectionEntry[];
    expect(selection).toHaveLength(3);
    expect(selection.map((e) => [e.groupCode, e.value])).toEqual([["LOCK", "A"], ["FARG", "RD"], ["BREDD", 1200]]);
  });

  it("a [null] set clears a default: the variant has the group empty, not the default", async () => {
    const s = await build();
    const sets = { LOCK: ["A"], BREDD: [1200], FARG: [null] };
    const [preview] = await service.previewVariants(s.article.id, { sets, calcQuantity: 10 });
    expect(preview!.status).toBe("new");
    const [row] = await service.createVariants(s.article.id, { sets, calcQuantity: 10 }, null);
    expect(row!.status).toBe("created");
    expect(row!.articleNumber).not.toBe(`${s.article.articleNumber}-A-RD-1200`);
    const variant = (await testArticleService.getArticle(row!.articleId!))!;
    expect(variant.colour).toBeNull();
    const [link] = await variantRows();
    expect((link!.selection as { groupCode: string; value: unknown }[]).find((e) => e.groupCode === "FARG")?.value ?? null).toBeNull();
  });

  it("the same combination again is `exists` — explicitly given default included — and creates nothing", async () => {
    const s = await build();
    const [first] = await service.createVariants(s.article.id, ONE, null);
    const before = await articleCount();
    const [again] = await service.createVariants(s.article.id, ONE, null);
    expect(again).toMatchObject({ status: "exists", articleId: first!.articleId });
    const [explicit] = await service.createVariants(s.article.id, { sets: { LOCK: ["A"], FARG: ["RD"], BREDD: [1200] }, calcQuantity: 10 }, null);
    expect(explicit).toMatchObject({ status: "exists", articleId: first!.articleId });
    expect(await articleCount()).toBe(before);
    expect(await variantRows()).toHaveLength(1);
  });

  it("an existing combination stays `exists` when the template is renamed past the identity length limit", async () => {
    const s = await build();
    const [first] = await service.createVariants(s.article.id, ONE, null);
    await db.update(articles).set({ name: "x".repeat(250) }).where(eq(articles.id, s.article.id));
    const [again] = await service.previewVariants(s.article.id, ONE);
    expect(again).toMatchObject({ status: "exists", articleId: first!.articleId });
  });

  it("mass creation: a rule-stopped combination is reported invalid with the rule's message, the rest are created", async () => {
    const s = await build();
    await service.createRule(s.article.id, {
      effect: "exclude", conditions: [{ groupId: s.lock.id, op: "is", valueIds: [s.b.id] }], target: { groupId: s.farg.id, valueIds: [s.bl.id] },
      message: "Lås B finns inte i blått", active: true,
    });
    const rows = await service.createVariants(s.article.id, { sets: { LOCK: ["A", "B"], FARG: ["RD", "BL"], BREDD: [1200] }, calcQuantity: 10 }, null);
    expect(rows.map((r) => [r.selection.LOCK, r.selection.FARG, r.status])).toEqual([
      ["A", "RD", "created"], ["A", "BL", "created"], ["B", "RD", "created"], ["B", "BL", "invalid"],
    ]);
    const stopped = rows[3]!;
    expect(stopped.errors).toContain("Lås B finns inte i blått");
    expect(stopped.articleNumber).toBeNull();
    expect(await variantRows()).toHaveLength(3);
    // The BL variant carries the lego operation and the conditional component.
    const bl = (await testArticleService.getArticle(rows[1]!.articleId!))!;
    expect(bl.colour).toBe("Blå");
    const ops = await db.select().from(routingOperations).where(eq(routingOperations.articleId, bl.id)).orderBy(routingOperations.sequenceNo);
    expect(ops.map((o) => [o.sequenceNo, o.workCenterId, o.setupPrice, o.unitPrice, o.timeUnit, o.description])).toEqual([
      [10, s.wcA.id, null, null, "minutes_per_unit", "Montering"],
      [20, s.wcB.id, null, null, "minutes_per_unit", null],
      [30, s.wcL.id, "100.00", "5.0000", "minutes_per_unit", "Lackering"],
    ]);
    expect(Number(bl.standardCost)).toBe(141); // 1110 + 150 (lack) + 150 (lego) = 1410 / 10
    expect(Number(bl.salesPrice)).toBe(1100);
  });

  it("a taken article number stops that combination only", async () => {
    const s = await build();
    await testArticleService.createArticle({ articleNumber: `${s.article.articleNumber}-B-RD-1200`, name: "Upptaget", type: "purchased" } as never);
    const rows = await service.createVariants(s.article.id, { sets: { LOCK: ["A", "B"], BREDD: [1200] }, calcQuantity: 10 }, null);
    expect(rows.map((r) => r.status)).toEqual(["created", "number_taken"]);
    expect(rows[1]!.errors).toEqual([`Artikelnumret ${s.article.articleNumber}-B-RD-1200 finns redan`]);
    expect(rows[1]!.articleId).toBeNull();
    expect(await variantRows()).toHaveLength(1);
  });

  it("a writer failure on the second variant rolls back every new article and link row", async () => {
    const s = await build();
    let calls = 0;
    const failing = makeVariantService({
      writers: {
        ...variantWriters,
        insertBomRows: async (tx, parentArticleId, rows) => {
          if ((calls += 1) === 2) throw new Error("boom");
          return variantWriters.insertBomRows(tx, parentArticleId, rows);
        },
      },
    });
    const before = await articleCount();
    await expect(failing.createVariants(s.article.id, { sets: { LOCK: ["A", "B"], BREDD: [1200] }, calcQuantity: 10 }, null)).rejects.toThrow("boom");
    expect(await articleCount()).toBe(before);
    expect(await variantRows()).toEqual([]);
  });

  it("two concurrent creates of the same combination give one `created` and one `exists`", async () => {
    const s = await build();
    const [r1, r2] = await Promise.all([service.createVariants(s.article.id, ONE, null), service.createVariants(s.article.id, ONE, null)]);
    expect([r1[0]!.status, r2[0]!.status].sort()).toEqual(["created", "exists"]);
    expect(r1[0]!.articleId).toBe(r2[0]!.articleId);
    expect(await variantRows()).toHaveLength(1);
  });

  it("previewVariants reports statuses and prices without writing anything", async () => {
    const s = await build();
    await service.createVariants(s.article.id, ONE, null);
    const before = await articleCount();
    const rows = await service.previewVariants(s.article.id, { sets: { LOCK: ["A", "B"], BREDD: [1200, 5000] }, calcQuantity: 10 });
    expect(rows.map((r) => [r.selection.LOCK, r.selection.BREDD, r.status])).toEqual([
      ["A", 1200, "exists"], ["A", 5000, "invalid"], ["B", 1200, "new"], ["B", 5000, "invalid"],
    ]);
    expect(rows[2]).toMatchObject({ articleNumber: `${s.article.articleNumber}-B-RD-1200`, salesPrice: 1050, standardCost: 121, articleId: null });
    expect(rows[1]!.articleNumber).toBeNull();
    expect(rows[1]!.errors.length).toBeGreaterThan(0);
    expect(await articleCount()).toBe(before);
    expect(await variantRows()).toHaveLength(1);
  });

  it("without a base price the variant's sales price is null and the row warns", async () => {
    const s = await build({ salesPrice: null });
    const [row] = await service.createVariants(s.article.id, ONE, null);
    expect(row!.status).toBe("created");
    expect(row!.salesPrice).toBeNull();
    expect(row!.warnings).toContain("Grundpris saknas — försäljningspris lämnas tomt");
    expect((await testArticleService.getArticle(row!.articleId!))!.salesPrice).toBeNull();
  });

  it("a template without structure and route gives a variant with standard cost null, never 0", async () => {
    const article = await makeArticle({ salesPrice: 500 });
    await service.createTemplate(article.id, { mode: "variants" });
    const g = await service.createGroup(article.id, { code: "STORLEK", name: "Storlek", kind: "choice", required: true });
    await service.createValue(article.id, g.id, { code: "S", name: "Small", priceAdd: 0, active: true });
    const [row] = await service.createVariants(article.id, { sets: { STORLEK: ["S"] }, calcQuantity: 1 }, null);
    expect(row!.status).toBe("created");
    expect(row!.standardCost).toBeNull();
    expect((await testArticleService.getArticle(row!.articleId!))!.standardCost).toBeNull();
  });

  it("the same component on a base row (op 10) and a conditional line (op 30) becomes one BOM row linked to op 10, with a warning", async () => {
    const s = await build();
    await service.createBomLine(s.article.id, {
      conditions: [{ groupId: s.farg.id, op: "is", valueIds: [s.bl.id] }], source: "article", componentArticleId: s.parts.skruv.id, quantity: 4,
      configuratorOperationId: s.op30.id,
    });
    const [row] = await service.createVariants(s.article.id, { sets: { LOCK: ["A"], FARG: ["BL"], BREDD: [1200] }, calcQuantity: 10 }, null);
    expect(row!.status).toBe("created");
    expect(row!.warnings).toContain(`Komponent ${s.parts.skruv.articleNumber} kopplad till flera operationer — dras i operation 10`);
    const ops = await db.select().from(routingOperations).where(eq(routingOperations.articleId, row!.articleId!));
    const op10 = ops.find((o) => o.sequenceNo === 10)!;
    const skruvRows = (await db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, row!.articleId!)))
      .filter((b) => b.componentArticleId === s.parts.skruv.id);
    expect(skruvRows.map((b) => [Number(b.quantity), b.routingOperationId])).toEqual([[12, op10.id]]);
  });

  it("a manufacturing order on the variant releases the derived structure with operation links, skipping the costing-only operation", async () => {
    const s = await build();
    const [row] = await service.createVariants(s.article.id, { sets: { LOCK: ["A"], FARG: ["BL"], BREDD: [1200] }, calcQuantity: 10 }, null);
    const order = await mfgService.createManufacturingOrder({ articleId: row!.articleId!, quantity: 2 }, null);
    const ops = await mfgService.listOperations(order.id);
    expect(ops.map((o) => o.sequenceNo)).toEqual([10, 30]);
    const materials = await mfgService.listMaterialConsumptions(order.id);
    const byComponent = Object.fromEntries(materials.map((m) => [m.componentArticleId, [Number(m.quantityPlanned), m.moOperationId]]));
    expect(byComponent).toEqual({
      [s.parts.skruv.id]: [16, ops.find((o) => o.sequenceNo === 10)!.id],
      [s.parts.lasA.id]: [2, null],
      [s.parts.plat.id]: [4, null],
      [s.parts.lack.id]: [2, null],
    });
  });
});

describe("guards once variants exist", () => {
  it("locks the codes variants use: group and alternative codes cannot change, the alternative cannot be deleted but can be deactivated", async () => {
    const s = await build();
    const [row] = await service.createVariants(s.article.id, ONE, null);
    await expect(service.updateGroup(s.article.id, s.lock.id, { code: "LAS" })).rejects.toBeInstanceOf(ConfiguratorCodeLockedError);
    await expect(service.updateValue(s.article.id, s.lock.id, s.a.id, { code: "AA" })).rejects.toBeInstanceOf(ConfiguratorCodeLockedError);
    const err = await service.deleteValue(s.article.id, s.lock.id, s.a.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((err as Error).message).toContain(row!.articleNumber!);
    const groupErr = await service.deleteGroup(s.article.id, s.bredd.id).catch((e: unknown) => e);
    expect(groupErr).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((groupErr as Error).message).toContain(row!.articleNumber!);
    // Unused codes stay free; deactivation is allowed.
    expect((await service.updateValue(s.article.id, s.lock.id, s.b.id, { code: "BB" })).code).toBe("BB");
    expect((await service.updateValue(s.article.id, s.lock.id, s.a.id, { active: false })).active).toBe(false);
    expect((await service.updateGroup(s.article.id, s.lock.id, { name: "Lås, nytt namn" })).name).toBe("Lås, nytt namn");
  });

  // Konfigurator 4b: a configured beställningsvara row locks the codes its
  // stored selection spells, exactly as a variant's key does — the row keeps
  // its configuration whatever the order's status.
  it("locks the codes a configured order row uses (beställningsvara), naming the order row", async () => {
    const article = await makeArticle({ salesPrice: 1000 });
    await service.createTemplate(article.id, { mode: "to_order" });
    const lock = await service.createGroup(article.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
    const a = await service.createValue(article.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
    const b = await service.createValue(article.id, lock.id, { code: "B", name: "Lås B", priceAdd: 50, active: true });
    const bredd = await service.createGroup(article.id, {
      code: "BREDD", name: "Bredd", kind: "number", required: false, unit: "mm", minValue: 500, maxValue: 2000, step: null,
      defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
    });
    const [customer] = await db.insert(customers).values({ customerNumber: `K-${crypto.randomUUID().slice(0, 6)}`, name: "Kund" }).returning();
    const [order] = await db.insert(salesOrders).values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 8)}`, customerId: customer!.id }).returning();
    await db.insert(salesOrderRows).values({
      salesOrderId: order!.id, articleId: article.id, quantityOrdered: "1", unitPrice: "1000",
      configuration: {
        templateArticleId: article.id, key: "LOCK=A",
        selection: [
          { groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "A", valueName: "Lås A", value: "A", unit: null },
          { groupCode: "BREDD", groupName: "Bredd", kind: "number", valueCode: null, valueName: null, value: null, unit: "mm" },
        ],
        price: { base: 1000, additions: [], unitPrice: 1000, discountPercent: 0, source: "article" },
      },
    });

    await expect(service.updateGroup(article.id, lock.id, { code: "LAS" })).rejects.toBeInstanceOf(ConfiguratorCodeLockedError);
    await expect(service.updateValue(article.id, lock.id, a.id, { code: "AA" })).rejects.toBeInstanceOf(ConfiguratorCodeLockedError);
    const err = await service.deleteValue(article.id, lock.id, a.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((err as Error).message).toContain(`orderrad ${order!.orderNumber}`);
    // Deactivation is allowed; codes the row does not spell stay free (B, and
    // BREDD which has no value on the row).
    expect((await service.updateValue(article.id, lock.id, a.id, { active: false })).active).toBe(false);
    expect((await service.updateValue(article.id, lock.id, b.id, { code: "BB" })).code).toBe("BB");
    expect((await service.updateGroup(article.id, bredd.id, { code: "WIDTH" })).code).toBe("WIDTH");
  });

  it("refuses leaving the variants mode and deleting the template", async () => {
    const s = await build();
    await service.createVariants(s.article.id, ONE, null);
    await expect(service.updateTemplate(s.article.id, { mode: "to_order" })).rejects.toBeInstanceOf(ConfiguratorTemplateHasVariantsError);
    await expect(service.deleteTemplate(s.article.id)).rejects.toBeInstanceOf(ConfiguratorTemplateHasVariantsError);
    expect((await service.updateTemplate(s.article.id, { mode: "variants" })).mode).toBe("variants");
  });

  it("a variant cannot become a template", async () => {
    const s = await build();
    const [row] = await service.createVariants(s.article.id, ONE, null);
    await expect(service.createTemplate(row!.articleId!, { mode: "variants" })).rejects.toBeInstanceOf(ConfiguratorVariantNotTemplateError);
  });

  it("preview and create require the variants mode", async () => {
    const article = await makeArticle({ salesPrice: 1000 });
    await service.createTemplate(article.id, { mode: "to_order" });
    await expect(service.previewVariants(article.id, { sets: {}, calcQuantity: 1 })).rejects.toBeInstanceOf(ConfiguratorNotVariantModeError);
    await expect(service.createVariants(article.id, { sets: {}, calcQuantity: 1 }, null)).rejects.toBeInstanceOf(ConfiguratorNotVariantModeError);
  });

  it("lists the variants with stock on hand and answers variant-of", async () => {
    const s = await build();
    const [row] = await service.createVariants(s.article.id, ONE, null);
    const list = await service.listVariants(s.article.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      articleId: row!.articleId, articleNumber: row!.articleNumber, name: row!.name, salesPrice: "1000.0000", standardCost: "111.0000", onHand: "0", active: true,
    });
    expect(list[0]!.selection.map((e) => e.groupCode)).toEqual(["LOCK", "FARG", "BREDD"]);

    const of = await service.getVariantOf(row!.articleId!);
    expect(of).toMatchObject({
      templateArticleId: s.article.id, templateArticleNumber: s.article.articleNumber, templateName: "Papperskorg 50 l", calcQuantity: "10.0000",
    });
    expect(of.selection).toHaveLength(3);
    await expect(service.getVariantOf(s.article.id)).rejects.toBeInstanceOf(ConfiguratorVariantNotFoundError);
  });
});
