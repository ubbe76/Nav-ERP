import { createArticleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { attendanceSessions, db, manufacturingOrders, timeReports } from "@navet/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Tidgranskningen at the routes: what used to be a 500 (a taken employee
// number, unknown references in a manual time report, dates that do not
// exist), the manual time report on an order that takes no reports, Ta bort
// on an open attendance, a start time in the future, and the stamp and
// attendance history in the list pattern.

const articleService = createArticleService(createArticleRepository(db));
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  unwiredSalesOrderLinks
);

const TRUNCATE = sql`TRUNCATE absences, absence_types, mo_reports, mo_report_materials, attendance_sessions, stamp_sessions,
  time_reports, overtime_dispositions, employees, mo_material_consumptions, mo_operations, manufacturing_orders,
  routing_operations, work_centers, production_groups, bom_components, articles, payroll_periods, audit_log, user_settings,
  users CASCADE`;
const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;
let admin: string;

const call = (method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { cookie: admin },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  app = buildApp();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } });
  admin = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
});

async function employee(employeeNumber = "101") {
  const res = await call("POST", "/employees", { employeeNumber, name: "Anna Andersson" });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

// A TO is released in its own create transaction; one operation.
async function operation() {
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Produkt", type: "manufactured", active: true })
  );
  const workCenter = await mfgService.createWorkCenter(
    parsed(createWorkCenterSchema, { code: String(100 + Math.floor(Math.random() * 800)), name: "Svets", active: true })
  );
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, null);
  const [op] = await mfgService.listOperations(order.id);
  return { orderId: order.id, operationId: op!.id };
}

describe("POST /employees", () => {
  it("answers a taken employee number with 409 duplicate-employee-number (was 500)", async () => {
    await employee("101");
    const res = await call("POST", "/employees", { employeeNumber: "101", name: "Bertil" });
    expect([res.statusCode, res.json().code]).toEqual([409, "duplicate-employee-number"]);
  });
});

describe("POST /time-reports", () => {
  it("refuses unknown references with 400 and an order that takes no reports with 409", async () => {
    const employeeId = await employee();
    const { orderId, operationId } = await operation();
    const report = (body: Record<string, unknown>) =>
      call("POST", "/time-reports", { employeeId, moOperationId: operationId, date: "2026-05-04", hours: 1, ...body });

    const noEmployee = await report({ employeeId: crypto.randomUUID() });
    expect([noEmployee.statusCode, noEmployee.json().code]).toEqual([400, "employee-not-found"]);
    const noOperation = await report({ moOperationId: crypto.randomUUID() });
    expect([noOperation.statusCode, noOperation.json().code]).toEqual([400, "mo-operation-not-found"]);

    // Released, and done (efterrapportering på Klar), take reports.
    expect((await report({})).statusCode).toBe(201);
    await db.update(manufacturingOrders).set({ status: "done" }).where(eq(manufacturingOrders.id, orderId));
    expect((await report({})).statusCode).toBe(201);

    for (const status of ["closed", "cancelled", "planned"] as const) {
      await db.update(manufacturingOrders).set({ status }).where(eq(manufacturingOrders.id, orderId));
      const refused = await report({});
      expect([status, refused.statusCode, refused.json().code]).toEqual([status, 409, "invalid-status-transition"]);
    }
    expect(await db.select({ id: timeReports.id }).from(timeReports)).toHaveLength(2);
  });
});

