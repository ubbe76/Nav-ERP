import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { inArray, sql } from "drizzle-orm";
import { db, emailLog, employees, permissionGroups } from "@navet/db";
import { API_CLIENT_SCOPES, effectivePermissions, satisfiesRule } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { enforceAccess, registerModule, resolveRule } from "../src/modules/auth/middleware/permission.middleware.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { resendAccessRule } from "../src/modules/mail/service/resend-access.js";

// Routes deliberately outside the permission gate: they authenticate
// themselves (login/register/logout, the OAuth token endpoint), answer for the
// session user only (/auth/me, /me/settings), or are the health probe and
// @fastify/cors's preflight catch-all.
const PUBLIC = new Set([
  "POST /api/v1/auth/register",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/logout",
  "GET /api/v1/auth/me",
  "GET /api/v1/me/settings",
  "PATCH /api/v1/me/settings",
  "POST /api/v1/auth/users",
  "GET /api/v1/auth/users",
  "PATCH /api/v1/auth/users/:id",
  "DELETE /api/v1/auth/users/:id",
  "POST /api/v1/oauth/token",
  "GET /health",
  "OPTIONS *",
]);

const routes: RouteOptions[] = [];
const app = buildApp();
// Root-level onRoute before ready(): inherited by every plugin, which only
// load (and register their routes) at ready().
app.addHook("onRoute", (route) => {
  routes.push(route);
});

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

function methods(route: RouteOptions): string[] {
  return (Array.isArray(route.method) ? route.method : [route.method]).filter((m) => m !== "HEAD");
}

// Behörigheter per OAuth-klient (4.9): exactly these routes are open to a
// client token, each behind one scope; any other route refuses clients.
const CLIENT_ROUTES = [
  "GET /api/v1/configurator/templates",
  "GET /api/v1/configurator/:articleId",
  "POST /api/v1/configurator/:articleId/evaluate",
  "POST /api/v1/quotes",
  "GET /api/v1/price-quote",
  "GET /api/v1/articles/:id/bom",
  "POST /api/v1/sales-orders/:id/confirm",
];

describe("client scopes", () => {
  it("open exactly the seven client routes, each with a known scope", () => {
    const known: readonly string[] = API_CLIENT_SCOPES;
    const scoped = routes
      .filter((r) => (r.config as { clientScope?: string } | undefined)?.clientScope)
      .flatMap((r) => methods(r).map((m) => ({ key: `${m} ${r.url}`, scope: (r.config as { clientScope: string }).clientScope })));
    expect(scoped.map((r) => r.key).sort()).toEqual([...CLIENT_ROUTES].sort());
    for (const r of scoped) expect(known).toContain(r.scope);
  });
});

describe("every API route has an access rule", () => {
  it("finds routes at all", () => {
    // ~90 % of the 660 route objects (incl. Fastify's implicit HEAD routes)
    // observed when this test was written: an empty or broken capture must
    // not pass the checks below vacuously.
    expect(routes.length).toBeGreaterThan(590);
  });

  it("has a rule or is explicitly public", () => {
    const missing: string[] = [];
    for (const route of routes) {
      for (const method of methods(route)) {
        const key = `${method} ${route.url}`;
        if (PUBLIC.has(key)) continue;
        if (resolveRule(route.config as never, method) === null) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("lets an Artiklar-only user write every /articles route, whichever module serves it", () => {
    const articlesOnly = { role: "user" as const, permissions: effectivePermissions("user", ["artiklar"]) };
    const blocked: string[] = [];
    for (const route of routes) {
      if (!route.url.startsWith("/api/v1/articles")) continue;
      for (const method of methods(route)) {
        if (method === "GET") continue;
        const rule = resolveRule(route.config as never, method);
        if (rule !== "public" && (rule === null || !satisfiesRule(articlesOnly, rule))) blocked.push(`${method} ${route.url}`);
      }
    }
    expect(blocked).toEqual([]);
  });

  it("lets an Artiklar-only user run the article card's actions served outside /articles", () => {
    // The Kalkyl tab deletes saved calculations and writes them back onto the
    // article (prisåterföring) through the costing module's own URLs.
    const articlesOnly = { role: "user" as const, permissions: effectivePermissions("user", ["artiklar"]) };
    const cardActions = [
      "DELETE /api/v1/cost-calculations/:id",
      "POST /api/v1/cost-calculations/:id/apply-standard-cost",
      "POST /api/v1/cost-calculations/:id/apply-sales-price",
    ];
    const verdicts = cardActions.map((key) => {
      const [method, url] = key.split(" ");
      const route = routes.find((r) => r.url === url && methods(r).includes(method!));
      if (!route) return `${key}: missing`;
      const rule = resolveRule(route.config as never, method!);
      return rule !== "public" && rule !== null && satisfiesRule(articlesOnly, rule) ? `${key}: ok` : `${key}: blocked`;
    });
    expect(verdicts).toEqual(cardActions.map((key) => `${key}: ok`));
  });

  it("still authenticates before the gate: anonymous requests get 401, not 403", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/articles" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/quotes", payload: {} })).statusCode).toBe(401);
  });
});

