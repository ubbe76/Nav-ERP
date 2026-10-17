import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { articles, db } from "@navet/db";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { ConfigurationRequiredError, createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { previousWorkingDay } from "../src/modules/planning/service/due-date-suggestion.js";
import { CONFIGURED_MFG_TRUNCATE, confirmedRow, FULL, mfg, resetCostingSettings } from "./helpers/configured-manufacturing.js";
import {
  buildVariants,
  configurator,
  makeCustomer,
  makeLocation,
  makeUser,
  purchaseService,
  resetConfiguredRows,
  salesService,
} from "./helpers/configured-rows.js";

// Konfigurator 4c — behovsberäkningen with beställningsvaror, against the
// database: the configured KO rows become proposal rows with their derived
// material cascaded, a configured TO's own material rows are the demand once
// it exists, the template is never proposed, and the article overview and
// the calc stay in step (the invariant both readers are built on).

beforeEach(async () => {
  await resetConfiguredRows();
  await db.execute(CONFIGURED_MFG_TRUNCATE);
  await resetCostingSettings();
});
afterAll(resetConfiguredRows);

const planning = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseService as never,
  manufacturing: mfg,
  configuredStructure: (t, s, q, o) => configurator.deriveForManufacturing(t, s, q, o),
  requirementsCacheMs: 0,
});
const list = async () =>
  (await planning.listRequirements({ showAll: true, limit: 500, offset: 0, refresh: true } as never)).rows;

