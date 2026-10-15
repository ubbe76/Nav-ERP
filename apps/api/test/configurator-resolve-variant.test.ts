import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, bomComponents, configuratorVariants, db, routingOperations } from "@navet/db";
import {
  ConfiguratorInvalidConfigurationError, ConfiguratorNotVariantModeError, ConfiguratorTemplateNotFoundError,
  ConfiguratorVariantNumberTakenError,
} from "../src/modules/configurator/service/configurator.errors.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { makeArticle, makeVariantService, resetConfigurator, testCostingSettings } from "./helpers/configurator.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Delprojekt 4a: resolveVariant — fetch-or-create one variant for a selection,
// the way the order forms' Konfigurera dialog uses it.

const service = makeVariantService();
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

async function reset() {
  await resetConfigurator();
  await db.execute(sql`TRUNCATE work_centers, routing_operations, cost_calculations CASCADE`);
  Object.assign(testCostingSettings, { costingMaterialSource: "standard", costingMoPercent: 0, costingLoPercent: 0, costingAffoPercent: 0, costingGeneralMarkupPercent: 0 });
}
beforeEach(reset);
afterAll(reset);

let seq = 0;
const part = (name: string, standardCost: number) =>
  testArticleService.createArticle({ articleNumber: `R-${(seq += 1)}-${crypto.randomUUID().slice(0, 6)}`, name, type: "purchased", unit: "st", standardCost } as never);

// LOCK (A/B, B +50) required, FARG default RD, BREDD 500–2000 required; one base BOM row on op 10.
async function build(opts: { orderQuantity?: number; salesPrice?: number } = {}) {
  const article = await makeArticle({ salesPrice: opts.salesPrice ?? 1000 });
  if (opts.orderQuantity !== undefined) await testArticleService.updateArticle(article.id, { orderQuantity: opts.orderQuantity } as never);
  await service.createTemplate(article.id, { mode: "variants" });
  const lock = await service.createGroup(article.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
  const a = await service.createValue(article.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
  const b = await service.createValue(article.id, lock.id, { code: "B", name: "Lås B", priceAdd: 50, active: true });
  const farg = await service.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false });
  const rd = await service.createValue(article.id, farg.id, { code: "RD", name: "Röd", priceAdd: 0, active: true });
  await service.updateGroup(article.id, farg.id, { defaultValueId: rd.id });
  const bredd = await service.createGroup(article.id, {
    code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", minValue: 500, maxValue: 2000, step: null,
    defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
  });
  const skruv = await part("Skruv", 2);
  const wc = await mfgService.createWorkCenter({ code: "301", name: "Montering", type: "machine", hourlyRate: 600, overheadPercent: 0, capacityFactor: 1, active: true });
  const op10 = await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: wc.id, setupTime: 5, runTimePerUnit: 1 });
  await testArticleService.addBomComponent(article.id, { componentArticleId: skruv.id, quantity: 8, routingOperationId: op10.id });
  return { article, lock, a, b, farg, rd, bredd, skruv, wc };
}

const SEL = { LOCK: "A", BREDD: 1200 };
const variantRows = () => db.select().from(configuratorVariants);

