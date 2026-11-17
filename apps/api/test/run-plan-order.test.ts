import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, moOperations, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { lockProductionPlan } from "../src/modules/planning/repository/plan-lock.js";
import type { RunPlanResult } from "../src/modules/planning/service/run-plan.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Ordningen inom dagen (#18 etapp 3) through the real app:
// PUT /planning/run-plan/order writes run_position 1..n for one day on one
// resource, the körplan and the terminal read it, every writer that changes
// the start day or the resource drops it — and NO date is ever touched by
// it. The plans are made by the app's own Planera (the real "today"), and
// the day they land on is read back, so the file runs on any weekday.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
// No plan reader: the orders are created unplanned, the app's Planera plans.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'KOR%'`;

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
    .values({ code: `KOR${crypto.randomUUID().slice(0, 6)}`, name: "Körordning", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const get = (cookie: string, url: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } });
const send = (cookie: string, method: "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });

// Three own resources with 8 h a day (110 Kantpress, 120 Kantpress 2, 130
// Svets) and a legoresurs. The article's only operation is on 110, 30 min a
// piece, with 120 as its alternative — 130 is outside its resources.
async function world() {
  const user = await authRepo.create({ email: `kor-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "admin" });
  const wc = (code: string, name: string) =>
    mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code, name, hoursPerDay: 8, active: true }));
  const r110 = await wc("110", "Kantpress");
  const r120 = await wc("120", "Kantpress 2");
  const r130 = await wc("130", "Svets");
  const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling AB", type: "subcontract", active: true }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `KONSOL-${crypto.randomUUID().slice(0, 8)}`, name: "Konsol", type: "manufactured", active: true })
  );
  await mfgService.createRoutingOperation(article.id, {
    sequenceNo: 10,
    workCenterId: r110.id,
    setupTime: 0,
    runTimePerUnit: 30,
    alternatives: [{ workCenterId: r120.id }],
  });
  const order = async (dueDate: string | null = null) => {
    const mo = await mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId: article.id, quantity: 1, dueDate }), user.id);
    const [op] = await mfgService.listOperations(mo.id);
    return { id: mo.id, orderNumber: mo.orderNumber, opId: op!.id };
  };
  return { user, r110, r120, r130, lego, article, order };
}
type Order = Awaited<ReturnType<Awaited<ReturnType<typeof world>>["order"]>>;

async function planera(cookie: string) {
  const res = await send(cookie, "POST", "/planning/plan");
  expect(res.statusCode, res.body).toBe(200);
}
async function opRow(opId: string) {
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, opId));
  return row!;
}
const positions = async (orders: Order[]) => Promise.all(orders.map(async (o) => (await opRow(o.opId)).runPosition));
const putOrder = (cookie: string, workCenterId: string, date: string, moOperationIds: string[]) =>
  send(cookie, "PUT", "/planning/run-plan/order", { workCenterId, date, moOperationIds });
async function runPlan(cookie: string, workCenterId: string, toDate: string): Promise<RunPlanResult> {
  const res = await get(cookie, `/planning/run-plan?workCenterId=${workCenterId}&toDate=${toDate}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}
const orderEvents = () => db.select().from(auditLog).where(and(eq(auditLog.entityType, "production_plan"), eq(auditLog.action, "run_order_changed")));

// Four TO:s planned by Planera: 30 min each, so all four start the same day
// on 110 — the first day with capacity from today. That day is `day`.
async function plannedDay() {
  const w = await world();
  const cookie = await adminCookie();
  const orders = [await w.order("2031-01-10"), await w.order("2031-01-11"), await w.order("2031-01-12"), await w.order("2031-01-13")];
  await planera(cookie);
  const day = (await opRow(orders[0]!.opId)).plannedStartDate!;
  for (const o of orders) expect((await opRow(o.opId)).plannedStartDate).toBe(day);
  return { w, cookie, orders, day, ids: orders.map((o) => o.opId) };
}

// Everything a date could hide in: the allocations, the mirror columns and
// the lock — and Beläggning's whole answer.
async function planSnapshot(cookie: string) {
  const days = await db.execute(sql`SELECT mo_operation_id, plan_date::text, minutes::text FROM mo_operation_plan_days ORDER BY mo_operation_id, plan_date`);
  const mirror = await db.execute(
    sql`SELECT id, work_center_id, planned_start_date::text, planned_end_date::text, plan_locked, planned_at::text, resource_locked FROM mo_operations ORDER BY id`
  );
  const capacity = await get(cookie, "/planning/capacity?weeks=8");
  expect(capacity.statusCode).toBe(200);
  return { days: [...days], mirror: [...mirror], capacity: capacity.json() };
}

describe("PUT /planning/run-plan/order — ordna", () => {
  it("writes 1..n in the given order; the körplan and the terminal read it; idempotent", async () => {
    const { w, cookie, orders, day, ids } = await plannedDay();
    // Untouched: the standard order (due date), no places, the day can be ordered.
    const before = await runPlan(cookie, w.r110.id, day);
    expect(before.rows.map((r) => [r.orderNumber, r.runPosition])).toEqual(orders.map((o) => [o.orderNumber, null]));
    expect(before.days).toEqual([expect.objectContaining({ kind: "day", date: day, reorderable: true, rows: 4 })]);

    const wanted = [ids[2]!, ids[0]!, ids[3]!, ids[1]!];
    const res = await putOrder(cookie, w.r110.id, day, wanted);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ date: day, moOperationIds: wanted });
    expect(await positions(orders)).toEqual([2, 4, 1, 3]);

    const after = await runPlan(cookie, w.r110.id, day);
    expect(after.rows.map((r) => [r.moOperationId, r.runPosition])).toEqual(wanted.map((id, i) => [id, i + 1]));
    const pdf = await get(cookie, `/planning/run-plan/pdf?workCenterId=${w.r110.id}&toDate=${day}`);
    expect(pdf.statusCode).toBe(200);

    const terminal = await get(cookie, `/terminal/operations?workCenterIds=${w.r110.id}`);
    expect(terminal.statusCode, terminal.body).toBe(200);
    const terminalRows = terminal.json().rows as { operationId: string; runPosition: number | null; plannedStartDate: string | null }[];
    expect(new Map(terminalRows.map((r) => [r.operationId, r.runPosition]))).toEqual(new Map(wanted.map((id, i) => [id, i + 1])));
    // The TO card's operations carry it too.
    const card = await get(cookie, `/manufacturing-orders/${orders[2]!.id}/operations`);
    expect(card.json()[0]).toMatchObject({ id: ids[2], runPosition: 1 });

    // One event, with the order numbers in the written order as one text.
    const events = await orderEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: null,
      detail: { workCenterCode: "110", date: day, orderNumbers: [orders[2]!, orders[0]!, orders[3]!, orders[1]!].map((o) => o.orderNumber).join(", ") },
    });

    // The same list again (a double click): the same answer, nothing new.
    const again = await putOrder(cookie, w.r110.id, day, wanted);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ date: day, moOperationIds: wanted });
    expect(await positions(orders)).toEqual([2, 4, 1, 3]);
    expect(await orderEvents()).toHaveLength(1);

    // A new order of the day rewrites the whole day.
    const next = [ids[1]!, ids[2]!, ids[0]!, ids[3]!];
    expect((await putOrder(cookie, w.r110.id, day, next)).statusCode).toBe(200);
    expect(await positions(orders)).toEqual([3, 1, 2, 4]);
    expect(await orderEvents()).toHaveLength(2);
  });

  it("an operation new on the day comes after the ordered ones, and the next PUT takes it in", async () => {
    const { w, cookie, orders, day, ids } = await plannedDay();
    expect((await putOrder(cookie, w.r110.id, day, [ids[3]!, ids[2]!, ids[1]!, ids[0]!])).statusCode).toBe(200);
    // Due before every other — the standard order would put it first.
    const fresh = await w.order("2030-12-01");
    await planera(cookie);
    expect((await opRow(fresh.opId)).plannedStartDate).toBe(day);
    const plan = await runPlan(cookie, w.r110.id, day);
    expect(plan.rows.map((r) => [r.moOperationId, r.runPosition])).toEqual([
      [ids[3], 1],
      [ids[2], 2],
      [ids[1], 3],
      [ids[0], 4],
      [fresh.opId, null],
    ]);
    // The old list is no longer the whole day.
    expect((await putOrder(cookie, w.r110.id, day, [ids[3]!, ids[2]!, ids[1]!, ids[0]!])).statusCode).toBe(409);
    expect((await putOrder(cookie, w.r110.id, day, [fresh.opId, ids[3]!, ids[2]!, ids[1]!, ids[0]!])).statusCode).toBe(200);
    expect(await positions([fresh, ...orders])).toEqual([1, 5, 4, 3, 2]);
  });

  it("never touches a date: the whole plan and GET /planning/capacity are identical before and after", async () => {
    const { w, cookie, day, ids } = await plannedDay();
    // A hand-moved (locked) operation and a second resource in the picture.
    const moved = await w.order("2031-02-01");
    await planera(cookie);
    expect((await send(cookie, "POST", `/planning/operations/${moved.opId}/move`, { date: addDays(day, 7) })).statusCode).toBe(200);

    const before = await planSnapshot(cookie);
    expect((await putOrder(cookie, w.r110.id, day, [ids[3]!, ids[1]!, ids[0]!, ids[2]!])).statusCode).toBe(200);
    expect((await putOrder(cookie, w.r110.id, addDays(day, 7), [moved.opId])).statusCode).toBe(200);
    expect(await planSnapshot(cookie)).toEqual(before);
    // … and a Planera afterwards gives the same days as one without the order.
    await planera(cookie);
    const replanned = await planSnapshot(cookie);
    expect(replanned.days).toEqual(before.days);
    // (Only the run's own timestamp differs.)
    const withoutRun = (capacity: { summary: { plannedAt: string | null } }) => ({ ...capacity, summary: { ...capacity.summary, plannedAt: null } });
    expect(withoutRun(replanned.capacity)).toEqual(withoutRun(before.capacity));
  });
});

