import { createArticleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { localDateOf } from "../src/modules/timereport/repository/stamp-close.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Regel 6 at the route: a stop time (Sluttid) on Stämpla ut is a
// supervisor's correction on Pågående arbete — the shop floor's terminal
// profile is refused it, even though it may stamp out.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);

const TRUNCATE = sql`TRUNCATE absences, absence_types, mo_reports, mo_report_materials, attendance_sessions, stamp_sessions, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, bom_components, articles, payroll_periods, audit_log, user_settings, users CASCADE`;
// Only the groups this file creates — the migration's seeded groups (ALLA,
// VERKSTAD) belong to other test files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'STOP%'`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

// A released TO with one operation, an employee, and that employee stamped
// in on it two hours ago.
async function setup() {
  const user = await authRepo.create({
    email: `stop-${crypto.randomUUID()}@example.com`,
    passwordHash: "x",
    name: "Arbetsledare",
    role: "supervisor",
  });
  const parent = await articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: `P-${crypto.randomUUID()}`,
    name: "Produkt",
    type: "manufactured",
    active: true,
  }));
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
  const [operation] = await mfgService.listOperations(order.id);
  const employee = await timeReportService.createEmployee({ employeeNumber: "107", name: "Urban", active: true });
  const stamp = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: operation!.id }, user.id);
  const startedAt = new Date(Date.now() - 2 * 3_600_000);
  await db.execute(sql`UPDATE stamp_sessions SET started_at = ${startedAt.toISOString()}::timestamptz WHERE id = ${stamp.id}`);
  return { stamp, startedAt };
}

