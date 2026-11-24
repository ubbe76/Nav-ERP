import { createArticleSchema, createWorkCenterSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, payrollPeriods, permissionGroups } from "@navet/db";
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

// Rapportera (Tillverkning → Rapportera, 2026-11-24): POST /operation-reports
// writes a manual time report and the operation's quantities in ONE
// transaction (the Stämplingar path, source manual_report) — Ångra
// rapportering on the TO card takes both back; the refusals and who may.

const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  unwiredSalesOrderLinks
);
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

const TRUNCATE = sql`TRUNCATE mo_reports, mo_report_materials, mo_operation_scrap, stamp_sessions, time_reports, employees,
  mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups,
  bom_components, articles, suppliers, payroll_periods, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'RAP%'`;
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

// An order of 5 with two operations (10 Svets, 20 Montering).
async function order() {
  const article = await testArticleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Produkt", type: "manufactured", active: true })
  );
  const weld = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "120", name: "Svets", active: true }));
  const assembly = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "130", name: "Montering", active: true }));
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: weld.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: assembly.id, setupTime: 5, runTimePerUnit: 1 });
  const created = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, null);
  const [first, second] = await mfgService.listOperations(created.id);
  return { orderId: created.id, first: first!, second: second!, weldId: weld.id };
}

describe("Rapportera — POST /operation-reports", () => {
  it("writes the time report and the quantities together, and Ångra takes both back", async () => {
    const employeeId = await employee();
    const { orderId, first, weldId } = await order();

    const res = await call("POST", "/operation-reports", {
      moOperationId: first.id,
      employeeId,
      date: "2026-11-03",
      hours: "1.5",
      kind: "run",
      note: "Lapp 12",
      quantityOk: "2",
      quantityScrapped: "0",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { reportId: string; timeReportId: string; received: number; orderCompleted: boolean };
    expect(body).toMatchObject({ received: 0, orderCompleted: false });

    const timeReports = (await call("GET", `/manufacturing-orders/${orderId}/time-reports`)).json() as Record<string, unknown>[];
    expect(timeReports).toHaveLength(1);
    expect(timeReports[0]).toMatchObject({ id: body.timeReportId, employeeId, date: "2026-11-03", kind: "run", note: "Lapp 12" });
    expect(Number(timeReports[0]!.hours)).toBe(1.5);
    // The operation's resource, read under the report's lock.
    const [stored] = await db.execute<{ work_center_id: string }>(sql`select work_center_id from time_reports where id = ${body.timeReportId}`);
    expect(stored!.work_center_id).toBe(weldId);
    // A manual time report: no stamp points at it.
    const [stamps] = await db.execute<{ n: number }>(sql`select count(*)::int as n from stamp_sessions`);
    expect(stamps!.n).toBe(0);

    const reports = (await call("GET", `/manufacturing-orders/${orderId}/reports`)).json() as Record<string, unknown>[];
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: body.reportId, source: "manual_report", kind: "operation", employeeName: "Anna Exempel" });
    expect(Number(reports[0]!.quantityOk)).toBe(2);
    // The report's time is the manual time report's — Ångra shows and removes it.
    expect(Number(reports[0]!.hours)).toBe(1.5);
    const [op] = (await mfgService.listOperations(orderId)).filter((o) => o.id === first.id);
    expect(Number(op!.quantityCompleted)).toBe(2);
    expect(op!.status).toBe("pending");

    const undone = await call("POST", `/manufacturing-orders/${orderId}/reports/${body.reportId}/undo`);
    expect(undone.statusCode).toBe(200);
    expect((await call("GET", `/manufacturing-orders/${orderId}/time-reports`)).json()).toEqual([]);
    const [after] = (await mfgService.listOperations(orderId)).filter((o) => o.id === first.id);
    expect(Number(after!.quantityCompleted)).toBe(0);
  });

  it("reports time only (0/0) as a report row that can be undone", async () => {
    const employeeId = await employee();
    const { orderId, first } = await order();
    const res = await call("POST", "/operation-reports", { moOperationId: first.id, employeeId, date: "2026-11-03", hours: 0.25 });
    expect(res.statusCode).toBe(201);
    const reports = (await call("GET", `/manufacturing-orders/${orderId}/reports`)).json() as Record<string, unknown>[];
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ source: "manual_report" });
    expect(Number(reports[0]!.quantityOk)).toBe(0);
    expect(Number(reports[0]!.hours)).toBe(0.25);
    const undone = await call("POST", `/manufacturing-orders/${orderId}/reports/${res.json().reportId}/undo`);
    expect(undone.statusCode).toBe(200);
    expect((await call("GET", `/manufacturing-orders/${orderId}/time-reports`)).json()).toEqual([]);
  });

  it("Operationen är klar marks the operation done with its total time", async () => {
    const employeeId = await employee();
    const { orderId, first } = await order();
    await call("POST", "/operation-reports", { moOperationId: first.id, employeeId, date: "2026-11-03", hours: 1, quantityOk: 2 });
    const res = await call("POST", "/operation-reports", {
      moOperationId: first.id,
      employeeId,
      date: "2026-11-04",
      hours: 2.5,
      quantityOk: 2,
      markOperationDone: true,
    });
    expect(res.statusCode).toBe(201);
    const [op] = (await mfgService.listOperations(orderId)).filter((o) => o.id === first.id);
    expect(op!.status).toBe("done");
    expect(Number(op!.quantityCompleted)).toBe(4);
    expect(Number(op!.actualTime)).toBe(3.5);
  });

  it("the last operation's OK is received, and the whole order completes", async () => {
    const employeeId = await employee();
    const { orderId, first, second } = await order();
    await call("POST", "/operation-reports", { moOperationId: first.id, employeeId, date: "2026-11-03", hours: 1, quantityOk: 5 });
    const res = await call("POST", "/operation-reports", { moOperationId: second.id, employeeId, date: "2026-11-03", hours: 1, quantityOk: 5 });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ received: 5, orderCompleted: true });
    expect((await call("GET", `/manufacturing-orders/${orderId}`)).json().status).toBe("done");
  });

  it("refuses what a manual time report and Lägg till arbete refuse", async () => {
    const employeeId = await employee();
    const { orderId, first } = await order();
    const base = { moOperationId: first.id, employeeId, date: "2026-11-03", hours: 1 };

    // A bad body: unknown employee or operation, no time, scrap without a reason.
    const unknownEmployee = await call("POST", "/operation-reports", { ...base, employeeId: crypto.randomUUID() });
    expect(unknownEmployee.statusCode).toBe(400);
    const unknownOperation = await call("POST", "/operation-reports", { ...base, moOperationId: crypto.randomUUID() });
    expect(unknownOperation.statusCode).toBe(400);
    expect((await call("POST", "/operation-reports", { ...base, hours: 0 })).statusCode).toBe(400);
    expect((await call("POST", "/operation-reports", { ...base, hours: "" })).statusCode).toBe(400);
    expect((await call("POST", "/operation-reports", { ...base, quantityScrapped: 1 })).statusCode).toBe(400);

    // A locked payroll period.
    await db.insert(payrollPeriods).values({ year: 2026, month: 11, status: "locked" });
    const locked = await call("POST", "/operation-reports", base);
    expect(locked.statusCode).toBe(409);
    expect(locked.json().code).toBe("payroll-period-locked");
    await db.execute(sql`delete from payroll_periods`);

    // A cancelled order takes no reports — and nothing is left behind.
    expect((await call("POST", `/manufacturing-orders/${orderId}/cancel`)).statusCode).toBe(200);
    const cancelled = await call("POST", "/operation-reports", base);
    expect(cancelled.statusCode).toBe(409);
    expect(cancelled.json().code).toBe("invalid-status-transition");
    const [left] = await db.execute<{ n: number }>(sql`select count(*)::int as n from time_reports`);
    expect(left!.n).toBe(0);
  });

  it("refuses a lego operation — it is reported on its IO", async () => {
    const employeeId = await employee();
    const supplier = await call("POST", "/suppliers", { name: "Ytbehandling AB" });
    expect(supplier.statusCode).toBe(201);
    const article = await testArticleService.createArticle(
      parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Produkt", type: "manufactured", active: true })
    );
    const lego = await mfgService.createWorkCenter(
      parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling", type: "subcontract", supplierId: supplier.json().id, active: true })
    );
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0 });
    const created = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, null);
    const [op] = await mfgService.listOperations(created.id);
    const res = await call("POST", "/operation-reports", { moOperationId: op!.id, employeeId, date: "2026-11-03", hours: 1, quantityOk: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("work-stamp-subcontract");
  });

  it("is the Tillverkning write permission", async () => {
    const employeeId = await employee();
    const { first } = await order();
    const user = async (permissions: string[]) => {
      const [group] = await db
        .insert(permissionGroups)
        .values({ code: `RAP${crypto.randomUUID().slice(0, 6)}`, name: "Grupp", permissions })
        .returning();
      const email = `user-${crypto.randomUUID()}@example.com`;
      await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
      return login(email);
    };
    const body = { moOperationId: first.id, employeeId, date: "2026-11-03", hours: 1, quantityOk: 1 };
    expect((await call("POST", "/operation-reports", body, await user(["inkop"]))).statusCode).toBe(403);
    expect((await call("POST", "/operation-reports", body, await user(["tillverkning"]))).statusCode).toBe(201);
  });
});