describe("PUT /planning/run-plan/order — vägran", () => {
  it("409s run-plan-order-changed when the day's operations are not the ones sent — nothing written", async () => {
    const { w, cookie, orders, day, ids } = await plannedDay();
    expect((await putOrder(cookie, w.r110.id, day, ids)).statusCode).toBe(200);
    const reversed = [...ids].reverse();
    const refused = async (list: string[], date = day, workCenterId = w.r110.id) => {
      const res = await putOrder(cookie, workCenterId, date, list);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe("run-plan-order-changed");
    };

    // One missing, and an id nobody knows.
    await refused(reversed.slice(1));
    await refused([...reversed.slice(1), crypto.randomUUID()]);
    await refused([...reversed, crypto.randomUUID()]);
    // The right operations on another day, and on another resource.
    await refused(reversed, addDays(day, 7));
    await refused(reversed, day, w.r120.id);
    expect(await positions(orders)).toEqual([1, 2, 3, 4]);

    // Moved to another day in the meantime.
    expect((await send(cookie, "POST", `/planning/operations/${ids[0]}/move`, { date: addDays(day, 7) })).statusCode).toBe(200);
    await refused(reversed);
    // … the day is now the three that are left.
    const left = reversed.filter((id) => id !== ids[0]);

    // Switched resource in the meantime (Byt resurs).
    const switched = await send(cookie, "PATCH", `/manufacturing-orders/${orders[1]!.id}/operations/${ids[1]}`, { workCenterId: w.r120.id });
    expect(switched.statusCode, switched.body).toBe(200);
    await refused(left);

    // Reported done in the meantime (the plan row stays until the next Planera).
    await db.update(moOperations).set({ status: "done" }).where(eq(moOperations.id, ids[2]!));
    await refused(left.filter((id) => id !== ids[1]));
    expect((await opRow(ids[3]!)).runPosition).toBe(4);
    expect((await opRow(ids[2]!)).runPosition).toBe(3);

    // What is left of the day goes through.
    expect((await putOrder(cookie, w.r110.id, day, [ids[3]!])).statusCode).toBe(200);
    expect((await opRow(ids[3]!)).runPosition).toBe(1);
    // Only the first write and the last one were logged.
    expect(await orderEvents()).toHaveLength(2);
  });

  it("404s an unknown resource, 400s a legoresurs and a bad body", async () => {
    const { w, cookie, day, ids } = await plannedDay();
    const unknown = await putOrder(cookie, crypto.randomUUID(), day, ids);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("work-center-not-found");
    const lego = await putOrder(cookie, w.lego.id, day, ids);
    expect(lego.statusCode).toBe(400);
    expect(lego.json().code).toBe("run-plan-subcontract-resource");

    for (const body of [
      {},
      { workCenterId: w.r110.id, date: day },
      { workCenterId: w.r110.id, date: day, moOperationIds: [] },
      { workCenterId: w.r110.id, date: day, moOperationIds: [ids[0], ids[0]] }, // the same operation twice
      { workCenterId: w.r110.id, date: day, moOperationIds: ["x"] },
      { workCenterId: w.r110.id, date: "nope", moOperationIds: ids },
      { workCenterId: "110", date: day, moOperationIds: ids },
      { workCenterId: w.r110.id, date: day, moOperationIds: Array.from({ length: 501 }, () => crypto.randomUUID()) },
    ]) {
      const res = await send(cookie, "PUT", "/planning/run-plan/order", body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 120)).toBe(400);
      expect(res.json().code).toBe("validation-failed");
    }
    expect(await orderEvents()).toHaveLength(0);
  });

  it("is Tillverkning's: the workshop profile reads the körplan but does not order it, and a read-only account never writes", async () => {
    const { w, orders, day, ids } = await plannedDay();
    const body = { workCenterId: w.r110.id, date: day, moOperationIds: [...ids].reverse() };
    const put = (cookie?: string) => app.inject({ method: "PUT", url: "/api/v1/planning/run-plan/order", payload: body, ...(cookie ? { headers: { cookie } } : {}) });

    expect((await put()).statusCode).toBe(401);
    for (const permissions of [["terminal", "artikeloversikt", "tillverkningsorder_las"], ["terminal"], ["forsaljning", "inkop", "lager"], []]) {
      const cookie = await userCookie(permissions);
      const res = await put(cookie);
      expect(res.statusCode, permissions.join()).toBe(403);
      expect(res.json().code).toBe("forbidden");
    }
    // The workshop profile still reads the list.
    expect((await get(await userCookie(["terminal"]), `/planning/run-plan?workCenterId=${w.r110.id}`)).statusCode).toBe(200);
    const readOnly = await put(await userCookie(["tillverkning"], true));
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("read-only-account");
    expect(await positions(orders)).toEqual([null, null, null, null]);

    expect((await put(await userCookie(["tillverkning"]))).statusCode).toBe(200);
    expect(await positions(orders)).toEqual([4, 3, 2, 1]);
  });
});

