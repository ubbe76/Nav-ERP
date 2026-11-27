import { createArticleSchema, createManufacturingOrderSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { db, manufacturingOrders, moOperationPlanDays, moOperations, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import type { ReplanStructureResult } from "../src/modules/planning/service/structure-replan.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// The two routes of Planera om strukturen through the real app (spec
// 2026-11-26, etapp 5): the contract (zod 400), the access rule — the
// module's write rule `tillverkning` on BOTH, the preview is not
// readOnlySafe — and that the preview writes nothing. What the routes do is
// tested in structure-replan.integration.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const authService = createAuthService(authRepo, "unused", createAuditRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE mo_operation_plan_days, stamp_sessions, mo_reports, mo_report_materials, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, holidays, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'RPS%'`;

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

const today = stockholmToday();
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
    .values({ code: `RPS${crypto.randomUUID().slice(0, 6)}`, name: "Planera om", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const post = (cookie: string | null, url: string, payload?: object) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) });

// Everything the routes could write.
async function snapshot() {
  const operations = await db
    .select({ id: moOperations.id, start: moOperations.plannedStartDate, end: moOperations.plannedEndDate, locked: moOperations.planLocked, plannedAt: moOperations.plannedAt })
    .from(moOperations)
    .orderBy(asc(moOperations.id));
  const days = await db.select().from(moOperationPlanDays).orderBy(asc(moOperationPlanDays.moOperationId), asc(moOperationPlanDays.planDate));
  const orders = await db.select({ id: manufacturingOrders.id, dueDate: manufacturingOrders.dueDate }).from(manufacturingOrders).orderBy(asc(manufacturingOrders.id));
  const [{ n }] = [...(await db.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE action IN ('structure_replanned', 'updated')`))] as [{ n: number }];
  return { operations, days, orders, events: n };
}

// P is made of H; one TO each, planned by Planera.
async function world() {
  const user = await authRepo.create({ email: `rps-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Planerare", role: "admin" });
  const kap = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "101", name: "Kap", hoursPerDay: 8, active: true }));
  const x = crypto.randomUUID().slice(0, 8);
  const article = (prefix: string, name: string) =>
    articleService.createArticle(parsed(createArticleSchema, { articleNumber: `${prefix}-${x}`, name, type: "manufactured", active: true }));
  const halv = await article("H", "Halvfabrikat");
  const product = await article("P", "Produkt");
  await mfgService.createRoutingOperation(halv.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 0, runTimePerUnit: 60 });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: kap.id, setupTime: 0, runTimePerUnit: 60 });
  await articleService.addBomComponent(product.id, { componentArticleId: halv.id, quantity: 1 });
  const order = (articleId: string, dueDate: string) =>
    mfgService.createManufacturingOrder(parsed(createManufacturingOrderSchema, { articleId, quantity: 2, dueDate }), user.id);
  const h = await order(halv.id, addDays(today, 30));
  const p = await order(product.id, addDays(today, 40));
  const cookie = await adminCookie();
  expect((await post(cookie, "/planning/plan")).statusCode).toBe(200);
  const previewUrl = `/manufacturing-orders/${p.id}/replan-structure/preview`;
  const writeUrl = `/manufacturing-orders/${p.id}/replan-structure`;
  const body = { dueDate: null, moveComponentDueDates: false };
  const shownRes = await post(cookie, previewUrl, body);
  expect(shownRes.statusCode, shownRes.body).toBe(200);
  const shown: ReplanStructureResult = shownRes.json();
  const writeBody = { ...body, includeOrderIds: [h.id], expected: shown.expected };
  return { h, p, cookie, previewUrl, writeUrl, body, shown, writeBody };
}

