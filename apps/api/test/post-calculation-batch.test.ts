import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, costCalculations, db, manufacturingOrders, permissionGroups } from "@navet/db";
import {
  createArticleGroupSchema,
  createArticleSchema,
  createStockLocationSchema,
  createWorkCenterSchema,
  POST_CALCULATION_BATCH_MAX,
  roundToDecimals,
} from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { manufacturingCost } from "../src/modules/costing/service/cost-figures.js";
import { createCostingService, type CostingService } from "../src/modules/costing/service/costing.service.js";
import { createPostCalculationBatchService } from "../src/modules/costing/service/post-calculation-batch.service.js";
import { perUnitVariance, postCalculationPerUnit } from "../src/modules/costing/service/post-calculation-batch.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Efterkalkylera flera (#34) through the real app: the selection (senaste
// inleverans — live receipts only, Stockholm day — article number range in
// byte order, article, varugrupp, statuses), the cap, the row's figures
// proven equal to the TO card's post-calculate and to Kalkylutfall for the
// same order, a failing order, the save and the access rules.

const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
const stockService = createStockService(createStockRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE cost_calculations, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, articles, article_groups, user_settings, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'EKF%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return login(email);
}

async function userCookie(permissions: string[], opts: { readOnly?: boolean; adminCookie?: string } = {}) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `EKF${crypto.randomUUID().slice(0, 6)}`, name: "Efterkalkylera flera", permissions })
    .returning();
  const email = `ekf-${crypto.randomUUID()}@example.com`;
  if (opts.readOnly) {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/users",
      headers: { cookie: opts.adminCookie! },
      payload: { email, password: PASSWORD, name: "Demo", role: "user", permissionGroupId: group!.id, readOnly: true },
    });
    expect(res.statusCode).toBe(201);
  } else {
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
  }
  return login(email);
}

const post = (cookie: string, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });
const get = (cookie: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });

const BATCH = "/costing/post-calculations/batch";
const ALL_STATUSES = ["planned", "released", "in_progress", "done", "closed", "cancelled"];

