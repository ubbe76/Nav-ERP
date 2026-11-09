import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { buildCsv, createArticleSchema, createCustomerSchema, createStockLocationSchema, createSupplierSchema, listRequirementsQuerySchema } from "@navet/shared";
import { articleForecasts, db, stockTransactions, systemSettings } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService, ForecastMonthOutsideHorizonError, ArticleNotFoundError } from "../src/modules/planning/service/planning.service.js";
import { requirementsExportColumns } from "../src/modules/planning/service/export-columns.js";
import type { AuditEntry } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";

// Prognos (#10) against the database. "Today" is pinned to Monday
// 2030-03-04: the default history window is 2029-03 … 2030-02, the horizon
// 2030-03 … 2030-08. The consumption history is written straight into
// stock_transactions with created_at in 2029 (the services date rows now).

const TODAY = "2030-03-04";

const auditEntries: AuditEntry[] = [];
const audit = {
  async log(entry: AuditEntry) {
    auditEntries.push(entry);
  },
};

const articleService = createArticleService(createArticleRepository(db), audit);
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const documentPdfService = createDocumentPdfService(systemService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseService,
  manufacturing: mfgService,
  requirementsCacheMs: 0,
  today: () => TODAY,
  audit,
});

const TRUNCATE = sql`TRUNCATE holidays, purchase_order_rows, purchase_orders, article_suppliers, suppliers, sales_order_rows, sales_orders, customers, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, article_forecasts, articles, users CASCADE`;
const SETTING_KEYS = ["planning_forecast_history_months", "planning_forecast_horizon_months"];

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  auditEntries.length = 0;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
});

async function makeUser() {
  return authRepo.create({ email: `fc-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Planner", role: "user" });
}

async function location() {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID().slice(0, 6)}`, active: true });
  return stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: `A-${crypto.randomUUID().slice(0, 6)}`, active: true }));
}

type Movement = { day: string; type: "sales_delivery" | "mo_consumption" | "inventory_adjustment" | "purchase_receipt"; delta: number };

async function movements(articleId: string, locationId: string, rows: Movement[]) {
  await db.insert(stockTransactions).values(
    rows.map((r) => ({
      articleId,
      locationId,
      quantityDelta: String(r.delta),
      transactionType: r.type,
      createdAt: new Date(`${r.day}T10:00:00Z`),
    }))
  );
}

// The standard history: a receipt before the window (first movement), 60
// sold in April and 60 drawn by a TO in July 2029, a delivery in September
// that was undone (nets to 0), a stock count in November (not consumption)
// and 2 sold this month. On hand = 120 − 60 − 60 + 5 − 2 = 3; average 10.
const HISTORY: Movement[] = [
  { day: "2029-02-15", type: "purchase_receipt", delta: 120 },
  { day: "2029-04-10", type: "sales_delivery", delta: -60 },
  { day: "2029-07-05", type: "mo_consumption", delta: -60 },
  { day: "2029-09-12", type: "sales_delivery", delta: -6 },
  { day: "2029-09-13", type: "sales_delivery", delta: 6 },
  { day: "2029-11-20", type: "inventory_adjustment", delta: 5 },
  { day: "2030-03-02", type: "sales_delivery", delta: -2 },
];

async function forecastArticle(articleNumber = "FC-1", forecastControlled = true, type: "purchased" | "manufactured" = "purchased") {
  const article = await articleService.createArticle(parsed(createArticleSchema, { articleNumber, name: articleNumber, type, active: true, forecastControlled }));
  const loc = await location();
  await movements(article.id, loc.id, HISTORY);
  return { article, loc };
}

const requirementRow = async (articleId: string, search: string) => {
  const { rows } = await planningService.listRequirements(parsed(listRequirementsQuerySchema, { limit: 50, offset: 0, showAll: "true", search }));
  return rows.find((r) => r.articleId === articleId);
};
const sum = (list: number[]) => Math.round(list.reduce((s, q) => s + q, 0) * 1e4) / 1e4;