describe("POST /stamp-sessions/:id/stop with a stop time", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function session(role: "user" | "supervisor", permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `STOP${crypto.randomUUID().slice(0, 8)}`, name: "Stämpling", permissions })
      .returning();
    const email = `r-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "R", role, permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("refuses the shop floor, rejects a stop before the start and accepts a valid one for a supervisor", async () => {
    const { stamp, startedAt } = await setup();
    const url = `/api/v1/stamp-sessions/${stamp.id}/stop`;

    // The terminal profile: role user, no menus, only the terminal.
    const shopFloor = await session("user", ["terminal"]);
    const refused = await app.inject({
      method: "POST",
      url,
      headers: { cookie: shopFloor },
      payload: { stoppedAt: new Date(startedAt.getTime() + 3_600_000).toISOString() },
    });
    expect([refused.statusCode, refused.json().code]).toEqual([403, "stop-time-not-allowed"]);

    const supervisor = await session("supervisor", ["tillverkning"]);
    const early = await app.inject({
      method: "POST",
      url,
      headers: { cookie: supervisor },
      payload: { stoppedAt: new Date(startedAt.getTime() - 60_000).toISOString() },
    });
    expect([early.statusCode, early.json().code]).toEqual([400, "invalid-stop-time"]);

    const stoppedAt = new Date(startedAt.getTime() + 90 * 60_000);
    const ok = await app.inject({
      method: "POST",
      url,
      headers: { cookie: supervisor },
      payload: { stoppedAt: stoppedAt.toISOString() },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().timeReport.hours).toBe("1.50");
    expect(new Date(ok.json().session.stoppedAt).getTime()).toBe(stoppedAt.getTime());
  });

  it("regel 8: POST /attendance-sessions answers 409 with the forgotten attendance until forgottenStoppedAt is given", async () => {
    await setup(); // stamping in clocked the employee in (regel 5)
    const [attendance] = await timeReportService.listAttendanceSessions(true);
    const H = 3_600_000;
    const startedAt = new Date(Date.now() - 26 * H);
    await db.execute(
      sql`UPDATE attendance_sessions SET started_at = ${startedAt.toISOString()}::timestamptz WHERE id = ${attendance!.id}`
    );
    const terminal = await session("user", ["terminal"]);
    const url = "/api/v1/attendance-sessions";

    const refused = await app.inject({ method: "POST", url, headers: { cookie: terminal }, payload: { employeeId: attendance!.employeeId } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "attendance-open-from-earlier-day",
      attendanceSessionId: attendance!.id,
      startedAt: startedAt.toISOString(),
    });

    const bad = await app.inject({
      method: "POST",
      url,
      headers: { cookie: terminal },
      payload: { employeeId: attendance!.employeeId, forgottenStoppedAt: new Date(startedAt.getTime() - H).toISOString() },
    });
    expect([bad.statusCode, bad.json().code]).toEqual([400, "invalid-attendance-interval"]);

    const ok = await app.inject({
      method: "POST",
      url,
      headers: { cookie: terminal },
      payload: { employeeId: attendance!.employeeId, forgottenStoppedAt: new Date(startedAt.getTime() + H).toISOString() },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().id).not.toBe(attendance!.id);
  });
  it("marks absentToday for supervisors only (health data) and filters on employeeId", async () => {
    const { stamp } = await setup();
    const other = await timeReportService.createEmployee({ employeeNumber: "108", name: "Annan", active: true });
    const [operation] = await db.execute(sql`SELECT mo_operation_id FROM stamp_sessions WHERE id = ${stamp.id}`) as unknown as { mo_operation_id: string }[];
    await timeReportService.stampIn({ employeeId: other.id, moOperationId: operation!.mo_operation_id });
    const today = localDateOf(new Date());
    await db.execute(sql`INSERT INTO absence_types (code, name, paxml_code) VALUES ('SJK', 'Sjuk', '1')`);
    await db.execute(
      sql`INSERT INTO absences (employee_id, absence_type_id, date, minutes) SELECT ${stamp.employeeId}, id, ${today}::date, 480 FROM absence_types WHERE code = 'SJK'`
    );

    const supervisor = await session("supervisor", ["tillverkning"]);
    const res = await app.inject({ method: "GET", url: "/api/v1/stamp-sessions?open=true", headers: { cookie: supervisor } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { employeeId: string; absentToday?: boolean }[];
    expect(rows.find((r) => r.employeeId === stamp.employeeId)!.absentToday).toBe(true);
    expect(rows.find((r) => r.employeeId === other.id)!.absentToday).toBe(false);

    const terminal = await session("user", ["terminal"]);
    const plain = await app.inject({ method: "GET", url: "/api/v1/stamp-sessions?open=true", headers: { cookie: terminal } });
    expect(plain.statusCode).toBe(200);
    expect(plain.json().length).toBe(2);
    for (const row of plain.json()) expect(row).not.toHaveProperty("absentToday");

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/stamp-sessions?open=true&employeeId=${other.id}`,
      headers: { cookie: supervisor },
    });
    expect((filtered.json() as { employeeId: string }[]).map((r) => r.employeeId)).toEqual([other.id]);

    const bad = await app.inject({ method: "GET", url: "/api/v1/stamp-sessions?employeeId=abc", headers: { cookie: supervisor } });
    expect(bad.statusCode).toBe(400);
  });
});

