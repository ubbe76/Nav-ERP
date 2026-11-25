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
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired";

// Skriv ut arbetsorder och ritning vid instämpling: the setting (Manuellt by
// default, saved by an admin, read by the terminal), what POST
// /stamp-sessions says about the stamp it made (the order's / the
// operation's first stamp-in — the terminal prints on one of them) and the
// batch printout the terminal prints a Starta valda with.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);

const TRUNCATE = sql`TRUNCATE mo_reports, mo_report_materials, attendance_sessions, stamp_sessions, time_reports, employees, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, bom_components, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'TPRN%'`;
const CLEAR = sql`DELETE FROM system_settings WHERE key = 'terminal_print_work_order'`;

const app = buildApp();
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(CLEAR);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(CLEAR);
  await app.close();
});

async function login(role: "user" | "admin", permissions: string[]) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `TPRN${crypto.randomUUID().slice(0, 8)}`, name: "Utskrift", permissions })
    .returning();
  const email = `tprn-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: "correcthorse", name: "T", role, permissionGroupId: group!.id });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

// A released TO with operations 10 and 20 on one resource.
async function released(code = "100") {
  const user = await authRepo.create({ email: `tprn-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ledare", role: "supervisor" });
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `P-${crypto.randomUUID()}`, name: "Diskbänk", type: "manufactured", active: true })
  );
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code, name: "Svets", active: true }));
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
  const order = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, user.id);
  const [op10, op20] = await mfgService.listOperations(order.id);
  return { order, op10: op10!, op20: op20! };
}

describe("Skriv ut arbetsorder och ritning vid instämpling — inställningen", () => {
  it("is Manuellt by default, saved by an admin, read by the terminal, and refuses another value", async () => {
    const terminal = await login("user", ["terminal"]);
    const admin = await login("admin", []);
    const read = async () =>
      (await app.inject({ method: "GET", url: "/api/v1/settings/terminal", headers: { cookie: terminal } })).json().terminalPrintWorkOrder;

    expect(await read()).toBe("manual");
    const settings = await app.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie: admin } });
    expect(settings.json().terminalPrintWorkOrder).toBe("manual");

    for (const mode of ["first_operation", "every_operation", "manual"]) {
      const saved = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: admin }, payload: { terminalPrintWorkOrder: mode } });
      expect([saved.statusCode, saved.json().terminalPrintWorkOrder]).toEqual([200, mode]);
      expect(await read()).toBe(mode);
    }

    const bad = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: admin }, payload: { terminalPrintWorkOrder: "always" } });
    expect(bad.statusCode).toBe(400);
    // Writing stays admin-only.
    const shop = await app.inject({ method: "PATCH", url: "/api/v1/settings", headers: { cookie: terminal }, payload: { terminalPrintWorkOrder: "first_operation" } });
    expect(shop.statusCode).toBe(403);
  });

  it("reads a stored value it does not know as Manuellt", async () => {
    const terminal = await login("user", ["terminal"]);
    await db.execute(sql`INSERT INTO system_settings (key, value) VALUES ('terminal_print_work_order', 'sometimes')`);
    const res = await app.inject({ method: "GET", url: "/api/v1/settings/terminal", headers: { cookie: terminal } });
    expect(res.json().terminalPrintWorkOrder).toBe("manual");
  });
});

describe("POST /stamp-sessions — orderns och operationens första instämpling", () => {
  it("says first on the order once, first on each operation once — never again for a colleague, another day or Ställ klart", async () => {
    const { op10, op20 } = await released();
    const anna = await timeReportService.createEmployee({ employeeNumber: "301", name: "Anna Exempel", active: true });
    const bo = await timeReportService.createEmployee({ employeeNumber: "302", name: "Bo Exempel", active: true });
    const terminal = await login("user", ["terminal"]);
    const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie: terminal }, payload });
    const facts = (res: { json: () => { firstStampOnOrder: boolean; firstStampOnOperation: boolean } }) => {
      const body = res.json();
      return [body.firstStampOnOrder, body.firstStampOnOperation];
    };

    // Anna starts the order on op 10 as Ställ: the order's and op 10's first.
    const first = await post("/stamp-sessions", { employeeId: anna.id, moOperationId: op10.id, kind: "setup" });
    expect(first.statusCode).toBe(201);
    expect(facts(first)).toEqual([true, true]);

    // Bo joins op 10: neither.
    const colleague = await post("/stamp-sessions", { employeeId: bo.id, moOperationId: op10.id });
    expect([colleague.statusCode, ...facts(colleague)]).toEqual([201, false, false]);

    // Ställ klart = stop the setup 0/0 and stamp in as Produktion: neither.
    const out = await post(`/stamp-sessions/${first.json().id}/stop`, { quantityOk: 0, quantityScrapped: 0 });
    expect(out.statusCode).toBe(200);
    const run = await post("/stamp-sessions", { employeeId: anna.id, moOperationId: op10.id, kind: "run" });
    expect([run.statusCode, ...facts(run)]).toEqual([201, false, false]);

    // Op 20's first stamp: not the order's, but the operation's.
    const next = await post("/stamp-sessions", { employeeId: bo.id, moOperationId: op20.id });
    expect([next.statusCode, ...facts(next)]).toEqual([201, false, true]);

    // Back on op 20 another time: neither.
    await post(`/stamp-sessions/${next.json().id}/stop`, { quantityOk: 0, quantityScrapped: 0 });
    const again = await post("/stamp-sessions", { employeeId: bo.id, moOperationId: op20.id });
    expect([again.statusCode, ...facts(again)]).toEqual([201, false, false]);
  });

  it("counts per order: another order's stamps do not make this one's first stamp a repeat", async () => {
    const a = await released("110");
    const b = await released("120");
    const anna = await timeReportService.createEmployee({ employeeNumber: "303", name: "Anna Exempel", active: true });
    const terminal = await login("user", ["terminal"]);
    const post = (payload: object) => app.inject({ method: "POST", url: "/api/v1/stamp-sessions", headers: { cookie: terminal }, payload });

    const onA = await post({ employeeId: anna.id, moOperationId: a.op20.id });
    expect([onA.json().firstStampOnOrder, onA.json().firstStampOnOperation]).toEqual([true, true]);
    const onB = await post({ employeeId: anna.id, moOperationId: b.op10.id });
    expect([onB.json().firstStampOnOrder, onB.json().firstStampOnOperation]).toEqual([true, true]);
  });
});

describe("GET /manufacturing-orders/pdf — utskriften av en Starta valda", () => {
  it("prints several orders as one PDF for the terminal, as /:id/pdf", async () => {
    const a = await released("130");
    const b = await released("140");
    const terminal = await login("user", ["terminal"]);
    const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie: terminal } });

    const one = await get(`/manufacturing-orders/${a.order.id}/pdf`);
    expect([one.statusCode, one.headers["content-type"]]).toEqual([200, "application/pdf"]);
    const both = await get(`/manufacturing-orders/pdf?ids=${a.order.id},${b.order.id}`);
    expect([both.statusCode, both.headers["content-type"]]).toEqual([200, "application/pdf"]);
    expect(both.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
