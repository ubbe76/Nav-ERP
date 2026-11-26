import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import type { CapacityResult } from "../src/modules/planning/service/capacity-calc.js";
import { mondayOf } from "../src/modules/planning/service/capacity-calc.js";
import {
  buildRunPlan,
  defaultRunPlanToDate,
  type RunPlanResult,
  type RunPlanRow,
} from "../src/modules/planning/service/run-plan.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { pdfText } from "./helpers/pdf.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Körplan (GET /planning/run-plan[/pdf]) through the real app: the
// selection, the veckonyckel, Försenad, the T.o.m. vecka limit, the order,
// and — the point of the feature — that every figure is the SAME as the
// reader it is borrowed from: Tid kvar and the week = Beläggning's
// (GET /planning/capacity), the beredskap = the terminal's
// (GET /terminal/operations), for the same operation.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
// No plan reader: the orders are created unplanned, the plan is set by hand.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'KPL%'`;

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
const thisMonday = mondayOf(today);
const nextMonday = addDays(thisMonday, 7);
const inTwoWeeks = addDays(thisMonday, 14);
const lastMonday = addDays(thisMonday, -7);
// Never before today, whatever weekday the suite runs on.
const thisSunday = addDays(thisMonday, 6);
// T.o.m. when none is given: the Sunday of next week.
const defaultToDate = addDays(nextMonday, 6);

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
    .values({ code: `KPL${crypto.randomUUID().slice(0, 6)}`, name: "Körplan", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const get = (cookie: string, url: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } });

