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
  defaultRunPlanToWeek,
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

const TABLES = sql`TRUNCATE mo_operation_plan_weeks, stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
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
    expect(plan.currentWeek).toBe(thisMonday);
    expect(plan.toWeek).toBe(nextMonday);
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
      week: thisMonday,
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
      week: thisMonday,
    });

    // The other resource has its own list; the done Kap operation's order is on it.
    const svets = await runPlan(cookie, `workCenterId=${w.svets.id}`);
    expect(svets.rows.every((r) => r.sequenceNo === 30)).toBe(true);
    expect(rowOf(svets, opDone.orderNumber)).toBeDefined();
    // No price or cost field anywhere in the answer.
    expect(JSON.stringify(plan)).not.toMatch(/price|cost/i);
  });

  it("keys on the planned week, else the due date's week, else nothing — Försenad always in, T.o.m. vecka inclusive", async () => {
    const w = await world();
    const cookie = await adminCookie();
    const thisWeek = await w.order(1, addDays(thisMonday, 6));
    const nextWeek = await w.order(1, addDays(nextMonday, 2));
    const later = await w.order(1, addDays(inTwoWeeks, 1));
    const late = await w.order(1, addDays(lastMonday, 2));
    const undated = await w.order(1, null);
    // Due in two weeks but Flyttad to next week: the plan wins.
    const moved = await w.order(1, addDays(inTwoWeeks, 3));
    const move = await app.inject({
      method: "POST",
      url: `/api/v1/planning/operations/${moved.op10.id}/move`,
      headers: { cookie },
      payload: { weekMonday: nextMonday, moveFollowing: false },
    });
    expect(move.statusCode, move.body).toBe(200);
    // Planned last week (a plan the calendar has passed), due next week.
    const latePlanned = await w.order(1, addDays(nextMonday, 4));
    await db.execute(sql`INSERT INTO mo_operation_plan_weeks (mo_operation_id, week_monday, minutes) VALUES (${latePlanned.op10.id}, ${lastMonday}, 32)`);
    await db.execute(sql`UPDATE mo_operations SET planned_start_week = ${lastMonday}, planned_end_week = ${lastMonday}, planned_at = now() WHERE id = ${latePlanned.op10.id}`);

    const plan = await runPlan(cookie, `workCenterId=${w.kap.id}`);
    // Försenad first (older key first, then due date), the weeks, Ej planerad last.
    expect(plan.rows.map((r) => r.orderNumber)).toEqual([
      late.orderNumber,
      latePlanned.orderNumber,
      thisWeek.orderNumber,
      nextWeek.orderNumber,
      moved.orderNumber,
      undated.orderNumber,
    ]);
    expect(rowOf(plan, later.orderNumber)).toBeUndefined();
    expect(rowOf(plan, late.orderNumber)).toMatchObject({ week: lastMonday, late: true, planned: false });
    expect(rowOf(plan, latePlanned.orderNumber)).toMatchObject({ week: lastMonday, late: true, planned: true, plannedStartWeek: lastMonday });
    expect(rowOf(plan, moved.orderNumber)).toMatchObject({ week: nextMonday, late: false, planned: true, planLocked: true, plannedStartWeek: nextMonday });
    expect(rowOf(plan, undated.orderNumber)).toMatchObject({ week: null, late: false, dueDate: null });

    // The groups in list order, each with its sum; the total is their sum.
    expect(plan.weeks.map((g) => [g.kind, g.week, g.late, g.rows, g.minutes])).toEqual([
      ["late", null, true, 2, 64],
      ["week", thisMonday, false, 1, 32],
      ["week", nextMonday, false, 2, 64],
      ["unplanned", null, false, 1, 32],
    ]);
    expect(plan.totalMinutes).toBe(192);
    expect(plan.totalHours).toBe(3.2);
    expect(plan.weeks[1]!.hours).toBe(0.53);

    // The limit is inclusive: two weeks ahead takes the later order in …
    const wide = await runPlan(cookie, `workCenterId=${w.kap.id}&toWeek=${inTwoWeeks}`);
    expect(rowOf(wide, later.orderNumber)).toMatchObject({ week: inTwoWeeks });
    // … and this week only drops next week's but keeps Försenad and Ej planerad.
    const narrow = await runPlan(cookie, `workCenterId=${w.kap.id}&toWeek=${thisMonday}`);
    expect(narrow.rows.map((r) => r.orderNumber)).toEqual([late.orderNumber, latePlanned.orderNumber, thisWeek.orderNumber, undated.orderNumber]);
    // A limit in the past still lists what is late.
    const past = await runPlan(cookie, `workCenterId=${w.kap.id}&toWeek=${addDays(lastMonday, -7)}`);
    expect(past.rows.map((r) => r.orderNumber)).toEqual([late.orderNumber, latePlanned.orderNumber, undated.orderNumber]);
  });

  it("orders a week by due date (none last), then order number, then operation", async () => {
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
  it("Tid kvar, Antal kvar and the week are Beläggning's for the same operation — setup done or not", async () => {
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
      payload: { weekMonday: nextMonday, moveFollowing: false },
    });
    expect(move.statusCode, move.body).toBe(200);

    const plan = await runPlan(cookie, `workCenterId=${w.kap.id}`);
    expect(plan.rows).toHaveLength(5);
    for (const row of plan.rows) {
      const { monday, chip } = await capacityChip(cookie, row.moOperationId!);
      expect(row.remainingHours, row.orderNumber).toBe(chip.remainingHours);
      expect(row.planned).toBe(chip.planned);
      expect(row.plannedStartWeek).toBe(chip.plannedStartWeek);
      expect(row.plannedEndWeek).toBe(chip.plannedEndWeek);
      expect(row.planLocked).toBe(chip.planLocked);
      // The veckonyckel is the matrix's week — except that the matrix puts
      // a passed week in the current one, where the körplan says Försenad.
      expect(row.late ? thisMonday : row.week, row.orderNumber).toBe(monday);
    }
    // Setup not done: 30 + 10 × 2. Setup done (a reported quantity): 6 × 2.
    expect(rowOf(plan, untouched.orderNumber)).toMatchObject({ setupDone: false, remainingMinutes: 50, remainingHours: 0.83, remainingQuantity: 10 });
    expect(rowOf(plan, started.orderNumber)).toMatchObject({ setupDone: true, remainingMinutes: 12, remainingHours: 0.2, remainingQuantity: 6 });
    expect(rowOf(plan, late.orderNumber).late).toBe(true);
    expect(rowOf(plan, undated.orderNumber).week).toBeNull();
    expect(rowOf(plan, moved.orderNumber).week).toBe(nextMonday);
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
      currentWeek: thisMonday,
      toWeek: nextMonday,
      rows: [],
      weeks: [],
      totalMinutes: 0,
      totalHours: 0,
      stations: [
        { id: w.kap.id, code: "100", name: "Kap" },
        { id: w.svets.id, code: "200", name: "Svets" },
      ],
    });
    expect((await runPlan(cookie, `workCenterId=${w.kap.id}`)).stations).toEqual(bare.stations);
    // The same list, in the same order, as the terminal's stations.
    expect(bare.stations).toEqual((await get(cookie, "/terminal/stations")).json());
    expect(defaultRunPlanToWeek(today)).toBe(nextMonday);
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
      // A Tuesday is not a week.
      expect((await get(cookie, `${path}?workCenterId=${w.kap.id}&toWeek=${addDays(thisMonday, 1)}`)).statusCode).toBe(400);
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
  it("answers a PDF with the resource, the period, the weeks with their sums and the orders", async () => {
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
    expect(String(res.headers["content-disposition"])).toContain(`korplan-100-${nextMonday}.pdf`);
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(res.rawPayload);
    expect(text).toContain("Körplan — 100 Kap");
    expect(text).toContain(`Utskriven ${today}`);
    expect(text).toContain(`(${nextMonday} – ${addDays(nextMonday, 6)})`);
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
    const empty = await get(cookie, `/planning/run-plan/pdf?workCenterId=${w.svets.id}&toWeek=${lastMonday}`);
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
  const build = (todayIs: string, toWeek: string, operations: ReturnType<typeof op>[]): RunPlanRow[] =>
    buildRunPlan({ today: todayIs, toWeek, workCenter, stations: [], operations, plannedOrderOperations: [] }).rows;

  it("takes the week from a Stockholm day: a Sunday belongs to the week that ends, next week starts the day after", () => {
    // 2030-03-10 is a Sunday; its week's Monday is 2030-03-04.
    expect(defaultRunPlanToWeek("2030-03-10")).toBe("2030-03-11");
    expect(defaultRunPlanToWeek("2030-03-11")).toBe("2030-03-18");
    const rows = build("2030-03-10", "2030-03-11", [
      op({ orderNumber: "TO-1", dueDate: "2030-03-03" }), // the Sunday before: last week
      op({ orderNumber: "TO-2", dueDate: "2030-03-04" }), // Monday of the current week, already passed — not Försenad by week
      op({ orderNumber: "TO-3", dueDate: "2030-03-17" }), // the limit week's Sunday
      op({ orderNumber: "TO-4", dueDate: "2030-03-18" }), // the Monday after the limit
    ]);
    expect(rows.map((r) => [r.orderNumber, r.week, r.late])).toEqual([
      ["TO-1", "2030-02-25", true],
      ["TO-2", "2030-03-04", false],
      ["TO-3", "2030-03-11", false],
    ]);
  });

  it("the plan's first week is the key even when the due date is another week, and time on the resource alone means the setup is done", () => {
    const rows = build("2030-03-06", "2030-03-11", [
      op({
        dueDate: "2030-04-30",
        plannedWeeks: [
          { monday: "2030-03-11", minutes: 20 },
          { monday: "2030-03-04", minutes: 30 },
        ],
        planLocked: true,
        timeOnCurrentResource: true,
      }),
    ]);
    expect(rows[0]).toMatchObject({
      week: "2030-03-04",
      plannedStartWeek: "2030-03-04",
      plannedEndWeek: "2030-03-11",
      planLocked: true,
      setupDone: true,
      remainingMinutes: 20,
    });
  });
});
