import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { auditLog, db, moOperations, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { lockProductionPlan } from "../src/modules/planning/repository/plan-lock.js";
import type { CapacityResult } from "../src/modules/planning/service/capacity-calc.js";
import type { StructureResult } from "../src/modules/planning/service/structure-tree.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";
import { waitForLockWaiter } from "./helpers/year-end.js";

// POST /planning/unlock-orders through the real app (spec 2026-11-26, etapp
// 4, S27) — Lås upp hela ordern / Lås upp strukturen: the locks of the given
// TOs' operations are removed in one transaction under the production_plan
// lock, the days stay until the next Planera, it is idempotent and the
// händelselogg only gets a row for a TO that actually had a lock. The plans
// are made by the app's own Planera and Flytta (the real "today") and read
// back, so the file runs on any weekday.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
// No plan reader: the orders are created unplanned, the app's Planera plans.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'ULO%'`;

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
// The next Monday–Friday after `date` (no holidays in the fixture).
const nextWeekday = (date: string) => {
  let next = addDays(date, 1);
  while ([0, 6].includes(new Date(`${next}T00:00:00Z`).getUTCDay())) next = addDays(next, 1);
  return next;
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
    .values({ code: `ULO${crypto.randomUUID().slice(0, 6)}`, name: "Lås upp", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const post = (cookie: string, url: string, payload?: object) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
const unlock = (cookie: string, manufacturingOrderIds: string[]) => post(cookie, "/planning/unlock-orders", { manufacturingOrderIds });

async function opRow(opId: string) {
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, opId));
  return row!;
}
// What the unlock may and may not touch: the locks, and the days.
async function planOf(opIds: string[]) {
  const rows = await Promise.all(opIds.map(opRow));
  return rows.map((r) => ({ locked: r.planLocked, start: r.plannedStartDate, end: r.plannedEndDate }));
}
const unlockEvents = () =>
  db
    .select({ entityType: auditLog.entityType, entityId: auditLog.entityId, action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(eq(auditLog.action, "order_plan_unlocked"))
    .orderBy(asc(auditLog.entityId));

// One resource with 8 h a day and three TOs (a, b, c) of an article with two
// operations of 30 minutes, planned by Planera. Then Flytta — which locks —
// both of a's operations, b's first and c's first to later days.
async function world() {
  const user = await authRepo.create({ email: `ulo-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "admin" });
  const r110 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "110", name: "Kantpress", hoursPerDay: 8, active: true }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `KONSOL-${crypto.randomUUID().slice(0, 8)}`, name: "Konsol", type: "manufactured", active: true })
  );
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: r110.id, setupTime: 0, runTimePerUnit: 30 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: r110.id, setupTime: 0, runTimePerUnit: 30 });
  const order = async (dueDate: string) => {
    const mo = await mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId: article.id, quantity: 1, dueDate }), user.id);
    const [op10, op20] = await mfgService.listOperations(mo.id);
    return { id: mo.id, orderNumber: mo.orderNumber, op10: op10!.id, op20: op20!.id };
  };
  const [a, b, c] = [await order("2031-01-10"), await order("2031-01-11"), await order("2031-01-12")];
  const cookie = await adminCookie();
  expect((await post(cookie, "/planning/plan")).statusCode).toBe(200);
  const planned = (await opRow(a!.op10)).plannedStartDate!;
  // Two working days well after everything Planera placed.
  const later = nextWeekday(addDays(planned, 14));
  const evenLater = nextWeekday(later);
  const move = async (opId: string, date: string) => {
    const res = await post(cookie, `/planning/operations/${opId}/move`, { date, moveFollowing: false });
    expect(res.statusCode, res.body).toBe(200);
  };
  await move(a!.op20, evenLater);
  await move(a!.op10, later);
  await move(b!.op10, later);
  await move(c!.op10, later);
  return { user, r110, a: a!, b: b!, c: c!, cookie, planned, later, evenLater };
}
type World = Awaited<ReturnType<typeof world>>;
const allOps = (w: World) => [w.a.op10, w.a.op20, w.b.op10, w.b.op20, w.c.op10, w.c.op20];

describe("POST /planning/unlock-orders", () => {
  it("removes every lock on the given TOs and leaves the days and the other TOs alone", async () => {
    const w = await world();
    const before = await planOf(allOps(w));
    expect(before.map((p) => p.locked)).toEqual([true, true, true, false, true, false]);
    expect(before.slice(0, 2).map((p) => p.start)).toEqual([w.later, w.evenLater]);

    const res = await unlock(w.cookie, [w.b.id, w.a.id]);
    expect(res.statusCode, res.body).toBe(200);
    // In the request's order, with the number of operations that had a lock.
    expect(res.json()).toEqual({
      unlocked: [
        { manufacturingOrderId: w.b.id, orderNumber: w.b.orderNumber, operations: 1 },
        { manufacturingOrderId: w.a.id, orderNumber: w.a.orderNumber, operations: 2 },
      ],
    });
    const after = await planOf(allOps(w));
    expect(after.map((p) => p.locked)).toEqual([false, false, false, false, true, false]);
    // The days stay until the next Planera, like Lås upp.
    expect(after.map(({ start, end }) => ({ start, end }))).toEqual(before.map(({ start, end }) => ({ start, end })));

    // One row per TO that had a lock, with the operations as ONE text.
    expect(await unlockEvents()).toEqual(
      [
        { entityType: "manufacturing_order", entityId: w.a.orderNumber, action: "order_plan_unlocked", detail: { operations: "op 10, op 20", count: 2 } },
        { entityType: "manufacturing_order", entityId: w.b.orderNumber, action: "order_plan_unlocked", detail: { operations: "op 10", count: 1 } },
      ].sort((x, y) => (x.entityId < y.entityId ? -1 : 1))
    );
  });

  it("is idempotent: a second call unlocks nothing and logs nothing", async () => {
    const w = await world();
    expect((await unlock(w.cookie, [w.a.id])).statusCode).toBe(200);
    expect(await unlockEvents()).toHaveLength(1);
    const again = await unlock(w.cookie, [w.a.id, w.b.id]);
    expect(again.statusCode).toBe(200);
    // a had its locks removed already; b still had one.
    expect(again.json()).toEqual({
      unlocked: [
        { manufacturingOrderId: w.a.id, orderNumber: w.a.orderNumber, operations: 0 },
        { manufacturingOrderId: w.b.id, orderNumber: w.b.orderNumber, operations: 1 },
      ],
    });
    expect((await unlockEvents()).map((e) => e.entityId).sort()).toEqual([w.a.orderNumber, w.b.orderNumber].sort());
    const third = await unlock(w.cookie, [w.a.id, w.b.id]);
    expect(third.json()).toMatchObject({ unlocked: [{ operations: 0 }, { operations: 0 }] });
    expect(await unlockEvents()).toHaveLength(2);
  });

  it("Planera afterwards moves the unlocked operations — and keeps the ones still locked", async () => {
    const w = await world();
    // Locked: Planera lets the hand-moved days lie.
    expect((await post(w.cookie, "/planning/plan")).statusCode).toBe(200);
    expect((await planOf([w.a.op10, w.a.op20, w.c.op10])).map((p) => p.start)).toEqual([w.later, w.evenLater, w.later]);

    expect((await unlock(w.cookie, [w.a.id])).statusCode).toBe(200);
    expect((await post(w.cookie, "/planning/plan")).statusCode).toBe(200);
    const [a10, a20, c10] = await planOf([w.a.op10, w.a.op20, w.c.op10]);
    expect(a10!.start! < w.later).toBe(true);
    expect(a20!.start! < w.evenLater).toBe(true);
    expect(c10).toEqual({ locked: true, start: w.later, end: w.later });
  });

  it("404 for a TO that does not exist — nothing is unlocked, nothing logged", async () => {
    const w = await world();
    const before = await planOf(allOps(w));
    const res = await unlock(w.cookie, [w.a.id, crypto.randomUUID()]);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "manufacturing-order-not-found" });
    expect(await planOf(allOps(w))).toEqual(before);
    expect(await unlockEvents()).toEqual([]);
  });

  it("400 for an empty list, a TO listed twice, a malformed id and more than 200 TOs", async () => {
    const w = await world();
    const before = await planOf(allOps(w));
    for (const payload of [
      {},
      { manufacturingOrderIds: [] },
      { manufacturingOrderIds: [w.a.id, w.a.id] },
      { manufacturingOrderIds: ["TO-1001"] },
      { manufacturingOrderIds: Array.from({ length: 201 }, () => crypto.randomUUID()) },
    ]) {
      const res = await post(w.cookie, "/planning/unlock-orders", payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect(await planOf(allOps(w))).toEqual(before);
  });

  it("waits for the production_plan lock", async () => {
    const w = await world();
    const before = await planOf(allOps(w));
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
    let run: Promise<Awaited<ReturnType<typeof unlock>>> | undefined;
    // Released even when something fails, so the open transaction never hangs the file.
    try {
      // inject() starts when it is awaited — `then` starts it now.
      run = unlock(w.cookie, [w.a.id]).then((res) => res);
      run.catch(() => {});
      await waitForLockWaiter();
      expect(await planOf(allOps(w))).toEqual(before);
    } finally {
      open();
    }
    await holder;
    const res = await run!;
    expect(res.statusCode, res.body).toBe(200);
    expect((await planOf([w.a.op10, w.a.op20])).map((p) => p.locked)).toEqual([false, false]);
  });

  it("needs the write rule tillverkning, and a read-only account is refused", async () => {
    const w = await world();
    const before = await planOf(allOps(w));
    for (const permissions of [["forsaljning"], ["inkop", "lager"], ["terminal", "tillverkningsorder_las"]]) {
      const denied = await unlock(await userCookie(permissions), [w.a.id]);
      expect(denied.statusCode, permissions.join()).toBe(403);
    }
    const readOnly = await unlock(await userCookie(["tillverkning"], true), [w.a.id]);
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json()).toMatchObject({ code: "read-only-account" });
    expect((await app.inject({ method: "POST", url: "/api/v1/planning/unlock-orders", payload: { manufacturingOrderIds: [w.a.id] } })).statusCode).toBe(401);
    expect(await planOf(allOps(w))).toEqual(before);
    expect(await unlockEvents()).toEqual([]);

    expect((await unlock(await userCookie(["tillverkning"]), [w.a.id])).statusCode).toBe(200);
    expect((await planOf([w.a.op10, w.a.op20])).map((p) => p.locked)).toEqual([false, false]);
  });

  it("Beläggning's summary and the tree count the locked operations — and stop counting them", async () => {
    const w = await world();
    const locked = async () =>
      ((await app.inject({ url: "/api/v1/planning/capacity", headers: { cookie: w.cookie } })).json() as CapacityResult).summary.lockedOperations;
    const tree = async (id: string): Promise<StructureResult> =>
      (await app.inject({ url: `/api/v1/planning/structure?manufacturingOrderId=${id}`, headers: { cookie: w.cookie } })).json();
    expect(await locked()).toBe(4);
    expect((await tree(w.a.id)).totals.lockedOperations).toBe(2);
    expect((await tree(w.a.id)).nodes[0]).toMatchObject({ kind: "order", lockedOperations: 2 });

    expect((await unlock(w.cookie, [w.a.id, w.b.id])).statusCode).toBe(200);
    expect(await locked()).toBe(1);
    expect((await tree(w.a.id)).totals.lockedOperations).toBe(0);
    expect((await tree(w.c.id)).totals.lockedOperations).toBe(1);
  });
});
