import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customerPrices, customers, db, priceListRows, priceLists, salesOrderRows } from "@navet/db";
import type { OrderRowConfiguration } from "@navet/shared";
import {
  ConfigurationNotAllowedError,
  ConfigurationRequiredError,
  PriceNotFoundError,
  RowConfigurationOutdatedError,
  RowVariantExistsError,
} from "../src/modules/sales/service/sales.errors.js";
import { ConfiguratorInvalidConfigurationError, ConfiguratorNotToOrderModeError } from "../src/modules/configurator/service/configurator.errors.js";
import { makeArticle } from "./helpers/configurator.js";
import { buildToOrder, configurator, makeCustomer, resetConfiguredRows, salesService } from "./helpers/configured-rows.js";

// Delprojekt 4b: a beställningsvara (template in to_order) on the order row —
// the configuration is evaluated, stored and priced on the row.

beforeEach(resetConfiguredRows);
afterAll(resetConfiguredRows);

const SEL = { LOCK: "B", BREDD: 1200 };
const rowsOf = (orderId: string) => salesService.listRows(orderId);
const cfgOf = (row: { configuration: unknown }) => row.configuration as OrderRowConfiguration;

describe("configured rows — create", () => {
  it("stores selection with labels, price split and prices the row from the template's chain", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 2, configuration: { selection: { ...SEL, AVLOPP: true } } }] } as never,
      null
    );
    const [row] = await rowsOf(order.id);
    expect(row!.articleId).toBe(article.id);
    expect(Number(row!.unitPrice)).toBe(1150);
    expect(Number(row!.discountPercent)).toBe(0);
    expect(row!.variantTemplateArticleId).toBeNull();
    const cfg = cfgOf(row!);
    expect(cfg.templateArticleId).toBe(article.id);
    expect(cfg.key).toBeTruthy();
    expect(cfg.selection.map((e) => [e.groupCode, e.value, e.valueName])).toEqual([
      ["LOCK", "B", "Lås B"],
      ["AVLOPP", true, null],
      ["BREDD", 1200, null],
    ]);
    expect(cfg.price).toMatchObject({ base: 1000, unitPrice: 1150, discountPercent: 0, source: "article" });
    expect(cfg.price.additions.map((a) => [a.groupCode, a.amount])).toEqual([
      ["LOCK", 50],
      ["AVLOPP", 100],
    ]);
  });

  it("two identical configured rows are both stored, and two different ones too", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      {
        customerId: c.id,
        rows: [
          { articleId: article.id, quantity: 1, configuration: { selection: SEL } },
          { articleId: article.id, quantity: 1, configuration: { selection: SEL } },
        ],
      } as never,
      null
    );
    await salesService.addRow(order.id, { articleId: article.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 800 } } } as never);
    expect(await rowsOf(order.id)).toHaveLength(3);
  });

  it("ordinary rows keep the duplicate guard, and the freight row is still found by article", async () => {
    const { article } = await buildToOrder();
    const plain = await makeArticle({ salesPrice: 100 });
    const frakt = await makeArticle({ salesPrice: 0 });
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      {
        customerId: c.id,
        rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }, { articleId: plain.id, quantity: 1 }],
      } as never,
      null
    );
    const dup = await salesService.addRow(order.id, { articleId: plain.id, quantity: 1 } as never).catch((e: unknown) => e);
    // The partial unique index, surfaced as the domain error (409 over HTTP).
    expect(dup).toBeInstanceOf(RowVariantExistsError);
    const added = await salesService.setFreightRow(order.id, { articleId: frakt.id, unitPrice: 250 });
    const repriced = await salesService.setFreightRow(order.id, { articleId: frakt.id, unitPrice: 300 });
    expect(repriced.id).toBe(added.id);
    expect(Number(repriced.unitPrice)).toBe(300);
    expect(await rowsOf(order.id)).toHaveLength(3);
  });

  it("the customer's chain on the template and the discount flow into the row; two customers differ", async () => {
    const { article } = await buildToOrder();
    const c1 = await makeCustomer(10);
    const c2 = await makeCustomer();
    await db.insert(customerPrices).values({ customerId: c2.id, articleId: article.id, fromQuantity: "1", unitPrice: "900", discountPercent: null });
    const q1 = await salesService.createQuote(
      { customerId: c1.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const q2 = await salesService.createQuote(
      { customerId: c2.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [r1] = await rowsOf(q1.order.id);
    const [r2] = await rowsOf(q2.order.id);
    expect([Number(r1!.unitPrice), Number(r1!.discountPercent), cfgOf(r1!).price.source]).toEqual([1050, 10, "customer_discount"]);
    expect([Number(r2!.unitPrice), Number(r2!.discountPercent), cfgOf(r2!).price.source]).toEqual([950, 0, "customer_article"]);
  });

  it("a manual price stands; the configuration still carries the engine's split", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 777, discountPercent: 5, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await rowsOf(order.id);
    expect([Number(row!.unitPrice), Number(row!.discountPercent)]).toEqual([777, 5]);
    expect(cfgOf(row!).price.unitPrice).toBe(1050);
  });

  it("a template without base price needs a manual price", async () => {
    const { article } = await buildToOrder({ salesPrice: null });
    const c = await makeCustomer();
    await expect(
      salesService.createQuote({ customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never, null)
    ).rejects.toBeInstanceOf(PriceNotFoundError);
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 500, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await rowsOf(order.id);
    expect(cfgOf(row!).price).toMatchObject({ unitPrice: null, source: null });
    await expect(salesService.updateRow(order.id, row!.id, { quantity: 3 } as never)).rejects.toBeInstanceOf(PriceNotFoundError);
  });

  it("a quantity change is refused when the template has since given the choices a förval the row doesn't show", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await rowsOf(order.id);
    expect(Number(row!.unitPrice)).toBe(1050);

    // A group added later, with a förval that costs extra.
    const montage = await configurator.createGroup(article.id, { code: "MONTAGE", name: "Montage", kind: "choice", required: false });
    const ja = await configurator.createValue(article.id, montage.id, { code: "JA", name: "Med montage", priceAdd: 300, active: true });
    await configurator.updateGroup(article.id, montage.id, { defaultValueId: ja.id });

    // Repriced at the new quantity, the row would cost 1350 for choices
    // that still list only Lås and Bredd.
    await expect(salesService.updateRow(order.id, row!.id, { quantity: 3 } as never)).rejects.toBeInstanceOf(RowConfigurationOutdatedError);
    await expect(salesService.updateRow(order.id, row!.id, { quantity: 3, unitPrice: 1050 } as never)).rejects.toBeInstanceOf(
      RowConfigurationOutdatedError
    );
    // The same quantity evaluates nothing: a price edit still works.
    const kept = await salesService.updateRow(order.id, row!.id, { quantity: 1, unitPrice: 990 } as never);
    expect(Number(kept.row.unitPrice)).toBe(990);
  });

  it("refuses: template without configuration (409), configuration on a plain article (400), invalid configuration (400 with details)", async () => {
    const { article } = await buildToOrder();
    const plain = await makeArticle({ salesPrice: 100 });
    const c = await makeCustomer();
    await expect(salesService.createQuote({ customerId: c.id, rows: [{ articleId: article.id, quantity: 1 }] } as never, null)).rejects.toBeInstanceOf(
      ConfigurationRequiredError
    );
    await expect(
      salesService.createQuote({ customerId: c.id, rows: [{ articleId: plain.id, quantity: 1, configuration: { selection: {} } }] } as never, null)
    ).rejects.toBeInstanceOf(ConfigurationNotAllowedError);
    const err = await salesService
      .createQuote({ customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: { LOCK: "B" } } }] } as never, null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfiguratorInvalidConfigurationError);
    expect((err as ConfiguratorInvalidConfigurationError).details.join(" ")).toMatch(/Bredd/);
    expect(await db.select().from(salesOrderRows)).toEqual([]);
  });

  // Delprojekt 5: a configuration on a variants template resolves the variant
  // instead (configurator-public-quotes.test.ts); the template itself is still
  // refused WITHOUT one (assertOrderableArticle unchanged).
  it("a variants template without a configuration is still refused as a template", async () => {
    const mall = await makeArticle({ salesPrice: 1000 });
    await configurator.createTemplate(mall.id, { mode: "variants" });
    const c = await makeCustomer();
    await expect(
      salesService.createQuote({ customerId: c.id, rows: [{ articleId: mall.id, quantity: 1 }] } as never, null)
    ).rejects.toMatchObject({ name: "ArticleIsTemplateError" });
  });
});