describe("frakt follows the Försäljning menu", () => {
  const as = (perms: string[]) => ({ role: "user" as const, permissions: effectivePermissions("user", perms as never) });
  const FREIGHT = /^\/api\/v1\/(shipments|freight-products|freight-settings|sales-orders\/:id\/freight)/;
  const OPEN_SETTINGS = new Set(["/api/v1/freight-settings/status", "/api/v1/freight-products"]);
  const allowed = (user: ReturnType<typeof as>, route: RouteOptions, method: string) => {
    const rule = resolveRule(route.config as never, method);
    return rule !== null && rule !== "public" && satisfiesRule(user, rule);
  };
  const each = (fn: (route: RouteOptions, method: string, key: string) => void) => {
    for (const route of routes.filter((r) => FREIGHT.test(r.url))) for (const m of methods(route)) fn(route, m, `${m} ${route.url}`);
  };

  it("finds the freight routes", () => {
    let n = 0;
    each(() => n++);
    expect(n).toBeGreaterThan(25);
  });

  it("lets Försäljning use every shipment route, but not the freight settings", () => {
    const sales = as(["forsaljning"]);
    const wrong: string[] = [];
    each((route, m, key) => {
      const settingsRoute = route.url.startsWith("/api/v1/freight-settings") && !OPEN_SETTINGS.has(route.url);
      if (allowed(sales, route, m) === settingsRoute) wrong.push(key);
    });
    expect(wrong).toEqual([]);
  });

  it("lets another office menu read shipments but change nothing", () => {
    const purchasing = as(["inkop"]);
    const wrong: string[] = [];
    each((route, m, key) => {
      const settingsRoute = route.url.startsWith("/api/v1/freight-settings") && !OPEN_SETTINGS.has(route.url);
      if (allowed(purchasing, route, m) !== (m === "GET" && !settingsRoute)) wrong.push(key);
    });
    expect(wrong).toEqual([]);
  });

  it("keeps the workshop profile out of every freight route", () => {
    const workshop = as(["terminal", "artikeloversikt", "tillverkningsorder_las"]);
    const open: string[] = [];
    each((route, m, key) => {
      if (allowed(workshop, route, m)) open.push(key);
    });
    expect(open).toEqual([]);
  });
});

