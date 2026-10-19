import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { sql } from "drizzle-orm";
import { db, permissionGroups, users } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { makeVariantService } from "./helpers/configurator.js";
import { multipartFile } from "./helpers/banking.js";

// Endast läsning: a read-only account (users.read_only) may open everything
// its permission group gives but change nothing. requireAuth (and the
// configurator scope's requireAuthOrClient) refuse every non-GET request from
// it with 403 read-only-account, except the routes marked readOnlySafe —
// POSTs that only compute and answer. Everything goes through the real app.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);
const configurator = makeVariantService();

const TRUNCATE = sql`TRUNCATE configurator_variants, configurator_rules, configurator_values, configurator_groups, configurator_templates,
  cost_calculations, article_files, mo_reports, mo_report_materials, attendance_sessions, stamp_sessions, time_reports, employees,
  mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups,
  bom_components, stock_transactions, sales_order_rows, sales_orders, customers, articles, audit_log, user_settings, users CASCADE`;
// Only this file's groups — the seeded ALLA/VERKSTAD belong to other files.
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'LAS%'`;

// The tables any of the requests below could write to. A read-only request
// must leave every count as it was.
const WATCHED = [
  "articles",
  "article_files",
  "cost_calculations",
  "configurator_variants",
  "manufacturing_orders",
  "mo_operations",
  "stamp_sessions",
  "attendance_sessions",
  "time_reports",
  "sales_orders",
  "stock_transactions",
  "user_settings",
  "audit_log",
] as const;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of WATCHED) {
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
    out[table] = row!.n;
  }
  return out;
}

// Every menu: what the demo account gets.
const ALL_MENUS = ["artiklar", "inkop", "forsaljning", "tillverkning", "lager", "ekonomi", "rapporter"];
const PASSWORD = "correcthorsebattery";

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function adminSession() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const admin = await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return { admin, cookie: await login(email) };
}

// The read-only account is created through the real admin route, as System →
// Användare does it.
async function readOnlySession(adminCookie: string) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `LAS${crypto.randomUUID().slice(0, 6)}`, name: "Demo", permissions: ALL_MENUS })
    .returning();
  const email = `demo-${crypto.randomUUID()}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/users",
    headers: { cookie: adminCookie },
    payload: { email, password: PASSWORD, name: "Demo", role: "user", permissionGroupId: group!.id, readOnly: true },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().readOnly).toBe(true);
  return { user: res.json() as { id: string }, cookie: await login(email) };
}

// A released TO with one operation, an employee to stamp with, a variants
// template with one choice and a purchased part.
async function fixtures(adminId: string) {
  const product = await testArticleService.createArticle({
    articleNumber: `P-${crypto.randomUUID().slice(0, 8)}`,
    name: "Diskbänk",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  const part = await testArticleService.createArticle({
    articleNumber: `K-${crypto.randomUUID().slice(0, 8)}`,
    name: "Skruv",
    type: "purchased",
    unit: "st",
    active: true,
  } as never);
  const workCenter = await mfgService.createWorkCenter({ code: "100", name: "Svets", active: true });
  await mfgService.createRoutingOperation(product.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: product.id, quantity: 5 }, adminId);
  const [operation] = await mfgService.listOperations(order.id);
  const employee = await timeReportService.createEmployee({ employeeNumber: "107", name: "Urban", active: true });

  const template = await testArticleService.createArticle({
    articleNumber: `T-${crypto.randomUUID().slice(0, 8)}`,
    name: "Papperskorg",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  await configurator.createTemplate(template.id, { mode: "variants" });
  const lock = await configurator.createGroup(template.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
  await configurator.createValue(template.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });

  return { product, part, order, operation: operation!, employee, template };
}

describe("Endast läsning — the session", () => {
  it("carries readOnly on /auth/me and in the user list", async () => {
    const { cookie: adminCookie } = await adminSession();
    const { user, cookie } = await readOnlySession(adminCookie);

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ id: user.id, readOnly: true });
    const adminMe = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: adminCookie } });
    expect(adminMe.json().readOnly).toBe(false);

    const list = await app.inject({ method: "GET", url: "/api/v1/auth/users", headers: { cookie: adminCookie } });
    expect(list.json().find((u: { id: string }) => u.id === user.id).readOnly).toBe(true);
  });
});