describe("configured rows — quantity change", () => {
  it("crossing a break on the template's price list reprices; a manual price or a unit-only patch does not", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const [list] = await db.insert(priceLists).values({ code: `PL-${crypto.randomUUID().slice(0, 8)}`, name: "Lista" }).returning();
    await db.update(customers).set({ priceListId: list!.id }).where(eq(customers.id, c.id));
    await db.insert(priceListRows).values([
      { priceListId: list!.id, articleId: article.id, fromQuantity: "1", unitPrice: "800" },
      { priceListId: list!.id, articleId: article.id, fromQuantity: "10", unitPrice: "700" },
    ]);
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await rowsOf(order.id);
    expect(Number(row!.unitPrice)).toBe(850);
    await salesService.updateRow(order.id, row!.id, { quantity: 10 } as never);
    let [updated] = await rowsOf(order.id);
    expect([Number(updated!.unitPrice), cfgOf(updated!).price.base, cfgOf(updated!).price.unitPrice]).toEqual([750, 700, 750]);
    expect(cfgOf(updated!).selection).toEqual(cfgOf(row!).selection);
    expect(cfgOf(updated!).key).toBe(cfgOf(row!).key);
    // Manual price: the row takes it, the configuration keeps the engine's price.
    await salesService.updateRow(order.id, row!.id, { quantity: 12, unitPrice: 600 } as never);
    [updated] = await rowsOf(order.id);
    expect([Number(updated!.unitPrice), cfgOf(updated!).price.unitPrice]).toEqual([600, 750]);
    // A note-only patch (no quantity) neither reprices nor touches the configuration.
    await salesService.updateRow(order.id, row!.id, { discountPercent: 3 } as never);
    [updated] = await rowsOf(order.id);
    expect([Number(updated!.unitPrice), Number(updated!.discountPercent), cfgOf(updated!).price.unitPrice]).toEqual([600, 3, 750]);
  });

  // Delprojekt 5 (Review Focus 5): a group the row left empty stays empty when
  // the row is re-evaluated after the template got a default for it —
  // selectionFromEntries writes null, which beats the default.
  it("a re-evaluated row keeps a group empty after the template gets a default for it", async () => {
    const { article } = await buildToOrder();
    const farg = await configurator.createGroup(article.id, { code: "FARG", name: "Färg", kind: "choice", required: false });
    await configurator.createValue(article.id, farg.id, { code: "RD", name: "Röd", priceAdd: 0, active: true });
    const bl = await configurator.createValue(article.id, farg.id, { code: "BL", name: "Blå", priceAdd: 200, active: true });
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await rowsOf(order.id);
    expect(Number(row!.unitPrice)).toBe(1050);
    expect(cfgOf(row!).selection.find((e) => e.groupCode === "FARG")).toMatchObject({ value: null, valueCode: null });

    await configurator.updateGroup(article.id, farg.id, { defaultValueId: bl.id });
    // The default is live: a NEW row with the same choices takes Blå (+200).
    const fresh = await salesService.addRow(order.id, { articleId: article.id, quantity: 1, configuration: { selection: SEL } } as never);
    expect(Number(fresh.unitPrice)).toBe(1250);
    expect(cfgOf(fresh).selection.find((e) => e.groupCode === "FARG")).toMatchObject({ value: "BL", valueName: "Blå" });

    // A real quantity change re-evaluates the stored row — empty stays empty, no +200.
    await salesService.updateRow(order.id, row!.id, { quantity: 2 } as never);
    const updated = (await rowsOf(order.id)).find((r) => r.id === row!.id)!;
    expect(Number(updated.quantityOrdered)).toBe(2);
    expect(Number(updated.unitPrice)).toBe(1050);
    expect(cfgOf(updated).price.unitPrice).toBe(1050);
    expect(cfgOf(updated).price.additions.map((a) => a.groupCode)).toEqual(["LOCK"]);
    expect(cfgOf(updated).selection.find((e) => e.groupCode === "FARG")).toMatchObject({ value: null, valueCode: null });
    expect(cfgOf(updated).key).toBe(cfgOf(row!).key);
  });

  it("a stored selection the template no longer accepts ⇒ ConfiguratorInvalidConfigurationError", async () => {
    const { article, bredd } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await rowsOf(order.id);
    await configurator.updateGroup(article.id, bredd.id, { minValue: 1300 });
    await expect(salesService.updateRow(order.id, row!.id, { quantity: 2 } as never)).rejects.toBeInstanceOf(ConfiguratorInvalidConfigurationError);
  });
});

describe("evaluateRowConfiguration", () => {
  it("refuses a variants template and an unknown template", async () => {
    const mall = await makeArticle({ salesPrice: 1000 });
    await configurator.createTemplate(mall.id, { mode: "variants" });
    const c = await makeCustomer();
    await expect(configurator.evaluateRowConfiguration(mall.id, {}, { customerId: c.id, quantity: 1 })).rejects.toBeInstanceOf(
      ConfiguratorNotToOrderModeError
    );
    await expect(configurator.evaluateRowConfiguration((await makeArticle()).id, {}, { customerId: c.id, quantity: 1 })).rejects.toMatchObject({
      name: "ConfiguratorTemplateNotFoundError",
    });
  });

  it("an invalid selection answers valid: false with the engine's messages and no configuration", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const result = await configurator.evaluateRowConfiguration(article.id, { LOCK: "B" }, { customerId: c.id, quantity: 1 });
    expect(result.valid).toBe(false);
    expect(result.configuration).toBeNull();
    expect(result.errors.join(" ")).toMatch(/Bredd/);
  });
});