describe("förbrukningen ur lagerloggen", () => {
  it("reads sales deliveries and TO draws per Stockholm month, nets an undone delivery and ignores stock counts", async () => {
    const { article } = await forecastArticle();
    const forecast = await planningService.getArticleForecast(article.id);
    expect(forecast).toMatchObject({ forecastControlled: true, historyMonths: 12, horizonMonths: 6, average: 10 });
    expect(forecast.history).toHaveLength(12);
    expect(forecast.history[0]).toEqual({ month: "2029-03", consumed: 0 });
    expect(forecast.history.filter((h) => h.consumed !== 0)).toEqual([
      { month: "2029-04", consumed: 60 },
      { month: "2029-07", consumed: 60 },
    ]);
    expect(forecast.months).toHaveLength(6);
    expect(forecast.months[0]).toEqual({ month: "2030-03", average: 10, own: null, forecast: 10, actualDemand: 0, alreadyConsumed: 2, forecastDemand: 8 });
    expect(forecast.months[1]).toEqual({ month: "2030-04", average: 10, own: null, forecast: 10, actualDemand: 0, alreadyConsumed: null, forecastDemand: 10 });
  });

  it("divides by the months since the first stock movement when it lies inside the window", async () => {
    const article = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "FC-NEW", name: "Ny", type: "purchased", active: true, forecastControlled: true }));
    const loc = await location();
    await movements(article.id, loc.id, [
      { day: "2029-12-05", type: "purchase_receipt", delta: 50 },
      { day: "2030-01-15", type: "sales_delivery", delta: -30 },
    ]);
    // December, January, February = 3 months.
    expect((await planningService.getArticleForecast(article.id)).average).toBe(10);
    // Not prognosstyrd: the picture is still computed, the flag says so.
    const plain = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "FC-OFF", name: "Av", type: "purchased", active: true }));
    expect(await planningService.getArticleForecast(plain.id)).toMatchObject({ forecastControlled: false, average: 0 });
  });
});

describe("prognosstyrd i behovsberäkningen och artikelöversikten", () => {
  it("gives weekly forecast proposals and forecast rows; the invariant holds; a non-prognosstyrd twin is unchanged", async () => {
    const { article: f } = await forecastArticle("FC-ON", true);
    const { article: h } = await forecastArticle("FC-OFF", false);

    const row = (await requirementRow(f.id, "FC-ON"))!;
    // March: 10 − 2 consumed = 8 over four weeks (2 each); April–August 10 each.
    expect(row.demandForecast).toBe(58);
    expect(row.onHand).toBe(3);
    expect(row.projected).toBe(-55);
    expect(row.proposals[0]).toMatchObject({ needDate: "2030-03-11", needWeek: "2030-03-11", quantity: 1, reason: "forecast", late: false });
    expect(sum(row.proposals.map((p) => p.quantity))).toBe(55);
    expect(row.proposals.every((p) => p.reason === "forecast" && !p.late)).toBe(true);

    const overview = await planningService.getArticleOverview(f.id);
    const forecastRows = overview.rows.filter((r) => r.kind === "forecast");
    expect(forecastRows[0]).toMatchObject({
      id: "fc:2030-03:2030-03-04",
      date: "2030-03-04",
      direction: "demand",
      documentType: null,
      documentId: null,
      documentNumber: "Prognos 2030-03 · v.10",
      quantity: -2,
      balance: 1,
    });
    expect(sum(forecastRows.map((r) => -r.quantity))).toBe(58);
    expect(overview.rows.every((r) => r.kind === "forecast")).toBe(true);
    expect(overview.closingBalance).toBe(row.projected + row.demandDerived);

    const twin = (await requirementRow(h.id, "FC-OFF"))!;
    expect(twin).toMatchObject({ demandForecast: 0, projected: 3, proposals: [] });
    const twinOverview = await planningService.getArticleOverview(h.id);
    expect(twinOverview.rows).toEqual([]);
    expect(twinOverview.closingBalance).toBe(3);
  });

  it("an order in the month consumes the forecast, in both readers", async () => {
    const { article: f } = await forecastArticle();
    const user = await makeUser();
    const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
    await salesService.createQuote(
      { customerId: customer.id, confirm: true, expectedDeliveryDate: "2030-03-20", rows: [{ articleId: f.id, quantity: 6, unitPrice: 100 }] },
      user.id
    );

    const forecast = await planningService.getArticleForecast(f.id);
    expect(forecast.months[0]).toMatchObject({ month: "2030-03", actualDemand: 6, alreadyConsumed: 2, forecastDemand: 2 });

    const row = (await requirementRow(f.id, "FC-1"))!;
    expect(row.demandSales).toBe(6);
    expect(row.demandForecast).toBe(52);
    const overview = await planningService.getArticleOverview(f.id);
    expect(overview.rows.filter((r) => r.kind === "sales_order")).toHaveLength(1);
    expect(sum(overview.rows.filter((r) => r.kind === "forecast").map((r) => -r.quantity))).toBe(52);
    expect(overview.closingBalance).toBe(row.projected + row.demandDerived);
  });

  it("a manufactured prognosstyrd article cascades its forecast proposals to the components", async () => {
    const { article: p } = await forecastArticle("FC-P", true, "manufactured");
    const c = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "FC-C", name: "Komponent", type: "purchased", active: true }));
    await articleService.addBomComponent(p.id, { componentArticleId: c.id, quantity: 2 });

    const parent = (await requirementRow(p.id, "FC-P"))!;
    const component = (await requirementRow(c.id, "FC-C"))!;
    expect(parent.demandForecast).toBe(58);
    expect(parent.proposalKind).toBe("manufacture");
    expect(component.demandDerived).toBeCloseTo(2 * 55, 9);
    expect(component.demandForecast).toBe(0);
  });
});

