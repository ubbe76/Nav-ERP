import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { buildCsv, createArticleSchema, updateArticleSchema } from "@navet/shared";
import { articles, db, systemSettings } from "@navet/db";
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
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { requirementsExportColumns } from "../src/modules/planning/service/export-columns.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";

// Tidsfasade förslag (#13), against the database: the artikelöversikt dates a
// TO's material with the TO's START, the behovsberäkning gives one proposal
// per need week with need/latest dates, Skapa ordrar dates each proposal from
// its own needDate (two weeks ⇒ two TOs, or two draft IOs at one supplier),
// the horizon filter/sort/CSV, and the article field Ledtid (dagar).
// "Today" is pinned to Monday 2030-03-04 so the dates never move.

const TODAY = "2030-03-04";

const articleService = createArticleService(createArticleRepository(db));
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
});

const TRUNCATE = sql`TRUNCATE holidays, purchase_order_rows, purchase_orders, article_suppliers, suppliers, sales_order_rows, sales_orders, customers, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `tp-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Planner",
    role: "user",
  });
}

async function makeArticle(overrides: { articleNumber: string; type?: "manufactured" | "purchased"; manufacturingLeadTimeDays?: number }) {
  return articleService.createArticle({ name: overrides.articleNumber, type: "purchased", active: true, ...overrides });
}

// A resource at 8 h/day with one operation of `minutesPerUnit` on the
// article — the routing's lead time is quantity × minutesPerUnit / 480 days.
let workCenterNo = 100;
async function routingOf(articleId: string, minutesPerUnit: number) {
  const wc = await mfgService.createWorkCenter({ code: String(workCenterNo++), name: "Svets", hoursPerDay: 8, active: true });
  await mfgService.createRoutingOperation(articleId, { sequenceNo: 10, workCenterId: wc.id, setupTime: 0, runTimePerUnit: minutesPerUnit });
  return wc;
}

async function koFor(articleId: string, quantity: number, userId: string, date: string) {
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  return salesService.createQuote(
    { customerId: customer.id, confirm: true, expectedDeliveryDate: date, rows: [{ articleId, quantity, unitPrice: 100 }] },
    userId
  );
}

async function supplierFor(articleIds: string[], leadTimeDays = 0) {
  const supplier = await purchaseService.createSupplier({ name: "Stål AB", active: true });
  for (const articleId of articleIds) {
    await purchaseService.addArticleSupplier(articleId, { supplierId: supplier.id, price: 10, currency: "SEK", leadTimeDays, isPrimary: true });
  }
  return supplier;
}

const list = async (query: Record<string, unknown> = {}) =>
  (await planningService.listRequirements({ limit: 50, offset: 0, showAll: true, sort: "article", ...query } as never)).rows;

