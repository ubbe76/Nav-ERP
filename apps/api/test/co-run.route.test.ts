import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { auditLog, db, moOperations, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import type { CoRunResult } from "../src/modules/planning/service/co-run.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Samkör through the real app (spec 2026-11-26, step 2c):
// POST /planning/co-run/preview and POST /planning/co-run — the body's
// validation, the access (the module's write rule tillverkning on BOTH, and
// neither is readOnlySafe), that the preview writes nothing, and the error
// codes. The plans are made by the app's own Planera (the real "today") and
// the days are read back, so the file runs on any weekday. The rules
// themselves are tested in co-run.test.ts and co-run.integration.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
// No plan reader: the orders are created unplanned, the app's Planera plans.
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, time_reports, employees, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'SAM%'`;

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
    .values({ code: `SAM${crypto.randomUUID().slice(0, 6)}`, name: "Samkörning", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const post = (cookie: string, url: string, payload?: object) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
const ROUTES = ["/planning/co-run/preview", "/planning/co-run"] as const;

async function opRow(opId: string) {
  const [row] = await db.select().from(moOperations).where(eq(moOperations.id, opId));
  return row!;
}
// Everything a co-run could write, and the log.
async function snapshot() {
  const days = await db.execute(sql`SELECT mo_operation_id, plan_date::text, minutes::text FROM mo_operation_plan_days ORDER BY mo_operation_id, plan_date`);
  const mirror = await db.execute(
    sql`SELECT id, work_center_id, planned_start_date::text, planned_end_date::text, plan_locked, run_position, planned_at::text FROM mo_operations ORDER BY id`
  );
  const events = await db.select({ id: auditLog.id }).from(auditLog).where(inArray(auditLog.action, ["co_run", "operation_moved"]));
  return { days: [...days], mirror: [...mirror], events: events.length };
}

// One own resource with 8 h a day and three TO:s with one operation of 30
// minutes each, planned by Planera: all three start the same day (`day`) —
// the first day with capacity from today. `target` = the working day after.
async function plannedDay() {
  const user = await authRepo.create({ email: `sam-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "admin" });
  const r110 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "110", name: "Kantpress", hoursPerDay: 8, active: true }));
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `KONSOL-${crypto.randomUUID().slice(0, 8)}`, name: "Konsol", type: "manufactured", active: true })
  );
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: r110.id, setupTime: 0, runTimePerUnit: 30 });
  const order = async (dueDate: string) => {
    const mo = await mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId: article.id, quantity: 1, dueDate }), user.id);
    const [op] = await mfgService.listOperations(mo.id);
    return { id: mo.id, orderNumber: mo.orderNumber, opId: op!.id };
  };
  const orders = [await order("2031-01-10"), await order("2031-01-11"), await order("2031-01-12")];
  const cookie = await adminCookie();
  expect((await post(cookie, "/planning/plan")).statusCode).toBe(200);
  const day = (await opRow(orders[0]!.opId)).plannedStartDate!;
  for (const o of orders) expect((await opRow(o.opId)).plannedStartDate).toBe(day);
  const target = nextWeekday(day);
  // The second and the first, in that order, to the day after.
  const body = {
    workCenterId: r110.id,
    date: target,
    operations: [
      { moOperationId: orders[1]!.opId, plannedStartDate: day },
      { moOperationId: orders[0]!.opId, plannedStartDate: day },
    ],
  };
  return { r110, orders, cookie, day, target, body };
}

