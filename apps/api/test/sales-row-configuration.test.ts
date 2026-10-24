import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { articles, auditLog, configuratorVariants, db, invoiceRows, invoices, manufacturingOrders, salesOrders } from "@navet/db";
import type { OrderRowConfiguration } from "@navet/shared";
import { ConfigurationNotAllowedError, RowConfigurationLockedError, RowVariantExistsError } from "../src/modules/sales/service/sales.errors.js";
import { ConfiguratorNotToOrderModeError, ConfiguratorTemplateNotFoundError } from "../src/modules/configurator/service/configurator.errors.js";
import { makeArticle } from "./helpers/configurator.js";
import {
  buildToOrder,
  buildVariants,
  configurator,
  makeCustomer,
  makeUser,
  resetConfiguredRows,
  salesService,
  stockService,
} from "./helpers/configured-rows.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// Delprojekt 4b, Ändra konfiguration: PUT /sales-orders/:id/rows/:rowId/
// configuration replaces a beställningsvara row's choices (and price) or
// moves a variant row to the resolved variant — as long as the row has not
// moved on (delivery, TO, invoice row, order status).

beforeEach(resetConfiguredRows);
afterAll(resetConfiguredRows);

const SEL = { LOCK: "B", BREDD: 1200 };
const NEW_SEL = { LOCK: "A", BREDD: 800 };
const cfgOf = (row: { configuration: unknown }) => row.configuration as OrderRowConfiguration;
const auditRows = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

describe("Ändra konfiguration — beställningsvara", () => {
  it("replaces choices, price split and a hand-written price; logs before/after keys", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 2, unitPrice: 777, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await salesService.listRows(order.id);
    expect(Number(row!.unitPrice)).toBe(777);

    const res = await salesService.setRowConfiguration(order.id, row!.id, { selection: { LOCK: "A", BREDD: 800, AVLOPP: true } }, null);
    expect(res.row.articleId).toBe(article.id);
    // base 1000 + LOCK A 0 + AVLOPP 100 — the hand-written 777 is gone.
    expect(Number(res.row.unitPrice)).toBe(1100);
    expect(Number(res.row.discountPercent)).toBe(0);
    expect(cfgOf(res.row).selection.map((e) => [e.groupCode, e.value])).toEqual([
      ["LOCK", "A"],
      ["AVLOPP", true],
      ["BREDD", 800],
    ]);
    expect(cfgOf(res.row).price).toMatchObject({ base: 1000, unitPrice: 1100 });
    expect(cfgOf(res.row).key).not.toBe(cfgOf(row!).key);

    const [log] = await auditRows("row_configuration_changed");
    expect(log!.entityType).toBe("sales_order_row");
    expect(log!.entityId).toBe(order.orderNumber);
    expect(log!.detail).toMatchObject({
      articleNumber: article.articleNumber,
      before: { articleNumber: article.articleNumber, key: cfgOf(row!).key, unitPrice: "777.0000" },
      after: { articleNumber: article.articleNumber, key: cfgOf(res.row).key, unitPrice: "1100.0000" },
    });
    expect((await db.select().from(salesOrders).where(eq(salesOrders.id, order.id)))[0]!.revision).toBe(2);
  });

  it("bumpRevision: false leaves the revision alone", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await salesService.listRows(order.id);
    await salesService.setRowConfiguration(order.id, row!.id, { selection: NEW_SEL, bumpRevision: false }, null);
    expect((await db.select().from(salesOrders).where(eq(salesOrders.id, order.id)))[0]!.revision).toBe(1);
  });

  // One confirmed order with a configured row, to be pushed past exactly one guard.
  async function lockedRow() {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, confirm: true, rows: [{ articleId: article.id, quantity: 2, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await salesService.listRows(order.id);
    return { article, order, row: row! };
  }
  async function expectLocked(orderId: string, row: { id: string; configuration: unknown }, reason: RegExp) {
    const err = await salesService.setRowConfiguration(orderId, row.id, { selection: NEW_SEL }, null).catch((e) => e);
    expect(err).toBeInstanceOf(RowConfigurationLockedError);
    expect((err as Error).message).toMatch(reason);
    expect((await salesService.listRows(orderId))[0]!.configuration).toEqual(row.configuration);
    expect(await auditRows("row_configuration_changed")).toHaveLength(0);
  }

  it("refuses after a partial delivery", async () => {
    const { article, order, row } = await lockedRow();
    await salesService.startProduction(order.id);
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 5, transactionType: "inventory_adjustment" });
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 1 }, (await makeUser()).id);
    await expectLocked(order.id, row, /levererats/);
  });

  it("refuses with a linked, non-cancelled TO — a cancelled TO does not lock", async () => {
    const { article, order, row } = await lockedRow();
    const [mo] = await db
      .insert(manufacturingOrders)
      .values({ orderNumber: `TO-${crypto.randomUUID().slice(0, 8)}`, articleId: article.id, quantity: "2", status: "planned", salesOrderRowId: row.id })
      .returning();
    await expectLocked(order.id, row, /tillverkningsorder/);

    await db.update(manufacturingOrders).set({ status: "cancelled" }).where(eq(manufacturingOrders.id, mo!.id));
    const res = await salesService.setRowConfiguration(order.id, row.id, { selection: NEW_SEL }, null);
    expect(cfgOf(res.row).selection.find((e) => e.groupCode === "LOCK")!.value).toBe("A");
  });

  it("refuses with an invoice row", async () => {
    const { order, row } = await lockedRow();
    const [invoice] = await db.insert(invoices).values({ customerId: order.customerId, createdBy: null }).returning();
    await db.insert(invoiceRows).values({
      invoiceId: invoice!.id,
      salesOrderRowId: row.id,
      articleId: row.articleId,
      description: "x",
      quantity: "1",
      unitPrice: "1",
      vatRate: "25",
    vatCodeId: await vatCodeId("MP25"),
      lineAmount: "1",
      vatAmount: "0.25",
    });
    await expectLocked(order.id, row, /fakturerad/);
  });

  it("refuses in status delivered", async () => {
    const { order, row } = await lockedRow();
    await salesService.setStatus(order.id, "delivered", null);
    await expectLocked(order.id, row, /status delivered/);
  });

  it("a template switched to variants keeps the row printable and refuses reconfiguration", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await salesService.listRows(order.id);
    await configurator.updateTemplate(article.id, { mode: "variants" });
    await expect(salesService.setRowConfiguration(order.id, row!.id, { selection: SEL }, null)).rejects.toBeInstanceOf(
      ConfiguratorNotToOrderModeError
    );
    expect(cfgOf((await salesService.listRows(order.id))[0]!).key).toBe(cfgOf(row!).key);
  });

  it("a removed template keeps the row and refuses reconfiguration with ConfiguratorTemplateNotFoundError", async () => {
    const { article } = await buildToOrder();
    const c = await makeCustomer();
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: article.id, quantity: 1, configuration: { selection: SEL } }] } as never,
      null
    );
    const [row] = await salesService.listRows(order.id);
    await configurator.deleteTemplate(article.id);
    await expect(salesService.setRowConfiguration(order.id, row!.id, { selection: SEL }, null)).rejects.toBeInstanceOf(
      ConfiguratorTemplateNotFoundError
    );
    expect(cfgOf((await salesService.listRows(order.id))[0]!).key).toBe(cfgOf(row!).key);
  });
});