// Ställ och produktion (#14 etapp 3) at the routes: the kind on the
// terminal's stamps (Ställ klart = stamp out 0/0, stamp in as produktion),
// on manual time reports and their correction, in the list and the CSV,
// and the setting the terminal reads. Behörigheterna are unchanged.
describe("ställ och produktion — rutterna (#14 etapp 3)", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
    await db.execute(sql`DELETE FROM system_settings WHERE key = 'time_kind_split'`);
  });

  async function login(role: "user" | "supervisor" | "admin", permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `STOP${crypto.randomUUID().slice(0, 8)}`, name: "Ställ", permissions })
      .returning();
    const email = `k-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "K", role, permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  async function released() {
    const user = await authRepo.create({ email: `k-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "supervisor" });
    const parent = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Produkt", type: "manufactured", active: true }));
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    const [operation] = await mfgService.listOperations(order.id);
    const employee = await timeReportService.createEmployee({ employeeNumber: "207", name: "Signe", active: true });
    return { order, operation: operation!, employee };
  }

  it("stamps in as Ställ, Ställ klart with two calls, and refuses an unknown kind", async () => {
    const { operation, employee } = await released();
    const terminal = await login("user", ["terminal"]);
    const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie: terminal }, payload });

    const setup = await post("/stamp-sessions", { employeeId: employee.id, moOperationId: operation.id, kind: "setup" });
    expect([setup.statusCode, setup.json().kind]).toEqual([201, "setup"]);
    const listed = await app.inject({ method: "GET", url: "/api/v1/stamp-sessions?open=true", headers: { cookie: terminal } });
    expect(listed.json().map((s: { kind: string | null }) => s.kind)).toEqual(["setup"]);

    const out = await post(`/stamp-sessions/${setup.json().id}/stop`, { quantityOk: 0, quantityScrapped: 0 });
    expect([out.statusCode, out.json().timeReport.kind]).toEqual([200, "setup"]);
    const run = await post("/stamp-sessions", { employeeId: employee.id, moOperationId: operation.id, kind: "run" });
    expect([run.statusCode, run.json().kind]).toEqual([201, "run"]);

    const bad = await post("/stamp-sessions", { employeeId: employee.id, moOperationId: operation.id, kind: "pause" });
    expect(bad.statusCode).toBe(400);
  });

  it("takes and corrects a manual report's Typ, and lists and exports it", async () => {
    const { order, operation, employee } = await released();
    const office = await login("supervisor", ["tillverkning"]);
    const call = (method: "POST" | "PATCH" | "GET", url: string, payload?: object) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { cookie: office }, ...(payload ? { payload } : {}) });

    const created = await call("POST", "/time-reports", { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-07", hours: 1.25, kind: "run" });
    expect([created.statusCode, created.json().kind]).toEqual([201, "run"]);
    const plain = await call("POST", "/time-reports", { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-08", hours: 0.5 });
    expect(plain.json().kind).toBeNull();
    const setup = await call("POST", "/time-reports", { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-06", hours: 0.75, kind: "setup" });
    expect((await call("POST", "/time-reports", { employeeId: employee.id, moOperationId: operation.id, date: "2026-07-06", hours: 1, kind: "x" })).statusCode).toBe(400);

    const cleared = await call("PATCH", `/time-reports/${setup.json().id}`, { kind: null });
    expect([cleared.statusCode, cleared.json().kind]).toEqual([200, null]);
    const back = await call("PATCH", `/time-reports/${setup.json().id}`, { kind: "setup" });
    expect(back.json().kind).toBe("setup");

    const list = await call("GET", "/time-reports");
    expect(new Map(list.json().rows.map((r: { date: string; kind: string | null }) => [r.date, r.kind]))).toEqual(
      new Map([["2026-07-08", null], ["2026-07-07", "run"], ["2026-07-06", "setup"]])
    );
    const onCard = await call("GET", `/manufacturing-orders/${order.id}/time-reports`);
    expect(onCard.json().map((r: { kind: string | null }) => r.kind).sort()).toEqual(["run", "setup", null].sort());

    const csv = await call("GET", "/time-reports/csv");
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Anställd;Tillverkningsorder;Operation;Datum;Timmar;Typ;Källa;Anteckning");
    // Newest date first: ej uppdelad, Produktion, Ställ.
    expect(lines.slice(1).map((l) => l.split(";").slice(4, 7))).toEqual([
      ["0,5", "", "Manuell"],
      ["1,25", "Produktion", "Manuell"],
      ["0,75", "Ställ", "Manuell"],
    ]);
  });

  it("serves Dela tid i ställ och produktion to the terminal, off by default and saved by an admin", async () => {
    await db.execute(sql`DELETE FROM system_settings WHERE key = 'time_kind_split'`);
    const terminal = await login("user", ["terminal"]);
    const admin = await login("admin", []);
    const read = async () =>
      (await app.inject({ method: "GET", url: "/api/v1/settings/terminal", headers: { cookie: terminal } })).json();

    expect((await read()).timeKindSplit).toBe(false);
    const saved = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: admin }, payload: { timeKindSplit: true } });
    expect([saved.statusCode, saved.json().timeKindSplit]).toEqual([200, true]);
    expect((await read()).timeKindSplit).toBe(true);
    // Writing stays admin-only.
    const shop = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: terminal }, payload: { timeKindSplit: false } });
    expect(shop.statusCode).toBe(403);
  });
});