async function supplierFor(articleIds: string[], leadTimeDays = 0) {
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "Stål AB", active: true }));
  for (const articleId of articleIds) {
    await purchaseService.addArticleSupplier(articleId, { supplierId: supplier.id, price: 10, currency: "SEK", leadTimeDays, isPrimary: true });
  }
  return supplier;
}

async function koFor(articleId: string, quantity: number, userId: string, date: string) {
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
  return salesService.createQuote({ customerId: customer.id, confirm: true, expectedDeliveryDate: date, rows: [{ articleId, quantity, unitPrice: 100 }] }, userId);
}

describe("prognosförslag är aldrig Passerat", () => {
  it("a purchased article with a lead time: `forecast` proposals, none late, outside latest=late, and Skapa ordrar warns for none", async () => {
    const { article: f } = await forecastArticle("FC-LEAD");
    await supplierFor([f.id], 10);
    const user = await makeUser();

    const row = (await requirementRow(f.id, "FC-LEAD"))!;
    expect(row.proposals.length).toBeGreaterThan(0);
    expect(row.proposals.every((p) => p.reason === "forecast" && !p.late && p.latestDate! >= TODAY)).toBe(true);
    expect(row.anyLate).toBe(false);
    // The first piece is this week, dated today: its latest order day
    // would be in the past with 10 days' lead time — floored at today.
    expect(row.proposals[0]).toMatchObject({ needDate: "2030-03-11", latestDate: TODAY, late: false });

    const late = await planningService.listRequirements({ limit: 50, offset: 0, latest: "late" } as never);
    expect(late.rows.find((r) => r.articleId === f.id)).toBeUndefined();
    const thisWeek = await planningService.listRequirements({ limit: 50, offset: 0, latest: "this_week" } as never);
    const inWeek = thisWeek.rows.find((r) => r.articleId === f.id)!.proposals.map((p) => p.latestDate!);
    expect(inWeek.length).toBeGreaterThan(0);
    expect(inWeek.every((d) => d >= TODAY && d <= "2030-03-10")).toBe(true);

    // Skapa ordrar: the delivery date is the earliest possible (after the
    // need) — a `forecast` proposal is never reported as late, like a
    // reorder-point proposal.
    const result = await planningService.createOrdersFromProposals(
      { proposals: row.proposals.map((p) => ({ articleId: f.id, quantity: p.quantity, kind: "purchase" as const, needDate: p.needDate!, reason: p.reason })) },
      user.id
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.purchaseOrders).toHaveLength(1);
    // The same proposals sent as plain demand WOULD warn — the reason is what silences it.
    const asDemand = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: f.id, quantity: 1, kind: "purchase" as const, needDate: "2030-03-11", reason: "demand" }] },
      user.id
    );
    expect(asDemand.warnings).toHaveLength(1);
  });

  it("a manufactured article with a lead time: the TO gets the floor date and no 'hinner inte' warning", async () => {
    const { article: m } = await forecastArticle("FC-SLOW", true, "manufactured");
    await articleService.updateArticle(m.id, { manufacturingLeadTimeDays: 10 });
    const user = await makeUser();
    const row = (await requirementRow(m.id, "FC-SLOW"))!;
    expect(row.proposals.every((p) => p.reason === "forecast" && !p.late)).toBe(true);

    const first = row.proposals[0]!;
    const result = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: m.id, quantity: first.quantity, kind: "manufacture", needDate: first.needDate!, reason: first.reason }] },
      user.id
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    // Today + 10 working days = Monday 03-18 — after the need, yet no warning.
    expect((await mfgService.getManufacturingOrder(result.manufacturingOrders[0]!.id))!.dueDate).toBe("2030-03-18");
  });
});