describe("artikelöversikt — material is needed when the TO starts", () => {
  it("dates a released TO's material rows and a planned TO's explosion with the TO's start; the invariant with the behovsberäkning holds", async () => {
    const user = await makeUser();
    const parent = await makeArticle({ articleNumber: "TP-P", type: "manufactured" });
    const part = await makeArticle({ articleNumber: "TP-C" });
    await articleService.addBomComponent(parent.id, { componentArticleId: part.id, quantity: 1 });
    await routingOf(parent.id, 480); // one day per unit

    // Released, 2 units due Fri 2030-03-08 ⇒ 2 days ⇒ starts Wed 03-06.
    const released = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 2, dueDate: "2030-03-08" }, user.id);
    // Planned (no snapshot), 3 units due Fri 03-15 ⇒ 3 days ⇒ starts Tue 03-12.
    const planned = await insertPlannedManufacturingOrder({ articleId: parent.id, quantity: 3, dueDate: "2030-03-15", createdBy: user.id });

    const overview = await planningService.getArticleOverview(part.id);
    expect(overview.rows.map((r) => [r.kind, r.documentId, r.date, r.quantity])).toEqual([
      ["mo_material", released.id, "2030-03-06", -2],
      ["mo_planned_material", planned.id, "2030-03-12", -3],
    ]);
    // The TO's own supply row keeps the due date.
    const parentOverview = await planningService.getArticleOverview(parent.id);
    expect(parentOverview.rows.map((r) => [r.kind, r.date])).toEqual([
      ["manufacturing_order", "2030-03-08"],
      ["manufacturing_order", "2030-03-15"],
    ]);

    const row = (await list({ search: "TP-C" })).find((r) => r.articleId === part.id)!;
    expect(overview.closingBalance).toBe(row.projected - row.demandDerived);
    // The behovsberäkning sees the same need dates: one proposal per week.
    expect(row.proposals.map((p) => [p.needDate, p.needWeek, p.latestDate, p.quantity, p.late])).toEqual([
      ["2030-03-06", "2030-03-04", "2030-03-05", 2, false],
      ["2030-03-12", "2030-03-11", "2030-03-11", 3, false],
    ]);
    expect(row.proposalQuantity).toBe(5);
    expect(row.earliestLatestDate).toBe("2030-03-05");
    expect(row.anyLate).toBe(false);
  });

  it("the field Ledtid (dagar) wins over the routing, and a full-day holiday is skipped", async () => {
    const user = await makeUser();
    const parent = await makeArticle({ articleNumber: "TP-F", type: "manufactured" });
    const part = await makeArticle({ articleNumber: "TP-FC" });
    await articleService.addBomComponent(parent.id, { componentArticleId: part.id, quantity: 1 });
    await routingOf(parent.id, 480);
    await articleService.updateArticle(parent.id, { manufacturingLeadTimeDays: 5 });
    await db.execute(sql`insert into holidays (date, name) values ('2030-03-06', 'Testdag')`);

    await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 2, dueDate: "2030-03-08" }, user.id);
    const overview = await planningService.getArticleOverview(part.id);
    // 5 working days before Fri 03-08, skipping Wed 03-06: 07, 05, 04, 01, 02-28.
    expect(overview.rows.map((r) => [r.kind, r.date])).toEqual([["mo_material", "2030-02-28"]]);
  });
});