// Alternativa resurser (#15), granskningen av etapp 1: the stamp and the
// time report keep their resource. Over HTTP: the terminal's workCenterId on
// POST /stamp-sessions (409 when the operation was switched since the list
// was loaded), the resource on the stamp, the stop and a manual report, and
// a PATCH that can never set one.
describe("tidrapportens resurs — rutterna (#15)", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function login(role: "user" | "supervisor" | "admin", permissions: string[]) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `STOP${crypto.randomUUID().slice(0, 8)}`, name: "Resurs", permissions })
      .returning();
    const email = `w-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "W", role, permissionGroupId: group!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }

  it("refuses a stamp on the station the list showed after a switch (409), keeps the resource on stamp, stop and manual report, and never takes one from a PATCH", async () => {
    const user = await authRepo.create({ email: `w-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "supervisor" });
    const parent = await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Produkt", type: "manufactured", active: true }));
    const r100 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    const r200 = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "200", name: "Svets 2", active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: r100.id, setupTime: 10, runTimePerUnit: 2 });
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    const [operation] = await mfgService.listOperations(order.id);
    const employee = await timeReportService.createEmployee({ employeeNumber: "307", name: "Vera", active: true });
    const terminal = await login("user", ["terminal"]);
    const office = await login("supervisor", ["tillverkning"]);
    const call = (cookie: string, method: "POST" | "PATCH", url: string, payload: object) =>
      app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });

    // The listed station matches: the stamp records it, and so does the stop.
    const stamp = await call(terminal, "POST", "/stamp-sessions", { employeeId: employee.id, moOperationId: operation!.id, workCenterId: r100.id });
    expect([stamp.statusCode, stamp.json().workCenterId]).toEqual([201, r100.id]);
    const out = await call(terminal, "POST", `/stamp-sessions/${stamp.json().id}/stop`, { quantityOk: 0, quantityScrapped: 0 });
    expect([out.statusCode, out.json().timeReport.workCenterId]).toEqual([200, r100.id]);

    // The planner moves the operation; the terminal's older list still says 100.
    await mfgService.updateOperation(order.id, operation!.id, { workCenterId: r200.id }, user.id);
    const stale = await call(terminal, "POST", "/stamp-sessions", { employeeId: employee.id, moOperationId: operation!.id, workCenterId: r100.id });
    expect([stale.statusCode, stale.json().code]).toEqual([409, "stamp-work-center-changed"]);
    const malformed = await call(terminal, "POST", "/stamp-sessions", { employeeId: employee.id, moOperationId: operation!.id, workCenterId: "100" });
    expect(malformed.statusCode).toBe(400);

    // A manual report takes the operation's resource now; a PATCH cannot set one.
    const manual = await call(office, "POST", "/time-reports", { employeeId: employee.id, moOperationId: operation!.id, date: "2026-07-07", hours: 1, workCenterId: r100.id });
    expect([manual.statusCode, manual.json().workCenterId]).toEqual([201, r200.id]);
    const patched = await call(office, "PATCH", `/time-reports/${out.json().timeReport.id}`, { hours: 2, workCenterId: r200.id });
    expect([patched.statusCode, patched.json().hours, patched.json().workCenterId]).toEqual([200, "2.00", r100.id]);
    // The list shows the resource the time was worked on.
    const onCard = await app.inject({ method: "GET", url: `/api/v1/manufacturing-orders/${order.id}/time-reports`, headers: { cookie: office } });
    expect(onCard.json().map((r: { workCenterName: string }) => r.workCenterName).sort()).toEqual(["Svets", "Svets 2"]);
  });
});