describe("POST /manufacturing-orders/:id/replan-structure and its preview", () => {
  it("the preview answers the tree and writes nothing — the plan, planned_at, the locks, the färdigdatum and the log", async () => {
    const w = await world();
    const before = await snapshot();
    expect(w.shown.orders.map((o) => [o.orderNumber, o.level, o.included])).toEqual([
      [w.p.orderNumber, 0, true],
      [w.h.orderNumber, 1, true],
    ]);
    expect(Object.keys(w.shown).sort()).toEqual(["blocked", "expected", "notes", "orders", "overloadedDays", "today", "top", "warnings"]);
    // No prices anywhere in the answer.
    expect(JSON.stringify(w.shown)).not.toMatch(/price|cost|rate|amount/i);
    // With every choice the dialog has: still nothing written.
    for (const body of [
      w.body,
      { dueDate: addDays(today, 70), moveComponentDueDates: true },
      { dueDate: addDays(today, 70), moveComponentDueDates: true, includeOrderIds: [] },
      { dueDate: null, moveComponentDueDates: true, includeOrderIds: [w.h.id] },
    ]) {
      expect((await post(w.cookie, w.previewUrl, body)).statusCode).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("400 for a body that is not the contract — on both routes, nothing written", async () => {
    const w = await world();
    const before = await snapshot();
    const expected = w.shown.expected;
    const previewBodies: object[] = [
      {},
      { dueDate: null },
      { moveComponentDueDates: true },
      { dueDate: "2030-13-01", moveComponentDueDates: true },
      { dueDate: "i morgon", moveComponentDueDates: true },
      { dueDate: null, moveComponentDueDates: "ja" },
      { dueDate: null, moveComponentDueDates: false, includeOrderIds: ["TO-1001"] },
      { dueDate: null, moveComponentDueDates: false, includeOrderIds: [w.h.id, w.h.id] },
      { dueDate: null, moveComponentDueDates: false, includeOrderIds: Array.from({ length: 201 }, () => crypto.randomUUID()) },
    ];
    for (const body of previewBodies) {
      expect((await post(w.cookie, w.previewUrl, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await post(w.cookie, w.writeUrl, { ...body, expected })).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const writeBodies: object[] = [
      // The write needs the choice and what the preview showed.
      w.body,
      { ...w.body, includeOrderIds: [w.h.id] },
      { ...w.body, expected },
      { ...w.body, includeOrderIds: [w.h.id], expected: [] },
      { ...w.body, includeOrderIds: [w.h.id], expected: [...expected, expected[0]] },
      { ...w.body, includeOrderIds: [w.h.id], expected: [{ ...expected[0], plannedStartDate: "2030-02-30" }] },
      { ...w.body, includeOrderIds: [w.h.id], expected: [{ manufacturingOrderId: w.p.id }] },
    ];
    for (const body of writeBodies) {
      expect((await post(w.cookie, w.writeUrl, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    // A malformed id in the path is refused by the id guard.
    expect((await post(w.cookie, "/manufacturing-orders/TO-1001/replan-structure/preview", w.body)).statusCode).toBe(400);
    expect((await post(w.cookie, "/manufacturing-orders/TO-1001/replan-structure", w.writeBody)).statusCode).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("both routes need the write rule tillverkning, and a read-only account is refused on both", async () => {
    const w = await world();
    const before = await snapshot();
    for (const permissions of [["forsaljning"], ["inkop", "lager"], ["terminal", "tillverkningsorder_las"]]) {
      const cookie = await userCookie(permissions);
      expect((await post(cookie, w.previewUrl, w.body)).statusCode, permissions.join()).toBe(403);
      expect((await post(cookie, w.writeUrl, w.writeBody)).statusCode, permissions.join()).toBe(403);
    }
    const readOnly = await userCookie(["tillverkning"], true);
    for (const [url, body] of [[w.previewUrl, w.body], [w.writeUrl, w.writeBody]] as const) {
      const res = await post(readOnly, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toMatchObject({ code: "read-only-account" });
      expect((await post(null, url, body)).statusCode).toBe(401);
    }
    expect(await snapshot()).toEqual(before);

    const planner = await userCookie(["tillverkning"]);
    expect((await post(planner, w.previewUrl, w.body)).statusCode).toBe(200);
    const res = await post(planner, w.writeUrl, w.writeBody);
    expect(res.statusCode, res.body).toBe(200);
    const after = await snapshot();
    expect(after.operations.every((op) => op.locked)).toBe(true);
  });
});
