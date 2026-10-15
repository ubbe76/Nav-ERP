import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@navet/db";
import { createConfiguratorService } from "../src/modules/configurator/service/configurator.service.js";
import {
  ConfiguratorCodeTakenError, ConfiguratorModeNotAllowedError, ConfiguratorReferenceInUseError, ConfiguratorReorderMismatchError,
  ConfiguratorTemplateExistsError, InvalidConfiguratorGroupError, InvalidConfiguratorRuleError,
} from "../src/modules/configurator/service/configurator.errors.js";
import { makeArticle, resetConfigurator, testCostingService, variantTestDeps } from "./helpers/configurator.js";
import { testArticleService } from "./helpers/services.js";
import {
  ConfiguratorGroupNotFoundError, ConfiguratorRuleNotFoundError, ConfiguratorTemplateNotFoundError, ConfiguratorValueNotFoundError,
} from "../src/modules/configurator/service/configurator.errors.js";
import { ArticleNotFoundError } from "../src/modules/article/service/article.service.js";
import { CustomerNotFoundError } from "../src/modules/sales/service/sales.service.js";
import { ZodError } from "zod";
import { sql } from "drizzle-orm";

const articles = {
  exists: async (id: string) => (await testArticleService.getArticle(id)) != null,
  isDescendant: (articleId: string, ancestorId: string) => testArticleService.isDescendant(articleId, ancestorId),
  find: (id: string) => testArticleService.getArticle(id),
};
const service = createConfiguratorService({
  db,
  prices: async () => ({ articleNumber: "X", price: { unitPrice: 900, discountPercent: 10, source: "customer_article" } }),
  customerExists: async (id) => id !== "00000000-0000-4000-8000-000000000000",
  articles,
  costing: testCostingService,
  ...variantTestDeps,
});

beforeEach(resetConfigurator);
afterAll(resetConfigurator);

async function setup() {
  const article = await makeArticle({ salesPrice: 1000 });
  await service.createTemplate(article.id, { mode: "variants" });
  const lock = await service.createGroup(article.id, { code: "LOCK", name: "Lock", kind: "choice", required: true });
  const a = await service.createValue(article.id, lock.id, { code: "A", name: "Lock A", priceAdd: 0, active: true });
  const c = await service.createValue(article.id, lock.id, { code: "C", name: "Lock C", priceAdd: 300, active: true });
  const farg = await service.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false });
  const ep = await service.createValue(article.id, farg.id, { code: "EP", name: "Elpolerad", priceAdd: 400, active: true });
  return { article, lock, a, c, farg, ep };
}