describe("Endast läsning — writes are refused", () => {
  it("refuses representative writes across modules with 403 read-only-account and writes nothing", async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const { user, cookie } = await readOnlySession(adminCookie);
    const f = await fixtures(admin.id);
    const before = await counts();

    const attempts = [
      // Artiklar: Ny artikel
      { method: "POST", url: "/api/v1/articles", payload: { name: "Ny", type: "purchased" } },
      { method: "PATCH", url: `/api/v1/articles/${f.product.id}`, payload: { name: "Ändrad" } },
      // Försäljning: Ny kundorder (the configurator scope, requireAuthOrClient)
      { method: "POST", url: "/api/v1/quotes", payload: { customerId: crypto.randomUUID(), rows: [] } },
      // Tillverkning: stämpla in i terminalen
      { method: "POST", url: "/api/v1/stamp-sessions", payload: { employeeId: f.employee.id, moOperationId: f.operation.id } },
      { method: "POST", url: "/api/v1/attendance-sessions", payload: { employeeId: f.employee.id } },
      // Lager
      { method: "POST", url: "/api/v1/stock/transactions", payload: { articleId: f.part.id, quantityDelta: 5 } },
      // DELETE, even of something that does not exist
      { method: "DELETE", url: `/api/v1/time-reports/${crypto.randomUUID()}` },
      // Own account: password and personal settings
      { method: "PATCH", url: `/api/v1/auth/users/${user.id}`, payload: { password: "ett-nytt-losenord" } },
      { method: "PATCH", url: "/api/v1/me/settings", payload: { listPageSize: 25 } },
      // Konfigurera på orderraden creates a variant article
      { method: "POST", url: `/api/v1/configurator/${f.template.id}/variant`, payload: { selection: { LOCK: "A" } } },
      // Saving a calculation
      { method: "POST", url: `/api/v1/articles/${f.product.id}/cost-calculations/pre-calculate`, payload: { quantity: 1, save: true } },
      { method: "POST", url: `/api/v1/manufacturing-orders/${f.order.id}/cost-calculations/post-calculate`, payload: { save: true } },
      // Reservationen after the delivery-time check
      { method: "POST", url: "/api/v1/delivery-time-check/apply", payload: { salesOrderId: crypto.randomUUID(), deliveryDate: "2030-01-01" } },
    ] as const;

    for (const attempt of attempts) {
      const res = await app.inject({ ...attempt, headers: { cookie } });
      expect([`${attempt.method} ${attempt.url}`, res.statusCode, res.json().code]).toEqual([
        `${attempt.method} ${attempt.url}`,
        403,
        "read-only-account",
      ]);
      expect(res.json().error).toBe("Kontot kan bara läsa — ändringar är avstängda.");
    }

    // Filuppladdning (multipart)
    const upload = await app.inject({
      method: "POST",
      url: `/api/v1/articles/${f.product.id}/files`,
      headers: { cookie, ...multipartFile("ritning.pdf", "%PDF-1.4\n%%EOF\n").headers },
      payload: multipartFile("ritning.pdf", "%PDF-1.4\n%%EOF\n").payload,
    });
    expect([upload.statusCode, upload.json().code]).toEqual([403, "read-only-account"]);

    expect(await counts()).toEqual(before);
  });

  it("is the flag, not the group: the same user may write once Endast läsning is cleared", async () => {
    const { cookie: adminCookie } = await adminSession();
    const { user, cookie } = await readOnlySession(adminCookie);
    const article = { name: "Ny", type: "purchased" };

    const refused = await app.inject({ method: "POST", url: "/api/v1/articles", headers: { cookie }, payload: article });
    expect(refused.statusCode).toBe(403);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/auth/users/${user.id}`,
      headers: { cookie: adminCookie },
      payload: { readOnly: false },
    });
    expect([cleared.statusCode, cleared.json().readOnly]).toEqual([200, false]);

    // The same session — verifyToken reads the account on every request.
    const allowed = await app.inject({ method: "POST", url: "/api/v1/articles", headers: { cookie }, payload: article });
    expect(allowed.statusCode).toBe(201);
  });
});

describe("Endast läsning — reads and side-effect-free POSTs work", () => {
  it("opens the registers and cards", async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const { cookie } = await readOnlySession(adminCookie);
    const f = await fixtures(admin.id);

    for (const url of [
      "/api/v1/articles",
      `/api/v1/articles/${f.product.id}`,
      "/api/v1/manufacturing-orders",
      `/api/v1/manufacturing-orders/${f.order.id}/operations`,
      "/api/v1/sales-orders",
      "/api/v1/purchase-orders",
      "/api/v1/stock/balances",
      "/api/v1/me/settings",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect([url, res.statusCode]).toEqual([url, 200]);
    }
  });

  it("runs every allowlisted POST and writes nothing", async () => {
    const { admin, cookie: adminCookie } = await adminSession();
    const { cookie } = await readOnlySession(adminCookie);
    const f = await fixtures(admin.id);
    const before = await counts();

    const calls = [
      { url: "/api/v1/delivery-time-check", payload: { rows: [{ articleId: f.part.id, quantity: 2 }] } },
      { url: `/api/v1/articles/${f.product.id}/cost-calculations/pre-calculate`, payload: { quantity: 1 } },
      { url: `/api/v1/articles/${f.product.id}/cost-calculations/pre-calculate`, payload: { quantity: 1, save: false } },
      { url: `/api/v1/manufacturing-orders/${f.order.id}/cost-calculations/post-calculate`, payload: undefined },
      { url: `/api/v1/manufacturing-orders/${f.order.id}/cost-calculations/post-calculate`, payload: { save: false } },
      { url: `/api/v1/articles/${f.template.id}/configurator/variants/preview`, payload: { sets: { LOCK: ["A"] }, calcQuantity: 1 } },
      { url: `/api/v1/configurator/${f.template.id}/evaluate`, payload: { selection: { LOCK: "A" } } },
      { url: `/api/v1/configurator/${f.template.id}/derive`, payload: { selection: { LOCK: "A" } } },
    ];
    for (const call of calls) {
      const res = await app.inject({ method: "POST", url: call.url, headers: { cookie }, payload: call.payload });
      expect([call.url, res.statusCode]).toEqual([call.url, 200]);
    }

    expect(await counts()).toEqual(before);
  });

  it("can always log out", async () => {
    const { cookie: adminCookie } = await adminSession();
    const { cookie } = await readOnlySession(adminCookie);
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === "session")?.value).toBe("");
  });
});

describe("Endast läsning — never an administrator", () => {
  it("refuses read-only together with role admin, on create and on either side of an edit", async () => {
    const { cookie: adminCookie } = await adminSession();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/auth/users",
      headers: { cookie: adminCookie },
      payload: { email: "ro-admin@example.com", password: PASSWORD, name: "X", role: "admin", readOnly: true },
    });
    expect([create.statusCode, create.json().code]).toEqual([400, "read-only-admin"]);

    const { user } = await readOnlySession(adminCookie);
    const promote = await app.inject({
      method: "PATCH",
      url: `/api/v1/auth/users/${user.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "admin" },
    });
    expect([promote.statusCode, promote.json().code]).toEqual([400, "read-only-admin"]);

    const second = await authService.createUser({ email: "admin2@example.com", password: PASSWORD, name: "A2", role: "admin" });
    const restrict = await app.inject({
      method: "PATCH",
      url: `/api/v1/auth/users/${second.id}`,
      headers: { cookie: adminCookie },
      payload: { readOnly: true },
    });
    expect([restrict.statusCode, restrict.json().code]).toEqual([400, "read-only-admin"]);

    // Both at once is fine when it ends as a non-admin.
    const demote = await app.inject({
      method: "PATCH",
      url: `/api/v1/auth/users/${second.id}`,
      headers: { cookie: adminCookie },
      payload: { role: "user", readOnly: true },
    });
    expect([demote.statusCode, demote.json().readOnly, demote.json().role]).toEqual([200, true, "user"]);
  });

  it("has the database refuse it too (migration 0128's CHECK)", async () => {
    await expect(
      db.insert(users).values({ email: "x@example.com", passwordHash: "x", name: "X", role: "admin", readOnly: true })
    ).rejects.toThrow();
  });
});

describe("Endast läsning — the allowlist", () => {
  // Pinned so a new readOnlySafe route is a reviewed decision: each must only
  // compute and answer (see docs/manual/system.md, Endast läsning).
  it("is exactly these routes", async () => {
    const routes: RouteOptions[] = [];
    const inventory = buildApp();
    inventory.addHook("onRoute", (route) => {
      routes.push(route);
    });
    await inventory.ready();
    await inventory.close();
    const marked = routes
      .filter((r) => (r.config as { readOnlySafe?: unknown } | undefined)?.readOnlySafe !== undefined)
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(marked).toEqual(
      [
        "POST /api/v1/delivery-time-check",
        "POST /api/v1/articles/:id/cost-calculations/pre-calculate",
        "POST /api/v1/manufacturing-orders/:id/cost-calculations/post-calculate",
        "POST /api/v1/articles/:id/configurator/variants/preview",
        "POST /api/v1/configurator/:articleId/derive",
        "POST /api/v1/configurator/:articleId/evaluate",
      ].sort()
    );
  });
});