describe("Skapa ordrar — one order per proposal, dated from its needDate", () => {
  it("two week proposals of one manufactured article become two TOs with their own färdigdatum; a lead time past the need warns", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "TP-M", type: "manufactured" });
    await koFor(m.id, 5, user.id, "2030-03-11"); // Monday
    await koFor(m.id, 3, user.id, "2030-03-25"); // Monday

    const row = (await list({ search: "TP-M" })).find((r) => r.articleId === m.id)!;
    expect(row.proposals.map((p) => [p.key, p.needDate, p.latestDate, p.quantity])).toEqual([
      [`manufacture:${m.id}:2030-03-11`, "2030-03-11", "2030-03-08", 5],
      [`manufacture:${m.id}:2030-03-25`, "2030-03-25", "2030-03-22", 3],
    ]);
    expect(row.leadDays).toBe(0);

    const result = await planningService.createOrdersFromProposals(
      {
        proposals: row.proposals.map((p) => ({ articleId: m.id, quantity: p.quantity, kind: "manufacture" as const, needDate: p.needDate! })),
      },
      user.id
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const dues = await Promise.all(result.manufacturingOrders.map(async (o) => (await mfgService.getManufacturingOrder(o.id))!));
    expect(dues.map((o) => [Number(o.quantity), o.dueDate])).toEqual([
      [5, "2030-03-08"],
      [3, "2030-03-22"],
    ]);

    // Afterwards the article is covered — nothing is proposed again.
    expect((await list({ search: "TP-M" })).find((r) => r.articleId === m.id)!.proposals).toEqual([]);

    // A lead time of 10 working days cannot make 03-11: the floor (today +
    // 10 working days = Mon 03-18) is used and the TO is reported as late.
    const slow = await makeArticle({ articleNumber: "TP-SLOW", type: "manufactured", manufacturingLeadTimeDays: 10 });
    const late = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: slow.id, quantity: 1, kind: "manufacture", needDate: "2030-03-11" }] },
      user.id
    );
    expect(late.errors).toEqual([]);
    expect((await mfgService.getManufacturingOrder(late.manufacturingOrders[0]!.id))!.dueDate).toBe("2030-03-18");
    expect(late.warnings).toEqual([
      {
        orderNumber: late.manufacturingOrders[0]!.orderNumber,
        articleNumber: "TP-SLOW",
        demandDate: "2030-03-11",
        deliveryDate: "2030-03-18",
        message: "Färdigdatumet (2030-03-18) hinner inte före behovet (2030-03-11)",
      },
    ]);

    // A reorder-point proposal is dated today for no deadline: the same
    // floor, but never reported as late.
    const rop = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: slow.id, quantity: 1, kind: "manufacture", needDate: "2030-03-04", reason: "reorder_point" }] },
      user.id
    );
    expect(rop.errors).toEqual([]);
    expect((await mfgService.getManufacturingOrder(rop.manufacturingOrders[0]!.id))!.dueDate).toBe("2030-03-18");
    expect(rop.warnings).toEqual([]);
  });

  it("two week proposals of one purchased article become two rows on ONE draft IO at the supplier, each with its own date; another article joins it", async () => {
    const user = await makeUser();
    const a = await makeArticle({ articleNumber: "TP-A" });
    const b = await makeArticle({ articleNumber: "TP-B" });
    const supplier = await supplierFor([a.id, b.id]);
    await koFor(a.id, 4, user.id, "2030-03-11");
    await koFor(a.id, 6, user.id, "2030-03-25");
    await koFor(b.id, 2, user.id, "2030-03-18");

    const rows = await list({ type: "purchased" });
    const proposals = rows.flatMap((r) => r.proposals.map((p) => ({ articleId: r.articleId, quantity: p.quantity, kind: "purchase" as const, needDate: p.needDate! })));
    expect(proposals).toHaveLength(3);

    const result = await planningService.createOrdersFromProposals({ proposals }, user.id);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    // One IO per supplier: a's two weeks are two rows of the same article.
    expect(result.purchaseOrders.map((o) => [o.supplierId, o.rowCount])).toEqual([[supplier.id, 3]]);
    const [order] = result.purchaseOrders;
    // The order gets the earliest date; rows in need-date order, each with
    // its own date when it differs from the order's.
    expect((await purchaseService.getPurchaseOrder(order!.id))!.expectedDeliveryDate).toBe("2030-03-08");
    const orderRows = await purchaseService.listRows(order!.id);
    expect(orderRows.map((r) => [r.articleId, Number(r.quantityOrdered), r.expectedDeliveryDate])).toEqual([
      [a.id, 4, null], // follows the order
      [b.id, 2, "2030-03-15"],
      [a.id, 6, "2030-03-22"],
    ]);
  });

  it("without needDate the first firm demand still decides (integrations)", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "TP-OLD", type: "manufactured" });
    await koFor(m.id, 5, user.id, "2030-03-11");
    const result = await planningService.createOrdersFromProposals(
      { proposals: [{ articleId: m.id, quantity: 5, kind: "manufacture" }] },
      user.id
    );
    expect((await mfgService.getManufacturingOrder(result.manufacturingOrders[0]!.id))!.dueDate).toBe("2030-03-08");
  });
});