// Rutt 10 Kap(100: ställ 30, 2 min/st) → 20 Lego(900) → 30 Svets(200: ställ
// 15, 3 min/st), plus a Kalkyl row on Kap that never reaches a TO.
async function world() {
  const user = await authRepo.create({ email: `kpl-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "admin" });
  const svets = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "200", name: "Svets", active: true }));
  const kap = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Kap", active: true }));
  const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling AB", type: "subcontract", active: true }));
  await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "300", name: "Gammal", active: false }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `STOL-${crypto.randomUUID().slice(0, 8)}`, name: "Stol", type: "manufactured", active: true })
  );
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 30, runTimePerUnit: 2, description: "Kapa rör" });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 30, workCenterId: svets.id, setupTime: 15, runTimePerUnit: 3 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 40, workCenterId: kap.id, setupTime: 500, runTimePerUnit: 50, costingOnly: true });

  const order = async (quantity: number, dueDate: string | null) => {
    const mo = await mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId: article.id, quantity, dueDate }), user.id);
    const ops = await mfgService.listOperations(mo.id);
    const op = (seq: number) => ops.find((o) => o.sequenceNo === seq)!;
    return { ...mo, op10: op(10), op20: op(20), op30: op(30) };
  };
  return { user, kap, svets, lego, article, order };
}

async function runPlan(cookie: string, query: string): Promise<RunPlanResult> {
  const res = await get(cookie, `/planning/run-plan?${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const rowOf = (plan: RunPlanResult, orderNumber: string) => plan.rows.find((r) => r.orderNumber === orderNumber)!;

// Beläggning's chip for an operation: the cell's Monday (null = Utan datum)
// and the chip itself.
async function capacityChip(cookie: string, moOperationId: string) {
  const res = await get(cookie, "/planning/capacity?weeks=8");
  expect(res.statusCode).toBe(200);
  const capacity = res.json() as CapacityResult;
  for (const group of capacity.groups) {
    for (const resource of group.resources) {
      const cells = [...resource.weeks.map((cell, i) => ({ cell, monday: capacity.weeks[i]!.monday as string | null })), { cell: resource.undated, monday: null }];
      for (const { cell, monday } of cells) {
        const chip = cell.orders.find((o) => o.moOperationId === moOperationId);
        if (chip) return { monday, chip };
      }
    }
  }
  throw new Error(`operation ${moOperationId} is not in the capacity matrix`);
}

describe("GET /planning/run-plan — urval, vecka och ordning", () => {
  it("lists the resource's pending operations of released, in-progress and planned orders — nothing else", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const released = await w.order(10, addDays(thisMonday, 6));
    const inProgress = await w.order(10, addDays(thisMonday, 6));
    await mfgService.reportOperationQuantities(inProgress.op10.id, { quantityOk: 4, quantityScrapped: 0, markDone: false, createdBy: w.user.id });
    const planned = await insertPlannedManufacturingOrder({ articleId: w.article.id, quantity: 5, dueDate: addDays(thisMonday, 6) });
    // Out: done / closed / cancelled orders, and an order whose Kap operation is done.
    const closed: string[] = [];
    for (const status of ["done", "closed", "cancelled"] as const) {
      const mo = await w.order(10, addDays(thisMonday, 6));
      await db.execute(sql`UPDATE manufacturing_orders SET status = ${status} WHERE id = ${mo.id}`);
      closed.push(mo.orderNumber);
    }
    const opDone = await w.order(10, addDays(thisMonday, 6));
    await db.execute(sql`UPDATE mo_operations SET status = 'done', quantity_completed = 10 WHERE id = ${opDone.op10.id}`);

    const plan = await runPlan(cookie, `workCenterId=${w.kap.id}`);
    expect(plan.workCenter).toEqual({ id: w.kap.id, code: "100", name: "Kap" });
    expect(plan.today).toBe(today);
    expect(plan.toDate).toBe(defaultToDate);
    expect(plan.rows.map((r) => r.orderNumber).sort()).toEqual([released.orderNumber, inProgress.orderNumber, planned.orderNumber].sort());
    for (const number of [...closed, opDone.orderNumber]) expect(rowOf(plan, number)).toBeUndefined();
    // Only Kap's own operation — never the lego one, Svets's or the Kalkyl row.
    expect(plan.rows.every((r) => r.sequenceNo === 10)).toBe(true);

    expect(rowOf(plan, released.orderNumber)).toMatchObject({
      key: released.op10.id,
      moOperationId: released.op10.id,
      manufacturingOrderId: released.id,
      articleNumber: w.article.articleNumber,
      articleName: "Stol",
      description: "Kapa rör",
      orderQuantity: 10,
      remainingQuantity: 10,
      remainingMinutes: 50,
      setupDone: false,
      // Unplanned: the day is the due date.
      date: thisSunday,
      late: false,
      planned: false,
      planLocked: false,
      status: "ready",
      waitingForSequenceNo: null,
    });
    // Planerad TO: no mo_operations yet — the route's operation, kommande.
    expect(rowOf(plan, planned.orderNumber)).toMatchObject({
      key: `${planned.id}:10`,
      moOperationId: null,
      status: "planned_order",
      available: null,
      description: "Kapa rör",
      remainingQuantity: 5,
      remainingMinutes: 40,
      date: thisSunday,
    });

    // The other resource has its own list; the done Kap operation's order is on it.
    const svets = await runPlan(cookie, `workCenterId=${w.svets.id}`);
    expect(svets.rows.every((r) => r.sequenceNo === 30)).toBe(true);
    expect(rowOf(svets, opDone.orderNumber)).toBeDefined();
    // No price or cost field anywhere in the answer.
    expect(JSON.stringify(plan)).not.toMatch(/price|cost/i);
  });

  it("keys on the planned day, else the due date, else nothing — Försenad always in, T.o.m. inclusive", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const thisWeek = await w.order(1, addDays(thisMonday, 6));
    const nextWeek = await w.order(1, addDays(nextMonday, 2));
    const later = await w.order(1, addDays(inTwoWeeks, 1));
    const late = await w.order(1, addDays(lastMonday, 2));
    const undated = await w.order(1, null);
    // Due in two weeks but Flyttad to next Monday: the plan wins.
    const moved = await w.order(1, addDays(inTwoWeeks, 3));
    const move = await app.inject({
      method: "POST",
      url: `/api/v1/planning/operations/${moved.op10.id}/move`,
      headers: { cookie },
      payload: { date: nextMonday, moveFollowing: false },
    });
    expect(move.statusCode, move.body).toBe(200);
    // Planned last Monday (a plan the calendar has passed), due next week.
    const latePlanned = await w.order(1, addDays(nextMonday, 4));
    await db.execute(sql`INSERT INTO mo_operation_plan_days (mo_operation_id, plan_date, minutes) VALUES (${latePlanned.op10.id}, ${lastMonday}, 32)`);
    await db.execute(sql`UPDATE mo_operations SET planned_start_date = ${lastMonday}, planned_end_date = ${lastMonday}, planned_at = now() WHERE id = ${latePlanned.op10.id}`);

    const plan = await runPlan(cookie, `workCenterId=${w.kap.id}`);
    // Försenad first (the older DAY first: the plan's last Monday is before
    // the other's due date two days later — both were "last week" when the
    // key was a week, and the due date decided), the days, Ej planerad last.
    expect(plan.rows.map((r) => r.orderNumber)).toEqual([
      latePlanned.orderNumber,
      late.orderNumber,
      thisWeek.orderNumber,
      moved.orderNumber,
      nextWeek.orderNumber,
      undated.orderNumber,
    ]);
    expect(rowOf(plan, later.orderNumber)).toBeUndefined();
    expect(rowOf(plan, late.orderNumber)).toMatchObject({ date: addDays(lastMonday, 2), late: true, planned: false });
    expect(rowOf(plan, latePlanned.orderNumber)).toMatchObject({ date: lastMonday, late: true, planned: true, plannedStartDate: lastMonday, plannedEndDate: lastMonday });
    expect(rowOf(plan, moved.orderNumber)).toMatchObject({ date: nextMonday, late: false, planned: true, planLocked: true, plannedStartDate: nextMonday });
    expect(rowOf(plan, undated.orderNumber)).toMatchObject({ date: null, late: false, dueDate: null });

    // The groups in list order, each with its sum; the total is their sum.
    expect(plan.days.map((g) => [g.kind, g.date, g.weekday, g.late, g.rows, g.minutes])).toEqual([
      ["late", null, null, true, 2, 64],
      ["day", thisSunday, 7, false, 1, 32],
      ["day", nextMonday, 1, false, 1, 32],
      ["day", addDays(nextMonday, 2), 3, false, 1, 32],
      ["unplanned", null, null, false, 1, 32],
    ]);
    expect(plan.totalMinutes).toBe(192);
    expect(plan.totalHours).toBe(3.2);
    expect(plan.days[1]!.hours).toBe(0.53);

    // The limit is inclusive: the later order's own day takes it in, the day before does not …
    const wide = await runPlan(cookie, `workCenterId=${w.kap.id}&toDate=${addDays(inTwoWeeks, 1)}`);
    expect(wide.toDate).toBe(addDays(inTwoWeeks, 1));
    expect(rowOf(wide, later.orderNumber)).toMatchObject({ date: addDays(inTwoWeeks, 1) });
    expect(rowOf(await runPlan(cookie, `workCenterId=${w.kap.id}&toDate=${inTwoWeeks}`), later.orderNumber)).toBeUndefined();
    // … and this Sunday only drops next week's but keeps Försenad and Ej planerad.
    const narrow = await runPlan(cookie, `workCenterId=${w.kap.id}&toDate=${thisSunday}`);
    expect(narrow.rows.map((r) => r.orderNumber)).toEqual([latePlanned.orderNumber, late.orderNumber, thisWeek.orderNumber, undated.orderNumber]);
    // A limit in the past still lists what is late.
    const past = await runPlan(cookie, `workCenterId=${w.kap.id}&toDate=${addDays(lastMonday, -7)}`);
    expect(past.rows.map((r) => r.orderNumber)).toEqual([latePlanned.orderNumber, late.orderNumber, undated.orderNumber]);
  });

  it("orders by day, then due date (none last), then order number, then operation", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const friday = await w.order(1, addDays(thisMonday, 4));
    const sunday = await w.order(1, addDays(thisMonday, 6));
    const fridayToo = await w.order(1, addDays(thisMonday, 4));
    const plan = await runPlan(cookie, `workCenterId=${w.kap.id}`);
    expect(plan.rows.map((r) => r.orderNumber)).toEqual([friday.orderNumber, fridayToo.orderNumber, sunday.orderNumber]);
  });
});

describe("GET /planning/run-plan — samma tal som Beläggning och terminalen", () => {
  it("Tid kvar, Antal kvar and the plan are Beläggning's for the same operation — setup done or not", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const untouched = await w.order(10, addDays(thisMonday, 6));
    const started = await w.order(10, addDays(nextMonday, 1));
    await mfgService.reportOperationQuantities(started.op10.id, { quantityOk: 4, quantityScrapped: 1, scrapReason: "Repa", markDone: false, createdBy: w.user.id });
    const late = await w.order(3, addDays(lastMonday, 1));
    const undated = await w.order(2, null);
    const moved = await w.order(6, addDays(inTwoWeeks, 3));
    const move = await app.inject({
      method: "POST",
      url: `/api/v1/planning/operations/${moved.op10.id}/move`,
      headers: { cookie },
      payload: { date: nextMonday, moveFollowing: false },
    });
    expect(move.statusCode, move.body).toBe(200);

    const plan = await runPlan(cookie, `workCenterId=${w.kap.id}`);
    expect(plan.rows).toHaveLength(5);
    for (const row of plan.rows) {
      const { monday, chip } = await capacityChip(cookie, row.moOperationId!);
      expect(row.remainingHours, row.orderNumber).toBe(chip.remainingHours);
      expect(row.planned).toBe(chip.planned);
      expect(row.plannedStartDate).toBe(chip.plannedStartDate);
      expect(row.plannedEndDate).toBe(chip.plannedEndDate);
      expect(row.planLocked).toBe(chip.planLocked);
      // The day key lies in the matrix's week — except that the matrix puts
      // a passed day on today, where the körplan says Försenad.
      expect(row.date == null ? null : row.late ? thisMonday : mondayOf(row.date), row.orderNumber).toBe(monday);
    }
    // Setup not done: 30 + 10 × 2. Setup done (a reported quantity): 6 × 2.
    expect(rowOf(plan, untouched.orderNumber)).toMatchObject({ setupDone: false, remainingMinutes: 50, remainingHours: 0.83, remainingQuantity: 10 });
    expect(rowOf(plan, started.orderNumber)).toMatchObject({ setupDone: true, remainingMinutes: 12, remainingHours: 0.2, remainingQuantity: 6 });
    expect(rowOf(plan, late.orderNumber).late).toBe(true);
    expect(rowOf(plan, undated.orderNumber).date).toBeNull();
    expect(rowOf(plan, moved.orderNumber).date).toBe(nextMonday);
  });

  it("the beredskap is the terminal's for the same operation, with the operation it waits for", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const waiting = await w.order(10, addDays(thisMonday, 6)); // lego op 20 untouched
    const partial = await w.order(10, addDays(thisMonday, 6));
    await db.execute(sql`UPDATE mo_operations SET quantity_completed = 4 WHERE id = ${partial.op20.id}`);
    const ready = await w.order(10, addDays(thisMonday, 6));
    await db.execute(sql`UPDATE mo_operations SET status = 'done', quantity_completed = 10 WHERE id = ${ready.op20.id}`);

    for (const workCenter of [w.kap, w.svets]) {
      const plan = await runPlan(cookie, `workCenterId=${workCenter.id}`);
      const res = await get(cookie, `/terminal/operations?workCenterIds=${workCenter.id}`);
      expect(res.statusCode).toBe(200);
      const terminal = (res.json() as { rows: { operationId: string; readiness: string; available: string; orderQuantity: string; quantityCompleted: string | null }[] }).rows;
      expect(plan.rows.map((r) => r.moOperationId).sort()).toEqual(terminal.map((t) => t.operationId).sort());
      for (const row of plan.rows) {
        const t = terminal.find((x) => x.operationId === row.moOperationId)!;
        expect(row.status).toBe(t.readiness);
        expect(row.available).toBe(Number(t.available));
        expect(row.remainingQuantity).toBe(Math.max(Number(t.orderQuantity) - Number(t.quantityCompleted ?? 0), 0));
      }
    }
    const svets = await runPlan(cookie, `workCenterId=${w.svets.id}`);
    expect(rowOf(svets, waiting.orderNumber)).toMatchObject({ status: "not_ready", available: 0, waitingForSequenceNo: 20 });
    expect(rowOf(svets, partial.orderNumber)).toMatchObject({ status: "partial", available: 4, waitingForSequenceNo: 20 });
    expect(rowOf(svets, ready.orderNumber)).toMatchObject({ status: "ready", available: 10, waitingForSequenceNo: null });
  });
});