// The gate itself, on a mini app: a fake auth hook sets req.user from a
// header (or req.apiClient, as requireAuthOrClient does for an OAuth client),
// then enforceAccess.
describe("enforceAccess", () => {
  async function miniApp(): Promise<FastifyInstance> {
    const mini = Fastify();
    mini.addHook("preHandler", async (req) => {
      const header = req.headers["x-test-user"];
      if (typeof header === "string") req.user = JSON.parse(header);
      if (req.headers["x-test-client"]) req.apiClient = { id: "client", scopes: ["prices:read"], customerId: null } as never;
    });
    mini.addHook("preHandler", enforceAccess());
    await registerModule(
      mini,
      async (scope) => {
        scope.get("/thing", async () => ({ ok: true }));
        scope.post("/thing", async () => ({ ok: true }));
        scope.post("/thing/special", { config: { access: ["lager"] } }, async () => ({ ok: true }));
        scope.get("/client-thing", { config: { clientScope: "prices:read" } }, async () => ({ ok: true }));
        scope.get("/client-other", { config: { clientScope: "orders:confirm" } }, async () => ({ ok: true }));
      },
      {},
      { read: ["office"], write: ["artiklar"] }
    );
    // Outside any module: no rule at all.
    mini.get("/stray", async () => ({ ok: true }));
    await mini.ready();
    return mini;
  }

  const as = (role: "admin" | "user", groupPermissions: string[]) => ({
    "x-test-user": JSON.stringify({ role, permissions: effectivePermissions(role, groupPermissions) }),
  });

  it("applies the module read/write defaults and answers 403 with the forbidden code", async () => {
    const mini = await miniApp();
    const inkop = as("user", ["inkop"]);
    expect((await mini.inject({ method: "GET", url: "/thing", headers: inkop })).statusCode).toBe(200);
    const denied = await mini.inject({ method: "POST", url: "/thing", headers: inkop });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "Insufficient permissions", code: "forbidden" });
    expect((await mini.inject({ method: "POST", url: "/thing", headers: as("user", ["artiklar"]) })).statusCode).toBe(200);
    // A user without a group has no office read either.
    expect((await mini.inject({ method: "GET", url: "/thing", headers: as("user", []) })).statusCode).toBe(403);
    await mini.close();
  });

  it("lets a route's own config.access win over the module default", async () => {
    const mini = await miniApp();
    expect((await mini.inject({ method: "POST", url: "/thing/special", headers: as("user", ["artiklar"]) })).statusCode).toBe(403);
    expect((await mini.inject({ method: "POST", url: "/thing/special", headers: as("user", ["lager"]) })).statusCode).toBe(200);
    await mini.close();
  });

  it("fails closed for a route without any rule, even for admin", async () => {
    const mini = await miniApp();
    expect((await mini.inject({ method: "GET", url: "/stray", headers: as("admin", []) })).statusCode).toBe(403);
    await mini.close();
  });

  it("lets an OAuth client (no user) through only on routes whose clientScope it holds", async () => {
    const mini = await miniApp();
    const client = { "x-test-client": "1" };
    expect((await mini.inject({ method: "GET", url: "/client-thing", headers: client })).statusCode).toBe(200);
    const other = await mini.inject({ method: "GET", url: "/client-other", headers: client });
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe("client-scope-missing");
    // No clientScope at all = closed to clients (fail closed).
    expect((await mini.inject({ method: "POST", url: "/thing", headers: client })).json().code).toBe("client-scope-missing");
    // Neither a user nor a client.
    expect((await mini.inject({ method: "POST", url: "/thing" })).statusCode).toBe(403);
    await mini.close();
  });
});

describe("resendAccessRule", () => {
  it("narrows a resend to the module that owns the logged document, failing closed", () => {
    expect(resendAccessRule("inquiry")).toEqual(["inkop"]);
    expect(resendAccessRule("purchase_order")).toEqual(["inkop"]);
    for (const type of ["quote", "order_confirmation", "invoice", "payment_reminder"]) {
      expect(resendAccessRule(type)).toEqual(["forsaljning"]);
    }
    expect(resendAccessRule("test")).toEqual(["admin"]);
    expect(resendAccessRule("something_new")).toEqual(["admin"]);
  });
});

// Profiles end to end: real groups, real logins, the real app.
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const NO_ID = "00000000-0000-0000-0000-000000000000";

// Never TRUNCATE permission_groups: the migration's seed rows (ALLA, VERKSTAD)
// must survive for every later test file.
async function clean() {
  await db.execute(sql`TRUNCATE user_settings, users, audit_log CASCADE`);
  await db.execute(sql`DELETE FROM permission_groups WHERE code NOT IN ('ALLA', 'VERKSTAD')`);
}