describe("PUT /planning/run-plan/order — samtidighet", () => {
  it("waits for the production_plan lock", async () => {
    const { w, cookie, orders, day, ids } = await plannedDay();
    let open!: () => void;
    const holding = new Promise<void>((resolve) => (open = resolve));
    let locked!: () => void;
    const inside = new Promise<void>((resolve) => (locked = resolve));
    const holder = db.transaction(async (tx) => {
      await lockProductionPlan(tx);
      locked();
      await holding;
    });
    await inside;
    const put = putOrder(cookie, w.r110.id, day, [...ids].reverse());
    // Released even when the wait fails, so the open transaction never hangs the file.
    await waitForLockWaiter()
      .then(async () => expect(await positions(orders)).toEqual([null, null, null, null]))
      .finally(open);
    await holder;
    expect((await put).statusCode).toBe(200);
    expect(await positions(orders)).toEqual([4, 3, 2, 1]);
  });

  it("two orderings at once serialise: the day ends as ONE of them, never a mix", async () => {
    const { w, cookie, orders, day, ids } = await plannedDay();
    const a = [ids[3]!, ids[2]!, ids[1]!, ids[0]!];
    const b = [ids[1]!, ids[3]!, ids[0]!, ids[2]!];
    const [first, second] = await Promise.all([putOrder(cookie, w.r110.id, day, a), putOrder(cookie, w.r110.id, day, b)]);
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const written = await positions(orders);
    const asPositions = (list: string[]) => ids.map((id) => list.indexOf(id) + 1);
    expect([asPositions(a), asPositions(b)]).toContainEqual(written);
    expect((await runPlan(cookie, w.r110.id, day)).rows.map((r) => r.runPosition)).toEqual([1, 2, 3, 4]);
  });
});