describe("härlett behov förbrukar prognosen i behovsberäkningen (användarbeslut 2026-11-07)", () => {
  it("a KO on the parent without a TO consumes the component's forecast like the released TO's material does; the overview and the card stay firm-only", async () => {
    const { article: c } = await forecastArticle("FC-COMP");
    const parent = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "FC-PAR", name: "Förälder", type: "manufactured", active: true }));
    await articleService.addBomComponent(parent.id, { componentArticleId: c.id, quantity: 1 });
    const user = await makeUser();
    await koFor(parent.id, 5, user.id, "2030-03-20");

    // Before the TO: the parent's proposal gives 5 derived demand on the
    // component in March ⇒ March forecast demand 8 − 5 = 3, total 53.
    const before = (await requirementRow(c.id, "FC-COMP"))!;
    expect(before).toMatchObject({ demandDerived: 5, demandMo: 0, demandForecast: 53, projected: -55 });
    expect(sum(before.proposals.map((p) => p.quantity))).toBe(55);
    // The overview has no row for the derived demand: 58 forecast, and the
    // extended invariant holds.
    const overviewBefore = await planningService.getArticleOverview(c.id);
    const overviewForecast = sum(overviewBefore.rows.filter((r) => r.kind === "forecast").map((r) => -r.quantity));
    expect(overviewForecast).toBe(58);
    expect(overviewBefore.rows.every((r) => r.kind === "forecast")).toBe(true);
    expect(overviewBefore.closingBalance).toBe(before.projected + before.demandDerived - (overviewForecast - before.demandForecast));
    // The Prognos card knows no derived demand either.
    const cardBefore = await planningService.getArticleForecast(c.id);
    expect(cardBefore.months[0]).toMatchObject({ month: "2030-03", actualDemand: 0, alreadyConsumed: 2, forecastDemand: 8 });

    // After the parent's TO is released: the same 5 is TO material.
    await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5, dueDate: "2030-03-20" }, user.id);
    const after = (await requirementRow(c.id, "FC-COMP"))!;
    expect(after).toMatchObject({ demandDerived: 0, demandMo: 5, demandForecast: 53, projected: -55 });
    expect(sum(after.proposals.map((p) => p.quantity))).toBe(55);
    const overviewAfter = await planningService.getArticleOverview(c.id);
    expect(sum(overviewAfter.rows.filter((r) => r.kind === "forecast").map((r) => -r.quantity))).toBe(53);
    expect(overviewAfter.closingBalance).toBe(after.projected + after.demandDerived - (53 - after.demandForecast));
    expect(overviewAfter.closingBalance).toBe(after.projected);
    const cardAfter = await planningService.getArticleForecast(c.id);
    expect(cardAfter.months[0]).toMatchObject({ month: "2030-03", actualDemand: 5, forecastDemand: 3 });
  });

  it("the CSV's Behov includes the forecast, with Varav prognos right after it", async () => {
    const { article: f } = await forecastArticle("FC-CSV");
    const exported = await planningService.listRequirementsForExport({ limit: 50, offset: 0, showAll: true, search: "FC-CSV" } as never);
    const csv = buildCsv(requirementsExportColumns, exported.rows);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toContain("Saldo;Behov;Varav prognos;Inkommande;Netto;");
    // Saldo 3; Behov 58 (all forecast); Varav prognos 58; Inkommande 0; Netto −55.
    expect(lines.find((l) => l.startsWith("FC-CSV"))).toContain(";3;58;58;0;-55;");
    expect(f.id).toBeTruthy();
  });
});

