import { API_CLIENT_SCOPES } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, invoiceRows, invoices, salesOrderRows } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createOAuthRepository } from "../src/modules/oauth/repository/oauth.repository.js";
import { createOAuthService } from "../src/modules/oauth/service/oauth.service.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createReportsService } from "../src/modules/reports/service/reports.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { ConfiguratorInvalidConfigurationError } from "../src/modules/configurator/service/configurator.errors.js";
import { testCostingService } from "./helpers/configurator.js";
import {
  buildToOrderWithStructure,
  CONFIGURED_MFG_TRUNCATE,
  FULL,
  resetCostingSettings,
} from "./helpers/configured-manufacturing.js";
import {
  buildVariants,
  configurator,
  invoiceService,
  mailService,
  makeCustomer,
  makeLocation,
  makeUser,
  registerService,
  resetConfiguredRows,
  rowConfiguration,
  salesRepository,
  seedStock,
  stockService,
} from "./helpers/configured-rows.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Konfigurator 4c: a configured (beställningsvara) row carries its own
// förkalkyl in sales_order_rows.configuration_cost — written on a new row,
// on Ändra konfiguration and on every quantity change — and the order card's
// täckningsbidrag and the Marginalrapport measure the row against it, never
// against the template's own saved calculation. The cost stays internal: it
// never reaches the invoice row or the OAuth POST /quotes response.

// The 4b sales service plus the costing reader, so listRows WOULD find the
// template's own saved calculation if the configured branch did not win.
const sales = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  testArticleService,
  testSystemService,
  (q) => resolvePrice(db, q, { variantPrice: (vq) => configurator.variantPrice(vq) }),
  createAuditRepository(db),
  undefined,
  testCostingService,
  undefined,
  rowConfiguration
);

beforeEach(async () => {
  await resetConfiguredRows();
  await db.execute(CONFIGURED_MFG_TRUNCATE);
  await resetCostingSettings();
});
afterAll(resetConfiguredRows);

const rawCost = async (rowId: string) => {
  const [raw] = await db.select({ cost: salesOrderRows.configurationCost }).from(salesOrderRows).where(eq(salesOrderRows.id, rowId));
  return raw!.cost as { selfCostPerUnit: number | null; manufacturingCostPerUnit: number | null; quantity: number; calculatedAt: string } | null;
};