describe("POST /planning/co-run and /planning/co-run/preview", () => {
  it("the preview writes nothing; the write answers the same and writes it", async () => {
    const { r110, orders, cookie, day, target, body } = await plannedDay();
    const before = await snapshot();

    const previewRes = await post(cookie, "/planning/co-run/preview", body);
    expect(previewRes.statusCode, previewRes.body).toBe(200);
    const preview: CoRunResult = previewRes.json();
    // Nothing: the days, the mirror with planned_at, the locks, the places, the log.
    expect(await snapshot()).toEqual(before);
    expect(preview).toMatchObject({
      workCenter: { id: r110.id, code: "110", name: "Kantpress" },
      date: target,
      operations: [
        { moOperationId: orders[1]!.opId, orderNumber: orders[1]!.orderNumber, sequenceNo: 10, fromDate: day, plannedStartDate: target, plannedEndDate: target, outcome: "moved" },
        { moOperationId: orders[0]!.opId, orderNumber: orders[0]!.orderNumber, sequenceNo: 10, fromDate: day, plannedStartDate: target, plannedEndDate: target, outcome: "moved" },
      ],
      following: [],
      dayLoad: {
        before: { date: target, loadHours: 0, availableHours: 8, overloaded: false },
        after: { date: target, loadHours: 1, availableHours: 8, overloaded: false },
      },
      lateOrders: [],
      warnings: [],
      materials: [],
      runOrder: [
        { moOperationId: orders[1]!.opId, orderNumber: orders[1]!.orderNumber, sequenceNo: 10, selected: true },
        { moOperationId: orders[0]!.opId, orderNumber: orders[0]!.orderNumber, sequenceNo: 10, selected: true },
      ],
    });
    // A preview again is the same answer — it left nothing behind.
    expect((await post(cookie, "/planning/co-run/preview", body)).json()).toEqual(preview);

    const res = await post(cookie, "/planning/co-run", body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(preview);
    expect(await opRow(orders[1]!.opId)).toMatchObject({ plannedStartDate: target, plannedEndDate: target, planLocked: true, runPosition: 1 });
    expect(await opRow(orders[0]!.opId)).toMatchObject({ plannedStartDate: target, plannedEndDate: target, planLocked: true, runPosition: 2 });
    expect(await opRow(orders[2]!.opId)).toMatchObject({ plannedStartDate: day, planLocked: false, runPosition: null });
    // The log through the real writer: two moves and the co-run, with labels.
    const events = await db.select().from(auditLog).where(inArray(auditLog.action, ["co_run", "operation_moved"]));
    expect(events.filter((e) => e.action === "operation_moved").map((e) => [e.entityType, e.entityId, (e.detail as { reason?: string }).reason])).toEqual(
      expect.arrayContaining([
        ["manufacturing_order", orders[1]!.orderNumber, "co_run"],
        ["manufacturing_order", orders[0]!.orderNumber, "co_run"],
      ])
    );
    expect(events.filter((e) => e.action === "co_run")).toEqual([
      expect.objectContaining({
        entityType: "production_plan",
        entityId: null,
        detail: { workCenterCode: "110", date: target, operations: `${orders[1]!.orderNumber} op 10, ${orders[0]!.orderNumber} op 10`, moved: 2 },
      }),
    ]);
    expect(events).toHaveLength(3);

    // The same request again: the operations are no longer where the list showed them.
    for (const url of ROUTES) {
      const again = await post(cookie, url, body);
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("co-run-changed");
    }
  });

  it("400 for a body the schema refuses, on both routes — nothing written", async () => {
    const { r110, orders, cookie, day, target, body } = await plannedDay();
    const before = await snapshot();
    const fifty = Array.from({ length: 51 }, () => ({ moOperationId: crypto.randomUUID(), plannedStartDate: null }));
    const bad: object[] = [
      // One operation is no co-run.
      { ...body, operations: [body.operations[0]] },
      { ...body, operations: [] },
      // More than 50.
      { ...body, operations: fifty },
      // The same operation twice.
      { ...body, operations: [body.operations[0], body.operations[0]] },
      // Dates that are no days.
      { ...body, date: "2030-02-30" },
      { ...body, date: "i morgon" },
      { workCenterId: r110.id, operations: body.operations },
      { ...body, operations: [body.operations[0], { moOperationId: orders[0]!.opId, plannedStartDate: "2030-13-01" }] },
      // plannedStartDate must be sent (null = unplanned), ids must be uuids.
      { ...body, operations: [body.operations[0], { moOperationId: orders[0]!.opId }] },
      { ...body, operations: [body.operations[0], { moOperationId: "42", plannedStartDate: day }] },
      { ...body, workCenterId: "110" },
      {},
    ];
    for (const url of ROUTES) {
      for (const payload of bad) {
        const res = await post(cookie, url, payload);
        expect(res.statusCode, `${url} ${JSON.stringify(payload).slice(0, 120)}`).toBe(400);
        expect(res.json().code).toBe("validation-failed");
      }
    }
    // Exactly 50 passes the schema (the unknown operations are a 404).
    const atLimit = await post(cookie, "/planning/co-run/preview", { ...body, operations: fifty.slice(0, 50) });
    expect(atLimit.statusCode).toBe(404);
    expect(atLimit.json().code).toBe("operation-not-found");
    expect(target > day).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("needs the write rule tillverkning on both routes, and a read-only account is refused on both", async () => {
    const { cookie, body } = await plannedDay();
    const before = await snapshot();
    // Reads the körplan, but neither previews nor co-runs.
    for (const permissions of [["terminal"], ["tillverkningsorder_las"], ["forsaljning", "inkop", "lager"]]) {
      const denied = await userCookie(permissions);
      for (const url of ROUTES) {
        const res = await post(denied, url, body);
        expect(res.statusCode, `${permissions} ${url}`).toBe(403);
        expect(res.json().code).toBe("forbidden");
      }
    }
    // Endast läsning with Tillverkning: the preview is not readOnlySafe (S15).
    const readOnly = await userCookie(["tillverkning"], true);
    for (const url of ROUTES) {
      const res = await post(readOnly, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe("read-only-account");
    }
    for (const url of ROUTES) expect((await app.inject({ method: "POST", url: `/api/v1${url}`, payload: body })).statusCode).toBe(401);
    expect(await snapshot()).toEqual(before);

    const allowed = await userCookie(["tillverkning"]);
    expect((await post(allowed, "/planning/co-run/preview", body)).statusCode).toBe(200);
    expect((await post(allowed, "/planning/co-run", body)).statusCode).toBe(200);
    expect((await snapshot()).events).toBe(3);
    // Still the admin's to use.
    expect((await post(cookie, "/planning/co-run/preview", body)).statusCode).toBe(409);
  });

  it("the error codes: 404 resource and operation, 400 legoresurs and passed day, 409 changed and no capacity", async () => {
    const { r110, orders, cookie, day, target, body } = await plannedDay();
    const lego = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling AB", type: "subcontract", active: true }));
    const before = await snapshot();
    // The first Saturday after the target day: no capacity on 110.
    let saturday = target;
    while (new Date(`${saturday}T00:00:00Z`).getUTCDay() !== 6) saturday = addDays(saturday, 1);
    const cases: [object, number, string][] = [
      [{ ...body, workCenterId: crypto.randomUUID() }, 404, "work-center-not-found"],
      [{ ...body, workCenterId: lego.id }, 400, "run-plan-subcontract-resource"],
      [{ ...body, date: "2020-01-07" }, 400, "plan-date-in-past"],
      [{ ...body, operations: [body.operations[0], { moOperationId: crypto.randomUUID(), plannedStartDate: null }] }, 404, "operation-not-found"],
      [{ ...body, operations: [body.operations[0], { moOperationId: orders[0]!.opId, plannedStartDate: target }] }, 409, "co-run-changed"],
      [{ ...body, operations: [body.operations[0], { moOperationId: orders[0]!.opId, plannedStartDate: null }] }, 409, "co-run-changed"],
      [{ ...body, date: saturday }, 409, "plan-date-no-capacity"],
    ];
    for (const url of ROUTES) {
      for (const [payload, status, code] of cases) {
        const res = await post(cookie, url, payload);
        expect(res.statusCode, `${url} ${code} ${res.body}`).toBe(status);
        expect(res.json().code).toBe(code);
      }
    }
    expect(r110.code).toBe("110");
    expect(day <= target).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});