describe("Ändra konfiguration — variantrad", () => {
  it("switches the row to the resolved variant (created or reused) and reprices through the chain", async () => {
    const s = await buildVariants();
    const c = await makeCustomer();
    const { article: v1 } = await configurator.resolveVariant(s.template.id, { LOCK: "A", BREDD: 1200 }, null);
    const { order } = await salesService.createQuote({ customerId: c.id, rows: [{ articleId: v1.id, quantity: 1 }] } as never, null);
    const [row] = await salesService.listRows(order.id);
    expect(row!.variantTemplateArticleId).toBe(s.template.id);
    expect(Number(row!.unitPrice)).toBe(1000);

    const res = await salesService.setRowConfiguration(order.id, row!.id, { selection: { LOCK: "B", BREDD: 1200 } }, null);
    expect(res.row.articleId).not.toBe(v1.id);
    expect(res.row.configuration).toBeNull();
    expect(Number(res.row.unitPrice)).toBe(1050);
    const variants = await db.select().from(configuratorVariants);
    expect(variants).toHaveLength(2);
    const v2 = variants.find((v) => v.articleId === res.row.articleId)!;
    const v1Link = variants.find((v) => v.articleId === v1.id)!;

    const [log] = await auditRows("row_configuration_changed");
    expect(log!.detail).toMatchObject({
      before: { articleNumber: v1.articleNumber, key: v1Link.configKey, unitPrice: "1000.0000" },
      after: { key: v2.configKey, unitPrice: "1050.0000" },
    });

    // Same choices again ⇒ only a repricing, no new variant.
    const again = await salesService.setRowConfiguration(order.id, row!.id, { selection: { LOCK: "B", BREDD: 1200 } }, null);
    expect(again.row.articleId).toBe(res.row.articleId);
    expect(await db.select().from(configuratorVariants)).toHaveLength(2);
  });

  it("the new variant already on the order as a plain row ⇒ RowVariantExistsError", async () => {
    const s = await buildVariants();
    const c = await makeCustomer();
    const { article: a } = await configurator.resolveVariant(s.template.id, { LOCK: "A", BREDD: 1200 }, null);
    const { article: b } = await configurator.resolveVariant(s.template.id, { LOCK: "B", BREDD: 1200 }, null);
    const { order } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: a.id, quantity: 1 }, { articleId: b.id, quantity: 1 }] } as never,
      null
    );
    // Picked by article, never by position.
    const rowA = (await salesService.listRows(order.id)).find((r) => r.articleId === a.id)!;
    expect(rowA).toBeDefined();
    const err = await salesService.setRowConfiguration(order.id, rowA.id, { selection: { LOCK: "B", BREDD: 1200 } }, null).catch((e) => e);
    expect(err).toBeInstanceOf(RowVariantExistsError);
    expect((err as Error).message).toBe(`Varianten ${b.articleNumber} ligger redan som rad på ordern`);
    const after = await salesService.listRows(order.id);
    expect(after.find((r) => r.id === rowA.id)!.articleId).toBe(a.id);
    expect(after.map((r) => r.articleId).sort()).toEqual([a.id, b.id].sort());
    expect(await auditRows("row_configuration_changed")).toHaveLength(0);
  });

  it("a locked variant row (invoice row) is refused BEFORE a new variant is created", async () => {
    const s = await buildVariants();
    const c = await makeCustomer();
    const { article: v1 } = await configurator.resolveVariant(s.template.id, { LOCK: "A", BREDD: 1200 }, null);
    const { order, rows } = await salesService.createQuote(
      { customerId: c.id, confirm: true, rows: [{ articleId: v1.id, quantity: 1 }] } as never,
      null
    );
    const row = rows[0]!;
    const [invoice] = await db.insert(invoices).values({ customerId: c.id, createdBy: null }).returning();
    await db.insert(invoiceRows).values({
      invoiceId: invoice!.id,
      salesOrderRowId: row.id,
      articleId: v1.id,
      description: "x",
      quantity: "1",
      unitPrice: "1",
      vatRate: "25",
    vatCodeId: await vatCodeId("MP25"),
      lineAmount: "1",
      vatAmount: "0.25",
    });
    const variantsBefore = await db.select().from(configuratorVariants);
    const articlesBefore = await db.select({ id: articles.id }).from(articles);
    expect(variantsBefore).toHaveLength(1);

    const err = await salesService.setRowConfiguration(order.id, row.id, { selection: { LOCK: "B", BREDD: 1200 } }, null).catch((e) => e);
    expect(err).toBeInstanceOf(RowConfigurationLockedError);
    expect((err as Error).message).toMatch(/fakturerad/);
    // No stray variant: the resolve never ran.
    expect(await db.select().from(configuratorVariants)).toHaveLength(1);
    expect(await db.select({ id: articles.id }).from(articles)).toHaveLength(articlesBefore.length);
    expect((await salesService.listRows(order.id))[0]!.articleId).toBe(v1.id);
    expect(await auditRows("row_configuration_changed")).toHaveLength(0);
  });

  it("a multi-row quote lists its rows in the order they were entered", async () => {
    const a = await makeArticle({ salesPrice: 10 });
    const b = await makeArticle({ salesPrice: 20 });
    const d = await makeArticle({ salesPrice: 30 });
    const c = await makeCustomer();
    const { order, rows } = await salesService.createQuote(
      { customerId: c.id, rows: [{ articleId: d.id, quantity: 1 }, { articleId: a.id, quantity: 1 }, { articleId: b.id, quantity: 1 }] } as never,
      null
    );
    expect(rows.map((r) => r.articleId)).toEqual([d.id, a.id, b.id]);
    for (let i = 0; i < 5; i++) {
      expect((await salesService.listRows(order.id)).map((r) => r.id)).toEqual(rows.map((r) => r.id));
    }
  });

  it("a plain row ⇒ ConfigurationNotAllowedError", async () => {
    const plain = await makeArticle({ salesPrice: 100 });
    const c = await makeCustomer();
    const { order, rows } = await salesService.createQuote({ customerId: c.id, rows: [{ articleId: plain.id, quantity: 1 }] } as never, null);
    await expect(salesService.setRowConfiguration(order.id, rows[0]!.id, { selection: {} }, null)).rejects.toBeInstanceOf(
      ConfigurationNotAllowedError
    );
  });
});