// Logs in through the real app, so the cookie is signed with the app's own
// JWT_SECRET whatever it is.
async function sessionFor(permissions: string[] | null, role: "user" | "admin" = "user") {
  let permissionGroupId: string | null = null;
  if (permissions) {
    const [g] = await db
      .insert(permissionGroups)
      .values({ code: `T-${crypto.randomUUID().slice(0, 8)}`, name: "T", permissions })
      .returning();
    permissionGroupId = g!.id;
  }
  const email = `p-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: "correcthorse", name: "P", role, permissionGroupId });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
  const cookie = res.cookies.find((c) => c.name === "session")!;
  return `session=${cookie.value}`;
}

async function status(cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });
  return res.statusCode;
}

describe("profiles against the real app", () => {
  beforeAll(clean);
  afterAll(clean);

  it("workshop: terminal, MO read, overview and files pass; everything else is 403", async () => {
    const c = await sessionFor(["terminal", "artikeloversikt", "tillverkningsorder_las"]);
    // passes the gate (any status but 403 — 400/404 come from the handler)
    expect(await status(c, "GET", "/stamp-sessions?open=true")).toBe(200);
    expect(await status(c, "POST", "/stamp-sessions", {})).toBe(400);
    expect(await status(c, "POST", `/stamp-sessions/${NO_ID}/stop`, {})).not.toBe(403);
    expect(await status(c, "GET", "/attendance-sessions?open=true")).toBe(200);
    expect(await status(c, "GET", "/employees/directory")).toBe(200);
    expect(await status(c, "GET", "/settings/terminal")).toBe(200);
    expect(await status(c, "GET", "/settings/pallet-card")).toBe(200);
    expect(await status(c, "GET", `/manufacturing-orders/${NO_ID}/reports/${NO_ID}/pallet-card`)).not.toBe(403);
    expect(await status(c, "GET", "/manufacturing-orders")).toBe(200);
    expect(await status(c, "GET", `/manufacturing-orders/${NO_ID}`)).toBe(404);
    expect(await status(c, "GET", `/manufacturing-orders/${NO_ID}/operations`)).not.toBe(403);
    expect(await status(c, "GET", `/manufacturing-orders/${NO_ID}/time-reports`)).not.toBe(403);
    expect(await status(c, "GET", `/articles/${NO_ID}/overview`)).toBe(404);
    expect(await status(c, "GET", `/articles/${NO_ID}/files`)).toBe(404);
    expect(await status(c, "GET", "/articles?search=x")).toBe(200);
    // blocked
    expect(await status(c, "GET", "/purchase-orders")).toBe(403);
    expect(await status(c, "GET", "/customers")).toBe(403);
    expect(await status(c, "GET", `/manufacturing-orders/${NO_ID}/cost-calculations`)).toBe(403);
    expect(await status(c, "POST", `/manufacturing-orders/${NO_ID}/release`)).toBe(403);
    expect(await status(c, "GET", "/employees")).toBe(403);
    expect(await status(c, "GET", "/settings")).toBe(403);
    expect(await status(c, "POST", "/articles", {})).toBe(403);
    // The configurator's evaluate is an office read, not a workshop one.
    expect(await status(c, "POST", `/configurator/${NO_ID}/evaluate`, { selection: {} })).toBe(403);
    expect(await status(c, "GET", `/articles/${NO_ID}/configurator`)).toBe(403);
    // Delprojekt 5: the external configurator's reads are office reads for a session too.
    expect(await status(c, "GET", "/configurator/templates")).toBe(403);
    expect(await status(c, "GET", `/configurator/${NO_ID}`)).toBe(403);
  });

  it("PATCH /articles/batch is an Artiklar write that the :id route does not swallow", async () => {
    const inkop = await sessionFor(["inkop"]);
    const artiklar = await sessionFor(["artiklar"]);
    const body = { rows: [{ id: NO_ID, name: "Nytt namn" }] };
    expect(await status(inkop, "PATCH", "/articles/batch", body)).toBe(403);
    expect(await status(artiklar, "PATCH", "/articles/batch", body)).toBe(200);
    expect(await status(artiklar, "PATCH", "/articles/batch", { rows: [] })).toBe(400);
    expect(await status(artiklar, "PATCH", "/articles/batch", { rows: [{ id: NO_ID }] })).toBe(400);
  });

  it("PATCH /articles/:id answers 400 invalid-reference for an unknown group", async () => {
    const artiklar = await sessionFor(["artiklar"]);
    const created = await app.inject({ method: "POST", url: "/api/v1/articles", headers: { cookie: artiklar }, payload: { articleNumber: `G-${crypto.randomUUID().slice(0, 8)}`, name: "G", type: "purchased" } });
    expect(created.statusCode).toBe(201);
    const res = await app.inject({ method: "PATCH", url: `/api/v1/articles/${created.json().id}`, headers: { cookie: artiklar }, payload: { groupId: crypto.randomUUID() } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid-reference");
  });

  it("configurator: any office menu may evaluate, only Artiklar edits the template", async () => {
    const inkop = await sessionFor(["inkop"]);
    const artiklar = await sessionFor(["artiklar"]);
    expect(await status(inkop, "POST", `/configurator/${NO_ID}/evaluate`, { selection: {} })).toBe(404);
    expect(await status(inkop, "GET", "/configurator/templates")).toBe(200);
    expect(await status(inkop, "GET", `/configurator/${NO_ID}`)).toBe(404);
    expect(await status(inkop, "GET", `/articles/${NO_ID}/configurator`)).toBe(404);
    expect(await status(inkop, "PATCH", `/articles/${NO_ID}/configurator`, { published: true })).toBe(403);
    expect(await status(artiklar, "PATCH", `/articles/${NO_ID}/configurator`, { published: true })).toBe(404);
    expect(await status(inkop, "POST", `/articles/${NO_ID}/configurator`, { mode: "variants" })).toBe(403);
    expect(await status(inkop, "POST", `/articles/${NO_ID}/configurator/groups/reorder`, { ids: [NO_ID] })).toBe(403);
    expect(await status(artiklar, "POST", `/articles/${NO_ID}/configurator`, { mode: "variants" })).toBe(404);
  });

  it("configurator: Försäljning and Tillverkning resolve a variant on the row but never create variants from the card", async () => {
    const sales = await sessionFor(["forsaljning"]);
    const production = await sessionFor(["tillverkning"]);
    const inkop = await sessionFor(["inkop"]);
    const workshop = await sessionFor(["terminal", "artikeloversikt", "tillverkningsorder_las"]);
    // passes the gate (404 from the handler: no such template)
    expect(await status(sales, "POST", `/configurator/${NO_ID}/variant`, { selection: {} })).toBe(404);
    expect(await status(production, "POST", `/configurator/${NO_ID}/variant`, { selection: {} })).toBe(404);
    // the card's mass creation stays an Artiklar write
    expect(await status(sales, "POST", `/articles/${NO_ID}/configurator/variants`, { sets: {}, calcQuantity: 1 })).toBe(403);
    // no office menu of the three ⇒ 403
    expect(await status(inkop, "POST", `/configurator/${NO_ID}/variant`, { selection: {} })).toBe(403);
    expect(await status(workshop, "POST", `/configurator/${NO_ID}/variant`, { selection: {} })).toBe(403);
  });

  it("configurator variants: office reads and previews, only Artiklar creates", async () => {
    const verkstad = await sessionFor(["terminal"]);
    const inkop = await sessionFor(["inkop"]);
    const artiklar = await sessionFor(["artiklar"]);
    const body = { sets: {}, calcQuantity: 1 };
    expect(await status(verkstad, "GET", `/articles/${NO_ID}/configurator/variants`)).toBe(403);
    expect(await status(inkop, "GET", `/articles/${NO_ID}/configurator/variants`)).toBe(404);
    expect(await status(inkop, "POST", `/articles/${NO_ID}/configurator/variants/preview`, body)).toBe(404);
    expect(await status(inkop, "GET", `/articles/${NO_ID}/variant-of`)).toBe(404);
    expect(await status(inkop, "POST", `/articles/${NO_ID}/configurator/variants`, body)).toBe(403);
    expect(await status(artiklar, "POST", `/articles/${NO_ID}/configurator/variants`, body)).toBe(404);
  });

  it("configurator derive is an office read; structure lines and operations are Artiklar writes", async () => {
    const verkstad = await sessionFor(["terminal"]);
    const inkop = await sessionFor(["inkop"]);
    const artiklar = await sessionFor(["artiklar"]);
    const line = { conditions: [], source: "article", componentArticleId: NO_ID, quantity: 1 };
    const op = { conditions: [], sequenceNo: 40, workCenterId: NO_ID, setupTime: 1, runTimePerUnit: 1 };
    expect(await status(verkstad, "POST", `/configurator/${NO_ID}/derive`, { selection: {} })).toBe(403);
    expect(await status(inkop, "POST", `/configurator/${NO_ID}/derive`, { selection: {} })).toBe(404);
    expect(await status(artiklar, "POST", `/configurator/${NO_ID}/derive`, { selection: {} })).toBe(404);
    for (const [method, url, body] of [
      ["POST", `/articles/${NO_ID}/configurator/bom-lines`, line],
      ["PATCH", `/articles/${NO_ID}/configurator/bom-lines/${NO_ID}`, { note: "x" }],
      ["DELETE", `/articles/${NO_ID}/configurator/bom-lines/${NO_ID}`, undefined],
      ["POST", `/articles/${NO_ID}/configurator/bom-lines/reorder`, { ids: [NO_ID] }],
      ["POST", `/articles/${NO_ID}/configurator/operations`, op],
      ["PATCH", `/articles/${NO_ID}/configurator/operations/${NO_ID}`, { description: "x" }],
      ["DELETE", `/articles/${NO_ID}/configurator/operations/${NO_ID}`, undefined],
    ] as const) {
      expect(await status(inkop, method, url, body), `inkop ${method} ${url}`).toBe(403);
      expect(await status(verkstad, method, url, body), `verkstad ${method} ${url}`).toBe(403);
      expect(await status(artiklar, method, url, body), `artiklar ${method} ${url}`).toBe(404);
    }
  });

  it("the employee directory carries names, numbers and Förvalda stationer only, sorted on the employee number", async () => {
    const c = await sessionFor(["terminal"]);
    const tag = crypto.randomUUID().slice(0, 8);
    const inserted = await db
      .insert(employees)
      .values([
        { employeeNumber: `${tag}-10`, name: "Tio", personalIdentityNumber: "19800101-1234", wage: "250.00", phone: "070", email: "x@example.com", address: "Gatan 1" },
        { employeeNumber: `${tag}-9`, name: "Nio", active: false },
      ])
      .returning({ id: employees.id });
    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/employees/directory", headers: { cookie: c } });
      expect(res.statusCode).toBe(200);
      const rows = (res.json() as Record<string, unknown>[]).filter((r) => String(r.employeeNumber).startsWith(tag));
      expect(rows).toEqual([
        { id: inserted[1]!.id, employeeNumber: `${tag}-9`, name: "Nio", active: false, defaultWorkCenterIds: [] },
        { id: inserted[0]!.id, employeeNumber: `${tag}-10`, name: "Tio", active: true, defaultWorkCenterIds: [] },
      ]);
      // A workshop user never reaches the full record.
      expect(await status(c, "GET", `/employees/${inserted[0]!.id}`)).toBe(403);
    } finally {
      await db.execute(sql`DELETE FROM employees WHERE employee_number LIKE ${tag + "-%"}`);
    }
  });

  it("sales-only: reads are shared, writes only in Försäljning", async () => {
    const c = await sessionFor(["forsaljning"]);
    expect(await status(c, "GET", "/articles")).toBe(200);
    expect(await status(c, "GET", "/manufacturing-orders")).toBe(200);
    expect(await status(c, "GET", "/purchase-orders")).toBe(200);
    expect(await status(c, "POST", "/articles", {})).toBe(403);
    expect(await status(c, "POST", "/purchase-orders", {})).toBe(403);
    expect(await status(c, "POST", "/quotes", {})).toBe(400); // configurator scope, human session
    expect(await status(c, "GET", "/accounts")).toBe(403);
    expect(await status(c, "GET", "/employees")).toBe(403);
  });

  it("purchase-only: the configurator's POST /quotes is 403 for a human", async () => {
    const c = await sessionFor(["inkop"]);
    expect(await status(c, "POST", "/quotes", {})).toBe(403);
  });

  it("ekonomi-only: Ekonomi opens without the admin role", async () => {
    const c = await sessionFor(["ekonomi"]);
    expect(await status(c, "GET", "/accounts")).toBe(200);
    expect(await status(c, "GET", "/articles")).toBe(200); // ekonomi is a menu permission ⇒ office
  });

  it("no group: everything is 403 but the session itself", async () => {
    const c = await sessionFor(null);
    expect(await status(c, "GET", "/auth/me")).toBe(200);
    expect(await status(c, "GET", "/articles")).toBe(403);
    expect(await status(c, "GET", "/stamp-sessions")).toBe(403);
  });

  it("admin: unaffected", async () => {
    const c = await sessionFor(null, "admin");
    expect(await status(c, "GET", "/employees")).toBe(200);
    expect(await status(c, "GET", "/accounts")).toBe(200);
    expect(await status(c, "GET", "/permission-groups")).toBe(200);
  });

  it("mail resend: only the module that owns the document may re-run its send", async () => {
    const inkop = await sessionFor(["inkop"]);
    const sales = await sessionFor(["forsaljning"]);
    // An unknown entry is 404 for every user the module rule admits.
    expect(await status(inkop, "POST", `/email-log/${NO_ID}/resend`)).toBe(404);
    expect(await status(sales, "POST", `/email-log/${NO_ID}/resend`)).toBe(404);

    // Logged sends pointing at nothing: the type check answers before any
    // document (or SMTP) is touched, so no real mail is needed.
    const entries = await db
      .insert(emailLog)
      .values(
        (["purchase_order", "order_confirmation", "payment_reminder", "test"] as const).map((documentType) => ({
          documentType,
          documentId: documentType === "test" ? null : NO_ID,
          recipient: "x@example.com",
          subject: "S",
          status: "failed" as const,
        }))
      )
      .returning({ id: emailLog.id, documentType: emailLog.documentType });
    const idOf = (type: string) => entries.find((e) => e.documentType === type)!.id;
    try {
      expect(await status(sales, "POST", `/email-log/${idOf("purchase_order")}/resend`)).toBe(403);
      expect(await status(inkop, "POST", `/email-log/${idOf("order_confirmation")}/resend`)).toBe(403);
      expect(await status(inkop, "POST", `/email-log/${idOf("payment_reminder")}/resend`)).toBe(403);
      expect(await status(sales, "POST", `/email-log/${idOf("test")}/resend`)).toBe(403);
      expect(await status(inkop, "POST", `/email-log/${idOf("test")}/resend`)).toBe(403);
      // The owning module passes the type check (the missing document is 404).
      expect(await status(inkop, "POST", `/email-log/${idOf("purchase_order")}/resend`)).toBe(404);
      expect(await status(sales, "POST", `/email-log/${idOf("order_confirmation")}/resend`)).toBe(404);
    } finally {
      await db.delete(emailLog).where(inArray(emailLog.id, entries.map((e) => e.id)));
    }
  });

  it("posting settings: the Ekonomi permission edits Konteringsregler's keys and nothing else", async () => {
    const ekonomi = await sessionFor(["ekonomi"]);
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/posting",
      headers: { cookie: ekonomi },
      payload: { postingVatOut25: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().postingVatOut25).toBe("2610");
    // Any other settings key is refused, not silently saved.
    expect(await status(ekonomi, "PATCH", "/settings/posting", { smtpHost: "smtp.example.com" })).toBe(400);
    // The full settings PATCH stays admin-only.
    expect(await status(ekonomi, "PATCH", "/settings", { postingVatOut25: "" })).toBe(403);
    const inkop = await sessionFor(["inkop"]);
    expect(await status(inkop, "PATCH", "/settings/posting", { postingVatOut25: "" })).toBe(403);
  });

  it("the gate really runs: a groupless user is refused on every protected route", { timeout: 120_000 }, async () => {
    // Static checks above prove each route HAS a rule; this proves the
    // preHandler that enforces it is wired in front of every one of them.
    // One session, every non-public route; any status but 403 means either a
    // handler ran for a user with no permissions at all, or (401) the session
    // stopped counting and the route was never really checked.
    const c = await sessionFor(null);
    // The session must really authenticate — otherwise every route would
    // answer 401 and the sweep would pass without the gate ever running.
    expect(await status(c, "GET", "/auth/me")).toBe(200);
    const leaks: string[] = [];
    const unauthenticated: string[] = [];
    for (const route of routes) {
      for (const method of methods(route)) {
        if (PUBLIC.has(`${method} ${route.url}`)) continue;
        const url = route.url.replace(/:[A-Za-z0-9_]+/g, NO_ID);
        const res = await app.inject({
          method: method as never,
          url,
          headers: { cookie: c },
          ...(method === "GET" ? {} : { payload: {} }),
        });
        if (res.statusCode === 401) unauthenticated.push(`${method} ${route.url}`);
        else if (res.statusCode !== 403) leaks.push(`${method} ${route.url} → ${res.statusCode}`);
      }
    }
    expect(leaks).toEqual([]);
    // With a valid session the refusal must come from the permission gate
    // (403), not from authentication (401) — a 401 here means the session
    // stopped counting and the sweep proved nothing for that route.
    expect(unauthenticated).toEqual([]);
  });

  it("hides prices from a profile without any menu (verkstad), keeps them for office users", { timeout: 60_000 }, async () => {
    await db.execute(
      sql`TRUNCATE mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, bom_components, articles CASCADE`
    );
    const admin = await sessionFor(null, "admin");
    const call = async (cookie: string, method: "GET" | "POST", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
      return res.json();
    };
    const wc = await call(admin, "POST", "/work-centers", { code: "901", name: "Lego prisprov", type: "subcontract" });
    const article = await call(admin, "POST", "/articles", {
      articleNumber: "PRIS-1",
      name: "Prisprov",
      type: "manufactured",
      standardCost: 123.45,
      salesPrice: 999,
    });
    await call(admin, "POST", `/articles/${article.id}/routing`, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 0,
      runTimePerUnit: 0,
      setupPrice: 250,
      unitPrice: 40,
    });
    const mo = await call(admin, "POST", "/manufacturing-orders", { articleId: article.id, quantity: 2 });

    const workshop = await sessionFor(["terminal", "artikeloversikt", "tillverkningsorder_las"]);
    const sales = await sessionFor(["forsaljning"]);

    const priceFields = async (cookie: string) => {
      const list = await call(cookie, "GET", "/articles?search=PRIS-1");
      const ops = await call(cookie, "GET", `/manufacturing-orders/${mo.id}/operations`);
      const row = list.rows.find((a: { id: string }) => a.id === article.id);
      return {
        standardCost: row.standardCost,
        salesPrice: row.salesPrice,
        setupPrice: ops[0].setupPrice,
        unitPrice: ops[0].unitPrice,
      };
    };

    expect(await priceFields(workshop)).toEqual({ standardCost: null, salesPrice: null, setupPrice: null, unitPrice: null });
    const office = await priceFields(sales);
    expect(Number(office.standardCost)).toBe(123.45);
    expect(Number(office.salesPrice)).toBe(999);
    expect(Number(office.setupPrice)).toBe(250);
    expect(Number(office.unitPrice)).toBe(40);
  });

  // Konfigurator 4c: a configured TO's förkalkyl (configuration.cost) is
  // price data like setupPrice/unitPrice above — nulled for the verkstad
  // profile on both the TO card and the list, kept for office users. The
  // configuration is stamped directly (the route's nulling is what is under
  // test, not the derivation — configured-manufacturing.test.ts covers that).
  it("hides a configured TO's förkalkyl from the verkstad profile on GET /manufacturing-orders[/:id]", { timeout: 60_000 }, async () => {
    await db.execute(sql`TRUNCATE mo_material_consumptions, mo_operations, manufacturing_orders, bom_components, articles CASCADE`);
    const admin = await sessionFor(null, "admin");
    const call = async (cookie: string, method: "GET" | "POST", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload: payload as never });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBeLessThan(300);
      return res.json();
    };
    const article = await call(admin, "POST", "/articles", { articleNumber: "KONF-1", name: "Konfigurerad", type: "manufactured" });
    const mo = await call(admin, "POST", "/manufacturing-orders", { articleId: article.id, quantity: 1 });
    const configuration = JSON.stringify({
      templateArticleId: article.id,
      key: "LOCK=B",
      selection: [{ groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "B", valueName: "Lås B", value: "B", unit: null }],
      cost: { manufacturingCostPerUnit: 168, calculatedAt: new Date().toISOString() },
    });
    await db.execute(sql`update manufacturing_orders set configuration = ${configuration}::jsonb where id = ${mo.id}`);

    const workshop = await sessionFor(["terminal", "artikeloversikt", "tillverkningsorder_las"]);
    const sales = await sessionFor(["forsaljning"]);
    const costFields = async (cookie: string) => {
      const detail = await call(cookie, "GET", `/manufacturing-orders/${mo.id}`);
      const list = await call(cookie, "GET", "/manufacturing-orders?search=KONF-1");
      const row = list.rows.find((r: { id: string }) => r.id === mo.id);
      return {
        detail: detail.configuration.cost.manufacturingCostPerUnit,
        list: row.configuration.cost.manufacturingCostPerUnit,
        // The rest of the configuration (the choices) stays — the shop floor
        // needs them.
        detailKey: detail.configuration.key,
      };
    };
    expect(await costFields(workshop)).toEqual({ detail: null, list: null, detailKey: "LOCK=B" });
    expect(await costFields(sales)).toEqual({ detail: 168, list: 168, detailKey: "LOCK=B" });
  });

  it("supervisor keeps the full employee list", async () => {
    const group = await db.execute<{ id: string }>(sql`SELECT id FROM permission_groups WHERE code = 'ALLA'`);
    const email = `s-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: "correcthorse", name: "S", role: "supervisor", permissionGroupId: group[0]!.id });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    const c = `session=${res.cookies.find((x) => x.name === "session")!.value}`;
    expect(await status(c, "GET", "/employees")).toBe(200);
    // Writes to the personnel register pass the gate (400/404 from the handler).
    expect(await status(c, "POST", "/employees", {})).toBe(400);
    expect(await status(c, "PATCH", `/employees/${NO_ID}`, { name: "X" })).toBe(404);
  });

  it("tillverkning-only: the personnel register's writes are admin/supervisor too (PATCH echoes the full row)", async () => {
    const c = await sessionFor(["tillverkning"]);
    expect(await status(c, "POST", "/employees", {})).toBe(403);
    expect(await status(c, "PATCH", `/employees/${NO_ID}`, { name: "X" })).toBe(403);
    // ...while the terminal's employee subresources stay open to it.
    expect(await status(c, "GET", "/employees/directory")).toBe(200);
    expect(await status(c, "GET", `/employees/${NO_ID}/atf`)).not.toBe(403);
  });
});