describe("run_position — vem som behåller och vem som nollar", () => {
  it("survives Planera on the same day; dropped by Flytta to another day, both ways of Byt resurs and a done operation", async () => {
    const { w, cookie, orders, day, ids } = await plannedDay();
    const fifth = await w.order("2031-01-14");
    await planera(cookie);
    const all = [...orders, fifth];
    const list = [fifth.opId, ids[3]!, ids[2]!, ids[1]!, ids[0]!];
    expect((await putOrder(cookie, w.r110.id, day, list)).statusCode).toBe(200);
    expect(await positions(all)).toEqual([5, 4, 3, 2, 1]);

    // Planera puts every operation on the same start day again: the order stays.
    await planera(cookie);
    for (const o of all) expect((await opRow(o.opId)).plannedStartDate).toBe(day);
    expect(await positions(all)).toEqual([5, 4, 3, 2, 1]);

    // Flytta to the SAME day (locks it): still the same start day ⇒ kept.
    expect((await send(cookie, "POST", `/planning/operations/${ids[0]}/move`, { date: day })).statusCode).toBe(200);
    expect(await opRow(ids[0]!)).toMatchObject({ plannedStartDate: day, planLocked: true, runPosition: 5 });
    // Flytta to another day: dropped — the others keep theirs (a hole).
    expect((await send(cookie, "POST", `/planning/operations/${ids[0]}/move`, { date: addDays(day, 7) })).statusCode).toBe(200);
    expect(await opRow(ids[0]!)).toMatchObject({ plannedStartDate: addDays(day, 7), runPosition: null });
    expect(await positions(all)).toEqual([null, 4, 3, 2, 1]);
    // Lås upp writes nothing but the lock.
    expect((await send(cookie, "POST", `/planning/operations/${ids[0]}/unlock`)).statusCode).toBe(200);

    // Byt resurs to one of the operation's resources (the switch writer):
    // the replanning gives the same day on the empty 120 — the place on
    // 110's day is dropped all the same.
    const toAlternative = await send(cookie, "PATCH", `/manufacturing-orders/${orders[1]!.id}/operations/${ids[1]}`, { workCenterId: w.r120.id });
    expect(toAlternative.statusCode, toAlternative.body).toBe(200);
    expect(await opRow(ids[1]!)).toMatchObject({ workCenterId: w.r120.id, resourceLocked: true, plannedStartDate: day, runPosition: null });
    // Byt resurs to a resource outside them (the plain update).
    const outside = await send(cookie, "PATCH", `/manufacturing-orders/${orders[2]!.id}/operations/${ids[2]}`, { workCenterId: w.r130.id });
    expect(outside.statusCode, outside.body).toBe(200);
    expect(await opRow(ids[2]!)).toMatchObject({ workCenterId: w.r130.id, plannedStartDate: day, runPosition: null });
    expect(await positions(all)).toEqual([null, null, null, 2, 1]);

    // An edit that changes no resource (a new benämning) keeps the place.
    const renamed = await send(cookie, "PATCH", `/manufacturing-orders/${orders[3]!.id}/operations/${ids[3]}`, { description: "Bocka" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await opRow(ids[3]!)).runPosition).toBe(2);

    // On the new resource's day the switched operation is ordered like any other.
    expect((await putOrder(cookie, w.r120.id, day, [ids[1]!])).statusCode).toBe(200);
    expect((await opRow(ids[1]!)).runPosition).toBe(1);
    // … and back to the ordinarie (the switch writer again) drops it again.
    const back = await send(cookie, "PATCH", `/manufacturing-orders/${orders[1]!.id}/operations/${ids[1]}`, { workCenterId: w.r110.id });
    expect(back.statusCode, back.body).toBe(200);
    expect(await opRow(ids[1]!)).toMatchObject({ workCenterId: w.r110.id, runPosition: null });

    // A done operation loses its plan — and its place — at the next Planera.
    await db.update(moOperations).set({ status: "done" }).where(eq(moOperations.id, ids[3]!));
    await planera(cookie);
    expect(await opRow(ids[3]!)).toMatchObject({ plannedStartDate: null, runPosition: null });
    expect((await opRow(fifth.opId)).runPosition).toBe(1);

    // The körplan of 110: the one with a place first, then the standard order.
    const plan = await runPlan(cookie, w.r110.id, addDays(day, 14));
    expect(plan.rows.map((r) => [r.moOperationId, r.runPosition])).toEqual([
      [fifth.opId, 1],
      [ids[0], null],
      [ids[1], null],
    ]);
  });
});
