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
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { isoWeekOf } from "../src/modules/timereport/service/schedule.service.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Beläggningens dagvy (#18, etapp 4) through the real app:
// GET /planning/capacity?granularity=day — the answer's form, the limits of
// `days`, no prices, and the same access as the week view.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
// No plan reader: the orders are created unplanned, the plan is set by hand.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'BDV%'`;

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
    .values({ code: `BDV${crypto.randomUUID().slice(0, 6)}`, name: "Dagvy", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const get = (cookie: string, url: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } });

// One resource with 8 h a day (Mon–Fri) and one order of 600 min on it.
async function world() {
  const user = await authRepo.create({ email: `bdv-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "admin" });
  const kap = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Kap", active: true, hoursPerDay: 8 }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `STOL-${crypto.randomUUID().slice(0, 8)}`, name: "Stol", type: "manufactured", active: true, standardCost: 123.45 })
  );
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 0, runTimePerUnit: 60 });
  const mo = await mfgService.createManufacturingOrder(
    parsed(createManufacturingOrderSchema, { articleId: article.id, quantity: 10, dueDate: addDays(today, 60) }),
    user.id
  );
  const [op] = await mfgService.listOperations(mo.id);
  return { kap, mo, op: op! };
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

const resourceOf = (capacity: CapacityResult, workCenterId: string) =>
  capacity.groups.flatMap((g) => g.resources).find((r) => r.workCenterId === workCenterId)!;

describe("GET /planning/capacity?granularity=day", () => {
  it("answers with day columns from today, the resource's day cells and the group's day totals", async () => {
    const w = await world();
    const cookie = await adminCookie();
    // 600 min: all of it tomorrow and the day after (the days exist whatever weekday it is).
    await planOn(w.op.id, [
      { date: addDays(today, 1), minutes: 540 },
      { date: addDays(today, 2), minutes: 60 },
    ]);

    const res = await get(cookie, "/planning/capacity?granularity=day");
    expect(res.statusCode, res.body).toBe(200);
    const capacity = res.json() as CapacityResult;
    expect(capacity.today).toBe(today);
    expect(capacity.granularity).toBe("day");
    expect(capacity.weeks).toEqual([]);
    // 14 days from today when none is given.
    expect(capacity.days).toHaveLength(14);
    expect(capacity.days[0]).toEqual({ date: today, isoWeek: isoWeekOf(today).isoWeek, weekday: new Date(`${today}T00:00:00Z`).getUTCDay() || 7 });
    expect(capacity.days.map((d) => d.date)).toEqual(Array.from({ length: 14 }, (_, i) => addDays(today, i)));

    const group = capacity.groups[0]!;
    expect(group.weekTotals).toEqual([]);
    expect(group.dayTotals).toHaveLength(14);
    const kap = resourceOf(capacity, w.kap.id);
    expect(kap.weeks).toEqual([]);
    expect(kap.days).toHaveLength(14);
    expect(kap.dayLoads.map((d) => d.date)).toEqual(capacity.days.map((d) => d.date));
    // Capacity per day: 8 h Monday–Friday, nothing at the weekend.
    expect(kap.days.map((c) => c.availableHours)).toEqual(capacity.days.map((d) => (d.weekday <= 5 ? 8 : 0)));

    const tomorrow = kap.days[1]!;
    expect(tomorrow.loadHours).toBe(9);
    // 9 h on 8 h — or on a weekend day's 0 h: over either way, by the one rule.
    expect(tomorrow.overloaded).toBe(true);
    expect(tomorrow.overloadedDays).toBe(1);
    expect(tomorrow.orders).toHaveLength(1);
    expect(tomorrow.orders[0]).toMatchObject({
      moOperationId: w.op.id,
      orderNumber: w.mo.orderNumber,
      hoursInDay: 9,
      remainingHours: 10,
      planned: true,
      plannedStartDate: addDays(today, 1),
      plannedEndDate: addDays(today, 2),
    });
    expect(kap.days[2]!.orders[0]).toMatchObject({ moOperationId: w.op.id, hoursInDay: 1 });
    expect(kap.days[0]!.orders).toEqual([]);
    expect(kap.dayLoads[1]).toEqual({ date: addDays(today, 1), loadHours: 9, availableHours: tomorrow.availableHours, overloaded: true });
    expect(capacity.summary.overloadedDays).toBeGreaterThanOrEqual(1);
    expect(capacity.summary.overloadedCells).toBe(capacity.summary.overloadedDays);
    expect(group.dayTotals[1]).toMatchObject({ loadHours: 9, overloaded: true });
    // No price or cost field anywhere in the answer.
    expect(res.body).not.toMatch(/price|cost/i);
  });

  it("the week view carries today, overloadedDays and the days without their orders — and no day columns", async () => {
    const w = await world();
    const cookie = await adminCookie();
    await planOn(w.op.id, [{ date: addDays(today, 1), minutes: 600 }]);

    const res = await get(cookie, "/planning/capacity?weeks=3");
    expect(res.statusCode, res.body).toBe(200);
    const capacity = res.json() as CapacityResult;
    expect(capacity.today).toBe(today);
    expect(capacity.granularity).toBe("week");
    expect(capacity.days).toEqual([]);
    expect(capacity.weeks).toHaveLength(3);
    const kap = resourceOf(capacity, w.kap.id);
    expect(kap.days).toEqual([]);
    expect(capacity.groups[0]!.dayTotals).toEqual([]);
    // 10 h on one day: that day is over, the week (40 h) is not.
    const weekIndex = capacity.weeks.findIndex((week) => week.monday === mondayOf(addDays(today, 1)));
    expect(kap.weeks[weekIndex]).toMatchObject({ loadHours: 10, availableHours: 40, overloaded: false, overloadedDays: 1 });
    expect(kap.weeks[weekIndex]!.orders[0]).toMatchObject({ hoursInWeek: 10, hoursInDay: null });
    expect(capacity.summary.overloadedCells).toBe(0);
    expect(capacity.summary.overloadedDays).toBe(1);
    // Flytta's "ledigt": the day's load and capacity, found by date.
    expect(kap.dayLoads).toHaveLength(21);
    expect(kap.dayLoads[0]!.date).toBe(capacity.weeks[0]!.monday);
    expect(kap.dayLoads.find((d) => d.date === addDays(today, 1))).toMatchObject({ loadHours: 10, overloaded: true });
    // The week view is the day view's sum: the same load on the same day.
    const dayView = (await get(cookie, "/planning/capacity?granularity=day&days=7")).json() as CapacityResult;
    expect(resourceOf(dayView, w.kap.id).dayLoads[1]).toEqual(kap.dayLoads.find((d) => d.date === addDays(today, 1)));
  });

  it("takes 7 to 42 days — 400 outside, and for an unknown granularity", async () => {
    await world();
    const cookie = await adminCookie();
    for (const days of [7, 42]) {
      const res = await get(cookie, `/planning/capacity?granularity=day&days=${days}`);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as CapacityResult).days).toHaveLength(days);
    }
    for (const query of ["granularity=day&days=6", "granularity=day&days=43", "granularity=day&days=7.5", "granularity=day&days=x", "granularity=hour"]) {
      const res = await get(cookie, `/planning/capacity?${query}`);
      expect(res.statusCode, query).toBe(400);
      expect(res.json().code).toBe("validation-failed");
    }
  });

  it("is read with the same access as the week view", async () => {
    await world();
    const statuses = async (cookie: string) =>
      Promise.all(["/planning/capacity", "/planning/capacity?granularity=day"].map(async (url) => (await get(cookie, url)).statusCode));
    expect(await statuses(await adminCookie())).toEqual([200, 200]);
    expect(await statuses(await userCookie(["tillverkning"]))).toEqual([200, 200]);
    // A read-only account reads.
    expect(await statuses(await userCookie(["tillverkning"], true))).toEqual([200, 200]);
    // The terminal alone, or nothing, is not the office.
    expect(await statuses(await userCookie(["terminal"]))).toEqual([403, 403]);
    expect(await statuses(await userCookie([]))).toEqual([403, 403]);
  });
});