describe("configurator service", () => {
  it("creates a template, groups and values and returns them ordered", async () => {
    const { article } = await setup();
    const t = await service.getTemplate(article.id);
    expect(t.mode).toBe("variants");
    expect(t.basePrice).toBe("1000.0000");
    expect(t.groups.map((g) => g.code)).toEqual(["LOCK", "FARG"]);
    expect(t.groups[0]!.values.map((v) => v.code)).toEqual(["A", "C"]);
  });

  it("refuses a second template, both modes on a purchased article and any phantom", async () => {
    const { article } = await setup();
    await expect(service.createTemplate(article.id, { mode: "variants" })).rejects.toBeInstanceOf(ConfiguratorTemplateExistsError);
    const bought = await makeArticle({ type: "purchased" });
    await expect(service.createTemplate(bought.id, { mode: "to_order" })).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
    const variantsOnBought = await service.createTemplate(bought.id, { mode: "variants" }).catch((e: unknown) => e);
    expect(variantsOnBought).toBeInstanceOf(ConfiguratorModeNotAllowedError);
    expect((variantsOnBought as Error).message).toBe("Variantartiklar kräver en tillverkad artikel");
    const phantom = await makeArticle({ isPhantom: true });
    await expect(service.createTemplate(phantom.id, { mode: "variants" })).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
    const svc = await makeArticle({ type: "service" });
    await expect(service.createTemplate(svc.id, { mode: "variants" })).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
  });

  it("refuses a type change on a template article that breaks the mode", async () => {
    const article = await makeArticle();
    await service.createTemplate(article.id, { mode: "to_order" });
    await expect(testArticleService.updateArticle(article.id, { type: "purchased" } as never)).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
  });

  it("409s a duplicate group code and a duplicate value code", async () => {
    const { article, lock } = await setup();
    await expect(service.createGroup(article.id, { code: "LOCK", name: "Igen", kind: "boolean", priceAdd: 0 })).rejects.toBeInstanceOf(ConfiguratorCodeTakenError);
    await expect(service.createValue(article.id, lock.id, { code: "A", name: "Dubblett", priceAdd: 0, active: true })).rejects.toBeInstanceOf(ConfiguratorCodeTakenError);
  });

  it("rejects fields that do not belong to the group's kind and a default from another group", async () => {
    const { article, lock, ep } = await setup();
    await expect(service.updateGroup(article.id, lock.id, { unit: "mm" })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
    await expect(service.updateGroup(article.id, lock.id, { defaultValueId: ep.id })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
  });

  it("validates rules against the template", async () => {
    const { article, lock, c, farg, ep } = await setup();
    const ok = await service.createRule(article.id, {
      effect: "exclude", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, valueIds: [c.id] },
      message: "Elpolerad finns inte med lock C", active: true,
    });
    expect(ok.effect).toBe("exclude");
    await expect(
      service.createRule(article.id, { effect: "exclude", conditions: [{ groupId: lock.id, op: "is", valueIds: [c.id] }], target: { groupId: lock.id, valueIds: [c.id] }, message: "Egen", active: true })
    ).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    await expect(
      service.createRule(article.id, { effect: "exclude", conditions: [{ groupId: farg.id, op: "is", valueIds: [c.id] }], target: { groupId: lock.id, valueIds: [c.id] }, message: "Fel grupp", active: true })
    ).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    await expect(
      service.createRule(article.id, { effect: "limit", conditions: [], target: { groupId: lock.id, max: 3 }, message: "Fel sort", active: true })
    ).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    const other = await setup();
    await expect(
      service.createRule(article.id, { effect: "require", conditions: [], target: { groupId: other.lock.id, op: "is", valueIds: [other.a.id] }, message: "Annan mall", active: true })
    ).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
  });

  it("delete refused while referenced; listing the rule messages", async () => {
    const { article, lock, c, farg, ep } = await setup();
    await service.createRule(article.id, {
      effect: "exclude", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, valueIds: [c.id] },
      message: "Elpolerad finns inte med lock C", active: true,
    });
    const err = await service.deleteValue(article.id, lock.id, c.id).catch((e) => e);
    expect(err).toBeInstanceOf(ConfiguratorReferenceInUseError);
    expect((err as ConfiguratorReferenceInUseError).references).toEqual(["Regel: Elpolerad finns inte med lock C"]);
    await expect(service.deleteGroup(article.id, farg.id)).rejects.toBeInstanceOf(ConfiguratorReferenceInUseError);
  });

  it("rule referencing a deleted group cannot be stored (concurrent delete serialises on the template lock)", async () => {
    const { article, lock, c, farg, ep } = await setup();
    await Promise.allSettled([
      service.deleteGroup(article.id, farg.id),
      service.createRule(article.id, {
        effect: "exclude", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, valueIds: [c.id] },
        message: "Kapplöpning", active: true,
      }),
    ]);
    const t = await service.getTemplate(article.id);
    const groupIds = new Set(t.groups.map((g) => g.id));
    for (const r of t.rules) for (const cond of r.conditions) expect(groupIds.has(cond.groupId)).toBe(true);
  });

  // Deterministic version of the race above: the brief's test passes even
  // without the lock (the delete simply wins), so this one forces the bad
  // interleaving. An outer transaction holds the template lock and deletes the
  // group; the rule save must wait for it and validate against the template
  // as it is AFTER that commit. Without lock-then-load the save would load the
  // old template during the 200 ms and store a dangling rule.
  it("a rule save waits for the template lock and validates against the template after it", async () => {
    const { article, lock, c, farg, ep } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM configurator_templates WHERE article_id = ${article.id} FOR UPDATE`);
      signalLocked();
      await gate;
      await tx.execute(sql`DELETE FROM configurator_groups WHERE id = ${farg.id}`);
    });
    await locked;
    const save = service
      .createRule(article.id, {
        effect: "exclude", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, valueIds: [c.id] },
        message: "Kapplöpning", active: true,
      })
      .then(() => "stored", (e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await holder;
    expect(await save).toBeInstanceOf(InvalidConfiguratorRuleError);
    expect((await service.getTemplate(article.id)).rules).toEqual([]);
  });

  it("reorder needs exactly the template's set", async () => {
    const { article, lock, farg } = await setup();
    await service.reorderGroups(article.id, [farg.id, lock.id]);
    expect((await service.getTemplate(article.id)).groups.map((g) => g.code)).toEqual(["FARG", "LOCK"]);
    await expect(service.reorderGroups(article.id, [farg.id])).rejects.toBeInstanceOf(ConfiguratorReorderMismatchError);
  });

  it("deleting a template removes groups and rules", async () => {
    const { article } = await setup();
    await service.deleteTemplate(article.id);
    await expect(service.getTemplate(article.id)).rejects.toThrow();
  });

  it("evaluate: base price from the article, customer chain replaces it", async () => {
    const { article } = await setup();
    const plain = await service.evaluate(article.id, { selection: { LOCK: "C", FARG: "EP" }, quantity: 1 });
    expect(plain.price.unitPrice).toBe(1700);
    expect(plain.key).toBe("FARG=EP;LOCK=C");
    const customer = await service.evaluate(article.id, { selection: { LOCK: "C" }, customerId: crypto.randomUUID(), quantity: 1 });
    expect(customer.price).toMatchObject({ base: 900, unitPrice: 1200, discountPercent: 10 });
  });
});

// Beyond the brief's minimum: op vs group kind (the engine does not check it,
// so the save validation is the only guard), not-found paths, number groups,
// default reset, reorder of values/rules, phantom flip, evaluate edge cases.
describe("configurator service — further cases", () => {
  const numberGroup = {
    kind: "number" as const, required: false, unit: "mm", minValue: 300, maxValue: 1200, step: null, defaultNumber: null,
    pricePerUnit: 0, priceBaseValue: 0,
  };

  async function withBooleanAndNumber() {
    const base = await setup();
    const hjul = await service.createGroup(base.article.id, { code: "HJUL", name: "Hjul", kind: "boolean", priceAdd: 150 });
    const bredd = await service.createGroup(base.article.id, { code: "BREDD", name: "Bredd", ...numberGroup });
    return { ...base, hjul, bredd };
  }

  it("rejects a condition or require target whose op does not match its group's kind", async () => {
    const { article, lock, a, c, farg, ep, hjul, bredd } = await withBooleanAndNumber();
    const rule = (conditions: unknown[], target: unknown, effect: "exclude" | "require" | "limit" = "exclude") =>
      service.createRule(article.id, { effect, conditions: conditions as never, target, message: "x", active: true });
    const excludeC = { groupId: lock.id, valueIds: [c.id] };
    // `is` on a boolean
    await expect(rule([{ groupId: hjul.id, op: "is", valueIds: [ep.id] }], excludeC)).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // `selected` on a choice
    await expect(rule([{ groupId: farg.id, op: "selected" }], excludeC)).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // a comparison on a choice
    await expect(rule([{ groupId: farg.id, op: "gt", value: 1 }], excludeC)).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // `selected` on a number
    await expect(rule([{ groupId: bredd.id, op: "not_selected" }], excludeC)).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // `is_not` on a number
    await expect(rule([{ groupId: bredd.id, op: "is_not", valueIds: [a.id] }], excludeC)).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // require targets: `selected` on a choice, comparison on a boolean
    await expect(rule([], { groupId: lock.id, op: "selected" }, "require")).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    await expect(rule([], { groupId: hjul.id, op: "ge", value: 2 }, "require")).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // exclude on a boolean / number group
    await expect(rule([], { groupId: hjul.id, valueIds: [a.id] })).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // a condition on a group that is not in the template
    await expect(rule([{ groupId: crypto.randomUUID(), op: "selected" }], excludeC)).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);

    // the matching ops are accepted
    await rule([{ groupId: hjul.id, op: "selected" }, { groupId: bredd.id, op: "gt", value: 900 }], excludeC);
    await rule([{ groupId: farg.id, op: "is_not", valueIds: [ep.id] }], { groupId: hjul.id, op: "not_selected" }, "require");
    await rule([{ groupId: hjul.id, op: "selected" }], { groupId: bredd.id, max: 1000 }, "limit");
    expect((await service.getTemplate(article.id)).rules).toHaveLength(3);
  });

  it("names the rule error in Swedish when the target sits in its own conditions", async () => {
    const { article, lock, c } = await setup();
    const err = await service
      .createRule(article.id, { effect: "exclude", conditions: [{ groupId: lock.id, op: "is_not", valueIds: [c.id] }], target: { groupId: lock.id, valueIds: [c.id] }, message: "x", active: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InvalidConfiguratorRuleError);
    expect(err.message).toBe("Målgruppen kan inte stå i regelns egna villkor");
  });

  it("a target that does not match the effect's shape is a ZodError (400 in the route)", async () => {
    const { article, lock } = await setup();
    await expect(
      service.createRule(article.id, { effect: "limit", conditions: [], target: { groupId: lock.id }, message: "x", active: true })
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("updateRule validates the merged effect, conditions and target", async () => {
    const { article, lock, c, farg, ep } = await setup();
    const rule = await service.createRule(article.id, {
      effect: "exclude", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, valueIds: [c.id] },
      message: "Elpolerad finns inte med lock C", active: true,
    });
    // conditions only — now the target group is in its own conditions
    await expect(
      service.updateRule(article.id, rule.id, { conditions: [{ groupId: lock.id, op: "is", valueIds: [c.id] }] })
    ).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    // effect only — a changed effect needs a new target (the stored one belongs to the old effect)
    const effectOnly = await service.updateRule(article.id, rule.id, { effect: "require" }).catch((e) => e);
    expect(effectOnly).toBeInstanceOf(InvalidConfiguratorRuleError);
    expect(effectOnly.message).toBe("Ange mål när effekten ändras");
    // the same effect without a target keeps the stored target
    expect(await service.updateRule(article.id, rule.id, { effect: "exclude" })).toMatchObject({ effect: "exclude", target: { groupId: lock.id, valueIds: [c.id] } });
    const updated = await service.updateRule(article.id, rule.id, { message: "Ny text", active: false });
    expect(updated).toMatchObject({ message: "Ny text", active: false, effect: "exclude" });
    await expect(service.updateRule(article.id, crypto.randomUUID(), { message: "x" })).rejects.toBeInstanceOf(ConfiguratorRuleNotFoundError);
    await service.deleteRule(article.id, rule.id);
    await expect(service.deleteRule(article.id, rule.id)).rejects.toBeInstanceOf(ConfiguratorRuleNotFoundError);
    // with the rule gone the value can be deleted
    await service.deleteValue(article.id, lock.id, c.id);
  });

  it("an effect-only PATCH never turns a require rule into its opposite", async () => {
    const { article, lock, c, farg, ep } = await setup();
    const rule = await service.createRule(article.id, {
      effect: "require", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, op: "is", valueIds: [c.id] },
      message: "Elpolerad kräver lock C", active: true,
    });
    await expect(service.updateRule(article.id, rule.id, { effect: "exclude" })).rejects.toBeInstanceOf(InvalidConfiguratorRuleError);
    const stored = (await service.getTemplate(article.id)).rules.find((r) => r.id === rule.id)!;
    expect(stored).toMatchObject({ effect: "require", target: { groupId: lock.id, op: "is", valueIds: [c.id] } });
    // effect + a matching new target is accepted
    const flipped = await service.updateRule(article.id, rule.id, { effect: "exclude", target: { groupId: lock.id, valueIds: [c.id] } });
    expect(flipped).toMatchObject({ effect: "exclude", target: { groupId: lock.id, valueIds: [c.id] } });
  });

  it("target schemas are strict: a target shaped for another effect is a ZodError, not silently stripped", async () => {
    const { article, lock, c, farg, ep } = await setup();
    const cond = [{ groupId: farg.id, op: "is" as const, valueIds: [ep.id] }];
    // a require-shaped target under exclude
    await expect(
      service.createRule(article.id, { effect: "exclude", conditions: cond, target: { groupId: lock.id, op: "is", valueIds: [c.id] }, message: "x", active: true })
    ).rejects.toBeInstanceOf(ZodError);
    // an exclude target with extra keys under limit / require
    await expect(
      service.createRule(article.id, { effect: "limit", conditions: cond, target: { groupId: lock.id, max: 3, valueIds: [c.id] }, message: "x", active: true })
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      service.createRule(article.id, { effect: "require", conditions: cond, target: { groupId: lock.id, op: "is", valueIds: [c.id], min: 1 }, message: "x", active: true })
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("deleting a group, and a whole template, while a group default points at one of its values", async () => {
    const { article, lock, a, farg, ep } = await setup();
    await service.updateGroup(article.id, lock.id, { defaultValueId: a.id });
    await service.updateGroup(article.id, farg.id, { defaultValueId: ep.id });
    await service.deleteGroup(article.id, lock.id);
    expect((await service.getTemplate(article.id)).groups.map((g) => g.code)).toEqual(["FARG"]);
    await service.deleteTemplate(article.id);
    await expect(service.getTemplate(article.id)).rejects.toBeInstanceOf(ConfiguratorTemplateNotFoundError);
  });

  it("deleting a value resets a group default that pointed at it", async () => {
    const { article, lock, a } = await setup();
    const g = await service.updateGroup(article.id, lock.id, { defaultValueId: a.id });
    expect(g.defaultValueId).toBe(a.id);
    await service.deleteValue(article.id, lock.id, a.id);
    const t = await service.getTemplate(article.id);
    expect(t.groups.find((x) => x.id === lock.id)!.defaultValueId).toBeNull();
  });

  it("refuses an inactive default and checks a number group's merged range", async () => {
    const { article, lock, a, bredd, hjul } = await withBooleanAndNumber();
    await service.updateValue(article.id, lock.id, a.id, { active: false });
    await expect(service.updateGroup(article.id, lock.id, { defaultValueId: a.id })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
    await expect(service.updateGroup(article.id, bredd.id, { minValue: 1300 })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
    await service.updateGroup(article.id, bredd.id, { defaultNumber: 600 });
    await expect(service.updateGroup(article.id, bredd.id, { maxValue: 500 })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
    const g = await service.updateGroup(article.id, bredd.id, { maxValue: 800, step: 0.5, unit: "cm" });
    expect(g).toMatchObject({ maxValue: "800.0000", step: "0.5000", unit: "cm", defaultNumber: "600.0000" });
    // boolean groups have no `required` and no number fields
    await expect(service.updateGroup(article.id, hjul.id, { required: true })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
    await expect(service.updateGroup(article.id, hjul.id, { minValue: 1 })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
    // choice groups have no price of their own
    await expect(service.updateGroup(article.id, lock.id, { priceAdd: 5 })).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
    expect((await service.updateGroup(article.id, hjul.id, { priceAdd: 99.5, name: "Hjul (4 st)" })).priceAdd).toBe("99.50");
  });

  it("a code change to a taken code is 409; values only live in list groups", async () => {
    const { article, lock, farg, a, hjul } = await withBooleanAndNumber();
    await expect(service.updateGroup(article.id, farg.id, { code: "LOCK" })).rejects.toBeInstanceOf(ConfiguratorCodeTakenError);
    await expect(service.updateValue(article.id, lock.id, a.id, { code: "C" })).rejects.toBeInstanceOf(ConfiguratorCodeTakenError);
    expect((await service.updateGroup(article.id, farg.id, { code: "YTA" })).code).toBe("YTA");
    await expect(
      service.createValue(article.id, hjul.id, { code: "X", name: "X", priceAdd: 0, active: true })
    ).rejects.toBeInstanceOf(InvalidConfiguratorGroupError);
  });

  it("not-found paths: template, group, value", async () => {
    const plain = await makeArticle();
    await expect(service.getTemplate(plain.id)).rejects.toBeInstanceOf(ConfiguratorTemplateNotFoundError);
    await expect(service.createGroup(plain.id, { code: "X", name: "X", kind: "boolean", priceAdd: 0 })).rejects.toBeInstanceOf(ConfiguratorTemplateNotFoundError);
    await expect(service.updateTemplate(plain.id, { mode: "variants" })).rejects.toBeInstanceOf(ConfiguratorTemplateNotFoundError);
    await expect(service.deleteTemplate(plain.id)).rejects.toBeInstanceOf(ConfiguratorTemplateNotFoundError);
    await expect(service.createTemplate(crypto.randomUUID(), { mode: "variants" })).rejects.toBeInstanceOf(ArticleNotFoundError);
    const { article, lock, a } = await setup();
    const other = await setup();
    // a group of another template is not found here
    await expect(service.deleteGroup(article.id, other.lock.id)).rejects.toBeInstanceOf(ConfiguratorGroupNotFoundError);
    await expect(service.updateGroup(article.id, other.lock.id, { name: "x" })).rejects.toBeInstanceOf(ConfiguratorGroupNotFoundError);
    await expect(service.updateValue(article.id, lock.id, other.a.id, { name: "x" })).rejects.toBeInstanceOf(ConfiguratorValueNotFoundError);
    await expect(service.deleteValue(article.id, other.lock.id, other.a.id)).rejects.toBeInstanceOf(ConfiguratorGroupNotFoundError);
    await expect(service.deleteValue(article.id, lock.id, crypto.randomUUID())).rejects.toBeInstanceOf(ConfiguratorValueNotFoundError);
    expect((await service.updateValue(article.id, lock.id, a.id, { name: "Lock A2", priceAdd: -50 })).priceAdd).toBe("-50.00");
  });

  it("updateTemplate switches mode on a template without variants", async () => {
    const { article } = await setup();
    expect((await service.updateTemplate(article.id, { mode: "to_order" })).mode).toBe("to_order");
    expect((await service.updateTemplate(article.id, { mode: "variants" })).mode).toBe("variants");
  });

  it("refuses making a template article phantom or anything but manufactured", async () => {
    const article = await makeArticle();
    await service.createTemplate(article.id, { mode: "variants" });
    await expect(testArticleService.updateArticle(article.id, { isPhantom: true } as never)).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
    await expect(testArticleService.updateArticle(article.id, { type: "purchased" } as never)).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
    await expect(testArticleService.updateArticle(article.id, { type: "service" } as never)).rejects.toBeInstanceOf(ConfiguratorModeNotAllowedError);
    expect((await testArticleService.getArticle(article.id))!.type).toBe("manufactured");
    // an article without a template changes freely
    const free = await makeArticle();
    expect((await testArticleService.updateArticle(free.id, { type: "service" } as never))!.type).toBe("service");
  });

  it("reorders values and rules; refuses duplicates and foreign ids", async () => {
    const { article, lock, a, c, farg, ep } = await setup();
    await service.reorderValues(article.id, lock.id, [c.id, a.id]);
    expect((await service.getTemplate(article.id)).groups[0]!.values.map((v) => v.code)).toEqual(["C", "A"]);
    await expect(service.reorderValues(article.id, lock.id, [c.id, c.id])).rejects.toBeInstanceOf(ConfiguratorReorderMismatchError);
    await expect(service.reorderValues(article.id, lock.id, [c.id, ep.id])).rejects.toBeInstanceOf(ConfiguratorReorderMismatchError);
    const r1 = await service.createRule(article.id, { effect: "exclude", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, valueIds: [c.id] }, message: "R1", active: true });
    const r2 = await service.createRule(article.id, { effect: "require", conditions: [{ groupId: farg.id, op: "is", valueIds: [ep.id] }], target: { groupId: lock.id, op: "is", valueIds: [a.id] }, message: "R2", active: true });
    expect((await service.getTemplate(article.id)).rules.map((r) => r.message)).toEqual(["R1", "R2"]);
    await service.reorderRules(article.id, [r2.id, r1.id]);
    expect((await service.getTemplate(article.id)).rules.map((r) => r.message)).toEqual(["R2", "R1"]);
    await expect(service.reorderRules(article.id, [r2.id, r1.id, crypto.randomUUID()])).rejects.toBeInstanceOf(ConfiguratorReorderMismatchError);
    await expect(service.reorderGroups(article.id, [farg.id, farg.id])).rejects.toBeInstanceOf(ConfiguratorReorderMismatchError);
  });

  it("evaluate: unknown customer is CustomerNotFoundError; no price from the chain keeps the base price", async () => {
    const { article } = await setup();
    await expect(
      service.evaluate(article.id, { selection: {}, customerId: "00000000-0000-4000-8000-000000000000", quantity: 1 })
    ).rejects.toBeInstanceOf(CustomerNotFoundError);
    const noChain = createConfiguratorService({ db, prices: async () => ({ articleNumber: "X", price: null }), customerExists: async () => true, articles, costing: testCostingService, ...variantTestDeps });
    const res = await noChain.evaluate(article.id, { selection: { LOCK: "C" }, customerId: crypto.randomUUID(), quantity: 1 });
    expect(res.price).toMatchObject({ base: 1000, unitPrice: 1300, discountPercent: 0, source: "article" });
    const plain = await makeArticle();
    await expect(service.evaluate(plain.id, { selection: {}, quantity: 1 })).rejects.toBeInstanceOf(ConfiguratorTemplateNotFoundError);
  });

  it("evaluate without a sales price warns and leaves the price null; numbers reach the engine as numbers", async () => {
    const article = await makeArticle();
    await service.createTemplate(article.id, { mode: "variants" });
    await service.createGroup(article.id, { code: "BREDD", name: "Bredd", ...numberGroup, step: 0.5, pricePerUnit: 2, priceBaseValue: 600 });
    const res = await service.evaluate(article.id, { selection: { BREDD: 800.5 }, quantity: 1 });
    expect(res.valid).toBe(true);
    expect(res.key).toBe("BREDD=800.5");
    expect(res.price.base).toBeNull();
    expect(res.price.unitPrice).toBeNull();
    expect(res.price.additions).toEqual([{ groupCode: "BREDD", label: "Bredd: 800,5 mm", amount: 401 }]);
    expect(res.warnings).toEqual(["Grundpris saknas — ange försäljningspris på artikeln"]);
    const bad = await service.evaluate(article.id, { selection: { BREDD: 800.25 }, quantity: 1 });
    expect(bad.valid).toBe(false);
  });

  it("a choice group can fill an article field; null clears it", async () => {
    const article = await makeArticle();
    await service.createTemplate(article.id, { mode: "variants" });
    const g = await service.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false, articleField: "colour" });
    expect(g.articleField).toBe("colour");
    const cleared = await service.updateGroup(article.id, g.id, { articleField: null });
    expect(cleared.articleField).toBeNull();
    const plain = await service.createGroup(article.id, { code: "YTA", name: "Yta", kind: "choice", required: false });
    expect(plain.articleField).toBeNull();
  });

  it("article field is rejected on a boolean group and cannot be taken twice in a template", async () => {
    const article = await makeArticle();
    await service.createTemplate(article.id, { mode: "variants" });
    const hjul = await service.createGroup(article.id, { code: "HJUL", name: "Hjul", kind: "boolean", priceAdd: 0 });
    await expect(service.updateGroup(article.id, hjul.id, { articleField: "colour" })).rejects.toThrow("Fyller artikelns fält gäller inte för ett ja/nej");
    await service.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false, articleField: "colour" });
    await expect(
      service.createGroup(article.id, { code: "FARG2", name: "Kulör", kind: "choice", required: false, articleField: "colour" })
    ).rejects.toThrow("Färg fylls redan av valgruppen Färg");
    const other = await service.createGroup(article.id, { code: "YTA", name: "Yta", kind: "choice", required: false });
    const err = await service.updateGroup(article.id, other.id, { articleField: "colour" }).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidConfiguratorGroupError);
  });
});