// The shared ground: a user, a resource (600 kr/h), a place and an employee.
async function makeBase() {
  const user = await authRepo.create({ email: `ekf-base-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Kalkyl", role: "admin" });
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", hourlyRate: 600, overheadPercent: 0, active: true }));
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
  const employee = await timeReportService.createEmployee({ employeeNumber: `E-${crypto.randomUUID().slice(0, 6)}`, name: "Kalle", active: true });
  return { user, workCenter, location, employee };
}
type Base = Awaited<ReturnType<typeof makeBase>>;

// A parent with one unlinked component (standard cost 10, two per parent)
// and one operation (setup 30 min, run 6 min/st at 600 kr/h).
async function makeProduct(base: Base, articleNumber: string) {
  const parent = await testArticleService.createArticle(parsed(createArticleSchema, { articleNumber, name: `Bänk ${articleNumber}`, type: "manufactured", active: true }));
  const component = await testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `${articleNumber}-K`, name: "Skiva", type: "purchased", standardCost: 10, active: true })
  );
  await testArticleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2 });
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: base.workCenter.id, setupTime: 30, runTimePerUnit: 6 });
  await stockService.recordTransaction({ articleId: component.id, locationId: base.location.id, quantityDelta: 1000, transactionType: "inventory_adjustment" });
  return parent;
}

// An order of `quantity` with `drawn` of the component drawn and `hours`
// reported, then `received` delivered by Slutför order (omitted: left open).
async function makeOrder(base: Base, articleId: string, opts: { quantity: number; drawn?: number; hours?: number; received?: number }) {
  const order = await mfgService.createManufacturingOrder({ articleId, quantity: opts.quantity }, base.user.id);
  const [material] = await mfgService.listMaterialConsumptions(order.id);
  const [operation] = await mfgService.listOperations(order.id);
  if (opts.drawn) await mfgService.consumeMaterial(order.id, material!.id, { locationId: base.location.id, quantity: opts.drawn }, base.user.id);
  if (opts.hours) {
    await timeReportService.createTimeReport({ employeeId: base.employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: opts.hours }, base.user.id);
  }
  if (opts.received !== undefined) await mfgService.complete(order.id, { quantity: opts.received, locationId: base.location.id }, base.user.id);
  return order;
}

// The moment the order's receipts (report-log rows that received goods)
// were booked. mo_reports is not the append-only stock log.
async function receivedAt(orderId: string, instant: string, kind?: "operation" | "completion") {
  await db.execute(
    kind
      ? sql`update mo_reports set created_at = ${instant}::timestamptz where manufacturing_order_id = ${orderId} and quantity_received > 0 and kind = ${kind}::mo_report_kind`
      : sql`update mo_reports set created_at = ${instant}::timestamptz where manufacturing_order_id = ${orderId} and quantity_received > 0`
  );
}

const statusOf = async (orderId: string) => (await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, orderId)))[0]!.status;

type Row = {
  manufacturingOrderId: string;
  orderNumber: string;
  status: string;
  lastReceivedOn: string | null;
  outputQuantity: number;
  preliminary: boolean;
  calculatedPerUnit: number | null;
  actualPerUnit: number | null;
  variance: { amount: number; percent: number | null } | null;
  latestPostCalculation: { calculationId: string; calculatedAt: string } | null;
  warnings: string[];
  error: string | null;
};

describe("Efterkalkylera flera — the selection", () => {
  // o1 A-10 (varugrupp) Klar, received 10 March noon
  // o2 A-9  Klar, received 10 March 23:30 UTC = 11 March in Stockholm
  // o3 B-1  open, nothing received
  // o4 B-1  4 received 5 March, the rest by Slutför order 20 March — undone
  // o5 B-1  Makulerad
  async function scenario() {
    const base = await makeBase();
    const group = await testArticleService.createArticleGroup(parsed(createArticleGroupSchema, { code: "70", name: "Bänkar" }));
    const a10 = await makeProduct(base, "A-10");
    await db.update(articles).set({ groupId: group.id }).where(eq(articles.id, a10.id));
    const a9 = await makeProduct(base, "A-9");
    const b1 = await makeProduct(base, "B-1");

    const o1 = await makeOrder(base, a10.id, { quantity: 2, received: 2 });
    await receivedAt(o1.id, "2026-03-10T12:00:00Z");
    const o2 = await makeOrder(base, a9.id, { quantity: 2, received: 2 });
    await receivedAt(o2.id, "2026-03-10T23:30:00Z");
    const o3 = await makeOrder(base, b1.id, { quantity: 2 });

    const o4 = await makeOrder(base, b1.id, { quantity: 10 });
    const [operation] = await mfgService.listOperations(o4.id);
    await mfgService.reportOperationQuantities(operation!.id, {
      quantityOk: 4,
      quantityScrapped: 0,
      markDone: false,
      locationId: base.location.id,
      createdBy: base.user.id,
    });
    await mfgService.complete(o4.id, { locationId: base.location.id }, base.user.id);
    expect(await statusOf(o4.id)).toBe("done");
    await receivedAt(o4.id, "2026-03-05T09:00:00Z", "operation");
    await receivedAt(o4.id, "2026-03-20T09:00:00Z", "completion");

    const o5 = await makeOrder(base, b1.id, { quantity: 2 });
    await mfgService.cancel(o5.id, base.user.id);
    return { base, group, a10, a9, b1, o1, o2, o3, o4, o5 };
  }

  const idsOf = (res: { json: () => { rows: Row[] } }) => res.json().rows.map((r) => r.manufacturingOrderId);

  it("takes the latest LIVE receipt as a Stockholm day: an undone receipt does not count", async () => {
    const cookie = await adminCookie();
    const s = await scenario();

    // Before the undo o4's latest receipt is the Slutför order of 20 March.
    const before = await post(cookie, BATCH, { selection: { statuses: ["done"], articleId: s.b1.id } });
    expect(before.json().rows.map((r: Row) => [r.manufacturingOrderId, r.lastReceivedOn])).toEqual([[s.o4.id, "2026-03-20"]]);

    const completion = (await mfgService.listReports(s.o4.id)).find((r) => r.kind === "completion")!;
    await mfgService.undoReport(s.o4.id, completion.id, s.base.user.id);
    expect(await statusOf(s.o4.id)).toBe("in_progress");

    // Everything, no dates: oldest receipt first, orders without one last
    // (by TO number). o4 is back on its delinleverans of 5 March.
    const all = await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES } });
    expect(all.statusCode).toBe(200);
    expect(all.json().rows.map((r: Row) => [r.manufacturingOrderId, r.lastReceivedOn, r.status])).toEqual([
      [s.o4.id, "2026-03-05", "in_progress"],
      [s.o1.id, "2026-03-10", "done"],
      [s.o2.id, "2026-03-11", "done"], // 23:30 UTC is the next day in Stockholm
      [s.o3.id, null, "released"],
      [s.o5.id, null, "cancelled"],
    ]);

    // The day's boundary, inclusive on both ends; an order without a
    // receipt is outside any date selection.
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, receivedFrom: "2026-03-11" } }))).toEqual([s.o2.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, receivedTo: "2026-03-10" } }))).toEqual([s.o4.id, s.o1.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, receivedFrom: "2026-03-10", receivedTo: "2026-03-10" } }))).toEqual([s.o1.id]);
    // The undone receipt of 20 March selects nothing.
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, receivedFrom: "2026-03-12" } }))).toEqual([]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, receivedFrom: "1900-01-01" } }))).toEqual([s.o4.id, s.o1.id, s.o2.id]);
  });

  it("filters on statuses, article number range in byte order, article and varugrupp", async () => {
    const cookie = await adminCookie();
    const s = await scenario();

    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ["done", "closed"] } }))).toEqual([s.o1.id, s.o2.id, s.o4.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ["cancelled"] } }))).toEqual([s.o5.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ["released"] } }))).toEqual([s.o3.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ["planned", "closed"] } }))).toEqual([]);

    // Byte order: "A-10" sorts before "A-9".
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, articleNumberFrom: "A-1", articleNumberTo: "A-9" } }))).toEqual([s.o1.id, s.o2.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, articleNumberTo: "A-10" } }))).toEqual([s.o1.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ["done"], articleNumberFrom: "A-2" } }))).toEqual([s.o2.id, s.o4.id]);

    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, articleId: s.b1.id } }))).toEqual([s.o4.id, s.o3.id, s.o5.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, groupId: s.group.id } }))).toEqual([s.o1.id]);
    expect(idsOf(await post(cookie, BATCH, { selection: { statuses: ALL_STATUSES, groupId: s.group.id, articleId: s.b1.id } }))).toEqual([]);
  });

  it("lists the selection without calculating: the run's match and order, has-efterkalkyl, nothing written", async () => {
    const cookie = await adminCookie();
    const s = await scenario();
    const saved = await post(cookie, `/manufacturing-orders/${s.o2.id}/cost-calculations/post-calculate`, { save: true });
    expect(saved.statusCode).toBe(201);
    const count = (await db.select().from(costCalculations)).length;

    const listed = await post(cookie, `${BATCH}/selection`, { selection: { statuses: ["done", "cancelled"] } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      count: 4,
      max: POST_CALCULATION_BATCH_MAX,
      orders: [
        { manufacturingOrderId: s.o1.id, orderNumber: s.o1.orderNumber, articleId: s.a10.id, articleNumber: "A-10", articleName: "Bänk A-10", status: "done", lastReceivedOn: "2026-03-10", hasPostCalculation: false },
        { manufacturingOrderId: s.o2.id, orderNumber: s.o2.orderNumber, articleId: s.a9.id, articleNumber: "A-9", articleName: "Bänk A-9", status: "done", lastReceivedOn: "2026-03-11", hasPostCalculation: true },
        { manufacturingOrderId: s.o4.id, orderNumber: s.o4.orderNumber, articleId: s.b1.id, articleNumber: "B-1", articleName: "Bänk B-1", status: "done", lastReceivedOn: "2026-03-20", hasPostCalculation: false },
        { manufacturingOrderId: s.o5.id, orderNumber: s.o5.orderNumber, articleId: s.b1.id, articleNumber: "B-1", articleName: "Bänk B-1", status: "cancelled", lastReceivedOn: null, hasPostCalculation: false },
      ],
    });
    expect(await db.select().from(costCalculations)).toHaveLength(count);
  });

  it("gives 400 validation-failed on a body that does not parse", async () => {
    const cookie = await adminCookie();
    const bad = [
      { url: BATCH, payload: {} },
      { url: BATCH, payload: { selection: {} } }, // no statuses
      { url: BATCH, payload: { selection: { statuses: [] } } },
      { url: BATCH, payload: { selection: { statuses: ["finished"] } } },
      { url: BATCH, payload: { selection: { statuses: ["done", "done"] } } },
      { url: BATCH, payload: { selection: { statuses: ["done"], receivedFrom: "2026-02-30" } } },
      { url: BATCH, payload: { selection: { statuses: ["done"], receivedTo: "10 mars" } } },
      { url: BATCH, payload: { selection: { statuses: ["done"], articleId: "nope" } } },
      { url: BATCH, payload: { selection: { statuses: ["done"], articleNumberFrom: " " } } },
      { url: BATCH, payload: { selection: { statuses: ["done"], type: "manufactured" } } }, // unknown filter
      { url: BATCH, payload: { selection: { statuses: ["done"] }, save: true } },
      { url: `${BATCH}/selection`, payload: { selection: { statuses: [] } } },
      { url: `${BATCH}/save`, payload: {} },
      { url: `${BATCH}/save`, payload: { manufacturingOrderIds: [] } },
      { url: `${BATCH}/save`, payload: { manufacturingOrderIds: ["not-a-uuid"] } },
      { url: `${BATCH}/save`, payload: { manufacturingOrderIds: ["0b0e8b0a-7c5e-4c38-9f0e-2d1c3b4a5f60", "0b0e8b0a-7c5e-4c38-9f0e-2d1c3b4a5f60"] } },
      { url: `${BATCH}/save`, payload: { manufacturingOrderIds: Array.from({ length: POST_CALCULATION_BATCH_MAX + 1 }, () => crypto.randomUUID()) } },
    ];
    for (const attempt of bad) {
      const res = await post(cookie, attempt.url, attempt.payload);
      expect([attempt.url, JSON.stringify(attempt.payload).slice(0, 70), res.statusCode, res.json().code]).toEqual([
        attempt.url,
        JSON.stringify(attempt.payload).slice(0, 70),
        400,
        "validation-failed",
      ]);
    }
  });

  it("answers the cap as 400 post-calculation-batch-too-large with count and max, before anything is calculated", async () => {
    const cookie = await adminCookie();
    const base = await makeBase();
    const product = await makeProduct(base, "A-1");
    await db.insert(manufacturingOrders).values(
      Array.from({ length: POST_CALCULATION_BATCH_MAX + 1 }, (_, i) => ({
        orderNumber: `BULK-${String(i).padStart(4, "0")}`,
        articleId: product.id,
        quantity: "1",
        status: "planned" as const,
      }))
    );
    const res = await post(cookie, BATCH, { selection: { statuses: ["planned"] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "post-calculation-batch-too-large",
      count: POST_CALCULATION_BATCH_MAX + 1,
      max: POST_CALCULATION_BATCH_MAX,
    });
    expect(res.json().error).toContain(`${POST_CALCULATION_BATCH_MAX + 1} tillverkningsordrar`);

    // Visa urval is never refused: the count past the cap, the cap's worth listed.
    const listed = await post(cookie, `${BATCH}/selection`, { selection: { statuses: ["planned"] } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().count).toBe(POST_CALCULATION_BATCH_MAX + 1);
    expect(listed.json().orders).toHaveLength(POST_CALCULATION_BATCH_MAX);
    // The empty selection is just empty.
    expect((await post(cookie, BATCH, { selection: { statuses: ["closed"] } })).json()).toEqual({ rows: [] });
  });
});

describe("Efterkalkylera flera — the row", () => {
  // A: 10 ordered, 20 drawn, 2 h, kortstängd at 8. Efterkalkyl 200 + 1200 =
  //    1400 ⇒ 175/st; Kalkylerat 16 × 10 + (30 + 48) / 60 × 600 = 940 ⇒ 117.50/st.
  // B: 5 ordered, 1 h, open — preliminary (Ej klar).
  // C: Makulerad, N = 0.
  async function scenario() {
    const base = await makeBase();
    const product = await makeProduct(base, "P-1");
    const a = await makeOrder(base, product.id, { quantity: 10, drawn: 20, hours: 2, received: 8 });
    await receivedAt(a.id, "2026-04-02T10:00:00Z");
    const b = await makeOrder(base, product.id, { quantity: 5, hours: 1 });
    const c = await makeOrder(base, product.id, { quantity: 5 });
    await mfgService.cancel(c.id, base.user.id);
    return { base, product, a, b, c };
  }

  it("carries the card's efterkalkyl and Kalkylutfall's figures for the same order", async () => {
    const cookie = await adminCookie();
    const s = await scenario();
    // Kalkylutfall's Mot förkalkyl lists an order only against a förkalkyl.
    expect((await post(cookie, `/articles/${s.product.id}/cost-calculations/pre-calculate`, { quantity: 10, save: true })).statusCode).toBe(201);

    const res = await post(cookie, BATCH, { selection: { statuses: ["done"] } });
    expect(res.statusCode).toBe(200);
    const [row] = res.json().rows as Row[];
    expect(res.json().rows).toHaveLength(1);
    expect(row).toEqual({
      manufacturingOrderId: s.a.id,
      orderNumber: s.a.orderNumber,
      articleId: s.product.id,
      articleNumber: "P-1",
      articleName: "Bänk P-1",
      status: "done",
      lastReceivedOn: "2026-04-02",
      outputQuantity: 8,
      preliminary: false,
      calculatedPerUnit: 117.5,
      actualPerUnit: 175,
      variance: { amount: 57.5, percent: 48.94 },
      latestPostCalculation: null,
      warnings: [],
      error: null,
    });
    // The preview wrote nothing.
    expect(await db.select().from(costCalculations).where(eq(costCalculations.type, "post"))).toEqual([]);

    // The TO card's own preview of the same order: the same efterkalkyl
    // (TVK ÷ N) and the same Kalkylerat (the analysis's base ÷ N).
    const card = (await post(cookie, `/manufacturing-orders/${s.a.id}/cost-calculations/post-calculate`)).json();
    expect(card.analysis.preliminary).toBe(false);
    expect(card.analysis.outputQuantity).toBe(row!.outputQuantity);
    expect(row!.actualPerUnit).toBe(roundToDecimals(manufacturingCost(card.calculation) / card.analysis.outputQuantity, 4));
    expect(row!.calculatedPerUnit).toBe(roundToDecimals(card.analysis.base / card.analysis.outputQuantity, 4));
    expect(row!.warnings).toEqual(card.warnings);

    // Saved from the batch, Kalkylutfall shows the same two per-unit figures.
    const saved = await post(cookie, `${BATCH}/save`, { manufacturingOrderIds: [s.a.id] });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      saved: [{ manufacturingOrderId: s.a.id, orderNumber: s.a.orderNumber, calculationId: expect.any(String) }],
      errors: [],
    });
    const calculationId = saved.json().saved[0].calculationId as string;
    const outcome = (await get(cookie, "/reports/calculation-outcome")).json();
    const outcomeRow = outcome.rows.find((r: { manufacturingOrderId: string }) => r.manufacturingOrderId === s.a.id);
    expect(outcomeRow).toMatchObject({ calculationId, perUnitBasis: "output", outputQuantity: 8 });
    expect(row!.actualPerUnit).toBe(roundToDecimals(outcomeRow.postTvkPerUnit, 4));
    expect(row!.calculatedPerUnit).toBe(roundToDecimals(outcomeRow.calculatedTvkPerUnit, 4));

    // The saved efterkalkyl IS the card's saved one: same header figures and
    // analysis as GET /cost-calculations/:id and as the card's own Spara.
    const stored = (await get(cookie, `/cost-calculations/${calculationId}`)).json();
    expect(stored).toMatchObject({ type: "post", manufacturingOrderId: s.a.id, preliminary: false });
    expect(Number(stored.outputQuantity)).toBe(8);
    expect(manufacturingCost(stored)).toBe(manufacturingCost(card.calculation));
    expect(stored.analysis.base).toBe(card.analysis.base);
    const cardSaved = (await post(cookie, `/manufacturing-orders/${s.a.id}/cost-calculations/post-calculate`, { save: true })).json();
    expect(manufacturingCost(cardSaved.calculation)).toBe(manufacturingCost(stored));
    // (each saved calculation has specification rows of its own, hence the ids)
    const withoutRowIds = (analysis: { materialRows: { id: string }[]; operationRows: { id: string }[] }) => ({
      ...analysis,
      materialRows: analysis.materialRows.map((r) => ({ ...r, id: null })),
      operationRows: analysis.operationRows.map((r) => ({ ...r, id: null })),
    });
    expect(withoutRowIds(cardSaved.analysis)).toEqual(withoutRowIds(stored.analysis));

    // Now the row names the latest saved efterkalkyl (the card's, the newer).
    const again = (await post(cookie, BATCH, { selection: { statuses: ["done"] } })).json().rows[0] as Row;
    expect(again.latestPostCalculation).toEqual({
      calculationId: cardSaved.calculation.id,
      calculatedAt: new Date(cardSaved.calculation.calculatedAt).toISOString(),
    });
    expect({ ...again, latestPostCalculation: null }).toEqual(row);
    // No price was set by the save.
    const [article] = await db.select().from(articles).where(eq(articles.id, s.product.id));
    expect([article!.standardCost, article!.salesPrice]).toEqual([null, null]);
  });

  it("marks an open order preliminary with no per-unit figures, and a Makulerad one final with N = 0", async () => {
    const cookie = await adminCookie();
    const s = await scenario();
    const res = await post(cookie, BATCH, { selection: { statuses: ["released", "in_progress", "cancelled"] } });
    const rows = res.json().rows as Row[];
    expect(rows.map((r) => r.manufacturingOrderId)).toEqual([s.b.id, s.c.id]);
    expect(rows[0]).toMatchObject({
      status: await statusOf(s.b.id),
      lastReceivedOn: null,
      outputQuantity: 0,
      preliminary: true,
      calculatedPerUnit: null,
      actualPerUnit: null,
      variance: null,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      status: "cancelled",
      lastReceivedOn: null,
      outputQuantity: 0,
      preliminary: false,
      calculatedPerUnit: null,
      actualPerUnit: null,
      variance: null,
      error: null,
    });
    // The card agrees: preliminary on the open order, N = 0 on the Makulerad.
    const cardB = (await post(cookie, `/manufacturing-orders/${s.b.id}/cost-calculations/post-calculate`)).json();
    expect(cardB.analysis.preliminary).toBe(true);
    const cardC = (await post(cookie, `/manufacturing-orders/${s.c.id}/cost-calculations/post-calculate`)).json();
    expect([cardC.analysis.preliminary, cardC.analysis.outputQuantity]).toEqual([false, 0]);

    // A preliminary efterkalkyl can still be saved, as on the card.
    const saved = await post(cookie, `${BATCH}/save`, { manufacturingOrderIds: [s.b.id, s.c.id] });
    expect(saved.json().errors).toEqual([]);
    expect(saved.json().saved.map((x: { manufacturingOrderId: string }) => x.manufacturingOrderId)).toEqual([s.b.id, s.c.id]);
    const stored = await db.select().from(costCalculations).where(eq(costCalculations.manufacturingOrderId, s.b.id));
    expect(stored.map((c) => [c.type, c.preliminary])).toEqual([["post", true]]);
  });

  it("derives the deviation from the two shown figures", () => {
    expect(perUnitVariance(175, 117.5)).toEqual({ amount: 57.5, percent: 48.94 });
    expect(perUnitVariance(90, 100)).toEqual({ amount: -10, percent: -10 });
    expect(perUnitVariance(12.5, 0)).toEqual({ amount: 12.5, percent: null });
    expect(perUnitVariance(null, 100)).toBeNull();
    expect(perUnitVariance(100, null)).toBeNull();
    // Final with N: TVK ÷ N and base ÷ N; preliminary or N = 0: nothing.
    const buckets = { materialCost: "200.0000", materialOverhead: 0, laborCost: "1200.0000", subcontractCost: 0, subcontractOverhead: 0, semiFinishedCost: 0 };
    const analysis = { preliminary: false, outputQuantity: 8, base: 940 };
    expect(postCalculationPerUnit({ ...buckets, quantity: 10, outputQuantity: "8.0000", preliminary: false }, analysis)).toEqual({
      calculatedPerUnit: 117.5,
      actualPerUnit: 175,
      variance: { amount: 57.5, percent: 48.94 },
    });
    expect(postCalculationPerUnit({ ...buckets, quantity: 10, outputQuantity: "8.0000", preliminary: true }, { ...analysis, preliminary: true })).toEqual({
      calculatedPerUnit: null,
      actualPerUnit: null,
      variance: null,
    });
    expect(postCalculationPerUnit({ ...buckets, quantity: 10, outputQuantity: 0, preliminary: false }, { ...analysis, outputQuantity: 0 })).toEqual({
      calculatedPerUnit: null,
      actualPerUnit: null,
      variance: null,
    });
  });
});

describe("Efterkalkylera flera — one order's failure", () => {
  it("is that row's error in the preview and one of the save's errors, never the batch's", async () => {
    const base = await makeBase();
    const product = await makeProduct(base, "F-1");
    const good = await makeOrder(base, product.id, { quantity: 2, received: 2 });
    const bad = await makeOrder(base, product.id, { quantity: 2, received: 2 });
    await receivedAt(good.id, "2026-05-04T08:00:00Z");
    await receivedAt(bad.id, "2026-05-05T08:00:00Z");

    // The real costing service (app.ts's settings), failing for one order.
    const real = createCostingService(createCostingRepository(db), testSystemService);
    const logged: string[] = [];
    // The cast narrows the wrapper to postCalculate's two overloads — it
    // forwards `save` untouched, so each overload answers what the real one does.
    const postCalculate = ((id: string, save?: boolean) => {
      if (id === bad.id) throw new Error("boom");
      return save ? real.postCalculate(id, true) : real.postCalculate(id);
    }) as CostingService["postCalculate"];
    const batch = createPostCalculationBatchService({ db, costing: { postCalculate }, log: (msg) => logged.push(msg) });

    const { rows } = await batch.preview({ selection: { statuses: ["done"] } });
    expect(rows.map((r) => [r.manufacturingOrderId, r.error])).toEqual([
      [good.id, null],
      [bad.id, "Efterkalkylen kunde inte beräknas"],
    ]);
    expect(rows[0]!.actualPerUnit).not.toBeNull();
    expect(rows[1]).toMatchObject({
      orderNumber: bad.orderNumber,
      lastReceivedOn: "2026-05-05",
      outputQuantity: 2,
      preliminary: false,
      calculatedPerUnit: null,
      actualPerUnit: null,
      variance: null,
      warnings: [],
    });
    expect(logged).toHaveLength(1);

    // The save: the failing order and an unknown one are errors, the good
    // one is saved — in the order asked for.
    const unknown = crypto.randomUUID();
    const result = await batch.save({ manufacturingOrderIds: [bad.id, unknown, good.id] });
    expect(result).toEqual({
      saved: [{ manufacturingOrderId: good.id, orderNumber: good.orderNumber, calculationId: expect.any(String) }],
      errors: [
        { manufacturingOrderId: bad.id, orderNumber: bad.orderNumber, message: "Efterkalkylen kunde inte beräknas" },
        { manufacturingOrderId: unknown, orderNumber: null, message: "Tillverkningsordern finns inte" },
      ],
    });
    const stored = await db.select().from(costCalculations).where(eq(costCalculations.type, "post"));
    expect(stored.map((c) => [c.id, c.manufacturingOrderId])).toEqual([[result.saved[0]!.calculationId, good.id]]);
    expect(logged).toHaveLength(2);
  });

  it("answers an unknown order in the save's errors through the route, not as a 404", async () => {
    const cookie = await adminCookie();
    const unknown = crypto.randomUUID();
    const res = await post(cookie, `${BATCH}/save`, { manufacturingOrderIds: [unknown] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ saved: [], errors: [{ manufacturingOrderId: unknown, orderNumber: null, message: "Tillverkningsordern finns inte" }] });
  });
});

describe("Efterkalkylera flera — access", () => {
  it("is Tillverkning's, like the card's efterkalkyl: office without it and the workshop profile get 403", async () => {
    const base = await makeBase();
    const product = await makeProduct(base, "T-1");
    const order = await makeOrder(base, product.id, { quantity: 2, received: 2 });
    const body = { selection: { statuses: ["done"] } };
    const save = { manufacturingOrderIds: [order.id] };

    const allowed = await userCookie(["tillverkning"]);
    expect((await post(allowed, BATCH, body)).statusCode).toBe(200);
    expect((await post(allowed, `${BATCH}/selection`, body)).statusCode).toBe(200);
    expect((await post(allowed, `${BATCH}/save`, save)).statusCode).toBe(200);
    expect((await post(allowed, `/manufacturing-orders/${order.id}/cost-calculations/post-calculate`)).statusCode).toBe(200);

    for (const permissions of [["artiklar"], ["forsaljning", "inkop", "lager", "ekonomi"], ["terminal", "tillverkningsorder_las", "artikeloversikt"]]) {
      const cookie = await userCookie(permissions);
      for (const [url, payload] of [
        [BATCH, body],
        [`${BATCH}/selection`, body],
        [`${BATCH}/save`, save],
        // The card's route answers the same.
        [`/manufacturing-orders/${order.id}/cost-calculations/post-calculate`, undefined],
      ] as const) {
        const res = await post(cookie, url, payload);
        expect([permissions.join(","), url, res.statusCode]).toEqual([permissions.join(","), url, 403]);
      }
    }
    // One efterkalkyl: the allowed user's save.
    expect(await db.select().from(costCalculations).where(eq(costCalculations.type, "post"))).toHaveLength(1);
  });

  it("lets a read-only account preview and list the selection but not save", async () => {
    const admin = await adminCookie();
    const cookie = await userCookie(["tillverkning"], { readOnly: true, adminCookie: admin });
    const base = await makeBase();
    const product = await makeProduct(base, "L-1");
    const order = await makeOrder(base, product.id, { quantity: 2, received: 2 });
    const body = { selection: { statuses: ["done"] } };

    const res = await post(cookie, BATCH, body);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: Row) => [r.manufacturingOrderId, r.error])).toEqual([[order.id, null]]);
    const listed = await post(cookie, `${BATCH}/selection`, body);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().count).toBe(1);
    const saved = await post(cookie, `${BATCH}/save`, { manufacturingOrderIds: [order.id] });
    expect(saved.statusCode).toBe(403);
    expect(saved.json().code).toBe("read-only-account");
    expect(await db.select().from(costCalculations)).toEqual([]);
  });
});