describe("det egna antalet (PUT /articles/:id/forecast)", () => {
  it("wins over the average, 0 included; null removes it; the change is logged on the article", async () => {
    const { article: f } = await forecastArticle();
    const user = await makeUser();

    const updated = await planningService.updateArticleForecast(
      f.id,
      { months: [{ month: "2030-04", quantity: 44 }, { month: "2030-05", quantity: 0 }] },
      user.id
    );
    expect(updated.months[1]).toMatchObject({ month: "2030-04", own: 44, forecast: 44, forecastDemand: 44 });
    expect(updated.months[2]).toMatchObject({ month: "2030-05", own: 0, forecast: 0, forecastDemand: 0 });
    expect((await requirementRow(f.id, "FC-1"))!.demandForecast).toBe(8 + 44 + 0 + 30);
    expect(auditEntries).toEqual([
      {
        entityType: "article",
        entityId: f.id,
        action: "forecast_updated",
        detail: { articleNumber: "FC-1", before: "2030-04: —, 2030-05: —", after: "2030-04: 44, 2030-05: 0" },
        userId: user.id,
      },
    ]);

    // Replace per given month: April back to the average, May untouched.
    auditEntries.length = 0;
    const cleared = await planningService.updateArticleForecast(f.id, { months: [{ month: "2030-04", quantity: null }] }, user.id);
    expect(cleared.months[1]).toMatchObject({ month: "2030-04", own: null, forecast: 10 });
    expect(cleared.months[2]).toMatchObject({ month: "2030-05", own: 0 });
    expect(await db.select({ month: articleForecasts.month }).from(articleForecasts)).toEqual([{ month: "2030-05-01" }]);
    expect(auditEntries.map((e) => e.detail)).toEqual([{ articleNumber: "FC-1", before: "2030-04: 44", after: "2030-04: —" }]);

    // Nothing changed ⇒ nothing logged.
    auditEntries.length = 0;
    await planningService.updateArticleForecast(f.id, { months: [{ month: "2030-05", quantity: 0 }] }, user.id);
    expect(auditEntries).toEqual([]);
  });

  it("refuses a month outside the horizon without writing anything, and an unknown article", async () => {
    const { article: f } = await forecastArticle();
    await expect(
      planningService.updateArticleForecast(f.id, { months: [{ month: "2030-04", quantity: 5 }, { month: "2030-09", quantity: 5 }] }, null)
    ).rejects.toBeInstanceOf(ForecastMonthOutsideHorizonError);
    expect(await db.select().from(articleForecasts)).toEqual([]);
    await expect(planningService.updateArticleForecast(crypto.randomUUID(), { months: [{ month: "2030-04", quantity: 5 }] }, null)).rejects.toBeInstanceOf(
      ArticleNotFoundError
    );
  });

  it("Prognosstyrd on the article card: the PATCH round-trips the flag and logs the change once", async () => {
    const user = await makeUser();
    const article = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "FC-FLAG", name: "Flagga", type: "purchased", active: true }));
    expect(article.forecastControlled).toBe(false);
    const on = await articleService.updateArticle(article.id, { forecastControlled: true }, user.id);
    expect(on!.forecastControlled).toBe(true);
    await articleService.updateArticle(article.id, { forecastControlled: true, reorderPoint: 5 }, user.id);
    expect(auditEntries).toEqual([
      {
        entityType: "article",
        entityId: article.id,
        action: "updated",
        detail: { articleNumber: "FC-FLAG", before: { forecastControlled: false }, after: { forecastControlled: true } },
        userId: user.id,
      },
    ]);
  });
});

