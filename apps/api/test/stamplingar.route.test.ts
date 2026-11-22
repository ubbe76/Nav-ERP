import { createArticleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Stämplingar (Personal & lön, 2026-11-22) at the routes: the day view, a
// work stamp registered, corrected and removed, a forgotten attendance and
// Ändra frånvaro — Personal & lön AND admin/supervisor, the refusals' codes.

const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  unwiredSalesOrderLinks
);
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

const TRUNCATE = sql`TRUNCATE absences, absence_types, mo_reports, mo_report_materials, mo_operation_scrap, attendance_sessions,
  stamp_sessions, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations,
  work_centers, production_groups, bom_components, articles, payroll_periods, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'STP%'`;
const PASSWORD = "correct-horse-battery";

let app: FastifyInstance;
let admin: string;

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

const call = (method: string, url: string, payload?: unknown, cookie = admin) =>
  app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  app = buildApp();
  await authService.createUser({ email: "admin@example.com", password: PASSWORD, name: "Admin", role: "admin" });
  admin = await login("admin@example.com");
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function employee() {
  const res = await call("POST", "/employees", { employeeNumber: "101", name: "Anna Exempel" });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function operation() {
  const article = await testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Produkt", type: "manufactured", active: true })
  );
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "120", name: "Svets", active: true }));
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, null);
  const [op] = await mfgService.listOperations(order.id);
  return op!.id;
}

const START = "2026-11-03T06:00:00.000Z";
const STOP = "2026-11-03T10:30:00.000Z";

describe("Stämplingar at the routes", () => {
  it("registers, shows, corrects and removes a work stamp", async () => {
    const employeeId = await employee();
    const operationId = await operation();

    const created = await call("POST", `/employees/${employeeId}/stamp-sessions`, {
      moOperationId: operationId,
      startedAt: START,
      stoppedAt: STOP,
      pauseMinutes: "30",
      quantityOk: "2",
    });
    expect(created.statusCode).toBe(201);
    const stampId = created.json().id as string;

    const day = await call("GET", `/employees/${employeeId}/stamp-day?date=2026-11-03`);
    expect(day.statusCode).toBe(200);
    expect(day.json()).toMatchObject({
      employee: { id: employeeId, name: "Anna Exempel" },
      periodLocked: false,
      stamps: [{ id: stampId, hours: 4, pauseMinutes: 30, report: { quantityOk: 2, source: "stamp_correction" } }],
    });

    const corrected = await call("PATCH", `/stamp-sessions/${stampId}`, {
      moOperationId: operationId,
      startedAt: START,
      stoppedAt: STOP,
      quantityOk: 3,
    });
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json()).toEqual({ id: stampId, reportRedone: true });

    const bad = await call("PATCH", `/stamp-sessions/${stampId}`, { moOperationId: operationId, startedAt: STOP, stoppedAt: START });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("invalid-work-stamp-interval");

    expect((await call("DELETE", `/stamp-sessions/${stampId}`)).statusCode).toBe(204);
    expect((await call("DELETE", `/stamp-sessions/${stampId}`)).statusCode).toBe(404);
    expect((await call("GET", `/employees/${crypto.randomUUID()}/stamp-day?date=2026-11-03`)).statusCode).toBe(404);
    expect((await call("GET", `/employees/${employeeId}/stamp-day?date=2026-02-30`)).statusCode).toBe(400);
  });

  it("adds a forgotten attendance and refuses an overlapping one", async () => {
    const employeeId = await employee();
    const first = await call("POST", `/employees/${employeeId}/attendance-sessions`, { startedAt: START, stoppedAt: STOP });
    expect(first.statusCode).toBe(201);
    const overlap = await call("POST", `/employees/${employeeId}/attendance-sessions`, {
      startedAt: "2026-11-03T10:00:00.000Z",
      stoppedAt: "2026-11-03T12:00:00.000Z",
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().code).toBe("attendance-overlap");
  });

  it("changes an absence: code, day and hours; a taken day/code is 409", async () => {
    const employeeId = await employee();
    const seeded = await call("POST", "/absence-types/generate-standard");
    expect(seeded.statusCode).toBeLessThan(300);
    const types = (await call("GET", "/absence-types")).json() as { id: string; code: string }[];
    const [a, b] = types;
    const one = await call("POST", `/employees/${employeeId}/absences`, { absenceTypeId: a!.id, date: "2026-11-03", minutes: 480 });
    const two = await call("POST", `/employees/${employeeId}/absences`, { absenceTypeId: b!.id, date: "2026-11-04", minutes: 480 });
    expect(one.statusCode).toBe(201);

    const changed = await call("PATCH", `/absences/${one.json().id}`, { minutes: 240, note: "Halvdag" });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ minutes: 240, note: "Halvdag", date: "2026-11-03" });

    const taken = await call("PATCH", `/absences/${two.json().id}`, { absenceTypeId: a!.id, date: "2026-11-03" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().code).toBe("duplicate-absence");
    expect((await call("PATCH", `/absences/${crypto.randomUUID()}`, { minutes: 60 })).statusCode).toBe(404);
  });

  it("is Personal & lön for admin and supervisor only", async () => {
    const employeeId = await employee();
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `STP${crypto.randomUUID().slice(0, 6)}`, name: "Personal", permissions: ["personal"] })
      .returning();
    const email = `user-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
    const user = await login(email);
    expect((await call("GET", `/employees/${employeeId}/stamp-day?date=2026-11-03`, undefined, user)).statusCode).toBe(403);
    expect(
      (await call("POST", `/employees/${employeeId}/attendance-sessions`, { startedAt: START, stoppedAt: STOP }, user)).statusCode
    ).toBe(403);
  });
});