describe("attendance corrections", () => {
  it("refuses Ta bort on an open attendance, and allows it once a stop time is set", async () => {
    const employeeId = await employee();
    const opened = await call("POST", "/attendance-sessions", { employeeId });
    expect(opened.statusCode).toBe(201);
    const id = opened.json().id as string;

    const refused = await call("DELETE", `/attendance-sessions/${id}`);
    expect([refused.statusCode, refused.json().code]).toEqual([409, "attendance-session-open"]);
    expect(await db.select().from(attendanceSessions).where(eq(attendanceSessions.id, id))).toHaveLength(1);

    const startedAt = new Date(opened.json().startedAt as string);
    expect((await call("PATCH", `/attendance-sessions/${id}`, { stoppedAt: new Date(startedAt.getTime() + 1000).toISOString() })).statusCode).toBe(200);
    expect((await call("DELETE", `/attendance-sessions/${id}`)).statusCode).toBe(204);
  });

  it("refuses a start time in the future — Gå hem would otherwise stop the attendance before it started", async () => {
    const employeeId = await employee();
    const opened = await call("POST", "/attendance-sessions", { employeeId });
    const id = opened.json().id as string;

    const tomorrow = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const refused = await call("PATCH", `/attendance-sessions/${id}`, { startedAt: tomorrow });
    expect([refused.statusCode, refused.json().code]).toEqual([400, "attendance-start-in-future"]);

    // Within the minute of slack, and in the past, as before.
    const earlier = new Date(Date.now() - 3_600_000).toISOString();
    expect((await call("PATCH", `/attendance-sessions/${id}`, { startedAt: earlier })).statusCode).toBe(200);
  });
});

describe("dates that do not exist", () => {
  it("answer 400 validation-failed instead of reaching Postgres as a 500", async () => {
    const employeeId = await employee();
    for (const url of [
      `/employees/${employeeId}/absences?from=2026-02-31&to=2026-03-31`,
      `/employees/${employeeId}/absences?from=2026-02-01&to=2026-13-01`,
      `/employees/${employeeId}/schedule-calendar?from=2026-02-30&to=2026-03-01`,
      `/employees/${employeeId}/schedule-calendar?from=2026-13-01&to=2026-13-02`,
    ]) {
      const res = await call("GET", url);
      expect([url, res.statusCode, res.json().code]).toEqual([url, 400, "validation-failed"]);
    }
    const put = await call("PUT", `/employees/${employeeId}/overtime-disposition/2026-13-01`, { disposition: "comp" });
    expect([put.statusCode, put.json().code]).toEqual([400, "validation-failed"]);
    const del = await call("DELETE", `/employees/${employeeId}/overtime-disposition/2026-02-30`);
    expect([del.statusCode, del.json().code]).toEqual([400, "validation-failed"]);

    // Real dates still work.
    expect((await call("GET", `/employees/${employeeId}/absences?from=2026-02-01&to=2026-02-28`)).statusCode).toBe(200);
  });
});

describe("the stamp and attendance history", () => {
  it("is paged in the list pattern; ?open=true stays the terminal's array", async () => {
    const first = await employee("101");
    const second = await employee("202");
    const { operationId } = await operation();
    for (const employeeId of [first, second]) {
      expect((await call("POST", "/stamp-sessions", { employeeId, moOperationId: operationId })).statusCode).toBe(201);
    }

    const open = await call("GET", "/stamp-sessions?open=true");
    expect(Array.isArray(open.json())).toBe(true);
    expect(open.json()).toHaveLength(2);

    const page = await call("GET", "/stamp-sessions?limit=1");
    expect(page.json().total).toBe(2);
    expect(page.json().rows).toHaveLength(1);
    const next = await call("GET", "/stamp-sessions?limit=1&offset=1");
    expect(next.json().rows[0].id).not.toBe(page.json().rows[0].id);
    expect((await call("GET", "/stamp-sessions?search=202")).json()).toMatchObject({ total: 1, rows: [{ employeeId: second }] });
    expect((await call("GET", `/stamp-sessions?employeeId=${first}`)).json()).toMatchObject({ total: 1, rows: [{ employeeId: first }] });

    // The stamp-ins opened the attendances.
    const attendance = await call("GET", "/attendance-sessions?limit=1");
    expect(attendance.json().total).toBe(2);
    expect(attendance.json().rows).toHaveLength(1);
    expect((await call("GET", "/attendance-sessions?search=Anna&employeeId=" + second)).json().total).toBe(1);
    expect(Array.isArray((await call("GET", "/attendance-sessions?open=true")).json())).toBe(true);
  });
});