describe("GET /planning/run-plan — resursväljaren, fel och behörighet", () => {
  it("answers the picker's stations (active, never lego, natural order) with or without a resource", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const bare = await runPlan(cookie, "");
    expect(bare).toEqual({
      workCenter: null,
      today,
      toDate: defaultToDate,
      rows: [],
      days: [],
      totalMinutes: 0,
      totalHours: 0,
      stations: [
        { id: w.kap.id, code: "100", name: "Kap" },
        { id: w.svets.id, code: "200", name: "Svets" },
      ],
      materialGroups: [],
      unlinkedRowKeys: [],
    });
    expect((await runPlan(cookie, `workCenterId=${w.kap.id}`)).stations).toEqual(bare.stations);
    // The same list, in the same order, as the terminal's stations.
    expect(bare.stations).toEqual((await get(cookie, "/terminal/stations")).json());
    expect(defaultRunPlanToDate(today)).toBe(defaultToDate);
  });

  it("404s an unknown resource, 400s a legoresurs and a bad query — list and PDF alike", async () => {
    const w = await world();
    const cookie = await adminCookie();
    for (const path of ["/planning/run-plan", "/planning/run-plan/pdf"]) {
      const unknown = await get(cookie, `${path}?workCenterId=${crypto.randomUUID()}`);
      expect([unknown.statusCode, unknown.json().code]).toEqual([404, "work-center-not-found"]);
      const lego = await get(cookie, `${path}?workCenterId=${w.lego.id}`);
      expect([lego.statusCode, lego.json().code]).toEqual([400, "run-plan-subcontract-resource"]);
      expect((await get(cookie, `${path}?workCenterId=nope`)).statusCode).toBe(400);
      // T.o.m. is a date (any weekday).
      expect((await get(cookie, `${path}?workCenterId=${w.kap.id}&toDate=nope`)).statusCode).toBe(400);
      expect((await get(cookie, `${path}?workCenterId=${w.kap.id}&toDate=${addDays(thisMonday, 1)}`)).statusCode).toBe(200);
    }
    // The printout is always of one resource.
    expect((await get(cookie, "/planning/run-plan/pdf")).statusCode).toBe(400);
  });

  it("is read like a TO: the workshop profile, the terminal, any office menu and a read-only account — not without one of them", async () => {
    const w = await world();
    await w.order(1, addDays(thisMonday, 6));
    const urls = [`/planning/run-plan?workCenterId=${w.kap.id}`, "/planning/run-plan", `/planning/run-plan/pdf?workCenterId=${w.kap.id}`];
    const statuses = async (cookie: string) => Promise.all(urls.map(async (url) => (await get(cookie, url)).statusCode));

    expect((await app.inject({ url: `/api/v1${urls[0]}` })).statusCode).toBe(401);
    expect(await statuses(await userCookie(["terminal", "artikeloversikt", "tillverkningsorder_las"]))).toEqual([200, 200, 200]);
    expect(await statuses(await userCookie(["tillverkningsorder_las"]))).toEqual([200, 200, 200]);
    // The terminal alone: its Körplan link opens the list.
    expect(await statuses(await userCookie(["terminal"]))).toEqual([200, 200, 200]);
    expect(await statuses(await userCookie(["tillverkning"]))).toEqual([200, 200, 200]);
    // The office without Tillverkning.
    expect(await statuses(await userCookie(["forsaljning", "inkop", "lager"]))).toEqual([200, 200, 200]);
    expect(await statuses(await userCookie(["terminal", "tillverkningsorder_las"], true))).toEqual([200, 200, 200]);
    // Neither a menu, the terminal nor Tillverkningsorder (läsläge). (Every
    // menu permission — personal included — counts as the office.)
    expect(await statuses(await userCookie(["artikeloversikt"]))).toEqual([403, 403, 403]);
    expect(await statuses(await userCookie([]))).toEqual([403, 403, 403]);
  });
});

