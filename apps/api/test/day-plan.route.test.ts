import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  attendanceSessions,
  db,
  employees,
  employeeWorkCenters,
  permissionGroups,
  purchaseOrderRows,
  purchaseOrders,
  stampSessions,
  suppliers,
} from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import type { CapacityResult } from "../src/modules/planning/service/capacity-calc.js";
import type { DayPlanResult } from "../src/modules/planning/service/day-plan.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService, type ManufacturingOrderCoverage } from "../src/modules/planning/service/planning.service.js";
import type { RunPlanResult } from "../src/modules/planning/service/run-plan.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { isoWeekOf } from "../src/modules/timereport/service/schedule.service.js";
import { parsed } from "./helpers/parsed.js";
import { pdfText } from "./helpers/pdf.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Dagplan (GET /planning/day-plan[/pdf]) through the real app. The point of
// the feature is that nothing is its own: a row is the körplan's
// (GET /planning/run-plan) for the same operation, the load is Beläggning's
// day cell (GET /planning/capacity?granularity=day), the material is the
// usable balance (never a Spärrad lagerplats) with Kommer from the pegging
// (GET /manufacturing-orders/:id/coverage) — and the pegging is only run
// when something is short.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
const stockService = createStockService(createStockRepository(db));
// No plan reader: the orders are created unplanned, the plan is set by hand.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, attendance_sessions, employee_work_centers, stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, purchase_order_rows, purchase_orders, suppliers, holidays, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'DPL%'`;

let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
// The same Stockholm day the service anchors on, whenever the suite runs.
const today = stockholmToday();
const tomorrow = addDays(today, 1);

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
async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `DPL${crypto.randomUUID().slice(0, 6)}`, name: "Dagplan", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const get = (cookie: string, url: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } });

async function dayPlan(cookie: string, query = ""): Promise<DayPlanResult> {
  const res = await get(cookie, `/planning/day-plan${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const resourceOf = (plan: DayPlanResult, workCenterId: string) => plan.resources.find((r) => r.workCenter.id === workCenterId)!;

// Kap(100, 8 h a day), Svets(200) and a legoresurs. The product STOL: op 10
// on Kap (ställ 30, 2 min/st), op 20 on Svets (3 min/st). On op 10 lie four
// PURCHASED materials (1, 2, 3 and 1 per st), a halvfabrikat — and one
// purchased material that is not linked to any operation.
async function world() {
  const user = await authRepo.create({ email: `dpl-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "admin" });
  const svets = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "200", name: "Svets", active: true }));
  const kap = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Kap", active: true, hoursPerDay: 8 }));
  const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling AB", type: "subcontract", active: true }));
  const suffix = crypto.randomUUID().slice(0, 8);
  const article = (number: string, type: "manufactured" | "purchased", extra: Record<string, unknown> = {}) =>
    articleService.createArticle(parsed(createArticleSchema, { articleNumber: `${number}-${suffix}`, name: number, type, active: true, ...extra }));
  const product = await article("STOL", "manufactured", { standardCost: 123.45 });
  const plat = await article("M1-PLAT", "purchased", { standardCost: 9.5 });
  const ror = await article("M2-ROR", "purchased");
  const bult = await article("M3-BULT", "purchased");
  const lack = await article("M4-LACK", "purchased");
  const halv = await article("M5-HALV", "manufactured");
  const loose = await article("M6-LOS", "purchased");
  const r10 = await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 30, runTimePerUnit: 2, description: "Kapa rör" });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 20, workCenterId: svets.id, setupTime: 0, runTimePerUnit: 3 });
  await articleService.addBomComponent(product.id, { componentArticleId: plat.id, quantity: 1, routingOperationId: r10.id });
  await articleService.addBomComponent(product.id, { componentArticleId: ror.id, quantity: 2, routingOperationId: r10.id });
  await articleService.addBomComponent(product.id, { componentArticleId: bult.id, quantity: 3, routingOperationId: r10.id });
  await articleService.addBomComponent(product.id, { componentArticleId: lack.id, quantity: 1, routingOperationId: r10.id });
  await articleService.addBomComponent(product.id, { componentArticleId: halv.id, quantity: 1, routingOperationId: r10.id });
  await articleService.addBomComponent(product.id, { componentArticleId: loose.id, quantity: 1 });
  // Only a halvfabrikat on its operation: never "linked" in the planning's sense.
  const frame = await article("RAM", "manufactured");
  const f10 = await mfgService.createRoutingOperation(frame.id, { sequenceNo: 10, workCenterId: svets.id, setupTime: 0, runTimePerUnit: 6 });
  await articleService.addBomComponent(frame.id, { componentArticleId: halv.id, quantity: 1, routingOperationId: f10.id });

  const order = async (articleId: string, quantity: number, dueDate: string | null) => {
    const mo = await mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId, quantity, dueDate }), user.id);
    const ops = await mfgService.listOperations(mo.id);
    return { ...mo, ops, op10: ops.find((o) => o.sequenceNo === 10)!, op20: ops.find((o) => o.sequenceNo === 20) };
  };

  const warehouse = (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!;
  const place = (name: string, blocked: boolean) => stockService.createLocation({ warehouseId: warehouse.id, name, active: true, fixed: true, blocked });
  const shelf = await place("A1", false);
  const quarantine = await place("SPÄRR", true);
  const stock = (articleId: string, locationId: string, quantityDelta: number) =>
    stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" }, user.id);

  return { user, kap, svets, lego, product, frame, plat, ror, bult, lack, halv, loose, order, shelf, quarantine, stock };
}