describe("configured rows — cost and margin", () => {
  it("a new configured row stores the förkalkyl at its quantity and listRows measures the margin against it", async () => {
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 2, configuration: { selection: FULL } }] } as never,
      null
    );
    const [row] = await sales.listRows(order.id);
    expect(row!.selfCostPerUnit).toBe(168);
    expect(row!.selfCostCalculatedAt).toBeTruthy();
    // Only the two derived fields leave listRows — the stored jsonb does not.
    expect(row).not.toHaveProperty("configurationCost");
    expect(await rawCost(row!.id)).toMatchObject({ selfCostPerUnit: 168, manufacturingCostPerUnit: 168, quantity: 2 });
  });

  it("addRow stores the cost too; an ordinary row keeps configuration_cost null", async () => {
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.parts.skruv.id, quantity: 1, unitPrice: 5 }] } as never,
      null
    );
    const added = await sales.addRow(order.id, { articleId: s.article.id, quantity: 1, configuration: { selection: FULL } } as never);
    expect(await rawCost(added.id)).toMatchObject({ selfCostPerUnit: 198, manufacturingCostPerUnit: 198, quantity: 1 });
    const plain = (await sales.listRows(order.id)).find((r) => r.articleId === s.parts.skruv.id)!;
    expect(await rawCost(plain.id)).toBeNull();
  });

  it("the template's own saved calculation is never used for a configured row", async () => {
    const s = await buildToOrderWithStructure();
    const saved = await testCostingService.preCalculate(s.article.id, 1, true);
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 1, configuration: { selection: { LOCK: "A", BREDD: 800 } } }] } as never,
      null
    );
    const [row] = await sales.listRows(order.id);
    const raw = await rawCost(row!.id);
    // The template's plain structure (SKRUV + op 10 + op 30 = 116) is a
    // different figure from the configuration's (+ PLAT 0,8 + FANT = 134).
    const templateCost = (await testCostingService.latestPreCalculationSelfCost([s.article.id])).get(s.article.id);
    expect(templateCost).toBeDefined();
    expect(saved).toBeTruthy();
    expect(templateCost!.selfCostPerUnit).not.toBe(raw!.selfCostPerUnit);
    expect(row!.selfCostPerUnit).toBe(raw!.selfCostPerUnit);
    expect(row!.selfCostPerUnit).toBe(134);
    expect(row!.selfCostCalculatedAt).toBe(raw!.calculatedAt);
  });

  it("a quantity change with a manual price keeps the price and recomputes the cost", async () => {
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 1, unitPrice: 777, configuration: { selection: FULL } }] } as never,
      null
    );
    const [row] = await sales.listRows(order.id);
    expect(await rawCost(row!.id)).toMatchObject({ quantity: 1, manufacturingCostPerUnit: 198 });
    await sales.updateRow(order.id, row!.id, { quantity: 2, unitPrice: 777 } as never);
    const [after] = await sales.listRows(order.id);
    expect(Number(after!.unitPrice)).toBe(777);
    expect(await rawCost(row!.id)).toMatchObject({ quantity: 2, manufacturingCostPerUnit: 168 });
    expect(after!.selfCostPerUnit).toBe(168);
  });

  it("a price-only change (the order card sends the unchanged quantity along) leaves the stored cost alone", async () => {
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 2, configuration: { selection: FULL } }] } as never,
      null
    );
    const [row] = await sales.listRows(order.id);
    const before = await rawCost(row!.id);
    const res = await sales.updateRow(order.id, row!.id, { quantity: 2, unitPrice: 900 } as never);
    expect(Number(res!.row.unitPrice)).toBe(900);
    expect(await rawCost(row!.id)).toEqual(before);
  });

  it("price and discount stay editable on a row whose stored choices the template no longer accepts, as long as the quantity is unchanged", async () => {
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 2, configuration: { selection: FULL } }] } as never,
      null
    );
    const [row] = await sales.listRows(order.id);
    const before = await rawCost(row!.id);
    // BREDD 1200 is no longer accepted.
    await configurator.updateGroup(s.article.id, s.bredd.id, { minValue: 1300 });

    const priced = await sales.updateRow(order.id, row!.id, { quantity: 2, unitPrice: 950 } as never);
    expect(Number(priced!.row.unitPrice)).toBe(950);
    const discounted = await sales.updateRow(order.id, row!.id, { quantity: 2, discountPercent: 5 } as never);
    expect(Number(discounted!.row.discountPercent)).toBe(5);
    expect(Number(discounted!.row.unitPrice)).toBe(950);
    // Same calculatedAt: nothing was re-evaluated or re-stamped.
    expect(await rawCost(row!.id)).toEqual(before);

    // A real quantity change still needs a valid configuration (400), even
    // with a hand-written price — the cost would otherwise go stale.
    await expect(sales.updateRow(order.id, row!.id, { quantity: 3, unitPrice: 950 } as never)).rejects.toBeInstanceOf(
      ConfiguratorInvalidConfigurationError
    );
    expect(await rawCost(row!.id)).toEqual(before);
  });

  it("no row the service returns carries the stored förkalkyl (create, add, update, Ändra konfiguration, delivery)", async () => {
    const user = await makeUser();
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const created = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 2, configuration: { selection: FULL } }] } as never,
      null
    );
    const added = await sales.addRow(created.order.id, { articleId: s.article.id, quantity: 1, configuration: { selection: FULL } } as never);
    const updated = await sales.updateRow(created.order.id, added.id, { quantity: 3 } as never);
    const changed = await sales.setRowConfiguration(created.order.id, added.id, { selection: { LOCK: "A", BREDD: 800 } }, null);
    // Each of these rows does have a stored cost.
    expect(await rawCost(created.rows[0]!.id)).not.toBeNull();
    expect(await rawCost(added.id)).not.toBeNull();
    await sales.confirm(created.order.id);
    await sales.startProduction(created.order.id);
    const location = await makeLocation();
    await seedStock(s.article.id, location.id, 5);
    const delivered = await sales.deliverGoods(created.order.id, created.rows[0]!.id, { locationId: location.id, quantity: 1 }, user.id);
    for (const row of [created.rows[0]!, added, updated!.row, changed.row, delivered.row]) {
      expect(row).toHaveProperty("configuration");
      expect(row).not.toHaveProperty("configurationCost");
    }
  });

  it("Ändra konfiguration replaces the cost; a switch to a variant row clears it", async () => {
    // Beställningsvara: FULL → { LOCK: A, BREDD: 800, AVLOPP: false } is
    // cheaper (no op 20, no AVL, PLAT 0,8) — 198 → 134 at quantity 1.
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 1, configuration: { selection: FULL } }] } as never,
      null
    );
    const [row] = await sales.listRows(order.id);
    const before = await rawCost(row!.id);
    expect(before).toMatchObject({ selfCostPerUnit: 198, manufacturingCostPerUnit: 198, quantity: 1 });
    await sales.setRowConfiguration(order.id, row!.id, { selection: { LOCK: "A", BREDD: 800, AVLOPP: false } }, null);
    const after = await rawCost(row!.id);
    expect(after).toMatchObject({ selfCostPerUnit: 134, manufacturingCostPerUnit: 134, quantity: 1 });
    expect(after!.selfCostPerUnit!).toBeLessThan(before!.selfCostPerUnit!);
    expect((await sales.listRows(order.id))[0]!.selfCostPerUnit).toBe(134);

    // Variant row: an ordinary row of a stocked variant. A stale cost is
    // planted on it so the write to null is actually observed.
    const v = await buildVariants();
    const { article: v1 } = await configurator.resolveVariant(v.template.id, { LOCK: "A", BREDD: 1200 }, null);
    const { order: vOrder } = await sales.createQuote({ customerId: c.id, rows: [{ articleId: v1.id, quantity: 1 }] } as never, null);
    const [vRow] = await sales.listRows(vOrder.id);
    expect(await rawCost(vRow!.id)).toBeNull();
    await db
      .update(salesOrderRows)
      .set({ configurationCost: { selfCostPerUnit: 1, manufacturingCostPerUnit: 1, quantity: 1, calculatedAt: new Date().toISOString() } })
      .where(eq(salesOrderRows.id, vRow!.id));
    const res = await sales.setRowConfiguration(vOrder.id, vRow!.id, { selection: { LOCK: "B", BREDD: 1200 } }, null);
    expect(res.row.articleId).not.toBe(v1.id);
    expect(await rawCost(vRow!.id)).toBeNull();
  });

  it("the cost never reaches the invoice row or the OAuth response", async () => {
    const user = await makeUser();
    const s = await buildToOrderWithStructure();
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 2, configuration: { selection: FULL } }] } as never,
      null
    );
    const [orderRow] = await sales.listRows(order.id);
    expect(await rawCost(orderRow!.id)).not.toBeNull();
    await sales.confirm(order.id);
    await sales.startProduction(order.id);
    const location = await makeLocation();
    await seedStock(s.article.id, location.id, 5);
    await sales.deliverGoods(order.id, orderRow!.id, { locationId: location.id, quantity: 2 }, user.id);

    // Invoice: invoice_rows has no cost column at all, and the created row
    // carries exactly the keys an ordinary (free) row has.
    const columns = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'invoice_rows'`
    );
    const columnNames = [...columns].map((r) => r.column_name);
    expect(columnNames).toContain("configuration");
    expect(columnNames).not.toContain("configuration_cost");
    const draft = await invoiceService.create(
      {
        customerId: c.id,
        rows: [
          { articleId: s.article.id, salesOrderRowId: orderRow!.id, description: "Korg", quantity: 2, unitPrice: 1150, discountPercent: 0 },
          { description: "Fri rad", quantity: 1, unitPrice: 10 },
        ],
      },
      user.id
    );
    const linked = draft!.rows.find((r) => r.salesOrderRowId === orderRow!.id)!;
    expect(linked.configuration).not.toBeNull();
    // costCenterId/costCenter are the row's kostnadsställe, not a cost.
    expect(Object.keys(linked).filter((k) => /cost/i.test(k) && !/^costCenter/.test(k))).toEqual([]);
    const serializedInvoice = JSON.stringify(draft);
    for (const leak of ["configurationCost", "configuration_cost", "selfCostPerUnit", "manufacturingCostPerUnit"]) {
      expect(serializedInvoice).not.toContain(leak);
    }
    const [storedInvoiceRow] = await db.select().from(invoiceRows).where(eq(invoiceRows.id, linked.id));
    expect(JSON.stringify(storedInvoiceRow)).not.toContain("selfCostPerUnit");

    // OAuth: the external configurator's POST /quotes answer carries the
    // rows, but never the row's förkalkyl. The template must be published
    // for the API (delprojekt 5) for a client to configure it at all.
    await configurator.updateTemplate(s.article.id, { published: true });
    const app = buildApp();
    try {
      const oauthService = createOAuthService(createOAuthRepository(db), "unused");
      const { client, clientSecret } = await oauthService.createApiClient({ name: "Konfigurator", scopes: [...API_CLIENT_SCOPES] }, user.id);
      const token = await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: client.id, clientSecret } });
      expect(token.statusCode).toBe(200);
      const { accessToken } = token.json() as { accessToken: string };
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/quotes",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 2, configuration: { selection: FULL } }] },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { order: { id: string }; rows: { id: string; configuration: unknown }[] };
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]!.configuration).not.toBeNull();
      // The row DID get a cost — it is just not sent.
      expect(await rawCost(body.rows[0]!.id)).not.toBeNull();
      for (const leak of ["configurationCost", "configuration_cost", "selfCostPerUnit", "manufacturingCostPerUnit"]) {
        expect(res.body).not.toContain(leak);
      }
    } finally {
      await app.close();
    }
  });

  it("the Marginalrapport measures an invoiced configured row against the row's förkalkyl, not the template's", async () => {
    const user = await makeUser();
    const s = await buildToOrderWithStructure();
    // The template's own saved calculation (116) — must NOT be used.
    await testCostingService.preCalculate(s.article.id, 1, true);
    const c = await makeCustomer();
    const { order } = await sales.createQuote(
      { customerId: c.id, rows: [{ articleId: s.article.id, quantity: 2, configuration: { selection: FULL } }] } as never,
      null
    );
    const [orderRow] = await sales.listRows(order.id);
    await sales.confirm(order.id);
    await sales.startProduction(order.id);
    const location = await makeLocation();
    await seedStock(s.article.id, location.id, 5);
    await sales.deliverGoods(order.id, orderRow!.id, { locationId: location.id, quantity: 2 }, user.id);
    const draft = await invoiceService.create(
      {
        customerId: c.id,
        rows: [{ articleId: s.article.id, salesOrderRowId: orderRow!.id, description: "Korg", quantity: 2, unitPrice: 1000, discountPercent: 0 }],
      },
      user.id
    );
    // The report reads issued invoices only; the posting path is not what
    // this test is about, so the status is set directly.
    await db.update(invoices).set({ status: "issued", invoiceDate: "2026-08-15" }).where(eq(invoices.id, draft!.id));

    const reports = createReportsService(createReportsRepository(db), testCostingService);
    const result = await reports.getOrderMargin({ from: "2026-08", to: "2026-08", groupBy: "article" });
    // 2 × 168 = 336 against 2000 net.
    expect(result.total).toMatchObject({ netRevenue: 2000, cost: 336, contribution: 1664, rowsWithoutCost: 0 });

    // A configured row whose förkalkyl is unknown counts as "saknar kalkyl",
    // not as the template's figure and never as zero.
    await db.update(salesOrderRows).set({ configurationCost: null }).where(eq(salesOrderRows.id, orderRow!.id));
    const unknown = await reports.getOrderMargin({ from: "2026-08", to: "2026-08", groupBy: "article" });
    expect(unknown.total).toMatchObject({ netRevenue: 2000, cost: null, rowsWithoutCost: 1 });
  });
});