describe("inte ett skarpt behov", () => {
  it("the färdigdatumsförslag, the pegging and the Leveranstidskontroll ignore the forecast rows", async () => {
    const { article: f } = await forecastArticle();
    const user = await makeUser();

    // Only forecast demand (58 against 3 on hand): nothing firm to date a TO from.
    expect(await planningService.suggestManufacturingDueDate(f.id)).toBeNull();

    // The 3 on hand ship today — the forecast rows before the checked row take nothing.
    const check = await planningService.checkDeliveryTime({ rows: [{ articleId: f.id, quantity: 3 }] });
    expect(check.shipDate).toBe(TODAY);
    expect(check.rows[0]!.chain).toEqual([{ kind: "stock", articleNumber: "FC-1", quantity: 3, date: TODAY }]);

    // A TO needing 3 of the article at the end of April: covered by stock,
    // although 58 of forecast demand is dated before it.
    const parent = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "FC-PARENT", name: "Förälder", type: "manufactured", active: true }));
    await articleService.addBomComponent(parent.id, { componentArticleId: f.id, quantity: 1 });
    const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 3, dueDate: "2030-04-30" }, user.id);
    const coverage = await planningService.getManufacturingOrderCoverage(mo.id);
    expect(coverage.materials).toHaveLength(1);
    expect(coverage.materials[0]).toMatchObject({ articleNumber: "FC-1", quantity: 3, uncovered: 0 });
    expect(coverage.materials[0]!.allocations).toEqual([expect.objectContaining({ kind: "stock", quantity: 3 })]);
    // …while the behovsberäkning plans for both: the TO's 3 (which consume
    // April's forecast: 10 − 3) and the forecast — 55 + 3 − 3 on hand.
    const row = (await requirementRow(f.id, "FC-1"))!;
    expect(row.demandMo).toBe(3);
    expect(row.demandForecast).toBe(55);
    expect(sum(row.proposals.map((p) => p.quantity))).toBe(55);
  });
});

describe("inställningarna", () => {
  it("the history window and the horizon follow the planning settings", async () => {
    const article = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: "FC-SET", name: "Inst", type: "purchased", active: true, forecastControlled: true }));
    const loc = await location();
    await movements(article.id, loc.id, [
      { day: "2029-01-10", type: "purchase_receipt", delta: 150 },
      { day: "2029-04-10", type: "sales_delivery", delta: -120 },
      { day: "2030-01-15", type: "sales_delivery", delta: -30 },
    ]);
    // Default: 150 over 12 months (the first movement lies before the window).
    expect((await planningService.getArticleForecast(article.id)).average).toBe(12.5);

    await systemService.updateSettings({ planningForecastHistoryMonths: 3, planningForecastHorizonMonths: 2 });
    const forecast = await planningService.getArticleForecast(article.id);
    expect(forecast).toMatchObject({ historyMonths: 3, horizonMonths: 2, average: 10 });
    expect(forecast.history.map((h) => h.month)).toEqual(["2029-12", "2030-01", "2030-02"]);
    expect(forecast.months.map((m) => m.month)).toEqual(["2030-03", "2030-04"]);
    // Nothing on hand, nothing consumed this month: two months of forecast.
    const row = (await requirementRow(article.id, "FC-SET"))!;
    expect(row.demandForecast).toBe(20);
    await expect(planningService.updateArticleForecast(article.id, { months: [{ month: "2030-05", quantity: 1 }] }, null)).rejects.toBeInstanceOf(
      ForecastMonthOutsideHorizonError
    );
  });
});

describe("Säkerhetslager-förslaget är aldrig Passerat (användarbeslut 2026-11-09)", () => {
  it("a purchased article below its safety stock with a lead time: one `safety_stock` proposal today, outside latest=late, and Skapa ordrar warns for none", async () => {
    const article = await articleService.createArticle(
      parsed(createArticleSchema, { articleNumber: "SL-LEAD", name: "SL-LEAD", type: "purchased", active: true, safetyStock: 5 })
    );
    await supplierFor([article.id], 10);
    const user = await makeUser();

    const row = (await requirementRow(article.id, "SL-LEAD"))!;
    expect(row.proposals).toEqual([
      expect.objectContaining({ needDate: TODAY, latestDate: TODAY, late: false, quantity: 5, reason: "safety_stock" }),
    ]);
    expect(row.anyLate).toBe(false);
    const late = await planningService.listRequirements({ limit: 50, offset: 0, latest: "late" } as never);
    expect(late.rows.find((r) => r.articleId === article.id)).toBeUndefined();

    const result = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: article.id, quantity: 5, kind: "purchase" as const, needDate: TODAY, reason: "safety_stock" }] },
      user.id
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.purchaseOrders).toHaveLength(1);
  });
});