describe("GET /planning/requirements — latest filter, sort and CSV", () => {
  async function fixture() {
    const user = await makeUser();
    const a = await makeArticle({ articleNumber: "TP-1" }); // late: need Fri 03-01 ⇒ latest Thu 02-28 < today
    const b = await makeArticle({ articleNumber: "TP-2" }); // this week (latest 03-08) and in four weeks (03-29 ⇒ latest 03-28)
    const c = await makeArticle({ articleNumber: "TP-3" }); // next week (latest 03-15)
    const d = await makeArticle({ articleNumber: "TP-4", type: "manufactured" }); // undated (reorder point today)
    await articleService.updateArticle(d.id, { reorderPoint: 2 });
    await supplierFor([a.id, b.id, c.id]);
    await koFor(a.id, 1, user.id, "2030-03-01");
    await koFor(b.id, 2, user.id, "2030-03-11");
    await koFor(b.id, 3, user.id, "2030-03-29");
    await koFor(c.id, 4, user.id, "2030-03-18");
    return { a, b, c, d };
  }

  it("keeps only the proposals inside the horizon and drops rows left without any", async () => {
    const { a, b, c, d } = await fixture();
    const numbers = (rows: { articleNumber: string }[]) => rows.map((r) => r.articleNumber);

    const late = await list({ latest: "late" });
    expect(numbers(late)).toEqual(["TP-1"]);
    expect(late[0]!.proposals[0]).toMatchObject({ needDate: "2030-03-01", latestDate: "2030-02-28", late: true });

    const thisWeek = await list({ latest: "this_week" }); // through Sun 03-10
    expect(numbers(thisWeek)).toEqual(["TP-1", "TP-2", "TP-4"]);
    const b2 = thisWeek.find((r) => r.articleId === b.id)!;
    expect(b2.proposals.map((p) => p.latestDate)).toEqual(["2030-03-08"]);
    expect(b2.proposalQuantity).toBe(2); // trimmed to the proposals shown
    expect(b2.earliestLatestDate).toBe("2030-03-08");
    // The reorder-point proposal is dated today — inside this week, never late.
    expect(thisWeek.find((r) => r.articleId === d.id)!.proposals[0]).toMatchObject({ reason: "reorder_point", latestDate: TODAY, late: false });

    expect(numbers(await list({ latest: "next_week" }))).toEqual(["TP-1", "TP-2", "TP-3", "TP-4"]);
    const four = await list({ latest: "four_weeks" }); // through Sun 03-31
    expect(four.find((r) => r.articleId === b.id)!.proposals.map((p) => p.latestDate)).toEqual(["2030-03-08", "2030-03-28"]);
    expect(numbers(await list({ latest: "this_week", search: "TP-3" }))).toEqual([]);
    expect(a.id && c.id).toBeTruthy();

    // total follows the filter.
    const paged = await planningService.listRequirements({ limit: 1, offset: 0, showAll: true, sort: "article", latest: "late" } as never);
    expect(paged.total).toBe(1);
  });

  it("sorts by the earliest latest date with undated rows last, and the CSV has one line per proposal", async () => {
    const { b, d } = await fixture();
    const sorted = await list({ sort: "latest" });
    expect(sorted.map((r) => [r.articleNumber, r.earliestLatestDate])).toEqual([
      ["TP-1", "2030-02-28"],
      ["TP-4", TODAY],
      ["TP-2", "2030-03-08"],
      ["TP-3", "2030-03-15"],
    ]);
    expect(b.id && d.id).toBeTruthy();

    const exported = await planningService.listRequirementsForExport({ limit: 50, offset: 0, showAll: true, sort: "latest" } as never);
    expect(exported.total).toBe(5); // TP-2 has two proposals
    const csv = buildCsv(requirementsExportColumns, exported.rows);
    const lines = csv.trim().split("\r\n").length > 1 ? csv.trim().split("\r\n") : csv.trim().split("\n");
    expect(lines[0]).toContain("Behovsdatum;Senaste datum;Passerat");
    expect(lines.filter((l) => l.startsWith("TP-2"))).toHaveLength(2);
    expect(lines.find((l) => l.startsWith("TP-1"))).toContain("2030-03-01;2030-02-28;Ja");
    expect(lines.find((l) => l.startsWith("TP-3"))).toContain("2030-03-18;2030-03-15;Nej");
  });
});