describe("GET /planning/run-plan/pdf", () => {
  it("answers a PDF with the resource, the period, the days with their sums and the orders", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const thisWeek = await w.order(10, addDays(thisMonday, 6));
    const late = await w.order(3, addDays(lastMonday, 1));
    const undated = await w.order(2, null);
    const planned = await insertPlannedManufacturingOrder({ articleId: w.article.id, quantity: 5, dueDate: addDays(nextMonday, 1) });
    const outside = await w.order(1, addDays(inTwoWeeks, 1));

    const res = await get(cookie, `/planning/run-plan/pdf?workCenterId=${w.kap.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(String(res.headers["content-disposition"])).toContain(`korplan-100-${defaultToDate}.pdf`);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(res.rawPayload);
    expect(text).toContain("Körplan — 100 Kap");
    expect(text).toContain(`Utskriven ${today}`);
    expect(text).toContain(`T.o.m. ${defaultToDate}`);
    // One group per day: the planned TO's due date is a Tuesday.
    expect(text).toContain(`tis ${addDays(nextMonday, 1)} (vecka`);
    expect(text).toContain(`Summa sön ${thisSunday}`);
    for (const order of [thisWeek, late, undated, planned]) expect(text).toContain(order.orderNumber);
    expect(text).not.toContain(outside.orderNumber);
    for (const printed of ["Försenad", "Ej planerad", "Summa försenad", "Summa tid kvar", "Planerad TO", "Redo", "10 Kapa rör", "Antal kvar", "Tid kvar", w.article.articleNumber]) {
      expect(text, printed).toContain(printed);
    }
    // 50 + 36 + 34 + 40 minutes = 2,67 h — the list's own total.
    const plan = await runPlan(cookie, `workCenterId=${w.kap.id}`);
    expect(plan.totalMinutes).toBe(160);
    expect(text).toContain("2,67 h");

    // Nothing to do: still a PDF, with the empty text.
    const empty = await get(cookie, `/planning/run-plan/pdf?workCenterId=${w.svets.id}&toDate=${lastMonday}`);
    expect(empty.statusCode).toBe(200);
    expect(pdfText(empty.rawPayload)).toContain("Körplan — 200 Svets");
  });
});

describe("buildRunPlan (pure)", () => {
  const workCenter = { id: "wc", code: "100", name: "Kap", type: "machine" as const, active: true };
  const op = (over: Partial<Parameters<typeof buildRunPlan>[0]["operations"][number]>) => ({
    moOperationId: crypto.randomUUID(),
    manufacturingOrderId: crypto.randomUUID(),
    orderNumber: "TO-1",
    articleNumber: "A",
    articleName: "Artikel",
    workCenterId: "wc",
    orderQuantity: 10,
    dueDate: null,
    sequenceNo: 10,
    setupTime: 30,
    runTimePerUnit: 2,
    operationStatus: "pending" as const,
    quantityCompleted: null,
    quantityScrapped: 0,
    ...over,
  });
  const plan = (todayIs: string, toDate: string, operations: ReturnType<typeof op>[]): RunPlanResult =>
    buildRunPlan({ today: todayIs, toDate, workCenter, stations: [], operations, plannedOrderOperations: [] });
  const build = (todayIs: string, toDate: string, operations: ReturnType<typeof op>[]): RunPlanRow[] => plan(todayIs, toDate, operations).rows;

  it("T.o.m. defaults to the Sunday of next week — the same selection as before the plan counted in days", () => {
    // 2030-03-10 is a Sunday; its week's Monday is 2030-03-04.
    expect(defaultRunPlanToDate("2030-03-10")).toBe("2030-03-17");
    expect(defaultRunPlanToDate("2030-03-06")).toBe("2030-03-17");
    expect(defaultRunPlanToDate("2030-03-11")).toBe("2030-03-24");
  });

  it("keys on the day: Försenad is before TODAY (also earlier this week), T.o.m. is inclusive, no day is Ej planerad", () => {
    // Wednesday 2030-03-06; each operation is 30 + 10 × 2 = 50 min.
    const result = plan("2030-03-06", "2030-03-08", [
      op({ orderNumber: "TO-1", dueDate: "2030-03-05" }), // yesterday
      op({ orderNumber: "TO-2", dueDate: "2030-03-04" }), // Monday of this week: passed — Försenad by day
      op({ orderNumber: "TO-3", dueDate: "2030-03-06" }), // today is not late
      op({ orderNumber: "TO-4", dueDate: "2030-03-08" }), // the limit day
      op({ orderNumber: "TO-5", dueDate: "2030-03-09" }), // the day after the limit
      op({ orderNumber: "TO-6", dueDate: null }),
    ]);
    expect(result.toDate).toBe("2030-03-08");
    expect(result.rows.map((r) => [r.orderNumber, r.date, r.late])).toEqual([
      ["TO-2", "2030-03-04", true],
      ["TO-1", "2030-03-05", true],
      ["TO-3", "2030-03-06", false],
      ["TO-4", "2030-03-08", false],
      ["TO-6", null, false],
    ]);
    // The groups in list order: Försenad together, then each day, Ej planerad last.
    expect(result.days).toEqual([
      { kind: "late", date: null, weekday: null, isoWeek: null, late: true, rows: 2, minutes: 100, hours: 1.67, reorderable: false },
      // Unplanned operations on their due dates: a day, but nothing to order.
      { kind: "day", date: "2030-03-06", weekday: 3, isoWeek: 10, late: false, rows: 1, minutes: 50, hours: 0.83, reorderable: false },
      { kind: "day", date: "2030-03-08", weekday: 5, isoWeek: 10, late: false, rows: 1, minutes: 50, hours: 0.83, reorderable: false },
      { kind: "unplanned", date: null, weekday: null, isoWeek: null, late: false, rows: 1, minutes: 50, hours: 0.83, reorderable: false },
    ]);
    expect(result.totalMinutes).toBe(250);
  });

  it("the plan's first day is the key even when the due date is another day, and time on the resource alone means the setup is done", () => {
    const rows = build("2030-03-06", "2030-03-08", [
      op({
        dueDate: "2030-04-30",
        plannedDays: [
          { date: "2030-03-11", minutes: 20 },
          { date: "2030-03-07", minutes: 30 },
        ],
        planLocked: true,
        timeOnCurrentResource: true,
      }),
    ]);
    expect(rows[0]).toMatchObject({
      date: "2030-03-07",
      late: false,
      planned: true,
      plannedStartDate: "2030-03-07",
      plannedEndDate: "2030-03-11",
      planLocked: true,
      setupDone: true,
      remainingMinutes: 20,
    });
  });

  it("a plan whose first day has passed is Försenad, whatever the due date; a plan beyond T.o.m. is left out", () => {
    const rows = build("2030-03-06", "2030-03-08", [
      op({ orderNumber: "TO-1", dueDate: "2030-03-20", plannedDays: [{ date: "2030-03-05", minutes: 50 }] }),
      op({ orderNumber: "TO-2", dueDate: "2030-03-07", plannedDays: [{ date: "2030-03-11", minutes: 50 }] }),
      // Due long ago but planned tomorrow: the plan is the key.
      op({ orderNumber: "TO-3", dueDate: "2030-02-01", plannedDays: [{ date: "2030-03-07", minutes: 50 }] }),
    ]);
    expect(rows.map((r) => [r.orderNumber, r.date, r.late])).toEqual([
      ["TO-1", "2030-03-05", true],
      ["TO-3", "2030-03-07", false],
    ]);
  });

  it("orders a day by due date (none last), then order number (natural), then operation", () => {
    const on = (orderNumber: string, dueDate: string | null, sequenceNo = 10) =>
      op({ orderNumber, dueDate, sequenceNo, plannedDays: [{ date: "2030-03-07", minutes: 50 }] });
    const rows = build("2030-03-06", "2030-03-08", [
      on("TO-10", "2030-03-20"),
      on("TO-9", "2030-03-20", 20),
      on("TO-9", "2030-03-20", 10),
      on("TO-3", null),
      on("TO-7", "2030-03-12"),
    ]);
    expect(rows.map((r) => [r.orderNumber, r.sequenceNo])).toEqual([
      ["TO-7", 10],
      ["TO-9", 10],
      ["TO-9", 20],
      ["TO-10", 10],
      ["TO-3", 10],
    ]);
  });

  it("within a day the place set by hand comes first — holes allowed, rows without a place after them in the standard order", () => {
    const on = (orderNumber: string, runPosition: number | null, dueDate: string | null = "2030-03-20", date = "2030-03-07") =>
      op({ orderNumber, dueDate, runPosition, plannedDays: [{ date, minutes: 50 }] });
    const result = plan("2030-03-06", "2030-03-08", [
      on("TO-1", null, "2030-03-10"), // the most urgent, but nobody placed it
      on("TO-2", 9),
      on("TO-3", 2, null),
      on("TO-4", 5, "2030-03-30"),
      on("TO-5", null, null),
      // The day is still the first key: place 1 on a later day never jumps ahead.
      on("TO-6", 1, "2030-03-09", "2030-03-08"),
      // Försenad: sorted on its own day and its old place.
      on("TO-7", 2, "2030-03-01", "2030-03-05"),
      on("TO-8", 1, "2030-03-02", "2030-03-05"),
      on("TO-9", 1, "2030-03-03", "2030-03-04"),
      // Ej planerad never has a place (a stray one on the row is not read).
      op({ orderNumber: "TO-10", dueDate: null, runPosition: 1 }),
    ]);
    expect(result.rows.map((r) => [r.orderNumber, r.date, r.runPosition])).toEqual([
      ["TO-9", "2030-03-04", 1],
      ["TO-8", "2030-03-05", 1],
      ["TO-7", "2030-03-05", 2],
      ["TO-3", "2030-03-07", 2],
      ["TO-4", "2030-03-07", 5],
      ["TO-2", "2030-03-07", 9],
      ["TO-1", "2030-03-07", null],
      ["TO-5", "2030-03-07", null],
      ["TO-6", "2030-03-08", 1],
      ["TO-10", null, null],
    ]);
    // Only a day can be ordered by hand.
    expect(result.days.map((d) => [d.kind, d.date, d.reorderable, d.rows])).toEqual([
      ["late", null, false, 3],
      ["day", "2030-03-07", true, 5],
      ["day", "2030-03-08", true, 1],
      ["unplanned", null, false, 1],
    ]);
    // … and per row: every planned row of a day, never Försenad or Ej planerad.
    expect(result.rows.filter((r) => r.reorderable).map((r) => r.orderNumber)).toEqual(["TO-3", "TO-4", "TO-2", "TO-1", "TO-5", "TO-6"]);
  });

  it("reorderable is per row: an unplanned operation lies on its due date in the day but is not in the day's order", () => {
    const result = plan("2030-03-06", "2030-03-08", [
      op({ orderNumber: "TO-1", dueDate: "2030-03-20", plannedDays: [{ date: "2030-03-07", minutes: 50 }] }),
      // Unplanned (Planera clears a plan without time, or it hit the horizon): keyed on the due date.
      op({ orderNumber: "TO-2", dueDate: "2030-03-07" }),
      op({ orderNumber: "TO-3", dueDate: "2030-03-25", plannedDays: [{ date: "2030-03-07", minutes: 50 }] }),
      // A day with only an unplanned operation has nothing to order.
      op({ orderNumber: "TO-4", dueDate: "2030-03-08" }),
    ]);
    expect(result.rows.map((r) => [r.orderNumber, r.date, r.planned, r.reorderable])).toEqual([
      ["TO-2", "2030-03-07", false, false],
      ["TO-1", "2030-03-07", true, true],
      ["TO-3", "2030-03-07", true, true],
      ["TO-4", "2030-03-08", false, false],
    ]);
    expect(result.days.map((d) => [d.date, d.reorderable, d.rows])).toEqual([
      ["2030-03-07", true, 3],
      ["2030-03-08", false, 1],
    ]);
  });

  it("a Planerad TO's route operation is never placed: it follows the ordered rows of its day", () => {
    const placed = op({ orderNumber: "TO-2", dueDate: "2030-03-30", runPosition: 1, plannedDays: [{ date: "2030-03-07", minutes: 50 }] });
    const { moOperationId: _id, ...route } = op({ orderNumber: "TO-1", dueDate: "2030-03-07" });
    const result = buildRunPlan({
      today: "2030-03-06",
      toDate: "2030-03-08",
      workCenter,
      stations: [],
      operations: [placed],
      plannedOrderOperations: [{ ...route, moOperationId: null, runPosition: 4 }],
    });
    expect(result.rows.map((r) => [r.orderNumber, r.moOperationId === null, r.runPosition, r.status])).toEqual([
      ["TO-2", false, 1, "ready"],
      ["TO-1", true, null, "planned_order"],
    ]);
  });
});