// The plan set by hand: `minutes` on each of the given days.
async function planOn(moOperationId: string, days: { date: string; minutes: number }[]) {
  for (const day of days) {
    await db.execute(
      sql`INSERT INTO mo_operation_plan_days (mo_operation_id, plan_date, minutes) VALUES (${moOperationId}, ${day.date}::date, ${day.minutes})`
    );
  }
  await db.execute(
    sql`UPDATE mo_operations SET planned_start_date = ${days[0]!.date}::date, planned_end_date = ${days[days.length - 1]!.date}::date, planned_at = now() WHERE id = ${moOperationId}`
  );
}

// A confirmed IO with one row of the article, arriving `date`.
async function purchaseOrder(articleId: string, quantity: number, date: string) {
  const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L${crypto.randomUUID().slice(0, 6)}`, name: "Leverantör AB" }).returning();
  const [po] = await db
    .insert(purchaseOrders)
    .values({ orderNumber: `IO-${crypto.randomUUID().slice(0, 6)}`, supplierId: supplier!.id, status: "confirmed", expectedDeliveryDate: date, confirmedDeliveryDate: date })
    .returning();
  await db.insert(purchaseOrderRows).values({
    purchaseOrderId: po!.id,
    articleId,
    quantityOrdered: String(quantity),
    quantityReceived: "0",
    unitPrice: "10",
    expectedDeliveryDate: date,
    confirmedDeliveryDate: date,
  });
  return po!;
}

describe("GET /planning/day-plan — svaret och de lånade talen", () => {
  it("answers the day, every own resource in station order and the totals", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const mo = await w.order(w.product.id, 10, addDays(today, 30));
    // 50 min on Kap today; op 20 on Svets is unplanned (it lies on the due date).
    await planOn(mo.op10.id, [{ date: today, minutes: 50 }]);

    const plan = await dayPlan(cookie);
    expect(plan.today).toBe(today);
    expect(plan.date).toBe(today);
    expect(plan.weekday).toBe(new Date(`${today}T00:00:00Z`).getUTCDay() || 7);
    expect(plan.isoWeek).toBe(isoWeekOf(today).isoWeek);
    // Never a passed day.
    expect(plan.previousDate).toBeNull();
    expect(plan.nextDate! > today).toBe(true);
    expect(plan.productionGroups).toEqual([]);
    // Natural station order, never the legoresurs.
    expect(plan.resources.map((r) => r.workCenter.code)).toEqual(["100", "200"]);

    const kap = resourceOf(plan, w.kap.id);
    expect(kap.workCenter).toEqual({ id: w.kap.id, code: "100", name: "Kap" });
    expect(kap.carried).toEqual([]);
    expect(kap.rows.map((r) => r.moOperationId)).toEqual([mo.op10.id]);
    expect(kap.rowHours).toBe(0.83);
    expect(kap.unplannedRows).toBe(0);
    expect(kap.present).toEqual([]);
    const svets = resourceOf(plan, w.svets.id);
    expect(svets.rows).toEqual([]);
    expect(svets.rowHours).toBe(0);
    // Four short materials on op 10 (nothing is in stock).
    expect(plan.totals).toEqual({ rows: 1, hours: 0.83, unlinkedOperations: 0, shortMaterials: 4 });

    // The same day asked for by date, and the day after: the row is gone.
    expect(await dayPlan(cookie, `?date=${today}`)).toEqual(plan);
    const next = await dayPlan(cookie, `?date=${tomorrow}`);
    expect(next.date).toBe(tomorrow);
    expect(next.previousDate === null || next.previousDate === today).toBe(true);
    expect(resourceOf(next, w.kap.id).rows).toEqual([]);
    expect(resourceOf(next, w.kap.id).carried).toEqual([]);
  });

  it("a row is the körplan's for the same operation — Tid kvar, the day, the status and the extras", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const mo = await w.order(w.product.id, 10, addDays(today, 30));
    await planOn(mo.op10.id, [{ date: today, minutes: 50 }]);
    await w.stock(w.plat.id, w.shelf.id, 10);

    const row = resourceOf(await dayPlan(cookie), w.kap.id).rows[0]!;
    const runPlanRes = await get(cookie, `/planning/run-plan?workCenterId=${w.kap.id}`);
    expect(runPlanRes.statusCode).toBe(200);
    const runPlanRow = (runPlanRes.json() as RunPlanResult).rows.find((r) => r.moOperationId === mo.op10.id)!;
    // Every field, the materials and the stamps included: one loader.
    expect(row).toEqual(runPlanRow);
    expect(row).toMatchObject({ date: today, late: false, remainingMinutes: 50, remainingHours: 0.83, status: "ready", reorderable: true, materialLinked: true });
    expect(row.materials).toHaveLength(4);
  });

  it("the load is Beläggning's day cell for the same resource and day", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const a = await w.order(w.product.id, 10, addDays(today, 30));
    const b = await w.order(w.product.id, 200, addDays(today, 30));
    // 430 min over today and tomorrow, and 50 min today: 5,5 h today, 2,5 h tomorrow.
    await planOn(b.op10.id, [
      { date: today, minutes: 280 },
      { date: tomorrow, minutes: 150 },
    ]);
    await planOn(a.op10.id, [{ date: today, minutes: 50 }]);

    const capacityRes = await get(cookie, "/planning/capacity?granularity=day");
    expect(capacityRes.statusCode).toBe(200);
    const capacity = capacityRes.json() as CapacityResult;
    const resources = capacity.groups.flatMap((g) => g.resources);
    for (const [i, date] of [today, tomorrow].entries()) {
      const plan = await dayPlan(cookie, `?date=${date}`);
      for (const resource of plan.resources) {
        const matrix = resources.find((r) => r.workCenterId === resource.workCenter.id)!;
        expect(resource.load, `${resource.workCenter.code} ${date}`).toEqual(matrix.dayLoads[i]);
      }
    }
    expect(resourceOf(await dayPlan(cookie), w.kap.id).load.loadHours).toBe(5.5);
    const next = resourceOf(await dayPlan(cookie, `?date=${tomorrow}`), w.kap.id);
    expect(next.load.loadHours).toBe(2.5);
    // Kvar från tidigare a later day: the operation that started today and
    // still lies on the day.
    expect(next.carried.map((r) => r.moOperationId)).toEqual([b.op10.id]);
    expect(next.rows).toEqual([]);
  });

  it("carries no price field", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const mo = await w.order(w.product.id, 10, addDays(today, 30));
    await planOn(mo.op10.id, [{ date: today, minutes: 50 }]);
    await w.stock(w.plat.id, w.shelf.id, 10);
    await purchaseOrder(w.ror.id, 20, addDays(today, 3));

    const res = await get(cookie, "/planning/day-plan");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/price|cost|amount/i);
  });
});

describe("GET /planning/day-plan — material", () => {
  it("finns, saknas with an IO on its way, saknas without cover, a Spärrad lagerplats is never counted", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const mo = await w.order(w.product.id, 10, addDays(today, 30));
    await planOn(mo.op10.id, [{ date: today, minutes: 50 }]);
    const frame = await w.order(w.frame.id, 5, addDays(today, 30));
    await planOn(frame.op10.id, [{ date: today, minutes: 30 }]);
    // M1 need 10: 10 on the shelf. M2 need 20: 5 on the shelf and an IO for
    // the rest. M3 need 30: 4 on the shelf, nothing coming. M4 need 10: 2 on
    // the shelf and 10 on a Spärrad lagerplats.
    await w.stock(w.plat.id, w.shelf.id, 10);
    await w.stock(w.ror.id, w.shelf.id, 5);
    await w.stock(w.bult.id, w.shelf.id, 4);
    await w.stock(w.lack.id, w.shelf.id, 2);
    await w.stock(w.lack.id, w.quarantine.id, 10);
    const io = await purchaseOrder(w.ror.id, 15, addDays(today, 3));

    const plan = await dayPlan(cookie);
    const row = resourceOf(plan, w.kap.id).rows[0]!;
    expect(row.materialLinked).toBe(true);
    // Natural article-number order; the halvfabrikat and the unlinked
    // material are never listed.
    expect(row.materials.map((m) => m.articleId)).toEqual([w.plat.id, w.ror.id, w.bult.id, w.lack.id]);
    const [plat, ror, bult, lack] = row.materials;
    expect(plat).toEqual({
      articleId: w.plat.id,
      articleNumber: w.plat.articleNumber,
      articleName: "M1-PLAT",
      unit: plat!.unit,
      remainingQuantity: 10,
      usableOnHand: 10,
      status: "available",
      missingQuantity: 0,
      supply: null,
    });
    // The article's base unit, as the terminal's material rows read it.
    const [unit] = await db.execute<{ code: string | null }>(
      sql`SELECT u.code FROM articles a LEFT JOIN units u ON u.id = a.unit_id WHERE a.id = ${w.plat.id}`
    );
    expect(plat!.unit).toBe(unit!.code);
    // Kommer: the pegging's allocation for the same need — the same document
    // and day as the TO card's Täcks av.
    const coverageRes = await get(cookie, `/manufacturing-orders/${mo.id}/coverage`);
    expect(coverageRes.statusCode).toBe(200);
    const coverage = coverageRes.json() as ManufacturingOrderCoverage;
    const pegged = coverage.materials.find((m) => m.articleId === w.ror.id)!.allocations.find((a) => a.kind === "purchase_order")!;
    expect(pegged).toMatchObject({ documentId: io.id, documentNumber: io.orderNumber });
    expect(ror).toMatchObject({
      remainingQuantity: 20,
      usableOnHand: 5,
      status: "short",
      // Covered by the shelf and the IO together.
      missingQuantity: 0,
      supply: { kind: "purchase_order", documentId: io.id, documentNumber: io.orderNumber, date: pegged.readyDate, isDraft: false },
    });
    expect(ror!.supply!.date).toBe(addDays(today, 3));
    // Nothing on its way: what is missing.
    expect(bult).toMatchObject({ remainingQuantity: 30, usableOnHand: 4, status: "short", missingQuantity: 26, supply: null });
    // 12 physically, 2 usable.
    expect(lack).toMatchObject({ remainingQuantity: 10, usableOnHand: 2, status: "short", missingQuantity: 8, supply: null });

    // Only a halvfabrikat on the operation: no material, not linked.
    const frameRow = resourceOf(plan, w.svets.id).rows.find((r) => r.moOperationId === frame.op10.id)!;
    expect(frameRow.materials).toEqual([]);
    expect(frameRow.materialLinked).toBe(false);
    expect(plan.totals).toMatchObject({ rows: 2, unlinkedOperations: 1, shortMaterials: 3 });
  });

  it("an operation without linked material says so; a fully drawn row leaves the list but keeps the link", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const mo = await w.order(w.product.id, 10, addDays(today, 30));
    await planOn(mo.op10.id, [{ date: today, minutes: 50 }]);
    await planOn(mo.op20!.id, [{ date: today, minutes: 30 }]);
    // Every purchased row on op 10 drawn in full.
    await db.execute(sql`UPDATE mo_material_consumptions SET quantity_consumed = quantity_planned WHERE mo_operation_id = ${mo.op10.id}`);

    const plan = await dayPlan(cookie);
    const op10 = resourceOf(plan, w.kap.id).rows[0]!;
    expect(op10.materials).toEqual([]);
    expect(op10.materialLinked).toBe(true);
    // Op 20 has no material row at all — the unlinked material is not its.
    const op20 = resourceOf(plan, w.svets.id).rows[0]!;
    expect(op20.materials).toEqual([]);
    expect(op20.materialLinked).toBe(false);
    expect(plan.totals).toMatchObject({ unlinkedOperations: 1, shortMaterials: 0 });
  });

  it("runs the pegging only when something is short — and then in one batch", async () => {
    const w = await world();
    const repo = createPlanningRepository(db);
    let peggings = 0;
    const service = createPlanningService(
      {
        ...repo,
        coverageParents: (...args: Parameters<typeof repo.coverageParents>) => {
          peggings += 1;
          return repo.coverageParents(...args);
        },
      },
      {
        purchase: {
          createPurchaseOrder: async () => {
            throw new Error("not used");
          },
          addRow: async () => {},
          cancel: async () => {},
        },
        manufacturing: mfgService,
        requirementsCacheMs: 0,
      }
    );
    const a = await w.order(w.product.id, 10, addDays(today, 30));
    const b = await w.order(w.product.id, 10, addDays(today, 31));
    await planOn(a.op10.id, [{ date: today, minutes: 50 }]);
    await planOn(b.op10.id, [{ date: today, minutes: 50 }]);
    // Each row is compared with the WHOLE balance: 10, 20, 30 and 10 cover
    // every row of both orders.
    await w.stock(w.plat.id, w.shelf.id, 10);
    await w.stock(w.ror.id, w.shelf.id, 20);
    await w.stock(w.bult.id, w.shelf.id, 30);
    await w.stock(w.lack.id, w.shelf.id, 10);

    const whole = await service.getDayPlan({});
    expect(whole.totals).toMatchObject({ rows: 2, shortMaterials: 0 });
    expect(whole.resources.flatMap((r) => r.rows).flatMap((r) => r.materials).map((m) => m.status)).toEqual(Array(8).fill("available"));
    expect(peggings).toBe(0);
    expect((await service.getRunPlan({ workCenterId: w.kap.id }))!.rows).toHaveLength(2);
    expect(peggings).toBe(0);

    // One article short on both orders: ONE pegging for the two of them.
    await w.stock(w.bult.id, w.shelf.id, -1);
    expect((await service.getDayPlan({})).totals.shortMaterials).toBe(2);
    expect(peggings).toBe(1);
    // A day without rows asks for nothing at all.
    peggings = 0;
    expect((await service.getDayPlan({ date: tomorrow })).totals.rows).toBe(0);
    expect(peggings).toBe(0);
  });
});

describe("GET /planning/day-plan — pågår och på plats", () => {
  it("lists the open stamps on the operation (a paused one marked) and, today only, who is clocked in on the resource", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const mo = await w.order(w.product.id, 200, addDays(today, 30));
    await planOn(mo.op10.id, [
      { date: today, minutes: 280 },
      { date: tomorrow, minutes: 150 },
    ]);
    const employee = async (employeeNumber: string, name: string, active = true) =>
      (await db.insert(employees).values({ employeeNumber, name, active }).returning())[0]!;
    const anna = await employee("101", "Anna");
    const jonas = await employee("102", "Jonas");
    const gone = await employee("103", "Hemma");
    const former = await employee("104", "Slutat", false);
    await db.insert(stampSessions).values([
      { employeeId: jonas.id, moOperationId: mo.op10.id },
      { employeeId: anna.id, moOperationId: mo.op10.id, pausedAt: new Date() },
      // A stopped stamp is history.
      { employeeId: gone.id, moOperationId: mo.op10.id, stoppedAt: new Date() },
    ]);
    await db.insert(attendanceSessions).values([
      { employeeId: anna.id },
      { employeeId: jonas.id },
      { employeeId: gone.id, stoppedAt: new Date() },
      { employeeId: former.id },
    ]);
    await db.insert(employeeWorkCenters).values([
      { employeeId: jonas.id, workCenterId: w.kap.id },
      { employeeId: anna.id, workCenterId: w.kap.id },
      { employeeId: anna.id, workCenterId: w.svets.id },
      { employeeId: gone.id, workCenterId: w.kap.id },
      { employeeId: former.id, workCenterId: w.kap.id },
    ]);

    const stamps = [
      { employeeId: anna.id, name: "Anna", paused: true },
      { employeeId: jonas.id, name: "Jonas", paused: false },
    ];
    const plan = await dayPlan(cookie);
    const kap = resourceOf(plan, w.kap.id);
    expect(kap.rows[0]!.activeStamps).toEqual(stamps);
    // By name; clocked out and inactive employees are not there.
    expect(kap.present).toEqual([
      { employeeId: anna.id, name: "Anna" },
      { employeeId: jonas.id, name: "Jonas" },
    ]);
    expect(resourceOf(plan, w.svets.id).present).toEqual([{ employeeId: anna.id, name: "Anna" }]);

    // Another day: the stamps follow the operation, nobody is "på plats".
    const next = await dayPlan(cookie, `?date=${tomorrow}`);
    expect(resourceOf(next, w.kap.id).carried[0]!.activeStamps).toEqual(stamps);
    expect(next.resources.flatMap((r) => r.present)).toEqual([]);
  });
});

describe("GET /planning/day-plan — fönstret, urvalet och behörigheten", () => {
  it("400s a day outside today … today + 41 and a bad query — list and PDF alike; an unknown group is an empty selection", async () => {
    const w = await world();
    const cookie = await adminCookie();
    for (const path of ["/planning/day-plan", "/planning/day-plan/pdf"]) {
      for (const date of [addDays(today, -1), addDays(today, 42)]) {
        const res = await get(cookie, `${path}?date=${date}`);
        expect(res.statusCode, `${path} ${date}`).toBe(400);
        expect(res.json()).toMatchObject({ code: "day-plan-date-out-of-range" });
      }
      expect((await get(cookie, `${path}?date=2026-13-01`)).statusCode).toBe(400);
      expect((await get(cookie, `${path}?productionGroupId=x`)).statusCode).toBe(400);
      expect((await get(cookie, `${path}?date=${addDays(today, 41)}`)).statusCode).toBe(200);
    }
    // The last day of the window has no next day.
    const last = await dayPlan(cookie, `?date=${addDays(today, 41)}`);
    expect(last.nextDate).toBeNull();
    expect(last.previousDate! < last.date).toBe(true);

    const none = await dayPlan(cookie, `?productionGroupId=${crypto.randomUUID()}`);
    expect(none.resources).toEqual([]);
    expect(none.totals).toEqual({ rows: 0, hours: 0, unlinkedOperations: 0, shortMaterials: 0 });
    expect(w.kap.id).toBeTruthy();
  });

  it("is read like the körplan: the workshop profile, the terminal, any office menu and a read-only account — not without one of them", async () => {
    const w = await world();
    const mo = await w.order(w.product.id, 1, addDays(today, 6));
    await planOn(mo.op10.id, [{ date: today, minutes: 32 }]);
    const urls = ["/planning/day-plan", `/planning/day-plan?date=${tomorrow}`, "/planning/day-plan/pdf"];
    const statuses = async (cookie: string) => Promise.all(urls.map(async (url) => (await get(cookie, url)).statusCode));

    expect((await app.inject({ url: `/api/v1${urls[0]}` })).statusCode).toBe(401);
    expect(await statuses(await userCookie(["terminal", "artikeloversikt", "tillverkningsorder_las"]))).toEqual([200, 200, 200]);
    expect(await statuses(await userCookie(["tillverkningsorder_las"]))).toEqual([200, 200, 200]);
    expect(await statuses(await userCookie(["terminal"]))).toEqual([200, 200, 200]);
    expect(await statuses(await userCookie(["tillverkning"]))).toEqual([200, 200, 200]);
    // The office without Tillverkning.
    expect(await statuses(await userCookie(["forsaljning", "inkop", "lager"]))).toEqual([200, 200, 200]);
    expect(await statuses(await userCookie(["terminal", "tillverkningsorder_las"], true))).toEqual([200, 200, 200]);
    // Neither a menu, the terminal nor Tillverkningsorder (läsläge).
    expect(await statuses(await userCookie(["artikeloversikt"]))).toEqual([403, 403, 403]);
    expect(await statuses(await userCookie([]))).toEqual([403, 403, 403]);
  });
});

describe("GET /planning/day-plan/pdf", () => {
  it("answers a PDF with the day, a group per resource with rows, the numbers and the material as text", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const first = await w.order(w.product.id, 10, addDays(today, 30));
    const second = await w.order(w.product.id, 20, addDays(today, 31));
    const late = await w.order(w.product.id, 5, addDays(today, 32));
    await planOn(first.op10.id, [{ date: today, minutes: 50 }]);
    await planOn(second.op10.id, [{ date: today, minutes: 70 }]);
    await planOn(late.op10.id, [{ date: addDays(today, -1), minutes: 40 }]);
    await db.execute(sql`UPDATE mo_operations SET plan_locked = true WHERE id = ${second.op10.id}`);
    // M1 covers every row, M2 has an IO coming, M3 and M4 are missing.
    await w.stock(w.plat.id, w.shelf.id, 20);
    const io = await purchaseOrder(w.ror.id, 100, addDays(today, 3));

    const plan = await dayPlan(cookie);
    const kap = resourceOf(plan, w.kap.id);
    expect(kap.carried.map((r) => r.moOperationId)).toEqual([late.op10.id]);
    expect(kap.rows.map((r) => r.moOperationId)).toEqual([first.op10.id, second.op10.id]);

    const res = await get(cookie, "/planning/day-plan/pdf");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(String(res.headers["content-disposition"])).toContain(`dagplan-${today}.pdf`);
    expect(String(res.headers["content-disposition"])).toContain("inline");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(res.rawPayload);
    const weekday = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"][plan.weekday - 1];
    expect(text).toContain(`Dagplan — ${weekday} ${today} (vecka ${plan.isoWeek})`);
    expect(text).toContain(`Alla resurser · Utskriven ${today}`);
    // The resource's heading with the day's load; Svets has no rows and no group.
    // (8 h a weekday; the suite may run at a weekend.)
    expect(kap.load.loadHours).toBe(2.67);
    expect(text).toContain(kap.load.availableHours === 0 ? "100 Kap — 2,67 h — ingen kapacitet" : "100 Kap — 2,67 h av 8,00 h");
    expect(text).not.toContain("200 Svets");
    for (const order of [first, second, late]) expect(text).toContain(order.orderNumber);
    for (const printed of ["Nr", "TO", "Antal kvar", "Tid kvar", "Färdigdatum", "Status", "Material", "Summa 100", "Summa tid kvar", "Redo · Låst", "10 Kapa rör"]) {
      expect(text, printed).toContain(printed);
    }
    // Material as text.
    expect(text).toContain(`${w.plat.articleNumber} (finns)`);
    expect(text).toContain(`(kommer ${addDays(today, 3)}`);
    expect(text).toContain(io.orderNumber);
    expect(text).toContain("(saknas 30");
    // 40 + 50 + 70 minutes = 2,67 h — the rows' own sum.
    expect(kap.rowHours).toBe(2.67);

    // A day without work: still a PDF, with the empty text.
    const empty = await get(cookie, `/planning/day-plan/pdf?date=${addDays(today, 41)}`);
    expect(empty.statusCode).toBe(200);
    expect(pdfText(empty.rawPayload)).toContain("Inga planerade operationer den dagen.");
  });
});
