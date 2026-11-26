import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLog, db, moOperations, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Flytta's preview and precondition through the real app (spec 2026-11-26,
// step 6a): POST /planning/operations/:opId/move/preview needs the module's
// write rule tillverkning and is not readOnlySafe, writes nothing, answers
// what the move then answers, and both routes refuse a stale
// expectedStartDate with 409 operation-plan-changed before any write. The
// plans are made by the app's own Planera (the real "today") and the days
// are read back, so the file runs on any weekday. The rule itself is tested
// in production-plan.integration.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
// No plan reader: the order is created unplanned, the app's Planera plans.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'FLY%'`;

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
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
// The next Monday–Friday after `date` (no holidays in the fixture).
const nextWeekday = (date: string) => {
  let next = addDays(date, 1);
  while ([0, 6].includes(weekdayOf(next))) next = addDays(next, 1);
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
    .values({ code: `FLY${crypto.randomUUID().slice(0, 6)}`, name: "Flytta", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const post = (cookie: string, url: string, payload?: object) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });

// Everything a move could write, and the log.
async function snapshot() {
  const days = await db.execute(sql`SELECT mo_operation_id, plan_date::text, minutes::text FROM mo_operation_plan_days ORDER BY mo_operation_id, plan_date`);
  const mirror = await db.execute(
    sql`SELECT id, work_center_id, planned_start_date::text, planned_end_date::text, plan_locked, run_position, planned_at::text FROM mo_operations ORDER BY id`
  );
  const events = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "operation_moved"));
  return { days: [...days], mirror: [...mirror], events: events.length };
}

// One own resource with 8 h a day and one TO with one operation of 30
// minutes, planned by Planera on `day` — the first day with capacity from
// today. `target` = the working day after.
async function plannedOperation() {
  const user = await authRepo.create({ email: `fly-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "admin" });
  const r110 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "110", name: "Kantpress", hoursPerDay: 8, active: true }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `KONSOL-${crypto.randomUUID().slice(0, 8)}`, name: "Konsol", type: "manufactured", active: true })
  );
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: r110.id, setupTime: 0, runTimePerUnit: 30 });
  const mo = await mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId: article.id, quantity: 1, dueDate: "2031-01-10" }), user.id);
  const [op] = await mfgService.listOperations(mo.id);
  const cookie = await adminCookie();
  expect((await post(cookie, "/planning/plan")).statusCode).toBe(200);
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, op!.id));
  const day = row!.plannedStartDate!;
  const target = nextWeekday(day);
  const url = `/planning/operations/${op!.id}/move`;
  return { cookie, opId: op!.id, day, target, url, body: { date: target, expectedStartDate: day } };
}

describe("POST /planning/operations/:opId/move/preview", () => {
  it("answers what the move then answers, writing and logging nothing", async () => {
    const { cookie, url, target, body } = await plannedOperation();
    const before = await snapshot();
    const res = await post(cookie, `${url}/preview`, body);
    expect(res.statusCode).toBe(200);
    const preview = res.json();
    expect(preview).toEqual({
      operation: { plannedStartDate: target, plannedEndDate: target },
      following: [],
      warnings: [],
      dayLoad: {
        before: { date: target, loadHours: 0, availableHours: 8, overloaded: false },
        after: { date: target, loadHours: 0.5, availableHours: 8, overloaded: false },
      },
    });
    expect(await snapshot()).toEqual(before);

    const moved = await post(cookie, url, body);
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toEqual({ operation: { ...preview.operation, planLocked: true }, following: [], warnings: [] });
    expect((await snapshot()).events).toBe(1);
  });

  it("needs the write rule tillverkning, and a read-only account is refused (not readOnlySafe)", async () => {
    const { cookie, url, body } = await plannedOperation();
    const before = await snapshot();
    // Reads the plan, but neither previews nor moves.
    for (const permissions of [["terminal"], ["tillverkningsorder_las"], ["forsaljning", "inkop", "lager"]]) {
      const denied = await userCookie(permissions);
      for (const path of [url, `${url}/preview`]) {
        const res = await post(denied, path, body);
        expect(res.statusCode, `${permissions} ${path}`).toBe(403);
        expect(res.json().code).toBe("forbidden");
      }
    }
    const readOnly = await userCookie(["tillverkning"], true);
    for (const path of [url, `${url}/preview`]) {
      const res = await post(readOnly, path, body);
      expect(res.statusCode, path).toBe(403);
      expect(res.json().code).toBe("read-only-account");
    }
    for (const path of [url, `${url}/preview`]) {
      expect((await app.inject({ method: "POST", url: `/api/v1${path}`, payload: body })).statusCode).toBe(401);
    }
    expect(await snapshot()).toEqual(before);

    const allowed = await userCookie(["tillverkning"]);
    expect((await post(allowed, `${url}/preview`, body)).statusCode).toBe(200);
    expect((await post(allowed, url, body)).statusCode).toBe(200);
    // Still the admin's to use — and now stale: the operation has moved.
    expect((await post(cookie, `${url}/preview`, body)).json().code).toBe("operation-plan-changed");
  });

  it("the error codes on both routes, before any write: 400 body, id and passed day, 404, 409 changed and no capacity", async () => {
    const { cookie, url, day, target, body } = await plannedOperation();
    const before = await snapshot();
    let saturday = target;
    while (weekdayOf(saturday) !== 6) saturday = addDays(saturday, 1);
    const cases: [string, object, number, string][] = [
      [url, {}, 400, "validation-failed"],
      [url, { date: target, expectedStartDate: "nope" }, 400, "validation-failed"],
      ["/planning/operations/not-a-uuid/move", body, 400, "validation-failed"],
      [`/planning/operations/${crypto.randomUUID()}/move`, body, 404, "operation-not-found"],
      [url, { date: addDays(day, -30), expectedStartDate: day }, 400, "plan-date-in-past"],
      [url, { date: target, expectedStartDate: target }, 409, "operation-plan-changed"],
      [url, { date: target, expectedStartDate: null }, 409, "operation-plan-changed"],
      [url, { date: saturday, expectedStartDate: day }, 409, "plan-date-no-capacity"],
      [url, { date: saturday }, 409, "plan-date-no-capacity"],
    ];
    for (const [path, payload, status, code] of cases) {
      for (const suffix of ["", "/preview"]) {
        const res = await post(cookie, `${path}${suffix}`, payload);
        expect(res.statusCode, `${path}${suffix} ${JSON.stringify(payload)}`).toBe(status);
        expect(res.json().code).toBe(code);
      }
    }
    expect(await snapshot()).toEqual(before);
    // Without the precondition (integrations) the move goes through.
    expect((await post(cookie, url, { date: target })).statusCode).toBe(200);
  });
});