describe("resolveVariant", () => {
  it("creates the variant with structure, route, link and the template's order quantity as calc quantity", async () => {
    const s = await build({ orderQuantity: 10 });
    const res = await service.resolveVariant(s.article.id, SEL, null);
    expect(res.created).toBe(true);
    expect(res.article.articleNumber).toBe(`${s.article.articleNumber}-A-RD-1200`);
    expect(res.article.name).toBe("Papperskorg 50 l, Lås A, Röd, Bredd 1200 mm");
    expect(res.article).toMatchObject({ type: "manufactured", unitId: s.article.unitId, configuratorMode: null, salesPrice: "1000.0000" });
    const [link] = await variantRows();
    expect(link).toMatchObject({ articleId: res.article.id, templateArticleId: s.article.id, calcQuantity: "10.0000" });
    const bom = await db.select().from(bomComponents).where(eq(bomComponents.parentArticleId, res.article.id));
    expect(bom.map((b) => [b.componentArticleId, Number(b.quantity)])).toEqual([[s.skruv.id, 8]]);
    const ops = await db.select().from(routingOperations).where(eq(routingOperations.articleId, res.article.id));
    expect(ops.map((o) => o.sequenceNo)).toEqual([10]);
    // Standard cost = TVK/st at calc quantity 10: 8 × 2 = 16 material + (5 + 10)/60 × 600 = 150 ⇒ 310 / 10 = 31.
    expect(Number(res.article.standardCost)).toBe(31);
  });

  it("uses calc quantity 1 when the template has no order quantity", async () => {
    const s = await build();
    await service.resolveVariant(s.article.id, SEL, null);
    expect((await variantRows())[0]!.calcQuantity).toBe("1.0000");
  });

  it("returns the existing variant without writing, explicit default included, and even when inactive", async () => {
    const s = await build();
    const first = await service.resolveVariant(s.article.id, SEL, null);
    const again = await service.resolveVariant(s.article.id, { ...SEL, FARG: "RD" }, null);
    expect(again).toMatchObject({ created: false, article: { id: first.article.id } });
    await testArticleService.updateArticle(first.article.id, { active: false } as never);
    const inactive = await service.resolveVariant(s.article.id, SEL, null);
    expect(inactive.created).toBe(false);
    expect(inactive.article.active).toBe(false);
    expect(await variantRows()).toHaveLength(1);
    expect((await db.select({ id: articles.id }).from(articles).where(eq(articles.articleNumber, first.article.articleNumber)))).toHaveLength(1);
  });

  // Delprojekt 5: null clears the default (— Välj — in the order forms' Konfigurera on a variants template).
  it("null on a defaulted group resolves the variant WITHOUT that option; the missing key keeps the default", async () => {
    const s = await build();
    const cleared = await service.resolveVariant(s.article.id, { ...SEL, FARG: null }, null);
    expect(cleared.created).toBe(true);
    expect(cleared.article.articleNumber).toBe(`${s.article.articleNumber}-A-1200`);
    expect(cleared.article.name).toBe("Papperskorg 50 l, Lås A, Bredd 1200 mm");
    const withDefault = await service.resolveVariant(s.article.id, SEL, null);
    expect(withDefault.created).toBe(true);
    expect(withDefault.article.articleNumber).toBe(`${s.article.articleNumber}-A-RD-1200`);
    const links = await variantRows();
    expect(links.map((l) => l.configKey).sort()).toEqual(["BREDD=1200;FARG=RD;LOCK=A", "BREDD=1200;LOCK=A"]);
    // The stored selection carries the empty group, so a re-evaluation (variantPrice) keeps it empty.
    const link = links.find((l) => l.articleId === cleared.article.id)!;
    expect((link.selection as { groupCode: string; value: unknown }[]).find((e) => e.groupCode === "FARG")).toMatchObject({ value: null });
    // Same selection again ⇒ the existing cleared variant.
    expect(await service.resolveVariant(s.article.id, { ...SEL, FARG: null }, null)).toMatchObject({ created: false, article: { id: cleared.article.id } });
  });

  it("null on a required group ⇒ ConfiguratorInvalidConfigurationError, nothing created", async () => {
    const s = await build();
    const err = await service.resolveVariant(s.article.id, { ...SEL, LOCK: null }, null).catch((e) => e);
    expect(err).toBeInstanceOf(ConfiguratorInvalidConfigurationError);
    expect((err as ConfiguratorInvalidConfigurationError).details[0]).toBe("Välj Lås");
    expect(await variantRows()).toEqual([]);
  });

  it("required measure omitted ⇒ ConfiguratorInvalidConfigurationError with the group's message", async () => {
    const s = await build();
    const err = await service.resolveVariant(s.article.id, { LOCK: "A" }, null).catch((e) => e);
    expect(err).toBeInstanceOf(ConfiguratorInvalidConfigurationError);
    expect((err as ConfiguratorInvalidConfigurationError).details.join(" ")).toMatch(/Bredd/);
    expect(await variantRows()).toEqual([]);
  });

  it("a value out of range is invalid, not a variant", async () => {
    const s = await build();
    await expect(service.resolveVariant(s.article.id, { LOCK: "A", BREDD: 5000 }, null)).rejects.toBeInstanceOf(ConfiguratorInvalidConfigurationError);
  });

  it("a template in to_order ⇒ ConfiguratorNotVariantModeError; a plain article ⇒ ConfiguratorTemplateNotFoundError", async () => {
    const toOrder = await makeArticle({ salesPrice: 1000 });
    await service.createTemplate(toOrder.id, { mode: "to_order" });
    await expect(service.resolveVariant(toOrder.id, {}, null)).rejects.toBeInstanceOf(ConfiguratorNotVariantModeError);
    const plain = await makeArticle();
    await expect(service.resolveVariant(plain.id, {}, null)).rejects.toBeInstanceOf(ConfiguratorTemplateNotFoundError);
  });

  it("a taken article number ⇒ ConfiguratorVariantNumberTakenError with dp3's text", async () => {
    const s = await build();
    await testArticleService.createArticle({ articleNumber: `${s.article.articleNumber}-A-RD-1200`, name: "Krock", type: "purchased", unit: "st" } as never);
    const err = await service.resolveVariant(s.article.id, SEL, null).catch((e) => e);
    expect(err).toBeInstanceOf(ConfiguratorVariantNumberTakenError);
    expect((err as Error).message).toBe(`Artikelnumret ${s.article.articleNumber}-A-RD-1200 finns redan`);
  });

  it("two concurrent calls with the same selection give one variant", async () => {
    const s = await build();
    const [r1, r2] = await Promise.all([service.resolveVariant(s.article.id, SEL, null), service.resolveVariant(s.article.id, SEL, null)]);
    expect([r1.created, r2.created].sort()).toEqual([false, true]);
    expect(r1.article.id).toBe(r2.article.id);
    expect(await variantRows()).toHaveLength(1);
  });

  it("createVariants and resolveVariant agree: the mass-created combination is `exists` for the dialog", async () => {
    const s = await build();
    const [row] = await service.createVariants(s.article.id, { sets: { LOCK: ["A"], BREDD: [1200] }, calcQuantity: 10 }, null);
    const res = await service.resolveVariant(s.article.id, SEL, null);
    expect(res).toMatchObject({ created: false, article: { id: row!.articleId } });
  });
});