describe("articles.manufacturing_lead_time_days", () => {
  it("is set and cleared through PATCH, refused when negative by zod and by the database", async () => {
    const m = await makeArticle({ articleNumber: "TP-LT", type: "manufactured" });
    expect((await articleService.getArticle(m.id))!.manufacturingLeadTimeDays).toBeNull();

    await articleService.updateArticle(m.id, { manufacturingLeadTimeDays: 7 });
    expect((await articleService.getArticle(m.id))!.manufacturingLeadTimeDays).toBe(7);
    await articleService.updateArticle(m.id, { manufacturingLeadTimeDays: null });
    expect((await articleService.getArticle(m.id))!.manufacturingLeadTimeDays).toBeNull();

    // The API's 400: the shared schema (coerced from the form's string).
    expect(updateArticleSchema.safeParse({ manufacturingLeadTimeDays: "5" }).success).toBe(true);
    expect(updateArticleSchema.safeParse({ manufacturingLeadTimeDays: -1 }).success).toBe(false);
    expect(updateArticleSchema.safeParse({ manufacturingLeadTimeDays: 1.5 }).success).toBe(false);
    expect(createArticleSchema.safeParse({ articleNumber: "X", name: "X", type: "manufactured", manufacturingLeadTimeDays: -3 }).success).toBe(false);
    // The migration's CHECK behind it.
    // The migration's CHECK behind it (Drizzle wraps the Postgres error; the
    // constraint name sits on the cause).
    await expect(db.update(articles).set({ manufacturingLeadTimeDays: -1 }).where(sql`${articles.id} = ${m.id}`)).rejects.toMatchObject({
      cause: { constraint_name: "articles_manufacturing_lead_time_days_nonnegative" },
    });
  });

  it("GET /articles/:id/due-date-suggestion floors the date at today plus the lead time (field or routing for the quantity)", async () => {
    const user = await makeUser();
    const m = await makeArticle({ articleNumber: "TP-DD", type: "manufactured" });
    await routingOf(m.id, 480); // one day per unit
    await koFor(m.id, 1, user.id, "2030-03-11");

    // Quantity 1 ⇒ 1 day: the working day before the need (03-08) is fine.
    expect(await planningService.suggestManufacturingDueDate(m.id)).toMatchObject({ dueDate: "2030-03-08", late: false });
    // Quantity 6 ⇒ 6 days: earliest finish Tue 03-12 — after the need.
    expect(await planningService.suggestManufacturingDueDate(m.id, { quantity: 6 })).toMatchObject({
      dueDate: "2030-03-12",
      demandDate: "2030-03-11",
      late: true,
    });
    // The field wins: 2 days regardless of quantity.
    await articleService.updateArticle(m.id, { manufacturingLeadTimeDays: 2 });
    expect(await planningService.suggestManufacturingDueDate(m.id, { quantity: 6 })).toMatchObject({ dueDate: "2030-03-08", late: false });
  });
});