// The first Wednesday at least `days` ahead (UTC calendar arithmetic, as the
// suggestion itself does) — its working day before is always the Tuesday,
// holidays aside (the test DB has none).
function futureWeekday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe("behovsberäkning — beställningsvara", () => {
  it("a configured row is planned by the customer's ship date (fasta leveransdagar)", async () => {
    const { s, order, row } = await confirmedRow(1);
    const date = futureWeekday(20); // a Wednesday
    const monday = previousWorkingDay(previousWorkingDay(date, new Set()), new Set());
    await db.execute(sql`update sales_orders set expected_delivery_date = ${date} where id = ${order.id}`);
    await db.execute(
      sql`update customers set delivery_day_mode = 'dispatch', transit_days = 2 where id = (select customer_id from sales_orders where id = ${order.id})`
    );
    expect(await planning.suggestManufacturingDueDate(s.article.id, { salesOrderRowId: row.id })).toMatchObject({
      demandDate: monday,
      dueDate: previousWorkingDay(monday, new Set()),
      source: "sales_order_row",
    });
    const cfg = (await list()).find((r) => r.proposalKind === "configured")!;
    expect(cfg.expectedDeliveryDate).toBe(monday);
  });

  it("an uncovered configured row gives a proposal row and cascades its material", async () => {
    const { s, row } = await confirmedRow(2);
    const rows = await list();
    const cfg = rows.find((r) => r.proposalKind === "configured")!;
    expect([cfg.salesOrderRowId, cfg.proposalQuantity, cfg.configurationSummary]).toEqual([
      row.id,
      2,
      "Lås: Lås B · Avlopp: Ja · Bredd: 1 200 mm",
    ]);
    expect([cfg.salesOrderId, cfg.customerName, cfg.configurationError]).toEqual([row.salesOrderId, "Kund AB", null]);
    // 8 skruv/st × 2 and the phantom's Del 1 (2 st/st × 2) land as derived demand…
    expect(rows.find((r) => r.articleId === s.parts.skruv.id)).toMatchObject({ demandDerived: 16, demandMo: 0, proposalKind: "purchase" });
    expect(rows.find((r) => r.articleId === s.parts.f1.id)).toMatchObject({ demandDerived: 4 });
    // …the phantom itself never appears, and the template is demand but no proposal.
    expect(rows.some((r) => r.articleId === s.parts.fant.id)).toBe(false);
    expect(rows.find((r) => r.articleId === s.article.id)).toMatchObject({
      demandSales: 2,
      proposalQuantity: 0,
      proposalKind: null,
      configuredTemplate: true,
    });
  });

  it("Skapa ordrar makes the row's TO; afterwards the TO's material is the demand and the row is covered", async () => {
    const { s, row } = await confirmedRow(2);
    const user = await makeUser();
    const created = await planning.createOrdersFromProposals(
      { proposals: [{ kind: "configured", articleId: s.article.id, salesOrderRowId: row.id, quantity: 2 }] } as never,
      user.id
    );
    expect(created.errors).toEqual([]);
    expect(created.manufacturingOrders).toHaveLength(1);
    expect(created.manufacturingOrders[0]!.articleNumber).toBe(s.article.articleNumber);
    const mo = await mfg.getManufacturingOrder(created.manufacturingOrders[0]!.id);
    expect([mo.status, mo.salesOrderRowId, Number(mo.quantity)]).toEqual(["released", row.id, 2]);

    const rows = await list();
    expect(rows.some((r) => r.proposalKind === "configured")).toBe(false);
    // The planned configured TO's own material rows are the demand now — not
    // a cascade, and not an explosion of the template's base BOM on top.
    expect(rows.find((r) => r.articleId === s.parts.skruv.id)).toMatchObject({ demandMo: 16, demandDerived: 0 });
    expect(rows.find((r) => r.articleId === s.parts.plat.id)).toMatchObject({ demandMo: 2.4, demandDerived: 0 });
    expect(rows.find((r) => r.articleId === s.article.id)).toMatchObject({ demandSales: 2, supplyMo: 2, projected: 0, proposalQuantity: 0 });
  });

  it("delivery from a free unit covers the row; the template gets no proposal after delivery", async () => {
    const { s, order, row } = await confirmedRow(1);
    const loc = await makeLocation();
    const user = await makeUser();
    // A reorder point makes the template's own row stay visible (and would
    // trigger a proposal on any ordinary article once stock reaches 0).
    await db.execute(sql`update articles set reorder_point = 1 where id = ${s.article.id}`);

    // A free TO (not linked to the row) built and received into stock.
    const free = await mfg.createManufacturingOrder(
      { articleId: s.article.id, quantity: 1, configuration: { selection: FULL } },
      user.id
    );
    await mfg.start(free.id);
    await mfg.complete(free.id, { quantity: 1, locationId: loc.id }, user.id);

    // Stock is shared by every configuration, so the row is still uncovered…
    const before = await list();
    expect(before.find((r) => r.proposalKind === "configured")).toMatchObject({ salesOrderRowId: row.id, proposalQuantity: 1 });
    expect(before.find((r) => r.articleId === s.article.id)).toMatchObject({ onHand: 1, demandSales: 1, proposalQuantity: 0 });

    // …until the row is delivered from it (delivery needs the KO in production).
    await salesService.startProduction(order.id, user.id);
    const delivered = await salesService.deliverGoods(order.id, row.id, { quantity: 1, locationId: loc.id }, user.id);
    expect(delivered.orderStatus).toBe("delivered");

    const after = await list();
    expect(after.some((r) => r.proposalKind === "configured")).toBe(false);
    // Stock went 1 → 0 under the reorder point: no proposal for the template.
    expect(after.find((r) => r.articleId === s.article.id)).toMatchObject({
      onHand: 0,
      demandSales: 0,
      reorderPoint: 1,
      proposalQuantity: 0,
      proposalKind: null,
      configuredTemplate: true,
    });
    expect(after.find((r) => r.articleId === s.parts.skruv.id)?.demandDerived ?? 0).toBe(0);
  });

  it("an unconfigured row on a to_order template gives no proposal", async () => {
    const { s, row } = await confirmedRow();
    await db.execute(sql`update sales_order_rows set configuration = null where id = ${row.id}`);
    const rows = await list();
    expect(rows.find((r) => r.articleId === s.article.id)).toMatchObject({ demandSales: 1, proposalQuantity: 0, configuredTemplate: true });
    expect(rows.some((r) => r.proposalKind === "configured")).toBe(false);
    expect(rows.find((r) => r.articleId === s.parts.skruv.id)?.demandDerived ?? 0).toBe(0);
  });

  it("an invalid stored configuration shows the engine's message and cascades nothing", async () => {
    const { s, row } = await confirmedRow();
    await db.execute(sql`update configurator_groups set min_value = 1500 where code = 'BREDD'`);
    const rows = await list();
    const cfg = rows.find((r) => r.proposalKind === "configured")!;
    expect(cfg.salesOrderRowId).toBe(row.id);
    expect(cfg.proposalQuantity).toBe(1);
    expect(cfg.configurationError).toBeTruthy();
    expect(rows.find((r) => r.articleId === s.parts.skruv.id)?.demandDerived ?? 0).toBe(0);

    // Skapa ordrar on it reports the TO service's refusal as an error row.
    const created = await planning.createOrdersFromProposals(
      { proposals: [{ kind: "configured", articleId: s.article.id, salesOrderRowId: row.id, quantity: 1 }] } as never,
      (await makeUser()).id
    );
    expect(created.manufacturingOrders).toEqual([]);
    expect(created.errors).toHaveLength(1);
    expect(created.errors[0]!.articleNumber).toBe(s.article.articleNumber);
  });

  it("the overview of a component and the calc agree (closingBalance === projected − demandDerived) with a planned configured TO", async () => {
    const { s, row } = await confirmedRow();
    await mfg.createFromSalesOrderRow(row.id, {}, null);
    const rows = await list();
    for (const id of [s.parts.skruv.id, s.parts.plat.id, s.parts.f1.id, s.article.id]) {
      const calc = rows.find((r) => r.articleId === id && r.proposalKind !== "configured")!;
      const overview = await planning.getArticleOverview(id);
      expect(overview.closingBalance).toBeCloseTo(calc.projected - calc.demandDerived, 4);
    }
    // The planned configured TO is seen ONCE in a component's overview: as
    // its material row, never as a planned-TO explosion of the template.
    const skruv = await planning.getArticleOverview(s.parts.skruv.id);
    expect(skruv.rows.map((r) => [r.kind, r.quantity])).toEqual([["mo_material", -8]]);
  });

  it("dates a configured row's TO from the row itself — never from another row's TO or a free unit in stock", async () => {
    // Row A (later date) already HAS its own TO; row B (earlier date) has
    // none. The pooled rule would allocate A's TO to B (earliest demand
    // first) and date B's new TO from A — wrong for a beställningsvara,
    // where A's TO is A's configuration and nobody else's.
    const { s, order: orderA, row: rowA } = await confirmedRow(1);
    const dateA = futureWeekday(40); // a Wednesday ≥ 40 days out
    const dateB = futureWeekday(20); // a Wednesday ≥ 20 days out, before A
    await db.execute(sql`update sales_orders set expected_delivery_date = ${dateA} where id = ${orderA.id}`);
    await mfg.createFromSalesOrderRow(rowA.id, {}, null);
    const customer = await makeCustomer();
    const { order: orderB, rows } = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        expectedDeliveryDate: dateB,
        rows: [{ articleId: s.article.id, quantity: 1, configuration: { selection: FULL } }],
      } as never,
      null
    );
    const rowB = rows[0]!;

    const suggestion = await planning.suggestManufacturingDueDate(s.article.id, { salesOrderRowId: rowB.id });
    expect(suggestion).toMatchObject({
      dueDate: previousWorkingDay(dateB, new Set()),
      demandDate: dateB,
      source: "sales_order_row",
      documentNumber: orderB.orderNumber,
      clampedToToday: false,
    });
    // Row A's own suggestion is still from A's date (its TO does not cover
    // it in the configured rule either — the TO is dated from the row).
    expect(await planning.suggestManufacturingDueDate(s.article.id, { salesOrderRowId: rowA.id })).toMatchObject({
      demandDate: dateA,
      documentNumber: orderA.orderNumber,
    });

    // A free unit (another configuration) in stock changes nothing for B…
    const loc = await makeLocation();
    const user = await makeUser();
    const free = await mfg.createManufacturingOrder(
      { articleId: s.article.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 800 } } },
      user.id
    );
    await mfg.start(free.id);
    await mfg.complete(free.id, { quantity: 1, locationId: loc.id }, user.id);
    expect((await planning.suggestManufacturingDueDate(s.article.id, { salesOrderRowId: rowB.id }))?.dueDate).toBe(
      previousWorkingDay(dateB, new Set())
    );
    // …while a call WITHOUT a row still follows the pooled rule, which now
    // sees both rows covered (A's TO + the free unit) and plans nothing —
    // exactly the answer that would have left B's TO undated.
    expect(await planning.suggestManufacturingDueDate(s.article.id)).toBeNull();

    // No date on the row's order ⇒ nothing to plan by.
    await db.execute(sql`update sales_orders set expected_delivery_date = null where id = ${orderB.id}`);
    expect(await planning.suggestManufacturingDueDate(s.article.id, { salesOrderRowId: rowB.id })).toBeNull();
  });

  it("Skapa ordrar dates the configured row's TO the working day before the row's date", async () => {
    const { s, order, row } = await confirmedRow(1);
    const date = futureWeekday(20);
    await db.execute(sql`update sales_orders set expected_delivery_date = ${date} where id = ${order.id}`);
    const created = await planning.createOrdersFromProposals(
      { proposals: [{ kind: "configured", articleId: s.article.id, salesOrderRowId: row.id, quantity: 1 }] } as never,
      (await makeUser()).id
    );
    expect(created.errors).toEqual([]);
    const mo = await mfg.getManufacturingOrder(created.manufacturingOrders[0]!.id);
    expect(mo.dueDate).toBe(previousWorkingDay(date, new Set()));
  });

  it("searches configured rows by KO number and by their choices", async () => {
    const { order } = await confirmedRow();
    const byOrder = await planning.listRequirements({ showAll: true, limit: 50, offset: 0, refresh: true, search: order.orderNumber.toLowerCase() } as never);
    expect(byOrder.rows.some((r) => r.proposalKind === "configured")).toBe(true);
    const byChoice = await planning.listRequirements({ showAll: true, limit: 50, offset: 0, search: "lås b" } as never);
    expect(byChoice.rows.map((r) => r.proposalKind)).toEqual(["configured"]);
  });
});