describe("Standardledtid and Standardkötid (system settings)", () => {
  const KEYS = ["planning_default_lead_time_days", "planning_queue_time_days"];
  // system_settings is not truncated with the rest — remove the pair so the
  // other describes keep measuring with 0/0.
  afterEach(async () => {
    await db.delete(systemSettings).where(inArray(systemSettings.key, KEYS));
  });

  // Two operations on one resource, each `minutesPerUnit` per unit.
  async function twoOperationRoutingOf(articleId: string, minutesPerUnit: number) {
    const wc = await mfgService.createWorkCenter({ code: String(workCenterNo++), name: "Svets", hoursPerDay: 8, active: true });
    await mfgService.createRoutingOperation(articleId, { sequenceNo: 10, workCenterId: wc.id, setupTime: 0, runTimePerUnit: minutesPerUnit });
    await mfgService.createRoutingOperation(articleId, { sequenceNo: 20, workCenterId: wc.id, setupTime: 0, runTimePerUnit: minutesPerUnit });
  }

  it("the Standardkötid between a TO's operations moves its start, the material's need date and the component's proposal earlier", async () => {
    const user = await makeUser();
    const parent = await makeArticle({ articleNumber: "TP-Q", type: "manufactured" });
    const part = await makeArticle({ articleNumber: "TP-QC" });
    await articleService.addBomComponent(parent.id, { componentArticleId: part.id, quantity: 1 });
    await twoOperationRoutingOf(parent.id, 240); // 2 units ⇒ 1 day per operation
    await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 2, dueDate: "2030-03-08" }, user.id);

    // 0 queue time: 2 days before Fri 03-08 ⇒ Wed 03-06.
    expect((await planningService.getArticleOverview(part.id)).rows.map((r) => [r.kind, r.date])).toEqual([["mo_material", "2030-03-06"]]);
    let row = (await list({ search: "TP-QC" })).find((r) => r.articleId === part.id)!;
    expect(row.proposals.map((p) => [p.needDate, p.latestDate])).toEqual([["2030-03-06", "2030-03-05"]]);

    // 1.5 days between the two operations: 2 + 1.5 = 3.5 ⇒ 4 days ⇒ Mon 03-04.
    await systemService.updateSettings({ planningQueueTimeDays: 1.5 });
    expect((await planningService.getArticleOverview(part.id)).rows.map((r) => [r.kind, r.date])).toEqual([["mo_material", "2030-03-04"]]);
    row = (await list({ search: "TP-QC" })).find((r) => r.articleId === part.id)!;
    expect(row.proposals.map((p) => [p.needDate, p.latestDate, p.late])).toEqual([["2030-03-04", "2030-03-01", true]]);
  });

  it("the Standardledtid applies to a manufactured article without a routing: the proposal's latest start, a TO's start and the färdigdatum floor", async () => {
    const user = await makeUser();
    const unrouted = await makeArticle({ articleNumber: "TP-U", type: "manufactured" });
    const part = await makeArticle({ articleNumber: "TP-UC" });
    await articleService.addBomComponent(unrouted.id, { componentArticleId: part.id, quantity: 1 });
    const routed = await makeArticle({ articleNumber: "TP-R", type: "manufactured" });
    await routingOf(routed.id, 480); // one day per unit — a routing is never replaced by the default
    // 3 ordered, 1 on an open TO ⇒ a proposal for 2.
    await koFor(unrouted.id, 3, user.id, "2030-03-18"); // Monday
    await koFor(routed.id, 1, user.id, "2030-03-18");
    await mfgService.createManufacturingOrder({ articleId: unrouted.id, quantity: 1, dueDate: "2030-03-08" }, user.id);

    // Without the setting: lead time 0 — latest start is the working day before the need.
    let rows = await list({ search: "TP-" });
    expect(rows.find((r) => r.articleId === unrouted.id)).toMatchObject({ leadDays: 0 });
    expect(rows.find((r) => r.articleId === unrouted.id)!.proposals.map((p) => p.latestDate)).toEqual(["2030-03-15"]);
    expect((await planningService.getArticleOverview(part.id)).rows.map((r) => r.date)).toEqual(["2030-03-08"]);

    await systemService.updateSettings({ planningDefaultLeadTimeDays: 3 });
    rows = await list({ search: "TP-" });
    // Unrouted: 3 days ⇒ Fri 03-15 − 3 working days = Tue 03-12.
    expect(rows.find((r) => r.articleId === unrouted.id)).toMatchObject({ leadDays: 3 });
    expect(rows.find((r) => r.articleId === unrouted.id)!.proposals.map((p) => p.latestDate)).toEqual(["2030-03-12"]);
    // Routed: still the routing (1 unit ⇒ 1 day ⇒ Thu 03-14).
    expect(rows.find((r) => r.articleId === routed.id)).toMatchObject({ leadDays: 1 });
    expect(rows.find((r) => r.articleId === routed.id)!.proposals.map((p) => p.latestDate)).toEqual(["2030-03-14"]);
    // The released TO has no operations (no routing) ⇒ the default: Fri 03-08 − 3 = Tue 03-05.
    expect((await planningService.getArticleOverview(part.id)).rows.map((r) => r.date)).toEqual(["2030-03-05"]);
    // The färdigdatum floor is today + 3 working days (Thu 03-07): a need on
    // 03-06 cannot be met.
    await koFor(unrouted.id, 5, user.id, "2030-03-06");
    expect(await planningService.suggestManufacturingDueDate(unrouted.id, { quantity: 5 })).toMatchObject({ dueDate: "2030-03-07", late: true });

    // The field still wins over the default.
    await articleService.updateArticle(unrouted.id, { manufacturingLeadTimeDays: 1 });
    rows = await list({ search: "TP-U" });
    expect(rows.find((r) => r.articleId === unrouted.id)).toMatchObject({ leadDays: 1 });
  });
});