describe("leveranstidskontroll — configured rows", () => {
  it("a beställningsvara row is planned on its derived route (Kalkyl operations left out)", async () => {
    const { order } = await confirmedRow(2);
    const result = await planning.checkDeliveryTime({ salesOrderId: order.id });
    const r = result.rows[0]!;
    expect(r.readyDate).not.toBeNull();
    expect(r.chain.filter((s) => s.kind === "operation").map((s) => (s as { sequenceNo: number }).sequenceNo)).toEqual([10, 20]);
    expect(result.shipDate).not.toBeNull();
  });

  it("an invalid configuration gives the row no date; a template without one is refused", async () => {
    const { s } = await confirmedRow(1);
    const result = await planning.checkDeliveryTime({ rows: [{ articleId: s.article.id, quantity: 1, configuration: { selection: {} } }] });
    expect(result.rows[0]!.readyDate).toBeNull();
    expect(result.rows[0]!.notes.length).toBeGreaterThan(0);
    await expect(planning.checkDeliveryTime({ rows: [{ articleId: s.article.id, quantity: 1 }] })).rejects.toBeInstanceOf(
      ConfigurationRequiredError
    );
  });

  it("a variant that does not exist yet is derived, never created", async () => {
    const { template } = await buildVariants();
    const countArticles = async () => (await db.select({ id: articles.id }).from(articles)).length;
    const before = await countArticles();
    const result = await planning.checkDeliveryTime({
      rows: [{ articleId: template.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 800 } } }],
    });
    expect(result.rows[0]!.readyDate).not.toBeNull();
    expect(await countArticles()).toBe(before);
  });
});
